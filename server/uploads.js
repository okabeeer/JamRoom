// POST /api/rooms/:code/upload — multipart audio files from a Jam member.
// Files are stored under random names and served from /media with HTTP Range
// support so every listener can seek.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { parseFile } from 'music-metadata';
import { JamError } from './rooms.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm', '.weba']);
export const MAX_UPLOAD_MB = 100;
const MAX_FILES = 20;

export function createUploadRouter({ store, uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES },
    fileFilter: (req, file, cb) => {
      const ok = AUDIO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase());
      if (!ok) req.skippedFiles.push(fixName(file.originalname));
      cb(null, ok);
    },
  });

  const router = express.Router();

  router.post(
    '/rooms/:code/upload',
    (req, res, next) => {
      try {
        req.jamMember = store.memberByToken(req.params.code, req.get('x-jam-token'));
        req.skippedFiles = [];
        next();
      } catch (err) {
        res.status(err.code === 'not-found' ? 404 : 403).json({ ok: false, error: err.message });
      }
    },
    (req, res, next) =>
      upload.array('files', MAX_FILES)(req, res, (err) => {
        if (!err) return next();
        removeFiles(req.files);
        const error =
          err.code === 'LIMIT_FILE_SIZE' ? `Each file must be under ${MAX_UPLOAD_MB} MB`
          : err.code === 'LIMIT_FILE_COUNT' ? `Upload at most ${MAX_FILES} files at a time`
          : 'Upload failed';
        res.status(400).json({ ok: false, error });
      }),
    async (req, res) => {
      const files = req.files ?? [];
      if (!files.length) {
        return res.status(400).json({ ok: false, error: 'Choose audio files (mp3, m4a, aac, ogg, opus, wav, flac, webm)', skipped: req.skippedFiles });
      }
      try {
        const items = await Promise.all(files.map(describe));
        const tracks = store.addTracks(req.params.code, req.jamMember.id, items, { enqueue: req.body?.enqueue === '1' });
        res.json({ ok: true, trackIds: tracks.map((t) => t.id), skipped: req.skippedFiles });
      } catch (err) {
        removeFiles(files);
        const known = err instanceof JamError;
        if (!known) console.error('[upload]', err);
        res.status(known ? 400 : 500).json({ ok: false, error: known ? err.message : 'Upload failed' });
      }
    },
  );

  return router;
}

async function describe(file) {
  const original = fixName(file.originalname);
  let meta = null;
  try {
    meta = await parseFile(file.path, { duration: true, skipCovers: true });
  } catch {
    // Untagged or unusual files still play; the browser reports the duration.
  }
  return {
    kind: 'file',
    src: `/media/${file.filename}`,
    file: file.filename,
    title: meta?.common?.title || path.basename(original, path.extname(original)),
    artist: meta?.common?.artist || null,
    durationSec: meta?.format?.duration ?? null,
  };
}

// Browsers send UTF-8 filenames; busboy may hand them over decoded as latin1.
function fixName(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

function removeFiles(files) {
  for (const file of files ?? []) fs.rm(file.path, { force: true }, () => {});
}
