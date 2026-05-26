/**
 * server.js
 * VOID Player — Express server entry point.
 *
 * v6.1 additions:
 *   • express-session + passport for Google OAuth
 *   • /api/auth/* — OAuth flow
 *   • /api/drive/* — Google Drive sync (library JSON + audio files)
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
const session     = require('express-session');
const passport    = require('./api/passport');

const config    = require('./config');
const apiRouter = require('./api');

const app = express();
app.set('trust proxy', 1);

// ── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
          'https://accounts.google.com',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com',
        ],
        imgSrc: [
          "'self'",
          'data:',
          'https://*.ytimg.com',
          'https://*.ggpht.com',
          'https://*.saavncdn.com',
          'https://*.jiosaavn.com',
          'https://*.sndcdn.com',
          'https://lh3.googleusercontent.com', // Google profile photos
          'https://*.googleusercontent.com',
        ],
        connectSrc: [
          "'self'",
          'https://cdnjs.cloudflare.com',
          'https://*.saavncdn.com',
          'https://*.sndcdn.com',
          'https://accounts.google.com',
          'https://oauth2.googleapis.com',
          'https://www.googleapis.com',
        ],
        mediaSrc: [
          "'self'",
          'blob:',
          'https://*.saavncdn.com',
          'https://cf-media.sndcdn.com',
          'https://cf-preview-media.sndcdn.com',
        ],
        frameSrc: [
          'https://accounts.google.com',
        ],
        workerSrc: ["'self'"],
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
    credentials: true,
  })
);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Sessions (required for Passport) ─────────────────────────────────────────
app.use(
  session({
    secret:            config.session.secret,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   !config.isDev, // HTTPS only in production
      httpOnly: true,
      maxAge:   config.session.maxAge,
      sameSite: 'lax',
    },
  })
);

// ── Passport ─────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

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
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

// ── SPA fallback ─────────────────────────────────────────────────────────────
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
  if (config.isDev) console.log(`[VOID] http://localhost:${config.port}`);
  if (!config.youtube.apiKey) {
    console.warn('[VOID] Warning: VOID_YT_API_KEY not set — YouTube API proxy will use Invidious fallback');
  }
  if (!config.google.clientId) {
    console.warn('[VOID] Warning: GOOGLE_CLIENT_ID not set — Google OAuth/Drive sync disabled');
  }
});

module.exports = app;
