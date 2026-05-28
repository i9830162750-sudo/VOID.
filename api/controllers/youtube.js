'use strict';

const SAAVN_API = 'https://jiosaavn-api-h375.onrender.com/api';

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

async function saavnFetch(path) {
  const res = await fetch(`${SAAVN_API}${path}`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`JioSaavn API error: ${res.status}`);
  return res.json();
}

function parseSong(song) {
  const imgArr = Array.isArray(song.image) ? song.image : [];
  const img = imgArr.find(i => i.quality === '500x500')?.url
    || imgArr[imgArr.length - 1]?.url
    || '';

  const dlUrls = Array.isArray(song.downloadUrl) ? song.downloadUrl : [];
  let audioUrl = '';
  for (const q of ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps']) {
    const entry = dlUrls.find(d => d.quality === q);
    if (entry && entry.url) { audioUrl = entry.url; break; }
  }
  if (!audioUrl && dlUrls.length) audioUrl = dlUrls[dlUrls.length - 1]?.url || '';

  let artist = '';
  if (song.artists?.primary?.length) {
    artist = song.artists.primary.map(a => a.name).join(', ');
  } else if (typeof song.primaryArtists === 'string') {
    artist = song.primaryArtists;
  }

  return {
    id: song.id,
    videoId: song.id,
    title: song.name || 'Unknown',
    artist,
    album: song.album?.name || '',
    duration: parseInt(song.duration || 0),
    thumbnail: img,
    audioUrl,
    source: 'jiosaavn',
    type: 'song',
  };
}

function parseArtist(a) {
  const imgArr = Array.isArray(a.image) ? a.image : [];
  const img = imgArr.find(i => i.quality === '500x500')?.url
    || imgArr[imgArr.length - 1]?.url || '';
  return {
    id: a.id,
    name: a.name || 'Unknown Artist',
    thumbnail: img,
    followerCount: a.followerCount || 0,
    type: 'artist',
    source: 'jiosaavn',
  };
}

function parseAlbum(al) {
  const imgArr = Array.isArray(al.image) ? al.image : [];
  const img = imgArr.find(i => i.quality === '500x500')?.url
    || imgArr[imgArr.length - 1]?.url || '';
  let artist = '';
  if (Array.isArray(al.artists?.primary)) artist = al.artists.primary.map(a => a.name).join(', ');
  else if (typeof al.primaryArtists === 'string') artist = al.primaryArtists;
  return {
    id: al.id,
    name: al.name || al.title || 'Unknown Album',
    artist,
    thumbnail: img,
    year: al.year || '',
    songCount: al.songCount || 0,
    type: 'album',
    source: 'jiosaavn',
  };
}

function parsePodcast(show) {
  const imgArr = Array.isArray(show.image) ? show.image : [];
  const img = imgArr.find(i => i.quality === '500x500')?.url
    || imgArr[imgArr.length - 1]?.url || '';
  return {
    id: show.id,
    name: show.name || show.title || 'Unknown Show',
    artist: show.header_desc || show.subTitle || '',
    thumbnail: img,
    type: 'podcast',
    source: 'jiosaavn',
  };
}

// ── Exported controller functions ─────────────────────────────────────────────

