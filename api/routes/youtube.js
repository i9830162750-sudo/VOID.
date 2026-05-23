'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/youtube');

// ─────────────────────────────────────────────
// YouTube search
// GET /api/youtube/search?q=
// ─────────────────────────────────────────────
router.get(
  '/search',
  controller.search
);

// ─────────────────────────────────────────────
// YouTube video metadata
// GET /api/youtube/videos?ids=
// ─────────────────────────────────────────────
router.get(
  '/videos',
  controller.videoDetails
);

// ─────────────────────────────────────────────
// Playlist fetch
// GET /api/youtube/playlist?id=
// ─────────────────────────────────────────────
router.get(
  '/playlist',
  controller.playlistItems
);

// ─────────────────────────────────────────────
// Stream proxy
// GET /api/youtube/stream?id=&title=&artist=
// ─────────────────────────────────────────────
router.get(
  '/stream',
  controller.streamProxy
);

// ─────────────────────────────────────────────
// Saavn search helper
// GET /api/youtube/saavn/search?q=
// ─────────────────────────────────────────────
router.get(
  '/saavn/search',
  controller.saavnSearch
);

module.exports = router;
