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

// ── Smart query expansion ─────────────────────────────────────────────────────
// Maps keyword/vibe queries to multiple concrete search terms that JioSaavn
// actually understands (artist names, song titles, genres). Each array entry
// becomes a separate parallel API call; results are merged + deduped.
const VIBE_EXPANSIONS = {
  // Moods
  sad:        ['sad songs', 'heartbreak songs', 'arijit singh sad', 'emotional hits'],
  happy:      ['happy songs', 'upbeat hits', 'feel good songs', 'party songs'],
  heartbreak: ['heartbreak songs', 'breakup songs', 'sad love songs', 'tujhe bhula diya'],
  breakup:    ['breakup songs', 'heartbreak hits', 'sad songs', 'move on songs'],
  romantic:   ['romantic songs', 'love songs', 'arijit singh romantic', 'atif aslam songs'],
  love:       ['love songs', 'romantic hits', 'pyaar songs', 'arijit singh'],
  angry:      ['angry songs', 'rock hits', 'intense energy songs', 'metal songs'],
  cry:        ['sad songs', 'emotional songs', 'crying songs', 'tere bina'],
  // Energy
  workout:    ['workout songs', 'gym motivation', 'pump up songs', 'high energy hits'],
  gym:        ['gym songs', 'workout motivation', 'pump up hits', 'energy songs'],
  running:    ['running songs', 'cardio hits', 'high energy music', 'pump up songs'],
  party:      ['party songs', 'dance hits', 'club songs', 'dj songs'],
  dance:      ['dance songs', 'dance hits', 'dj remix', 'garba songs'],
  hype:       ['hype songs', 'energy hits', 'pump up music', 'motivation songs'],
  // Chill
  chill:      ['chill songs', 'lofi songs', 'relaxing music', 'smooth hits'],
  relax:      ['relaxing songs', 'calm music', 'peaceful songs', 'lofi beats'],
  sleep:      ['sleep music', 'calm songs', 'peaceful music', 'soothing songs'],
  lofi:       ['lofi songs', 'chill beats', 'lo-fi hip hop', 'study music'],
  study:      ['study music', 'lofi songs', 'focus music', 'concentration music'],
  focus:      ['focus music', 'study songs', 'concentration music', 'lofi hits'],
  // Occasions
  morning:    ['morning songs', 'fresh start songs', 'uplifting morning hits', 'good morning music'],
  night:      ['night songs', 'late night vibes', 'midnight songs', 'chill night music'],
  'road trip':['road trip songs', 'driving songs', 'travel hits', 'long drive music'],
  driving:    ['driving songs', 'long drive music', 'road trip hits', 'car songs'],
  // Genres
  bollywood:  ['bollywood hits 2024', 'bollywood songs', 'hindi film songs', 'top bollywood'],
  punjabi:    ['punjabi songs', 'punjabi hits 2024', 'diljit dosanjh', 'ap dhillon'],
  hindi:      ['hindi songs', 'hindi hits 2024', 'bollywood songs', 'new hindi songs'],
  tamil:      ['tamil songs', 'tamil hits 2024', 'kollywood songs', 'thalapathy songs'],
  telugu:     ['telugu songs', 'tollywood hits', 'allu arjun songs', 'telugu hits 2024'],
  rap:        ['rap songs', 'hip hop songs', 'desi hip hop', 'divine songs'],
  hiphop:     ['hip hop songs', 'rap songs', 'desi hip hop', 'divine emiway'],
  rock:       ['rock songs', 'rock hits', 'classic rock', 'indian rock'],
  pop:        ['pop songs', 'pop hits 2024', 'english pop', 'top pop songs'],
  jazz:       ['jazz songs', 'smooth jazz', 'jazz instrumental', 'jazz hits'],
  classical:  ['classical music', 'instrumental classical', 'carnatic music', 'hindustani classical'],
  // Trending
  trending:   ['trending songs 2024', 'top hits 2024', 'viral songs', 'popular songs'],
  latest:     ['latest songs 2024', 'new songs 2024', 'new hindi songs', 'new bollywood'],
  new:        ['new songs 2024', 'latest hits 2024', 'new bollywood', 'new english songs'],
  top:        ['top songs 2024', 'best songs', 'top hindi songs', 'top bollywood hits'],
  // Vibes
  nostalgia:  ['90s hits', 'throwback songs', 'retro songs', '2000s hits'],
  throwback:  ['throwback songs', '90s hits', 'retro bollywood', 'old is gold'],
  motivation: ['motivation songs', 'inspirational songs', 'hustle songs', 'workout motivation'],
  summer:     ['summer songs', 'summer hits', 'beach songs', 'fun summer music'],
  rain:       ['rain songs', 'monsoon songs', 'barish songs', 'rainy day songs'],
};

