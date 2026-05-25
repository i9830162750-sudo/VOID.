/**
 * api/routes/drive.js
 * Drive sync routes — all require authentication.
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const router     = express.Router();
const controller = require('../controllers/drive');

// multer: memory storage (we stream straight to Drive, no disk writes)
// Limit to 100MB for audio files
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── Auth guard ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// All drive routes require auth
router.use(requireAuth);

// Library (track metadata + playlists + settings)
router.get('/library',       controller.getLibrary);
router.post('/library',      express.json({ limit: '5mb' }), controller.saveLibrary);

// Audio file upload/stream/delete
router.post('/upload-audio', upload.single('audio'), controller.uploadAudio);
router.get('/audio/:fileId', controller.streamAudio);
router.delete('/audio/:fileId', controller.deleteAudio);

module.exports = router;