// GET /api/youtube/search?q=&type=all|song|artist|album|podcast
exports.search = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'all').trim();
    if (!q) return res.status(400).json({ error: 'Missing query parameter: q' });

    const cacheKey = `saavn_search:${q}:${type}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, _cached: true });

    if (type === 'all') {
      // Fetch songs + artists + albums in parallel for rich results
      const [songsData, artistsData, albumsData, podcastData] = await Promise.allSettled([
        saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`),
        saavnFetch(`/search/artists?query=${encodeURIComponent(q)}&page=1&limit=5`),
        saavnFetch(`/search/albums?query=${encodeURIComponent(q)}&page=1&limit=5`),
        saavnFetch(`/search/podcasts?query=${encodeURIComponent(q)}&page=1&limit=5`),
      ]);

      const songs = songsData.status === 'fulfilled'
        ? (songsData.value.data?.results || songsData.value.results || []).map(parseSong)
        : [];
      const artists = artistsData.status === 'fulfilled'
        ? (artistsData.value.data?.results || artistsData.value.results || []).map(parseArtist)
        : [];
      const albums = albumsData.status === 'fulfilled'
        ? (albumsData.value.data?.results || albumsData.value.results || []).map(parseAlbum)
        : [];
      const podcasts = podcastData.status === 'fulfilled'
        ? (podcastData.value.data?.results || podcastData.value.results || []).map(parsePodcast)
        : [];

      const result = { items: songs, artists, albums, podcasts, source: 'jiosaavn' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'artist') {
      const data = await saavnFetch(`/search/artists?query=${encodeURIComponent(q)}&page=1&limit=20`);
      const results = data.data?.results || data.results || [];
      const result = { items: [], artists: results.map(parseArtist), albums: [], podcasts: [], source: 'jiosaavn' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'album') {
      const data = await saavnFetch(`/search/albums?query=${encodeURIComponent(q)}&page=1&limit=20`);
      const results = data.data?.results || data.results || [];
      const result = { items: [], artists: [], albums: results.map(parseAlbum), podcasts: [], source: 'jiosaavn' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    if (type === 'podcast') {
      const data = await saavnFetch(`/search/podcasts?query=${encodeURIComponent(q)}&page=1&limit=20`);
      const results = data.data?.results || data.results || [];
      const result = { items: [], artists: [], albums: [], podcasts: results.map(parsePodcast), source: 'jiosaavn' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    // Default: songs only
    const data = await saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`);
    const results = data.data?.results || data.results || [];
    const result = { items: results.map(parseSong), artists: [], albums: [], podcasts: [], source: 'jiosaavn' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn search error]', err.message);
    next(err);
  }
};

// GET /api/youtube/artist?id=ARTIST_ID
// Returns artist info + top songs
exports.artistPage = async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const cacheKey = `saavn_artist:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [infoData, songsData] = await Promise.allSettled([
      saavnFetch(`/artists/${id}`),
      saavnFetch(`/artists/${id}/songs?page=1&songCount=40`),
    ]);

    let artistInfo = {};
    if (infoData.status === 'fulfilled') {
      const d = infoData.value.data || infoData.value;
      const imgArr = Array.isArray(d.image) ? d.image : [];
      artistInfo = {
        id: d.id || id,
        name: d.name || '',
        bio: (Array.isArray(d.bio) ? d.bio.map(b => b.text).join(' ') : d.bio) || '',
        thumbnail: imgArr.find(i => i.quality === '500x500')?.url || imgArr[imgArr.length - 1]?.url || '',
        followerCount: d.followerCount || 0,
        dominantType: d.dominantType || '',
      };
    }

    let songs = [];
    if (songsData.status === 'fulfilled') {
      const d = songsData.value.data || songsData.value;
      songs = (d.songs || d.results || []).map(parseSong);
    }

    const result = { artist: artistInfo, songs, source: 'jiosaavn' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn artist error]', err.message);
    next(err);
  }
};

// GET /api/youtube/album?id=ALBUM_ID
// Returns album info + songs
exports.albumPage = async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const cacheKey = `saavn_album:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/albums?id=${encodeURIComponent(id)}`);
    const d = data.data || data;
    const imgArr = Array.isArray(d.image) ? d.image : [];
    let artist = '';
    if (Array.isArray(d.artists?.primary)) artist = d.artists.primary.map(a => a.name).join(', ');
    else if (typeof d.primaryArtists === 'string') artist = d.primaryArtists;

    const albumInfo = {
      id: d.id || id,
      name: d.name || d.title || '',
      artist,
      thumbnail: imgArr.find(i => i.quality === '500x500')?.url || imgArr[imgArr.length - 1]?.url || '',
      year: d.year || '',
      description: d.description || '',
    };
    const songs = (d.songs || []).map(parseSong);
    const result = { album: albumInfo, songs, source: 'jiosaavn' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn album error]', err.message);
    next(err);
  }
};

