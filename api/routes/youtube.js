/**
 * api/routes/youtube.js
 * YouTube proxy route definitions.
 *
 * All routes:
 *   GET /api/youtube/search?q=&type=&max=
 *   GET /api/youtube/videos?ids=
 *   GET /api/youtube/playlist?id=
 */

'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/youtube');

// Search videos or playlists
// ?q=     — search query (required)
// ?type=  — 'video' | 'playlist' (default: 'video')
// ?max=   — max results, 1-50 (default: 15)
router.get('/search', controller.search);

// Video content details (duration, etc.)
// ?ids= — comma-separated YouTube video IDs
router.get('/videos', controller.videoDetails);

// Playlist items
// ?id= — YouTube playlist ID
router.get('/playlist', controller.playlistItems);

module.exports = router;
