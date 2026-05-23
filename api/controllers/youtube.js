/**
 * api/controllers/youtube.js
 * Server-side proxy for YouTube (search/metadata) + yt-dlp (streaming).
 *
 * Stream flow:
 *   1. yt-dlp resolves a direct googlevideo.com audio URL using cookies
 *   2. Return { url, mimeType } JSON to the client
 *   3. Browser fetches audio directly from googlevideo.com CDN
 */

'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
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

// ── yt-dlp audio URL resolver ─────────────────────────────────────────────────
// Uses cookies from VOID_YT_COOKIE env var (raw Netscape cookies.txt format).
// yt-dlp only resolves the URL — it never downloads audio bytes.
async function ytdlpGetAudioUrl(videoId) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const bin   = '/opt/render/project/src/.venv/bin/yt-dlp';

  // Write cookies to a temp file from the VOID_YT_COOKIE env var
  let cookiesFile = null;
  const cookieData = process.env.VOID_YT_COOKIE;
  if (cookieData) {
    try {
      cookiesFile = path.join(os.tmpdir(), `yt-cookies-${Date.now()}.txt`);
      fs.writeFileSync(cookiesFile, cookieData, 'utf8');
      console.log('[VOID yt-dlp] cookies written to temp file');
    } catch (e) {
      console.warn('[VOID yt-dlp] failed to write cookies:', e.message);
      cookiesFile = null;
    }
  } else {
    console.warn('[VOID yt-dlp] VOID_YT_COOKIE not set — attempting without cookies');
  }

  const args = [
    '--no-warnings',
    '--quiet',
    '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio[ext=opus]/bestaudio/best',
    '--get-url',
  ];
  
  if (cookiesFile) args.push('--cookies', cookiesFile);
  args.push(ytUrl);

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 25000 });
    if (stderr) console.warn('[VOID yt-dlp] stderr:', stderr.slice(0, 200));

    const audioUrl = stdout.trim().split('\n')[0];
    if (!audioUrl || !audioUrl.startsWith('http')) throw new Error('Empty URL returned');

    console.log(`[VOID yt-dlp] resolved: ${audioUrl.slice(0, 80)}…`);
    return { url: audioUrl, mimeType: 'audio/webm' };
  } catch (e) {
    console.error('[VOID yt-dlp] failed:', e.message.slice(0, 300));
    return null;
  } finally {
    if (cookiesFile) try { fs.unlinkSync(cookiesFile); } catch {}
  }
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
// Returns { url, mimeType } — browser fetches audio from CDN directly.
exports.streamProxy = async (req, res, next) => {
  const videoId = String(req.query.id || '').trim();
  if (!videoId) return res.status(400).json({ error: 'Missing query parameter: id' });

  console.log(`[VOID stream] resolving: ${videoId}`);

  try {
    const resolved = await ytdlpGetAudioUrl(videoId);

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
