/**
 * api/routes/auth.js
 * Google OAuth 2.0 authentication routes.
 *
 * Flow:
 *   1. User clicks "Sign in with Google" → GET /api/auth/google
 *   2. Google redirects to /api/auth/google/callback with code
 *   3. Passport exchanges code for tokens, stores user in session
 *   4. We redirect the browser back to the app (/)
 *
 * Session: express-session (in-memory store in dev; use Redis/DB in prod)
 */

'use strict';

const express  = require('express');
const passport = require('passport');
const router   = express.Router();

// ── Initiate OAuth flow ───────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', {
    scope: [
      'profile',
      'email',
      'https://www.googleapis.com/auth/drive.file', // only files created by this app
    ],
    accessType: 'offline',   // get refresh token
    prompt: 'consent',       // always show consent to ensure refresh_token is issued
  })
);

// ── OAuth callback ────────────────────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=error' }),
  (req, res) => {
    // Successful auth — redirect back to app
    res.redirect('/?auth=success');
  }
);

// ── Get current user (called by frontend on load) ─────────────────────────
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ user: null });
  res.json({
    user: {
      id:          req.user.id,
      displayName: req.user.displayName,
      email:       req.user.email,
      photo:       req.user.photo,
    },
  });
});

// ── Logout ────────────────────────────────────────────────────────────────
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

module.exports = router;

// ── Proxy Google profile photo (avoids CSP/SW issues with googleusercontent.com) ──
router.get('/photo', async (req, res) => {
  if (!req.isAuthenticated() || !req.user.photo) {
    return res.status(404).end();
  }
  try {
    const response = await fetch(req.user.photo);
    if (!response.ok) return res.status(502).end();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = await response.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch(e) {
    res.status(502).end();
  }
});
