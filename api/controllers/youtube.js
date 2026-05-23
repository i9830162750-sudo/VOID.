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

// ── JioSaavn helpers ──────────────────────────────────────────────────────────
const SAAVN_BASE = 'https://saavn.me';

async function saavnSearchByTitle(title) {
  // Clean the title — strip common YouTube suffixes that confuse Saavn
  const cleaned = title
    .replace(/\(.*?\)/g, '')           // remove (Official Video) etc
    .replace(/\[.*?\]/g, '')           // remove [HD] etc
    .replace(/\|.*/g, '')              // remove | HD Video | ...
    .replace(/official\s*(video|audio|music|lyric[s]?)/gi, '')
    .replace(/lyrics?/gi, '')
    .replace(/hd|4k|full\s*video/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  console.log(`[VOID saavn] searching: "${cleaned}" (original: "${title}")`);

  const resp = await fetch(
    `${SAAVN_BASE}/api/search/songs?query=${encodeURIComponent(cleaned)}&page=1&limit=5`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!resp.ok) throw new Error(`Saavn search failed: ${resp.status}`);
  const data = await resp.json();
  return data?.data?.results || [];
}

async function saavnGetStreamUrl(songId) {
  const resp = await fetch(
    `${SAAVN_BASE}/api/songs/${songId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!resp.ok) throw new Error(`Saavn song fetch failed: ${resp.status}`);
  const data = await resp.json();
  const song = data?.data?.[0];
  if (!song) throw new Error('Song not found in Saavn response');

  const urls = song.downloadUrl || [];
  const best =
    urls.find(u => u.quality === '320kbps') ||
    urls.find(u => u.quality === '160kbps') ||
    urls[urls.length - 1];

  if (!best?.url) throw new Error('No download URL in Saavn response');
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

// ── Stream proxy — searches JioSaavn by YouTube title, streams audio ──────────
// ?id=       YouTube video ID
// ?title=    YouTube video title (used to match on Saavn)
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id    || '').trim();
  const title   = String(req.query.title || '').trim();

  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });
  if (!title)   return res.status(400).json({ error: 'Missing query parameter: title' });

  try {
    const results = await saavnSearchByTitle(title);
    if (!results.length) {
      return res.status(404).json({ error: `No Saavn match found for: ${title}` });
    }

    const songId = results[0].id;
    const streamUrl = await saavnGetStreamUrl(songId);

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
    const results = await saavnSearchByTitle(q);
    res.json({ data: { results } });
  } catch (e) {
    next(e);
  }
};
