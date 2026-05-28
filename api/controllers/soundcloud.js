'use strict';

const SC_API = 'https://void-soundcloud-service.onrender.com';

// ── Tiny in-memory cache ──────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function scFetch(path) {
  const res = await fetch(`${SC_API}${path}`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`SoundCloud service error: ${res.status}`);
  return res.json();
}

function parseSCTrack(track) {
  return {
    id:        track.id,
    videoId:   String(track.id),
    title:     track.title   || track.name || 'Unknown',
    artist:    track.artist  || track.user?.username || '',
    album:     track.album   || '',
    duration:  Math.round((track.duration || 0) / 1000),
    thumbnail: track.artwork_url || track.thumbnail || '',
    audioUrl:  track.stream_url  || track.audioUrl  || '',
    source:    'soundcloud',
    type:      'song',
  };
}

function parseSCUser(user) {
  return {
    id:          String(user.id),
    name:        user.username || user.full_name || 'Unknown',
    thumbnail:   user.avatar_url || user.thumbnail || '',
    followerCount: user.followers_count || 0,
    type:        'artist',
    source:      'soundcloud',
  };
}

function parseSCPlaylist(pl) {
  return {
    id:          String(pl.id),
    name:        pl.title || pl.name || 'Playlist',
    artist:      pl.user?.username || pl.artist || '',
    thumbnail:   pl.artwork_url || pl.thumbnail || '',
    trackCount:  pl.track_count || (pl.tracks?.length) || 0,
    type:        'playlist',
    source:      'soundcloud',
  };
}

// Merge track arrays, dedup by id
function mergeTracks(arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    for (const t of arr) {
      const key = String(t.id);
      if (!seen.has(key)) { seen.add(key); out.push(t); }
    }
  }
  return out;
}

