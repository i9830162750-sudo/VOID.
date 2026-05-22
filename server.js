/**
 * server.js
 * VOID Player — Express server entry point.
 *
 * Responsibilities:
 *   • Serve the static PWA shell (public/)
 *   • Mount the /api/* routes
 *   • SPA fallback so browser refreshes never 404
 *   • Production-ready middleware (helmet, compression, rate-limiting)
 */

'use strict';

// Load .env in development (Render injects env vars directly in production)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const path        = require('path');
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');

const config  = require('./config');
const apiRouter = require('./api');

const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],   // inline JS in index.html
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
        imgSrc:      ["'self'", 'data:', 'https://*.ytimg.com', 'https://*.ggpht.com'],
        connectSrc:  ["'self'", 'https://www.googleapis.com', 'https://*.youtube.com'],
        mediaSrc:    ["'self'", 'blob:', 'https://*.googlevideo.com'],
        workerSrc:   ["'self'"],
        manifestSrc: ["'self'"],

      },
    },
  })
);

// ── Compression ─────────────────────────────────────────────────────────────
app.use(compression());

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.cors.allowedOrigins.includes('*')
      ? '*'
      : config.cors.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Rate limiting (API only) ─────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Static files (PWA shell) ─────────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge:  config.isDev ? '0' : '1d',
    etag:    true,
    // Explicitly do NOT cache service worker so updates propagate
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

// ── SPA fallback — send index.html for any unmatched GET ─────────────────────
// This ensures browser refreshes on deep paths never 404 on Render.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = config.isDev ? err.message : 'Internal server error';
  if (status >= 500) console.error('[VOID] Server error:', err);
  res.status(status).json({ error: message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`[VOID] Server running on port ${config.port} (${config.env})`);
  if (config.isDev) {
    console.log(`[VOID] http://localhost:${config.port}`);
  }
  if (!config.youtube.apiKey) {
    console.warn('[VOID] Warning: VOID_YT_API_KEY not set — YouTube API proxy will use Invidious fallback');
  }
});

module.exports = app; // exported for future testing
