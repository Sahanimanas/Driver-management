import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { bad } from './util.js';

const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]);

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const dir = path.join(config.uploadDir, new Date().toISOString().slice(0, 7));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 8 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(bad(`Unsupported file type: ${file.mimetype}`));
    }
    return cb(null, true);
  },
});

/** Record an uploaded multer file in the attachments table. */
export function saveAttachment(file, { ownerType, ownerId, kind, userId }) {
  const id = crypto.randomUUID();
  q.run(
    `INSERT INTO attachments(id, owner_type, owner_id, kind, filename, mime, size, stored_path, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    ownerType,
    ownerId == null ? null : String(ownerId),
    kind,
    file.originalname,
    file.mimetype,
    file.size,
    path.relative(config.uploadDir, file.path).replace(/\\/g, '/'),
    userId ?? null,
  );
  return id;
}

/** Register a server-generated buffer (registers, sheets, Tally XML) as a file. */
export function saveBuffer(buffer, { filename, mime, ownerType, ownerId, kind, userId }) {
  const id = crypto.randomUUID();
  const dir = path.join(config.uploadDir, new Date().toISOString().slice(0, 7), 'generated');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${id}${path.extname(filename)}`);
  fs.writeFileSync(abs, buffer);
  q.run(
    `INSERT INTO attachments(id, owner_type, owner_id, kind, filename, mime, size, stored_path, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    ownerType,
    ownerId == null ? null : String(ownerId),
    kind,
    filename,
    mime,
    buffer.length,
    path.relative(config.uploadDir, abs).replace(/\\/g, '/'),
    userId ?? null,
  );
  return id;
}

export function attachmentPath(row) {
  return path.join(config.uploadDir, row.stored_path);
}

export function removeAttachment(id) {
  const row = q.get('SELECT * FROM attachments WHERE id = ?', id);
  if (!row) return;
  try {
    fs.unlinkSync(attachmentPath(row));
  } catch {
    /* file already gone */
  }
  q.run('DELETE FROM attachments WHERE id = ?', id);
}