// Fetch tracks from the top playlist result for a query.
// SoundCloud has tons of user-curated mood/vibe playlists so
// "sad songs" → finds "Sad Songs 💔" playlist → returns its tracks.
async function fetchPlaylistTracksForQuery(q) {
  try {
    const data = await scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=3`);
    const playlists = data.items || data.collection || data.results || data.playlists || [];
    if (!playlists.length) return [];

    const topPlaylist = playlists[0];
    const plId = String(topPlaylist.id || '');
    if (!plId) return [];

    const plData = await scFetch(`/playlist?id=${encodeURIComponent(plId)}`);
    const d = plData.data || plData;
    return (d.tracks || d.songs || []).map(parseSCTrack);
  } catch (e) {
    console.warn('[SC playlist tracks fetch]', e.message);
    return [];
  }
}

// ── Exported controller functions ─────────────────────────────────────────────

// GET /api/soundcloud/search?q=&type=all|song|artist|playlist
exports.search = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'all').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const cacheKey = `sc_search:${q}:${type}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    if (type === 'all') {
      // Fetch tracks + users + playlists + playlist-tracks all in parallel
      const [tracksData, usersData, playlistsData, playlistTracks] = await Promise.allSettled([
        scFetch(`/search?q=${encodeURIComponent(q)}&type=tracks&limit=15`),
        scFetch(`/search?q=${encodeURIComponent(q)}&type=users&limit=5`),
        scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=5`),
        fetchPlaylistTracksForQuery(q),
      ]);

      const directTracks = tracksData.status === 'fulfilled'
        ? (tracksData.value.items || tracksData.value.collection || tracksData.value.results || tracksData.value.tracks || []).map(parseSCTrack)
        : [];
      const fromPlaylist = playlistTracks.status === 'fulfilled' ? playlistTracks.value : [];
      const tracks = mergeTracks([directTracks, fromPlaylist]);

      const artists = usersData.status === 'fulfilled'
        ? (usersData.value.items || usersData.value.collection || usersData.value.results || usersData.value.users || []).map(parseSCUser)
        : [];
      const playlists = playlistsData.status === 'fulfilled'
        ? (playlistsData.value.items || playlistsData.value.collection || playlistsData.value.results || playlistsData.value.playlists || []).map(parseSCPlaylist)
        : [];

      const result = { items: tracks, artists, playlists, source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'artist' || type === 'user') {
      const data = await scFetch(`/search?q=${encodeURIComponent(q)}&type=users&limit=20`);
      const users = (data.items || data.collection || data.results || data.users || []).map(parseSCUser);
      const result = { items: [], artists: users, playlists: [], source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'playlist') {
      const data = await scFetch(`/search?q=${encodeURIComponent(q)}&type=playlists&limit=20`);
      const pls = (data.items || data.collection || data.results || data.playlists || []).map(parseSCPlaylist);
      const result = { items: [], artists: [], playlists: pls, source: 'soundcloud' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    // Default: tracks + playlist tracks merged
    const [tracksData, playlistTracks] = await Promise.allSettled([
      scFetch(`/search?q=${encodeURIComponent(q)}&limit=20`),
      fetchPlaylistTracksForQuery(q),
    ]);
    const direct = tracksData.status === 'fulfilled'
      ? (tracksData.value.items || tracksData.value.results || tracksData.value.tracks || tracksData.value || []).map(t => parseSCTrack(t))
      : [];
    const fromPlaylist = playlistTracks.status === 'fulfilled' ? playlistTracks.value : [];
    const tracks = mergeTracks([direct, fromPlaylist]);

    const result = { items: tracks, artists: [], playlists: [], source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[SoundCloud search error]', err.message);
    next(err);
  }
};

// GET /api/soundcloud/artist?id=USER_ID
exports.artistPage = async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const cacheKey = `sc_artist:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [userRes, tracksRes] = await Promise.allSettled([
      scFetch(`/user?id=${encodeURIComponent(id)}`),
      scFetch(`/user/tracks?id=${encodeURIComponent(id)}&limit=40`),
    ]);

    let artistInfo = { id, name: '', thumbnail: '', followerCount: 0 };
    if (userRes.status === 'fulfilled') {
      const u = userRes.value.data || userRes.value;
      artistInfo = {
        id: String(u.id || id),
        name: u.username || u.full_name || '',
        thumbnail: u.avatar_url || u.thumbnail || '',
        followerCount: u.followers_count || 0,
        description: u.description || '',
      };
    }

    let songs = [];
    if (tracksRes.status === 'fulfilled') {
      const d = tracksRes.value;
      songs = (d.items || d.collection || d.tracks || d.results || []).map(parseSCTrack);
    }

    const result = { artist: artistInfo, songs, source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[SoundCloud artist error]', err.message);
    next(err);
  }
};

// GET /api/soundcloud/playlist?id=PLAYLIST_ID_OR_URL
exports.playlistPage = async (req, res, next) => {
  try {
    const rawId = String(req.query.id || req.query.url || '').trim();
    if (!rawId) return res.status(400).json({ error: 'Missing id or url' });

    const cacheKey = `sc_pl:${rawId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const param = /^\d+$/.test(rawId)
      ? `id=${encodeURIComponent(rawId)}`
      : `url=${encodeURIComponent(rawId)}`;

    const data = await scFetch(`/playlist?${param}`);
    const d = data.data || data;

    const plInfo = {
      id: String(d.id || rawId),
      name: d.title || d.name || 'Playlist',
      artist: d.user?.username || d.artist || '',
      thumbnail: d.artwork_url || d.thumbnail || '',
      trackCount: d.track_count || (d.tracks?.length) || 0,
      description: d.description || '',
    };
    const songs = (d.tracks || d.songs || []).map(parseSCTrack);
    const result = { playlist: plInfo, songs, source: 'soundcloud' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[SoundCloud playlist error]', err.message);
    next(err);
  }
};

exports.streamProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `sc_url:${trackId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await scFetch(`/stream?id=${trackId}`);
    const url = data.url || data.stream_url || data.audioUrl || '';
    if (!url) return res.status(502).json({ error: 'No stream URL found' });

    const result = { url, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('[SoundCloud stream error]', e.message);
    next(e);
  }
};

exports.audioProxy = async (req, res, next) => {
  const trackId = String(req.query.id || '').trim();
  if (!trackId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await scFetch(`/stream?id=${trackId}`);
    const url = data.url || data.stream_url || data.audioUrl || '';
    if (!url) return res.status(502).send('No audio URL');

    const audioRes = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!audioRes.ok) return res.status(502).send('Upstream failed');

    res.setHeader('Content-Type', 'audio/mpeg');
    const contentLength = audioRes.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const buf = await audioRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[SoundCloud audio error]', e.message);
    next(e);
  }
};
