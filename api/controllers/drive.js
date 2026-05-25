/**
 * api/controllers/drive.js
 * Google Drive operations for VOID Player.
 *
 * Each user gets a "VOID Player" folder in their Drive.
 * Inside that folder:
 *   • void_library.json   — track metadata (titles, artists, playlists, settings)
 *   • audio/<blobId>.mp3  — uploaded local audio files (optional, if user enables)
 */

'use strict';

const { google } = require('googleapis');
const config = require('../../config');

const FOLDER_NAME  = config.google.driveFolderName;
const LIBRARY_FILE = 'void_library.json';
const AUDIO_FOLDER = 'audio';

// ── Build an authenticated Drive client from user tokens ──────────────────
function getDriveClient(user) {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.callbackUrl
  );
  oauth2.setCredentials({
    access_token:  user.accessToken,
    refresh_token: user.refreshToken,
  });
  return google.drive({ version: 'v3', auth: oauth2 });
}

// ── Find or create a folder by name under a parent ───────────────────────
async function ensureFolder(drive, name, parentId = null) {
  const q = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  };
  const created = await drive.files.create({ resource: meta, fields: 'id' });
  return created.data.id;
}

// ── Find a file by name in a folder ──────────────────────────────────────
async function findFile(drive, name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  return res.data.files.length > 0 ? res.data.files[0] : null;
}

// ── Download a JSON file from Drive ──────────────────────────────────────
async function downloadJSON(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return JSON.parse(Buffer.from(res.data).toString('utf-8'));
}

// ── Upload / overwrite a JSON file in Drive ───────────────────────────────
async function uploadJSON(drive, name, data, folderId, existingFileId = null) {
  const content = Buffer.from(JSON.stringify(data, null, 2));
  const media   = { mimeType: 'application/json', body: require('stream').Readable.from(content) };

  if (existingFileId) {
    await drive.files.update({ fileId: existingFileId, media });
    return existingFileId;
  }
  const res = await drive.files.create({
    resource: { name, parents: [folderId] },
    media,
    fields: 'id',
  });
  return res.data.id;
}

// ── Controller: GET /api/drive/library ───────────────────────────────────
exports.getLibrary = async (req, res) => {
  try {
    const drive    = getDriveClient(req.user);
    const rootId   = await ensureFolder(drive, FOLDER_NAME);
    const libFile  = await findFile(drive, LIBRARY_FILE, rootId);

    if (!libFile) return res.json({ library: null }); // first login — no data yet

    const data = await downloadJSON(drive, libFile.id);
    res.json({ library: data });
  } catch (err) {
    console.error('[Drive] getLibrary error:', err.message);
    res.status(502).json({ error: 'Could not read from Google Drive', detail: err.message });
  }
};

// ── Controller: POST /api/drive/library ──────────────────────────────────
exports.saveLibrary = async (req, res) => {
  try {
    const { library } = req.body;
    if (!library || typeof library !== 'object') {
      return res.status(400).json({ error: 'Missing library payload' });
    }
    library._savedAt = new Date().toISOString();
    library._version = 1;

    const drive   = getDriveClient(req.user);
    const rootId  = await ensureFolder(drive, FOLDER_NAME);
    const libFile = await findFile(drive, LIBRARY_FILE, rootId);

    await uploadJSON(drive, LIBRARY_FILE, library, rootId, libFile?.id || null);
    res.json({ ok: true, savedAt: library._savedAt });
  } catch (err) {
    console.error('[Drive] saveLibrary error:', err.message);
    res.status(502).json({ error: 'Could not write to Google Drive', detail: err.message });
  }
};

// ── Controller: POST /api/drive/upload-audio ─────────────────────────────
// Accepts multipart/form-data with field "audio" (the audio file) + "blobId" + "meta" (JSON)
exports.uploadAudio = async (req, res) => {
  try {
    console.log('[Drive] uploadAudio called, file:', req.file ? req.file.originalname : 'MISSING', 'body:', req.body);
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { blobId } = req.body;
    if (!blobId) return res.status(400).json({ error: 'Missing blobId' });

    const drive      = getDriveClient(req.user);
    const rootId     = await ensureFolder(drive, FOLDER_NAME);
    const audioId    = await ensureFolder(drive, AUDIO_FOLDER, rootId);

    // Check if file already exists (avoid duplicates)
    const fileName  = `${blobId}`;
    const existing  = await findFile(drive, fileName, audioId);
    if (existing) return res.json({ ok: true, fileId: existing.id, cached: true });

    // Stream upload to Drive
    const { Readable } = require('stream');
    const readable = Readable.from(req.file.buffer);

    const driveFile = await drive.files.create({
      resource: { name: fileName, parents: [audioId] },
      media:    { mimeType: req.file.mimetype || 'audio/mpeg', body: readable },
      fields:   'id,size',
    });

    res.json({ ok: true, fileId: driveFile.data.id });
  } catch (err) {
    console.error('[Drive] uploadAudio error:', err.message);
    res.status(502).json({ error: 'Could not upload audio to Google Drive', detail: err.message });
  }
};

// ── Controller: GET /api/drive/audio/:fileId ─────────────────────────────
// Streams an audio file from Drive back to the browser (so the audio element can play it)
exports.streamAudio = async (req, res) => {
  try {
    const { fileId } = req.params;
    const drive = getDriveClient(req.user);

    // Get file metadata for content-type
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size' });
    const mimeType = meta.data.mimeType || 'audio/mpeg';
    const size     = parseInt(meta.data.size || '0', 10);

    // Range request support (needed for <audio> seeking)
    const rangeHeader = req.headers.range;
    if (rangeHeader && size > 0) {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mimeType,
      });

      const stream = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );
      stream.data.pipe(res);
    } else {
      if (size > 0) res.setHeader('Content-Length', size);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Accept-Ranges', 'bytes');

      const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      stream.data.pipe(res);
    }
  } catch (err) {
    console.error('[Drive] streamAudio error:', err.message);
    res.status(502).json({ error: 'Could not stream audio from Google Drive' });
  }
};

// ── Controller: DELETE /api/drive/audio/:fileId ──────────────────────────
exports.deleteAudio = async (req, res) => {
  try {
    const { fileId } = req.params;
    const drive = getDriveClient(req.user);
    await drive.files.delete({ fileId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Drive] deleteAudio error:', err.message);
    res.status(502).json({ error: 'Could not delete from Google Drive' });
  }
};
