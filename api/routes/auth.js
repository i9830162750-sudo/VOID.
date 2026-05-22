/**
 * api/routes/auth.js  [STUB — NOT ACTIVE]
 *
 * Future account system scaffolding.
 * This file documents the intended API surface.
 * Wire it into api/index.js when ready to implement.
 *
 * Planned endpoints:
 *   POST /api/auth/register   — create account (email + password)
 *   POST /api/auth/login      — returns JWT access token + refresh token
 *   POST /api/auth/refresh    — exchange refresh token for new access token
 *   POST /api/auth/logout     — invalidate refresh token
 *   GET  /api/auth/me         — returns current user from token
 *
 * Architecture notes:
 *   • Use bcrypt for password hashing (never store plaintext)
 *   • Short-lived JWT access tokens (15min) + long-lived refresh tokens (7d)
 *   • Refresh tokens stored in DB and invalidated on logout
 *   • requireAuth middleware (see api/middleware/auth.js) protects all
 *     routes that need a logged-in user
 */

'use strict';

// const express    = require('express');
// const router     = express.Router();
// const controller = require('../controllers/auth');

// router.post('/register', controller.register);
// router.post('/login',    controller.login);
// router.post('/refresh',  controller.refresh);
// router.post('/logout',   controller.logout);
// router.get('/me',        requireAuth, controller.me);

// module.exports = router;
