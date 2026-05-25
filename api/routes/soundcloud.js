'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/soundcloud');

// GET /api/soundcloud/search?q=
router.get('/search', controller.search);

// GET /api/soundcloud/stream?id=
router.get('/stream', controller.streamProxy);

// GET /api/soundcloud/audio?id=
router.get('/audio', controller.audioProxy);

module.exports = router;