// GET /api/youtube/podcast?id=SHOW_ID
// Returns podcast show + episodes
exports.podcastPage = async (req, res, next) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const cacheKey = `saavn_podcast:${id}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/podcasts/${id}`);
    const d = data.data || data;
    const imgArr = Array.isArray(d.image) ? d.image : [];

    const showInfo = {
      id: d.id || id,
      name: d.name || d.title || '',
      artist: d.header_desc || d.subTitle || d.subtitle || '',
      thumbnail: imgArr.find(i => i.quality === '500x500')?.url || imgArr[imgArr.length - 1]?.url || '',
      description: d.description || d.fan_count || '',
    };

    // Episodes are like songs
    const episodes = (d.episodes || d.songs || []).map(ep => {
      const epImg = Array.isArray(ep.image) ? ep.image : [];
      const epDlUrls = Array.isArray(ep.downloadUrl) ? ep.downloadUrl : [];
      let audioUrl = '';
      for (const q of ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps']) {
        const entry = epDlUrls.find(d => d.quality === q);
        if (entry && entry.url) { audioUrl = entry.url; break; }
      }
      return {
        id: ep.id,
        videoId: ep.id,
        title: ep.name || ep.title || 'Episode',
        artist: showInfo.name,
        album: '',
        duration: parseInt(ep.duration || 0),
        thumbnail: epImg.find(i => i.quality === '500x500')?.url || epImg[epImg.length - 1]?.url || showInfo.thumbnail,
        audioUrl,
        source: 'jiosaavn',
        type: 'podcast_episode',
      };
    });

    const result = { show: showInfo, episodes, source: 'jiosaavn' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn podcast error]', err.message);
    next(err);
  }
};

// GET /api/youtube/videos?ids=
exports.videoDetails = async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').trim();
    if (!ids) return res.status(400).json({ error: 'Missing query parameter: ids' });

    const cacheKey = `saavn_song:${ids}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/songs/${ids}`);
    const results = data.data || data.results || [];
    const songs = (Array.isArray(results) ? results : [results]).map(parseSong);
    cacheSet(cacheKey, { items: songs });
    res.json({ items: songs });
  } catch (err) {
    console.error('[JioSaavn videoDetails error]', err.message);
    next(err);
  }
};

// GET /api/youtube/playlist?id=PLAYLIST_ID_OR_URL
// Supports JioSaavn playlist IDs and URLs
exports.playlistItems = async (req, res, next) => {
  try {
    const rawId = String(req.query.id || req.query.url || '').trim();
    if (!rawId) return res.status(400).json({ error: 'Missing id or url' });

    // Extract ID from URL if needed: jiosaavn.com/featured/xyz/abc123
    let plId = rawId;
    const urlMatch = rawId.match(/\/featured\/[^/]+\/([^/?]+)/);
    if (urlMatch) plId = urlMatch[1];

    const cacheKey = `saavn_pl:${plId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/playlists?id=${encodeURIComponent(plId)}`);
    const d = data.data || data;
    const imgArr = Array.isArray(d.image) ? d.image : [];
    const plInfo = {
      id: d.id || plId,
      name: d.name || d.title || 'Playlist',
      description: d.description || '',
      thumbnail: imgArr.find(i => i.quality === '500x500')?.url || imgArr[imgArr.length - 1]?.url || '',
      songCount: d.songCount || 0,
    };
    const songs = (d.songs || []).map(parseSong);
    const result = { playlist: plInfo, songs, source: 'jiosaavn' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn playlist error]', err.message);
    next(err);
  }
};

// GET /api/youtube/stream?id=SONG_ID
exports.streamProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const cacheKey = `saavn_url:${songId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const data = await saavnFetch(`/songs/${songId}`);
    const results = data.data || data.results || [];
    const arr = Array.isArray(results) ? results : [results];
    const song = parseSong(arr[0] || {});

    if (!song.audioUrl) return res.status(502).json({ error: 'No stream URL found' });

    const result = { url: song.audioUrl, mimeType: 'audio/mpeg' };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('[JioSaavn stream error]', e.message);
    next(e);
  }
};

// GET /api/youtube/audio?id=SONG_ID
exports.audioProxy = async (req, res, next) => {
  const songId = String(req.query.id || '').trim();
  if (!songId) return res.status(400).json({ error: 'Missing id' });

  try {
    const data = await saavnFetch(`/songs/${songId}`);
    const results = data.data || data.results || [];
    const arr = Array.isArray(results) ? results : [results];
    const song = parseSong(arr[0] || {});

    if (!song.audioUrl) return res.status(502).send('No audio URL');

    const audioRes = await fetch(song.audioUrl, { signal: AbortSignal.timeout(60000) });
    if (!audioRes.ok) return res.status(502).send('Upstream failed');

    res.setHeader('Content-Type', 'audio/mpeg');
    const contentLength = audioRes.headers.get('Content-Length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Accept-Ranges', 'bytes');

    const buf = await audioRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[JioSaavn audio error]', e.message);
    next(e);
  }
};
