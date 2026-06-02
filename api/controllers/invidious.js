'use strict';

const config = require('../../config');

/**
 * GET /api/invidious/playlist?id=PLAYLIST_ID
 *
 * Server-side proxy for the Invidious playlist API.
 * Tries each configured instance in order and returns the first success.
 * Keeps Invidious domains off the browser's connect-src CSP entirely.
 */
exports.playlist = async (req, res, next) => {
  const plId = String(req.query.id || '').trim();
  if (!plId) return res.status(400).json({ error: 'Missing playlist id' });

  const instances = config.youtube.invidiousInstances;
  let lastErr = null;

  for (const inst of instances) {
    try {
      const url = `${inst}/api/v1/playlists/${encodeURIComponent(plId)}?fields=title,videos`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!upstream.ok) {
        lastErr = `${inst} → HTTP ${upstream.status}`;
        continue;
      }
      const data = await upstream.json();
      return res.json(data);
    } catch (e) {
      lastErr = `${inst} → ${e.message}`;
    }
  }

  console.error('[invidious/playlist] all instances failed:', lastErr);
  res.status(502).json({ error: 'All Invidious instances failed', detail: lastErr });
};
