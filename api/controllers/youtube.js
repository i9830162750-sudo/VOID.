/**
 * api/controllers/youtube.js
 * Server-side YouTube Data API v3 proxy.
 *
 * Why a proxy?
 *   • Keeps the API key off the client (no more hardcoded key in index.html).
 *   • Allows rate-limiting, caching, and key rotation in one place.
 *   • Makes it trivial to swap YouTube API for a different provider later.
 *
 * Current endpoints:
 *   search(q, type, maxResults)        → /api/youtube/search
 *   videoDetails(ids)                   → /api/youtube/videos
 *   playlistItems(playlistId)           → /api/youtube/playlist
 *
 * Fallback: if VOID_YT_API_KEY is not configured, requests are forwarded
 * to the Invidious public API (same behaviour as the current frontend).
 */

'use strict';

const config = require('../../config');

// ── Tiny in-memory cache (reduces API quota usage) ───────────────────────────
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

// ── Shared fetch helper ────────────────────────────────────────────────────
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
  if (!key) return null; // signal caller to use Invidious

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

// ── Invidious fallback helpers ────────────────────────────────────────────────
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

    // Try YouTube API first; fall back to Invidious
    let data;
    try {
      data = await ytSearch(q, type, maxResults);
      if (!data) data = await invidiousSearch(q, type); // no API key configured
    } catch (err) {
      // YouTube API failed — try Invidious
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
        // No API key — try Invidious playlist endpoint
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

const youtubedl = require('youtube-dl-exec');

exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id || '').trim();
  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });

  try {
    const ytdl = require('@distube/ytdl-core');

    if (!ytdl.validateID(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' });
    }

    const info = await ytdl.getInfo(videoId);

    const format = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly',
    });

    if (!format) {
      return res.status(502).json({ error: 'No audio format found' });
    }

    const mimeType = format.mimeType?.split(';')[0] || 'audio/webm';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'no-store');

    ytdl(videoId, { format }).pipe(res);

  } catch (e) {
    console.error('[VOID stream] ytdl error:', e.message);
    next(e);
  }
};
