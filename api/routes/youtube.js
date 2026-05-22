'use strict';

const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/youtube');

router.get('/search',        controller.search);
router.get('/videos',        controller.videoDetails);
router.get('/playlist',      controller.playlistItems);
router.get('/stream',        controller.streamProxy);
router.get('/saavn/search',  controller.saavnSearch);

module.exports = router;
