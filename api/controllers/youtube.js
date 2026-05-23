/**
 * api/controllers/youtube.js
 * Server-side proxy for YouTube (search/metadata) + Piped/Invidious (streaming).
 *
 * Endpoints:
 *   search(q, type, maxResults)  → /api/youtube/search
 *   videoDetails(ids)             → /api/youtube/videos
 *   playlistItems(playlistId)     → /api/youtube/playlist
 *   streamProxy(id)               → /api/youtube/stream  (Piped audio)
 *
 * Stream flow:
 *   1. Try each configured Piped instance in order for /streams/:videoId
 *   2. Piped returns audioStreams[] — pick the best quality URL
 *   3. Proxy the audio bytes back to the client with correct headers
 *   4. If ALL Piped instances fail, fall back to Invidious /api/v1/videos/:id
 *      which also exposes adaptive_formats[] with audio-only streams
 *
 * No Deezer. No JioSaavn. No metadata translation pipeline.
 */

'use strict';

const config = require('../../config');

// ── Tiny in-memory cache ──────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeout || 8000),
    headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Upstream ${res.status}: ${url}`), {
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

// ── Invidious fallback for search/playlist ────────────────────────────────────
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
  throw new Error('All Invidious search instances failed');
}

// ── Piped stream resolver ─────────────────────────────────────────────────────
// Piped /streams/:id returns { audioStreams: [{ url, quality, mimeType }] }
// We pick the highest-quality audio-only stream.
async function pipedGetAudioUrl(videoId) {
  const instances = config.youtube.pipedInstances;

  for (const instance of instances) {
    try {
      const data = await apiFetch(`${instance}/streams/${videoId}`, { timeout: 10000 });

      const streams = data?.audioStreams;
      if (!streams || !streams.length) continue;

      // Sort by bitrate descending (quality field is a string like "48kbps")
      const sorted = [...streams].sort((a, b) => {
        const bpsA = parseInt(a.quality) || 0;
        const bpsB = parseInt(b.quality) || 0;
        return bpsB - bpsA;
      });

      const best = sorted[0];
      if (!best?.url) continue;

      console.log(`[VOID piped] ${instance} → ${best.quality} (${best.mimeType || 'audio'})`);
      return { url: best.url, mimeType: best.mimeType || 'audio/webm' };
    } catch (e) {
      console.warn(`[VOID piped] ${instance} failed:`, e.message);
    }
  }
  return null; // all Piped instances exhausted
}

// ── Invidious stream resolver (fallback) ──────────────────────────────────────
// Invidious /api/v1/videos/:id exposes adaptiveFormats[] with audio-only entries.
async function invidiousGetAudioUrl(videoId) {
  const instances = config.youtube.invidiousInstances;

  for (const instance of instances) {
    try {
      const data = await apiFetch(
        `${instance}/api/v1/videos/${videoId}?fields=adaptiveFormats`,
        { timeout: 10000 }
      );

      const formats = data?.adaptiveFormats;
      if (!formats || !formats.length) continue;

      // Keep only audio-only formats (no video resolution)
      const audioOnly = formats.filter(f =>
        f.type && f.type.startsWith('audio/') && !f.resolution
      );

      if (!audioOnly.length) continue;

      // Pick highest bitrate
      const best = audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best?.url) continue;

      console.log(`[VOID invidious] ${instance} → ${best.bitrate}bps (${best.type})`);
      return { url: best.url, mimeType: best.type.split(';')[0] || 'audio/webm' };
    } catch (e) {
      console.warn(`[VOID invidious-stream] ${instance} failed:`, e.message);
    }
  }
  return null;
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
// GET /api/youtube/stream?id=VIDEO_ID
//
// Flow:
//   1. Try all Piped instances → audioStreams[]
//   2. Fall back to all Invidious instances → adaptiveFormats[] (audio-only)
//   3. If both chains fail → 502
//   4. Proxy the audio bytes to the client (supports Range for seek)
//
// The client (ytFetchBlob) downloads the whole buffer and stores it in
// IndexedDB — so this endpoint is called once per track, not on every seek.
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id || '').trim();
  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });

  console.log(`[VOID stream] resolving: ${videoId}`);

  try {
    // ── Step 1: Resolve an audio URL ─────────────────────────────────────────
    let resolved = await pipedGetAudioUrl(videoId);

    if (!resolved) {
      console.warn(`[VOID stream] Piped exhausted, trying Invidious for ${videoId}`);
      resolved = await invidiousGetAudioUrl(videoId);
    }

    if (!resolved) {
      return res.status(502).json({
        error: 'All stream sources failed. Try again in a moment.',
      });
    }

    const { url: audioUrl, mimeType } = resolved;

    // ── Step 2: Proxy the audio bytes ─────────────────────────────────────────
    // Forward any Range header the client sends (rare here since the frontend
    // does a full download, but correct to forward it).
    const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;

    const audioResp = await fetch(audioUrl, {
      signal: AbortSignal.timeout(90000),
      headers: upstreamHeaders,
    });

    if (!audioResp.ok && audioResp.status !== 206) {
      return res.status(502).json({
        error: `Upstream audio fetch failed: ${audioResp.status}`,
      });
    }

    // Mirror status + key headers from upstream
    res.status(audioResp.status);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');

    const contentLength = audioResp.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = audioResp.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    // Stream the body — don't buffer the whole file in memory
    const reader = audioResp.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const ok = res.write(value);
        // Respect backpressure
        if (!ok) await new Promise(r => res.once('drain', r));
      }
    };
    req.on('close', () => reader.cancel().catch(() => {}));
    await pump();

  } catch (e) {
    console.error('[VOID stream] error:', e.message);
    if (!res.headersSent) next(e);
  }
};
