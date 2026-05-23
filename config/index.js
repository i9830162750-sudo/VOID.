/**
 * config/index.js
 * Central configuration — reads from environment variables.
 * All runtime config flows through here; never read process.env directly in routes.
 */
'use strict';

module.exports = {
  // ── Server ────────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT, 10) || 3000,
  env:  process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

 // ── YouTube ───────────────────────────────────────────────────────────────
  youtube: {
    // Server-side API key — never exposed to the client
    apiKey: process.env.VOID_YT_API_KEY || '',
    searchEndpoint:   'https://www.googleapis.com/youtube/v3/search',
    videosEndpoint:   'https://www.googleapis.com/youtube/v3/videos',
    playlistEndpoint: 'https://www.googleapis.com/youtube/v3/playlistItems',

    // ── Piped instances (primary stream source) ────────────────────────────
    // GET /streams/:videoId → { audioStreams: [{ url, quality, mimeType }] }
    // Override via VOID_PIPED_INSTANCES env var (comma-separated).
    pipedInstances: (process.env.VOID_PIPED_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_PIPED_INSTANCES || '')
            .split(',').map(s => s.trim()).filter(Boolean)
        : [
            'https://pipedapi.kavin.rocks',
            'https://pipedapi.adminforge.de',
            'https://piped-api.garudalinux.org',
            'https://pipedapi.drgns.space',
            'https://pipedapi.coldacid.net',
            'https://piped.lunar.icu/api',
          ],

    // ── Invidious instances (search fallback + stream double-fallback) ─────
    // Override via VOID_INVIDIOUS_INSTANCES env var (comma-separated).
    invidiousInstances: (process.env.VOID_INVIDIOUS_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_INVIDIOUS_INSTANCES || '')
            .split(',').map(s => s.trim()).filter(Boolean)
        : [
            'https://invidious.io.lol',
            'https://invidious.fdn.fr',
            'https://invidious.nerdvpn.de',
            'https://inv.tux.pizza',
            'https://yewtu.be',
            'https://invidious.privacydev.net',
          ],
  },

  // ── CORS ──────────────────────────────────────────────────────────────────
  cors: {
    // In prod, restrict to your actual domain(s)
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : ['*'],
  },

  // ── Rate limiting ─────────────────────────────────────────────────────────
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,                  // requests per window
  },

  // ── Future: Database ─────────────────────────────────────────────────────
  // db: {
  //   url: process.env.DATABASE_URL,
  // },

  // ── Future: Auth / Sessions ───────────────────────────────────────────────
  // auth: {
  //   sessionSecret: process.env.SESSION_SECRET,
  //   jwtSecret:     process.env.JWT_SECRET,
  //   tokenExpiry:   '7d',
  // },
};
