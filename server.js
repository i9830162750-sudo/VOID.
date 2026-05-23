/**
 * server.js
 * VOID Player — Express server entry point.
 */

'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const path        = require('path');
const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');

const config    = require('./config');
const apiRouter = require('./api');

const app = express();

// ── Trust proxy (required on Render / behind a load balancer) ────────────────
// Fixes ERR_ERL_UNEXPECTED_X_FORWARDED_FOR from express-rate-limit.
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"],
        styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
        imgSrc:        ["'self'", 'data:', 'https://*.ytimg.com', 'https://*.ggpht.com'],
        connectSrc:    [
          "'self'",
          'https://www.googleapis.com',
          'https://*.youtube.com',
          'https://saavn.dev',
          'https://api.deezer.com',
          'blob:',
        ],
        mediaSrc:      ["'self'", 'blob:', 'https://*.saavn.dev', 'https://*.jiosaavn.com'],
        workerSrc:     ["'self'"],
        manifestSrc:   ["'self'"],
      },
    },
  })
);

// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.cors.allowedOrigins.includes('*')
      ? '*'
      : config.cors.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Rate limiting (API only) ──────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', limiter);

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Static files (PWA shell) ──────────────────────────────────────────────────
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isDev ? '0' : '1d',
    etag:   true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status  = err.status || err.statusCode || 500;
  const message = config.isDev ? err.message : 'Internal server error';
  if (status >= 500) console.error('[VOID] Server error:', err);
  res.status(status).json({ error: message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`[VOID] Server running on port ${config.port} (${config.env})`);
  if (config.isDev) console.log(`[VOID] http://localhost:${config.port}`);
  if (!config.youtube.apiKey) {
    console.warn('[VOID] Warning: VOID_YT_API_KEY not set — using Invidious fallback');
  }
});

module.exports = app;
