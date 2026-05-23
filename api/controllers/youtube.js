/**
 * api/controllers/youtube.js
 * Server-side proxy for YouTube (search/metadata) + Piped/Invidious (streaming).
 *
 * Endpoints:
 *   search(q, type, maxResults)  → /api/youtube/search
 *   videoDetails(ids)             → /api/youtube/videos
 *   playlistItems(playlistId)     → /api/youtube/playlist
 *   streamProxy(id)               → /api/youtube/stream
 *
 * Stream flow:
 *   1. Try each Piped instance → /streams/:videoId → audioStreams[]
 *   2. Fall back to each Invidious instance → /api/v1/videos/:id → adaptiveFormats[]
 *   3. Return { url, mimeType } JSON to the client — NO audio bytes proxied
 *   4. Browser fetches audio directly from the resolved URL
 *
 * Why browser-direct?
 *   Piped/Invidious instances block requests from datacenter IPs (AWS/Render).
 *   The browser is on a residential IP and is not blocked.
 *   Server only does the cheap metadata lookup; browser does the heavy fetch.
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

// ── Invidious fallback for search / playlist ──────────────────────────────────
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
// GET /streams/:videoId → { audioStreams: [{ url, quality, mimeType }] }
// Returns the best quality audio URL, or null if all instances fail.
async function pipedGetAudioUrl(videoId) {
  const instances = config.youtube.pipedInstances;

  for (const instance of instances) {
    try {
      const data = await apiFetch(`${instance}/streams/${videoId}`, { timeout: 10000 });

      const streams = data?.audioStreams;
      if (!streams || !streams.length) continue;

      // Sort by bitrate descending — quality field is e.g. "128kbps"
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
  return null;
}

// ── Invidious stream resolver (fallback) ──────────────────────────────────────
// GET /api/v1/videos/:id?fields=adaptiveFormats → audio-only formats
// Returns the best quality audio URL, or null if all instances fail.
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

      // Audio-only: has audio mime type and no video resolution
      const audioOnly = formats.filter(f =>
        f.type && f.type.startsWith('audio/') && !f.resolution
      );
      if (!audioOnly.length) continue;

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

// ── Cobalt.tools audio resolver ───────────────────────────────────────────────
// cobalt is a free, open source media downloader with a public API.
// Docs: https://github.com/imputnet/cobalt
async function cobaltGetAudioUrl(videoId) {
  const endpoints = [
    'https://api.cobalt.tools',
    'https://cobalt.tools',
  ];

  const body = JSON.stringify({
    url: `https://www.youtube.com/watch?v=${videoId}`,
    downloadMode: 'audio',
    audioFormat: 'mp3',
    audioBitrate: '128',
    disableMetadata: true,
  });

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(`${endpoint}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        console.warn(`[VOID cobalt] ${endpoint} → ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      console.log(`[VOID cobalt] ${endpoint} → status: ${data.status}`);

      if ((data.status === 'tunnel' || data.status === 'redirect') && data.url) {
        return { url: data.url, mimeType: 'audio/mpeg' };
      }

      console.warn(`[VOID cobalt] ${endpoint} rejected:`, data?.error?.code || data.status);
    } catch (e) {
      console.warn(`[VOID cobalt] ${endpoint} failed:`, e.message);
    }
  }
  return null;
}

// ── Stream proxy ──────────────────────────────────────────────────────────────
// GET /api/youtube/stream?id=VIDEO_ID
// Returns { url, mimeType } — browser fetches audio from the URL directly.
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id || '').trim();
  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });

  console.log(`[VOID stream] resolving: ${videoId}`);

  try {
    const resolved = await cobaltGetAudioUrl(videoId);

    if (!resolved) {
      return res.status(502).json({
        error: 'Could not resolve audio stream. Try again in a moment.',
      });
    }

    res.json({ url: resolved.url, mimeType: resolved.mimeType });

  } catch (e) {
    console.error('[VOID stream] error:', e.message);
    if (!res.headersSent) next(e);
  }
};
