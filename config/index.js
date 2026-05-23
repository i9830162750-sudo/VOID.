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
    apiKey: process.env.VOID_YT_API_KEY || '',
    searchEndpoint:   'https://www.googleapis.com/youtube/v3/search',
    videosEndpoint:   'https://www.googleapis.com/youtube/v3/videos',
    playlistEndpoint: 'https://www.googleapis.com/youtube/v3/playlistItems',

    // Piped instances — server-side only (resolves audio URL, not proxied)
    pipedInstances: (process.env.VOID_PIPED_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_PIPED_INSTANCES || '')
            .split(',').map(s => s.trim()).filter(Boolean)
        : [
            'https://pipedapi.darkness.services',
            'https://pipedapi.reallyaweso.me',
            'https://pipedapi.aeong.one',
            'https://pipedapi.syncpundit.io',
            'https://api.piped.yt',
            'https://pipedapi.tokhmi.xyz',
            'https://pipedapi.moomoo.me',
            'https://piped-api.cfe.re',
          ],

    // Invidious instances — server-side only (stream URL fallback)
    invidiousInstances: (process.env.VOID_INVIDIOUS_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_INVIDIOUS_INSTANCES || '')
            .split(',').map(s => s.trim()).filter(Boolean)
        : [
            'https://invidious.materialio.us',
            'https://invidious.privacyredirect.com',
            'https://invidious.dhusch.de',
            'https://invidious.perennialte.ch',
            'https://yt.drgnz.club',
            'https://invidious.asir.dev',
            'https://iv.nboeck.de',
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
