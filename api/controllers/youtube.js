/**
 * api/controllers/youtube.js
 * Server-side proxy for YouTube (search/metadata) + JioSaavn (streaming).
 *
 * Endpoints:
 *   search(q, type, maxResults)  → /api/youtube/search
 *   videoDetails(ids)             → /api/youtube/videos
 *   playlistItems(playlistId)     → /api/youtube/playlist
 *   streamProxy(id, title)        → /api/youtube/stream  (JioSaavn audio)
 *   saavnSearch(q)                → /api/youtube/saavn/search
 */

'use strict';

const config = require('../../config');

// ── Tiny in-memory cache ──────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── Shared fetch helper ───────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Upstream error ${res.status}`), {
      status: res.status,
      upstream: body,
    });
  }
  return res.json();
}

// ── YouTube Data API v3 helpers ───────────────────────────────────────────────
async function ytSearch(q, type = 'video', maxResults = 15) {
  const key = config.youtube.apiKey;
  if (!key) return null;

  const url = new URL(config.youtube.searchEndpoint);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('q', q);
  url.searchParams.set('type', type);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('key', key);

  return apiFetch(url.toString());
}

async function ytVideoDetails(ids) {
  const key = config.youtube.apiKey;
  if (!key) return null;

  const url = new URL(config.youtube.videosEndpoint);
  url.searchParams.set('part', 'contentDetails,snippet');
  url.searchParams.set('id', Array.isArray(ids) ? ids.join(',') : ids);
  url.searchParams.set('key', key);

  return apiFetch(url.toString());
}

async function ytPlaylistItems(playlistId, maxResults = 50) {
  const key = config.youtube.apiKey;
  if (!key) return null;

  const url = new URL(config.youtube.playlistEndpoint);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('playlistId', playlistId);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('key', key);

  return apiFetch(url.toString());
}

// ── Invidious fallback ────────────────────────────────────────────────────────
async function invidiousSearch(q, type = 'video') {
  const instances = config.youtube.invidiousInstances;
  const fields = type === 'playlist'
    ? 'title,playlistId,author,videoCount,videos'
    : 'title,videoId,author,lengthSeconds,videoThumbnails';

  for (const instance of instances) {
    try {
      const url = `${instance}/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&fields=${fields}`;
      return await apiFetch(url);
    } catch {
      // try next instance
    }
  }
  throw new Error('All Invidious instances failed');
}

// ── Deezer search — clean title + artist from messy YouTube titles ────────────
const DEEZER_API = 'https://api.deezer.com';

async function deezerSearch(ytTitle, ytArtist) {
  // Strip YouTube bloat from title first
  const cleanTitle = ytTitle
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\|.*/g, '')
    .replace(/[-–—]\s*(full|official|video|audio|song|lyric|hd|4k).*/gi, '')
    .replace(/official\s*(video|audio|music|lyric[s]?)/gi, '')
    .replace(/\b(lyrics?|hd|4k|full\s*video|full\s*song|audio|video)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Build query: cleaned title + artist if available and not "Unknown Artist"
  const artistPart = (ytArtist && ytArtist !== 'Unknown Artist' && ytArtist !== 'YouTube')
    ? ` ${ytArtist}` : '';
  const query = `${cleanTitle}${artistPart}`.trim();

  console.log(`[VOID deezer] searching: "${query}"`);

  const resp = await fetch(
    `${DEEZER_API}/search?q=${encodeURIComponent(query)}&limit=5`,
    { signal: AbortSignal.timeout(8000) }
  );

  if (!resp.ok) throw new Error(`Deezer search failed: ${resp.status}`);
  const data = await resp.json();
  const results = data?.data || [];

  if (!results.length) return null;

  // Return the top result's clean title and artist
  const top = results[0];
  return {
    title: top.title,
    artist: top.artist?.name || '',
  };
}

// ── JioSaavn direct integration ───────────────────────────────────────────────
const SAAVN_API = 'https://www.jiosaavn.com/api.php';

async function saavnSearch(cleanTitle, cleanArtist) {
  // Use Deezer-cleaned title + artist for accurate Saavn matching
  const query = cleanArtist
    ? `${cleanTitle} ${cleanArtist}`
    : cleanTitle;

  console.log(`[VOID saavn] searching: "${query}"`);

  const params = new URLSearchParams({
    __call: 'search.getResults',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    query,
    n: '5',
    p: '1',
  });

  const resp = await fetch(`${SAAVN_API}?${params}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.jiosaavn.com/',
    },
  });

  if (!resp.ok) throw new Error(`Saavn search failed: ${resp.status}`);
  const data = await resp.json();
  const results = data?.results || [];
  return results.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.more_info?.singers || '',
  }));
}

async function saavnGetStreamUrl(songId) {
  const params = new URLSearchParams({
    __call: 'song.generateAuthToken',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    bitrate: '320',
    url: `https://www.jiosaavn.com/song/x/${songId}`,
  });

  const resp = await fetch(`${SAAVN_API}?${params}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.jiosaavn.com/',
    },
  });

  if (!resp.ok) throw new Error(`Saavn token failed: ${resp.status}`);
  const data = await resp.json();
  const url = data?.auth_url;
  if (!url) throw new Error('No auth_url in Saavn response');
  return url;
}

// ── Exported controller functions ─────────────────────────────────────────────

exports.search = async (req, res, next) => {
  try {
    const q          = String(req.query.q   || '').trim();
    const type       = String(req.query.type || 'video');
    const maxResults = Math.min(parseInt(req.query.max, 10) || 15, 50);

    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const cacheKey = `search:${q}:${type}:${maxResults}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    let data;
    try {
      data = await ytSearch(q, type, maxResults);
      if (!data) data = await invidiousSearch(q, type);
    } catch {
      data = await invidiousSearch(q, type);
    }

    cacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
};

