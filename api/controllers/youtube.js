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

// ── Title cleanup — strip YouTube bloat before searching ─────────────────────
function cleanYouTubeTitle(title) {
  return title
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\|.*/g, '')
    .replace(/[-–—]\s*(full|official|video|audio|song|lyric|hd|4k).*/gi, '')
    .replace(/official\s*(video|audio|music|lyric[s]?)/gi, '')
    .replace(/\b(lyrics?|hd|4k|full\s*video|full\s*song|audio|video)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Deezer — resolve canonical title + artist from a messy YouTube title ──────
const DEEZER_API = 'https://api.deezer.com';

async function deezerSearch(ytTitle, ytArtist) {
  const cleaned = cleanYouTubeTitle(ytTitle);

  const skipArtist = !ytArtist
    || ytArtist === 'Unknown Artist'
    || ytArtist === 'YouTube';

  const query = skipArtist
    ? cleaned
    : `${cleaned} ${ytArtist}`.trim();

  console.log(`[VOID deezer] searching: "${query}"`);

  const resp = await fetch(
    `${DEEZER_API}/search?q=${encodeURIComponent(query)}&limit=5`,
    { signal: AbortSignal.timeout(8000) }
  );

  if (!resp.ok) throw new Error(`Deezer search failed: ${resp.status}`);
  const data = await resp.json();
  const results = data?.data || [];
  if (!results.length) return null;

  const top = results[0];
  return {
    title:  top.title,
    artist: top.artist?.name || '',
  };
}

// ── saavn.dev — public JioSaavn API (reliable, no scraping) ──────────────────
// Docs: https://saavn.dev
// ── saavn — tries multiple public API instances until one responds ─────────────
const SAAVN_INSTANCES = [
  'https://saavn.dev/api',
  'https://jiosaavn-api-privatecvc2.vercel.app',
  'https://saavn.me',
];

async function saavnSearch(query) {
  console.log(`[VOID saavn] searching: "${query}"`);

  for (const base of SAAVN_INSTANCES) {
    try {
      const resp = await fetch(
        `${base}/search/songs?query=${encodeURIComponent(query)}&page=1&limit=5`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      const results = data?.data?.results || [];
      if (results.length) {
        console.log(`[VOID saavn] got results from ${base}`);
        return results;
      }
    } catch (e) {
      console.warn(`[VOID saavn] instance ${base} failed:`, e.message);
    }
  }
  return [];
}

function saavnPickStreamUrl(song) {
  // downloadUrl is an array of { quality, url } sorted low→high
  const urls = song?.downloadUrl;
  if (!urls || !urls.length) throw new Error('No downloadUrl in Saavn result');
  // Prefer 320kbps, fall back to whatever is highest
  const best = [...urls].reverse().find(u => u.url) || urls[urls.length - 1];
  if (!best?.url) throw new Error('No usable stream URL in Saavn result');
  return best.url;
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
// Flow: YouTube title → Deezer (canonical title+artist) → saavn.dev search → stream
// ?id=      YouTube video ID (required)
// ?title=   YouTube video title (required)
// ?artist=  YouTube channel/artist name (optional, improves matching)
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id     || '').trim();
  const title   = String(req.query.title  || '').trim();
  const artist  = String(req.query.artist || '').trim();

  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });
  if (!title)   return res.status(400).json({ error: 'Missing query parameter: title' });

  try {
    // Step 1 — Ask Deezer to resolve a canonical title + artist.
    // If Deezer fails we fall back to the (lightly cleaned) raw YouTube title.
    let cleanTitle  = cleanYouTubeTitle(title);
    let cleanArtist = artist;

    try {
      const deezerResult = await deezerSearch(title, artist);
      if (deezerResult) {
        cleanTitle  = deezerResult.title;
        cleanArtist = deezerResult.artist;
        console.log(`[VOID deezer] resolved: "${cleanTitle}" by "${cleanArtist}"`);
      }
    } catch (e) {
      console.warn('[VOID deezer] lookup failed, using cleaned raw title:', e.message);
    }

    // Step 2 — Search saavn.dev with progressively looser queries.
    let song = null;

    const attempts = [
      // Most specific first
      cleanArtist ? `${cleanTitle} ${cleanArtist}` : null,
      cleanTitle,
      // Raw YouTube title as a last resort (catches non-English titles that
      // survive Deezer poorly, e.g. "Aaj Ki Raat")
      cleanYouTubeTitle(title) !== cleanTitle ? cleanYouTubeTitle(title) : null,
      // First 3 words of the cleaned title
      cleanTitle.split(' ').slice(0, 3).join(' '),
    ].filter(Boolean);

    for (const query of attempts) {
      console.log(`[VOID saavn] trying: "${query}"`);
      try {
        const results = await saavnSearch(query);
        if (results.length) { song = results[0]; break; }
      } catch (e) {
        console.warn(`[VOID saavn] attempt failed for "${query}":`, e.message);
      }
    }

    if (!song) {
      return res.status(404).json({ error: `No Saavn match found for: ${cleanTitle}` });
    }

    // Step 3 — Extract the best stream URL directly from the search result.
    // saavn.dev returns downloadUrl[] in the song object — no second API call needed.
    const streamUrl = saavnPickStreamUrl(song);
    console.log(`[VOID saavn] streaming: "${song.name}" — ${streamUrl.slice(0, 60)}…`);

    // Step 4 — Fetch audio and proxy it to the client.
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
    console.error('[VOID stream] error:', e.message);
    next(e);
  }
};

// ── Saavn search endpoint (used by frontend scan) ─────────────────────────────
exports.saavnSearch = async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });
  try {
    const results = await saavnSearch(q);
    res.json({ data: { results } });
  } catch (e) {
    next(e);
  }
};
