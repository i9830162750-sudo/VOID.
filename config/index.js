/**
 * config/index.js
 * Central configuration — reads from environment variables.
 */
'use strict';

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env:  process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // ── YouTube ───────────────────────────────────────────────────────────────
  youtube: {
    apiKey: process.env.VOID_YT_API_KEY || '',
    searchEndpoint:   'https://www.googleapis.com/youtube/v3/search',
    videosEndpoint:   'https://www.googleapis.com/youtube/v3/videos',
    playlistEndpoint: 'https://www.googleapis.com/youtube/v3/playlistItems',
    pipedInstances: (process.env.VOID_PIPED_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_PIPED_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean)
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
    invidiousInstances: (process.env.VOID_INVIDIOUS_INSTANCES || '')
      .split(',').map(s => s.trim()).filter(Boolean).length
        ? (process.env.VOID_INVIDIOUS_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean)
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

  // ── Google OAuth + Drive ──────────────────────────────────────────────────
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID     || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // In prod this should be your Render URL; in dev it's localhost
    callbackUrl:  process.env.GOOGLE_CALLBACK_URL  || 'http://localhost:3000/api/auth/google/callback',
    // Drive folder name where VOID stores user files
    driveFolderName: 'VOID Player',
  },

  // ── Sessions ──────────────────────────────────────────────────────────────
  session: {
    secret:  process.env.SESSION_SECRET || 'void-dev-secret-change-in-prod',
    maxAge:  30 * 24 * 60 * 60 * 1000, // 30 days
  },

  // ── CORS ──────────────────────────────────────────────────────────────────
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
      : ['*'],
  },

  // ── Rate limiting ─────────────────────────────────────────────────────────
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 200,
  },
};
