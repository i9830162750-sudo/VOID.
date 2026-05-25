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

const SAAVN_API = 'https://jiosaavn-api-h375.onrender.com/api';

async function saavnFetch(path) {
  const res = await fetch(`${SAAVN_API}${path}`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`JioSaavn API error: ${res.status}`);
  return res.json();
}

function parseSong(song) {
  const img = (song.image || '').replace('150x150', '500x500');
  // Pick best quality download URL
  const dlUrls = song.downloadUrl || [];
  let audioUrl = '';
  for (const q of ['320kbps', '160kbps', '96kbps']) {
    const entry = dlUrls.find(d => d.quality === q);
    if (entry && entry.url) { audioUrl = entry.url; break; }
  }
  if (!audioUrl && dlUrls.length) audioUrl = dlUrls[dlUrls.length - 1]?.url || '';

  return {
    id: song.id,
    videoId: song.id,          // reuse videoId field so frontend works as-is
    title: song.name || 'Unknown',
    artist: (song.primaryArtists || song.artists?.primary?.map(a=>a.name).join(', ') || ''),
    album: song.album?.name || '',
    duration: parseInt(song.duration || 0),
    thumbnail: img,
    audioUrl,                  // direct 320kbps mp3 URL
    source: 'jiosaavn',
  };
}

// ── Exported controller functions ─────────────────────────────────────────────

exports.search = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const cacheKey = `saavn_search:${q}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    const data = await saavnFetch(`/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`);
    const songs = (data.data?.results || []).map(parseSong);
    const result = { items: songs, source: 'jiosaavn' };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.videoDetails = async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').trim();
    if (!ids) return res.status(400).json({ error: 'Missing query parameter: ids' });

    const cacheKey = `saavn_song:${ids}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/api/songs/${ids}`);
    const songs = (data.data || []).map(parseSong);
    cacheSet(cacheKey, { items: songs });
    res.json({ items: songs });
  } catch (err) {
    next(err);
  }
};

exports.playlistItems = async (req, res, next) => {
  res.status(501).json({ error: 'Playlist import not supported for JioSaavn yet' });
};

// GET /api/youtube/stream?id=SONG_ID
// Returns { url, mimeType } — client sets audioEl.src directly (no blob download needed)
exports.streamProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `saavn_url:${songId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/api/songs/${songId}`);
    const song = parseSong((data.data || [])[0] || {});
    if (!song.audioUrl) return res.status(502).json({ error: 'No stream URL found' });

    const result = { url: song.audioUrl, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    next(e);
  }
};

// GET /api/youtube/audio?id=SONG_ID
// Pipes the audio through the server (for download/cache)
exports.audioProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await saavnFetch(`/api/songs/${songId}`);
    const song = parseSong((data.data || [])[0] || {});
    if (!song.audioUrl) return res.status(502).send('No audio URL');

    const audioRes = await fetch(song.audioUrl, { signal: AbortSignal.timeout(60000) });
    if (!audioRes.ok) return res.status(502).send('Upstream failed');

    res.setHeader('Content-Type', 'audio/mpeg');
    const contentLength = audioRes.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const buf = await audioRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    next(e);
  }
};
