/**
 * api/index.js
 * Root API router — mounts all sub-routers under /api/*
 *
 * Current routes:
 *   /api/health          — liveness probe (Render, uptime monitors)
 *   /api/youtube/*       — server-side YouTube proxy
 *
 * Future routes (stubs already wired, implementation deferred):
 *   /api/auth/*          — login, signup, token refresh
 *   /api/users/*         — user profile, preferences
 *   /api/sync/*          — cloud sync for playlists / library
 */

'use strict';

const express = require('express');
const router  = express.Router();

// ── Active routes ────────────────────────────────────────────────────────────
router.use('/health',  require('./routes/health'));
router.use('/youtube', require('./routes/youtube'));

// ── Future routes (pre-wired, returns 501 until implemented) ─────────────────
const notImplemented = (label) => (_req, res) =>
  res.status(501).json({ error: `${label} not yet implemented` });

router.use('/auth',  notImplemented('Auth'));
router.use('/users', notImplemented('Users'));
router.use('/sync',  notImplemented('Sync'));

module.exports = router;
