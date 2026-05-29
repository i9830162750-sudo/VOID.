'use strict';

const SC_API = 'https://void-soundcloud-service.onrender.com';

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL      = 5  * 60 * 1000;  // 5 min  — search results
const STREAM_URL_TTL = 55 * 60 * 1000;  // 55 min — stream URLs (signed, ~1hr expiry)

function cacheGet(key, ttl = CACHE_TTL) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ── scFetch: retries once on transient errors, never throws 500-worthy errors ─
async function scFetch(path, retries = 1) {
  const url = `${SC_API}${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      // 404 = track gone, 429 = rate limited — don't retry these
      if (res.status === 404) return null;
      if (res.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
      if (!res.ok) throw Object.assign(new Error(`SC service ${res.status}`), { status: res.status });
      return await res.json();
    } catch (e) {
      lastErr = e;
      // Don't retry rate limits or timeouts caused by the service being down
      if (e.status === 429 || e.status === 404) break;
      if (attempt < retries) await new Promise(r => setTimeout(r, 600));
    }
  }
  throw lastErr;
}

// ── Parsers — safe, never crash on missing fields ─────────────────────────────
function parseSCTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const id = track.id || track.videoId;
  if (!id) return null;
  return {
    id:        String(id),
    videoId:   String(id),
    title:     String(track.title || track.name || 'Unknown'),
    artist:    String(track.artist || (track.user && track.user.username) || ''),
    album:     String(track.album || ''),
    duration:  Math.round(((typeof track.duration === 'number' ? track.duration : 0)) / 1000) || 0,
    thumbnail: String(track.artwork_url || track.thumbnail || ''),
    audioUrl:  String(track.stream_url  || track.audioUrl  || ''),
    source:    'soundcloud',
    type:      'song',
  };
}

function parseSCUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id:            String(user.id || ''),
    name:          String(user.username || user.full_name || 'Unknown'),
    thumbnail:     String(user.avatar_url || user.thumbnail || ''),
    followerCount: Number(user.followers_count) || 0,
    type:          'artist',
    source:        'soundcloud',
  };
}

function parseSCPlaylist(pl) {
  if (!pl || typeof pl !== 'object') return null;
  return {
    id:         String(pl.id || ''),
    name:       String(pl.title || pl.name || 'Playlist'),
    artist:     String((pl.user && pl.user.username) || pl.artist || ''),
    thumbnail:  String(pl.artwork_url || pl.thumbnail || ''),
    trackCount: Number(pl.track_count) || (Array.isArray(pl.tracks) ? pl.tracks.length : 0),
    type:       'playlist',
    source:     'soundcloud',
  };
}

// Safely parse an array through a parser, drop nulls
function parseAll(arr, parser) {
  if (!Array.isArray(arr)) return [];
  return arr.map(parser).filter(Boolean);
}

// Merge track arrays, dedup by id
function mergeTracks(arrays) {
  const seen = new Set();
  const out  = [];
  for (const arr of arrays) {
    for (const t of arr) {
      if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
  }
  return out;
}

// Extract items array from various response shapes the SC service might return
function extractItems(data) {
  if (!data) return [];
  return data.items || data.collection || data.results ||
         data.tracks || data.users || data.playlists || [];
}

// Fetch tracks from the top playlist for a query (best for mood/vibe searches)
async function fetchPlaylistTracksForQuery(q) {
  try {
    const data = await scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=3`);
    if (!data) return [];
    const playlists = extractItems(data);
    if (!playlists.length) return [];
    const plId = String((playlists[0] && playlists[0].id) || '');
    if (!plId) return [];
    const plData = await scFetch(`/playlist?id=${encodeURIComponent(plId)}`);
    if (!plData) return [];
    const d = plData.data || plData;
    return parseAll(d.tracks || d.songs || [], parseSCTrack);
  } catch (e) {
    console.warn('[SC playlist tracks]', e.message);
    return [];
  }
}

// ── Controllers ───────────────────────────────────────────────────────────────