exports.videoDetails = async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').trim();
    if (!ids) return res.status(400).json({ error: 'Missing query parameter: ids' });

    const cacheKey = `video:${ids}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    const data = await ytVideoDetails(ids);
    if (!data) return res.status(503).json({ error: 'YouTube API key not configured' });

    cacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
};

exports.playlistItems = async (req, res, next) => {
  try {
    const playlistId = String(req.query.id || '').trim();
    if (!playlistId) return res.status(400).json({ error: 'Missing query parameter: id' });

    const cacheKey = `playlist:${playlistId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    let data;
    try {
      data = await ytPlaylistItems(playlistId);
      if (!data) {
        const instance = config.youtube.invidiousInstances[0];
        data = await apiFetch(`${instance}/api/v1/playlists/${encodeURIComponent(playlistId)}?fields=title,videos`);
      }
    } catch {
      const instance = config.youtube.invidiousInstances[0];
      data = await apiFetch(`${instance}/api/v1/playlists/${encodeURIComponent(playlistId)}?fields=title,videos`);
    }

    cacheSet(cacheKey, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
};

// ── Stream proxy ──────────────────────────────────────────────────────────────
// Flow: YouTube title → Deezer (clean title+artist) → Saavn search → stream
// ?id=      YouTube video ID
// ?title=   YouTube video title
// ?artist=  YouTube channel/artist name (optional but helps)
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id     || '').trim();
  const title   = String(req.query.title  || '').trim();
  const artist  = String(req.query.artist || '').trim();

  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });
  if (!title)   return res.status(400).json({ error: 'Missing query parameter: title' });

  try {
    // Step 1 — Use Deezer to get clean title + artist from messy YouTube title
    let cleanTitle = title;
    let cleanArtist = artist;

    try {
      const deezerResult = await deezerSearch(title, artist);
      if (deezerResult) {
        cleanTitle  = deezerResult.title;
        cleanArtist = deezerResult.artist;

        // Extra aggressive cleanup for Saavn
        cleanTitle = cleanTitle
          .replace(/\(from\s+["'].*?["']\)/gi, '')
          .replace(/\(.*?version.*?\)/gi, '')
          .replace(/\(.*?\)/g, '')
          .replace(/\[.*?\]/g, '')
          .replace(/\|.*/g, '')
          .replace(/official/gi, '')
          .replace(/video/gi, '')
          .replace(/lyrics?/gi, '')
          .replace(/full\s*song/gi, '')
          .replace(/audio/gi, '')
          .replace(/4k|hd/gi, '')
          .replace(/[^a-zA-Z0-9\s]/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        console.log(`[VOID deezer] resolved clean: "${cleanTitle}" by "${cleanArtist}"`);
      }
    } catch (e) {
      console.warn('[VOID deezer] lookup failed, falling back to raw title:', e.message);
    }

    // Step 2 — Search Saavn with clean data + fallback logic
    let results = await saavnSearch(cleanTitle, cleanArtist);

    // Fallback 1 — without artist
    if (!results.length && cleanArtist) {
      console.log('[VOID saavn] retrying without artist...');
      results = await saavnSearch(cleanTitle, '');
    }

    // Fallback 2 — use first 3 words of title only
    if (!results.length) {
      const simpleTitle = cleanTitle.split(' ').slice(0, 3).join(' ');
      console.log(`[VOID saavn] retrying simple: "${simpleTitle}"`);
      results = await saavnSearch(simpleTitle, '');
    }

    if (!results.length) {
      return res.status(404).json({ error: `No Saavn match found for: ${cleanTitle}` });
    }

    // Step 3 — Get stream URL
    const songId = results[0].id;
    const streamUrl = await saavnGetStreamUrl(songId);

    // Step 4 — Fetch and proxy audio
    const audioResp = await fetch(streamUrl, {
      signal: AbortSignal.timeout(60000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!audioResp.ok) {
      return res.status(502).json({ error: `Audio fetch failed: ${audioResp.status}` });
    }

    const buffer = Buffer.from(await audioResp.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);

  } catch (e) {
    console.error('[VOID stream] Saavn error:', e.message);
    next(e);
  }
};

// ── Saavn search endpoint ─────────────────────────────────────────────────────
exports.saavnSearch = async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });
  try {
    const results = await saavnSearch(q, '');
    res.json({ data: { results } });
  } catch (e) {
    next(e);
  }
};