// Detect if a query is a "vibe/keyword" query vs a direct song/artist name search
function expandQuery(q) {
  const lower = q.toLowerCase().trim();

  // Multi-word keys first (longest match wins)
  const keys = Object.keys(VIBE_EXPANSIONS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower === key
      || lower.startsWith(key + ' ')
      || lower.endsWith(' ' + key)
      || lower.includes(' ' + key + ' ')) {
      return VIBE_EXPANSIONS[key];
    }
  }

  // "songs about X" / "songs for X" / "X songs" / "music for X" patterns
  const aboutMatch = lower.match(/^(?:songs?|music|tracks?)\s+(?:about|for|on)\s+(.+)$/);
  if (aboutMatch) return [aboutMatch[1].trim() + ' songs', aboutMatch[1].trim() + ' hits'];

  const byMatch = lower.match(/^(?:songs?|music|tracks?)\s+by\s+(.+)$/);
  if (byMatch) return [byMatch[1].trim()]; // artist search — single query is fine

  const xSongsMatch = lower.match(/^(.+?)\s+(?:songs?|music|tracks?)$/);
  if (xSongsMatch && xSongsMatch[1].split(' ').length <= 3) {
    return [xSongsMatch[1].trim() + ' songs', xSongsMatch[1].trim() + ' hits'];
  }

  // Plain query — return as-is (no expansion needed)
  return null;
}

// Fetch songs for a single query string
async function fetchSongsForQuery(q, limit = 15) {
  const data = await saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`);
  return (data.data?.results || data.results || []).map(parseSong);
}

// Merge song arrays, dedup by id, preserve order
function mergeSongs(arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    for (const song of arr) {
      if (!seen.has(song.id)) { seen.add(song.id); out.push(song); }
    }
  }
  return out;
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

    // ── Smart expansion: for vibe/keyword queries, fan out to multiple searches ──
    const expansions = expandQuery(q);
    const isExpanded = expansions !== null;

    if (type === 'all') {
      let songs = [], artists = [], albums = [], podcasts = [];

      if (isExpanded) {
        // Fan out: run all expanded song queries in parallel
        const songFetches = expansions.map(eq =>
          saavnFetch(`/search/songs?query=${encodeURIComponent(eq)}&page=1&limit=15`)
            .then(d => (d.data?.results || d.results || []).map(parseSong))
            .catch(() => [])
        );
        const songResults = await Promise.all(songFetches);
        songs = mergeSongs(songResults).slice(0, 30);
        // Still fetch artists/albums using the raw query so they make sense
        const [artistsData, albumsData] = await Promise.allSettled([
          saavnFetch(`/search/artists?query=${encodeURIComponent(q)}&page=1&limit=5`),
          saavnFetch(`/search/albums?query=${encodeURIComponent(q)}&page=1&limit=5`),
        ]);
        if (artistsData.status === 'fulfilled')
          artists = (artistsData.value.data?.results || artistsData.value.results || []).map(parseArtist);
        if (albumsData.status === 'fulfilled')
          albums = (albumsData.value.data?.results || albumsData.value.results || []).map(parseAlbum);
      } else {
        // Normal parallel fetch for specific queries
        const [songsData, artistsData, albumsData, podcastData] = await Promise.allSettled([
          saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=15`),
          saavnFetch(`/search/artists?query=${encodeURIComponent(q)}&page=1&limit=5`),
          saavnFetch(`/search/albums?query=${encodeURIComponent(q)}&page=1&limit=5`),
          saavnFetch(`/search/podcasts?query=${encodeURIComponent(q)}&page=1&limit=5`),
        ]);
        if (songsData.status === 'fulfilled')
          songs = (songsData.value.data?.results || songsData.value.results || []).map(parseSong);
        if (artistsData.status === 'fulfilled')
          artists = (artistsData.value.data?.results || artistsData.value.results || []).map(parseArtist);
        if (albumsData.status === 'fulfilled')
          albums = (albumsData.value.data?.results || albumsData.value.results || []).map(parseAlbum);
        if (podcastData.status === 'fulfilled')
          podcasts = (podcastData.value.data?.results || podcastData.value.results || []).map(parsePodcast);
      }

      const result = { items: songs, artists, albums, podcasts, source: 'jiosaavn', _expanded: isExpanded };
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

    // Default: songs only (with smart expansion)
    let songs = [];
    if (isExpanded) {
      const songFetches = expansions.map(eq =>
        fetchSongsForQuery(eq, 15).catch(() => [])
      );
      const songResults = await Promise.all(songFetches);
      songs = mergeSongs(songResults).slice(0, 30);
    } else {
      const data = await saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&page=1&limit=20`);
      songs = (data.data?.results || data.results || []).map(parseSong);
    }
    const result = { items: songs, artists: [], albums: [], podcasts: [], source: 'jiosaavn', _expanded: isExpanded };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[JioSaavn search error]', err.message);
    next(err);
  }
};

// GET /api/youtube/artist?id=ARTIST_ID
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
exports.playlistItems = async (req, res, next) => {
  try {
    const rawId = String(req.query.id || req.query.url || '').trim();
    if (!rawId) return res.status(400).json({ error: 'Missing id or url' });

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
