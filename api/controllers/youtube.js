'use strict';

const SAAVN_API = 'https://jiosaavn-api-h375.onrender.com/api';

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

async function saavnFetch(path) {
  const res = await fetch(`${SAAVN_API}${path}`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`JioSaavn API error: ${res.status}`);
  return res.json();
}

function parseSong(song) {
  // Image is an array of quality objects
  const imgArr = Array.isArray(song.image) ? song.image : [];
  const img = imgArr.find(i => i.quality === '500x500')?.url
    || imgArr[imgArr.length - 1]?.url
    || '';

  // Pick best quality download URL
  const dlUrls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
  let audioUrl = '';
  for (const q of ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps']) {
    const entry = dlUrls.find(d => d.quality === q);
    if (entry && entry.url) { audioUrl = entry.url; break; }
  }
  if (!audioUrl && dlUrls.length) audioUrl = dlUrls[dlUrls.length - 1]?.url || '';

  // Artist name — handle both array and string formats
  let artist = '';
  if (song.artists?.primary?.length) {
    artist = song.artists.primary.map(a => a.name).join(', ');
  } else if (typeof song.primaryArtists === 'string') {
    artist = song.primaryArtists;
  }

  return {
    id: song.id,
    videoId: song.id,
    title: song.name || 'Unknown',
    artist,
    album: song.album?.name || '',
    duration: parseInt(song.duration || 0),
    thumbnail: img,
    audioUrl,
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

    const data = await saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`);
    const results = data.data?.results || data.results || [];
    const songs = results.map(parseSong);
    const result = { items: songs, source: 'jiosaavn' };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn search error]', err.message);
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

    const data = await saavnFetch(`/songs?id=${ids}`);
    const results = data.data || data.results || [];
    const songs = (Array.isArray(results) ? results : [results]).map(parseSong);
    cacheSet(cacheKey, { items: songs });
    res.json({ items: songs });
  } catch (err) {
    console.error('[JioSaavn videoDetails error]', err.message);
    next(err);
  }
};

exports.playlistItems = async (req, res, next) => {
  res.status(501).json({ error: 'Playlist import not supported for JioSaavn' });
};

// GET /api/youtube/stream?id=SONG_ID
// Returns { url, mimeType } — client downloads audio directly
exports.streamProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `saavn_url:${songId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/songs?id=${songId}`);
    const results = data.data || data.results || [];
    const arr = Array.isArray(results) ? results : [results];
    const song = parseSong(arr[0] || {});

    if (!song.audioUrl) return res.status(502).json({ error: 'No stream URL found' });

    const result = { url: song.audioUrl, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('[JioSaavn stream error]', e.message);
    next(e);
  }
};

// GET /api/youtube/audio?id=SONG_ID
// Pipes audio through server (for download/cache)
exports.audioProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await saavnFetch(`/songs?id=${songId}`);
    const results = data.data || data.results || [];
    const arr = Array.isArray(results) ? results : [results];
    const song = parseSong(arr[0] || {});

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
    console.error('[JioSaavn audio error]', e.message);
    next(e);
  }
};
