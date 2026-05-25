'use strict';

const SC_API = 'https://void-soundcloud-service.onrender.com';

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

async function scFetch(path) {
  const res = await fetch(`${SC_API}${path}`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`SoundCloud service error: ${res.status}`);
  return res.json();
}

function parseSCTrack(track) {
  return {
    id:        track.id,
    videoId:   String(track.id),
    title:     track.title   || track.name || 'Unknown',
    artist:    track.artist  || track.user?.username || '',
    album:     track.album   || '',
    duration:  Math.round((track.duration || 0) / 1000), // SC returns ms
    thumbnail: track.artwork_url || track.thumbnail || '',
    audioUrl:  track.stream_url  || track.audioUrl  || '',
    source:    'soundcloud',
  };
}

// ── Exported controller functions ─────────────────────────────────────────────

exports.search = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const cacheKey = `sc_search:${q}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    const data = await scFetch(`/search?q=${encodeURIComponent(q)}&limit=15`);
    const results = data.items || data.results || data.tracks || data || [];
    const songs = (Array.isArray(results) ? results : []).map(parseSCTrack);
    const result = { items: songs, source: 'soundcloud' };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[SoundCloud search error]', err.message);
    next(err);
  }
};

exports.streamProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `sc_url:${trackId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await scFetch(`/stream?id=${trackId}`);
    const url = data.url || data.stream_url || data.audioUrl || '';
    if (!url) return res.status(502).json({ error: 'No stream URL found' });

    const result = { url, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('[SoundCloud stream error]', e.message);
    next(e);
  }
};

exports.audioProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await scFetch(`/stream?id=${trackId}`);
    const url = data.url || data.stream_url || data.audioUrl || '';
    if (!url) return res.status(502).send('No audio URL');

    const audioRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!audioRes.ok) return res.status(502).send('Upstream failed');

    res.setHeader('Content-Type', 'audio/mpeg');
    const contentLength = audioRes.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const buf = await audioRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[SoundCloud audio error]', e.message);
    next(e);
  }
};