// GET /api/soundcloud/search?q=&type=all|song|artist|playlist
exports.search = async (req, res, next) => {
  try {
    const q    = String(req.query.q    || '').trim();
    const type = String(req.query.type || 'all').trim();
    if (!q) return res.status(400).json({ error: 'Missing q' });

    const cacheKey = `sc_search:${q}:${type}`;
    const cached   = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    if (type === 'all') {
      const [tracksRes, usersRes, playlistsRes, playlistTracks] = await Promise.allSettled([
        scFetch(`/search?q=${encodeURIComponent(q)}&type=tracks&limit=15`),
        scFetch(`/search?q=${encodeURIComponent(q)}&type=users&limit=5`),
        scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=5`),
        fetchPlaylistTracksForQuery(q),
      ]);

      const directTracks  = tracksRes.status    === 'fulfilled' ? parseAll(extractItems(tracksRes.value),    parseSCTrack)    : [];
      const fromPlaylist  = playlistTracks.status === 'fulfilled' ? playlistTracks.value : [];
      const artists       = usersRes.status      === 'fulfilled' ? parseAll(extractItems(usersRes.value),     parseSCUser)     : [];
      const playlists     = playlistsRes.status  === 'fulfilled' ? parseAll(extractItems(playlistsRes.value), parseSCPlaylist) : [];
      const tracks        = mergeTracks([directTracks, fromPlaylist]);

      const result = { items: tracks, artists, playlists, source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'artist' || type === 'user') {
      const data  = await scFetch(`/search?q=${encodeURIComponent(q)}&type=users&limit=20`);
      const users = parseAll(extractItems(data), parseSCUser);
      const result = { items: [], artists: users, playlists: [], source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'playlist') {
      const data = await scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=20`);
      const pls  = parseAll(extractItems(data), parseSCPlaylist);
      const result = { items: [], artists: [], playlists: pls, source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    // Fallback: tracks only
    const [tracksRes, playlistTracks] = await Promise.allSettled([
      scFetch(`/search?q=${encodeURIComponent(q)}&limit=20`),
      fetchPlaylistTracksForQuery(q),
    ]);
    const direct       = tracksRes.status    === 'fulfilled' ? parseAll(extractItems(tracksRes.value),  parseSCTrack) : [];
    const fromPlaylist = playlistTracks.status === 'fulfilled' ? playlistTracks.value : [];
    const tracks       = mergeTracks([direct, fromPlaylist]);

    const result = { items: tracks, artists: [], playlists: [], source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[SoundCloud search]', err.message);
    // Return empty results instead of 500 — search should never hard-fail
    res.json({ items: [], artists: [], playlists: [], source: 'soundcloud', _error: true });
  }
};

// GET /api/soundcloud/artist?id=USER_ID
exports.artistPage = async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const cacheKey = `sc_artist:${id}`;
    const cached   = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [userRes, tracks0, tracks1, tracks2] = await Promise.allSettled([
      scFetch(`/user?id=${encodeURIComponent(id)}`),
      scFetch(`/user/tracks?id=${encodeURIComponent(id)}&limit=50&offset=0`),
      scFetch(`/user/tracks?id=${encodeURIComponent(id)}&limit=50&offset=50`),
      scFetch(`/user/tracks?id=${encodeURIComponent(id)}&limit=50&offset=100`),
    ]);

    let artistInfo = { id, name: '', thumbnail: '', followerCount: 0 };
    if (userRes.status === 'fulfilled' && userRes.value) {
      const u = userRes.value.data || userRes.value;
      artistInfo = {
        id:            String(u.id || id),
        name:          String(u.username || u.full_name || ''),
        thumbnail:     String(u.avatar_url || u.thumbnail || ''),
        followerCount: Number(u.followers_count) || 0,
        description:   String(u.description || ''),
      };
    }

    const seen  = new Set();
    const songs = [];
    for (const page of [tracks0, tracks1, tracks2]) {
      if (page.status !== 'fulfilled' || !page.value) continue;
      for (const t of parseAll(extractItems(page.value), parseSCTrack)) {
        if (!seen.has(t.id)) { seen.add(t.id); songs.push(t); }
      }
    }

    const result = { artist: artistInfo, songs, source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[SoundCloud artist]', err.message);
    next(Object.assign(err, { status: err.status || 502 }));
  }
};

// GET /api/soundcloud/playlist?id=PLAYLIST_ID_OR_URL
exports.playlistPage = async (req, res, next) => {
  try {
    const rawId = String(req.query.id || req.query.url || '').trim();
    if (!rawId) return res.status(400).json({ error: 'Missing id or url' });

    const cacheKey = `sc_pl:${rawId}`;
    const cached   = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const param = /^\d+$/.test(rawId)
      ? `id=${encodeURIComponent(rawId)}`
      : `url=${encodeURIComponent(rawId)}`;

    const data = await scFetch(`/playlist?${param}`);
    if (!data) return res.status(404).json({ error: 'Playlist not found' });

    const d = data.data || data;
    const plInfo = {
      id:          String(d.id || rawId),
      name:        String(d.title || d.name || 'Playlist'),
      artist:      String((d.user && d.user.username) || d.artist || ''),
      thumbnail:   String(d.artwork_url || d.thumbnail || ''),
      trackCount:  Number(d.track_count) || (Array.isArray(d.tracks) ? d.tracks.length : 0),
      description: String(d.description || ''),
    };
    const songs  = parseAll(d.tracks || d.songs || [], parseSCTrack);
    const result = { playlist: plInfo, songs, source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[SoundCloud playlist]', err.message);
    next(Object.assign(err, { status: err.status || 502 }));
  }
};

// GET /api/soundcloud/stream?id=TRACK_ID
// Returns the stream URL. Short TTL cache since signed URLs expire.
exports.streamProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `sc_url:${trackId}`;
    const cached   = cacheGet(cacheKey, STREAM_URL_TTL);
    if (cached) return res.json(cached);

    const data = await scFetch(`/stream?id=${encodeURIComponent(trackId)}`);
    if (!data) return res.status(404).json({ error: 'Track not found' });

    const url = String(data.url || data.stream_url || data.audioUrl || '');
    if (!url) return res.status(502).json({ error: 'No stream URL in response' });

    const result = { url, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error('[SoundCloud stream]', err.message);
    // Return a structured error so the frontend can show a friendly message
    const status = err.status || 502;
    res.status(status).json({ error: err.message || 'Stream unavailable' });
  }
};

// GET /api/soundcloud/audio?id=TRACK_ID
// Pipes audio through as a stream — never buffers the whole file.
exports.audioProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await scFetch(`/stream?id=${encodeURIComponent(trackId)}`);
    if (!data) return res.status(404).send('Track not found');

    const url = String(data.url || data.stream_url || data.audioUrl || '');
    if (!url) return res.status(502).send('No audio URL');

    // Support range requests for seeking
    const rangeHeader = req.headers.range;
    const upstreamHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

    const audioRes = await fetch(url, {
      signal:  AbortSignal.timeout(30000),
      headers: upstreamHeaders,
    });

    if (!audioRes.ok && audioRes.status !== 206) {
      return res.status(502).send('Upstream audio fetch failed');
    }

    // Forward relevant headers
    res.status(audioRes.status);
    res.setHeader('Content-Type', audioRes.headers.get('Content-Type') || 'audio/mpeg');
    const cl = audioRes.headers.get('Content-Length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = audioRes.headers.get('Content-Range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    // Pipe — never buffer the whole file in memory
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb
      ? Readable.fromWeb(audioRes.body)
      : require('stream').Readable.from(audioRes.body);
    nodeStream.pipe(res);
    nodeStream.on('error', () => res.end());

  } catch (err) {
    console.error('[SoundCloud audio]', err.message);
    if (!res.headersSent) res.status(502).send('Audio proxy error');
  }
};
