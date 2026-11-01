/**
 * Safe handling of uploaded files.
 *
 * Every upload is treated as untrusted. Files are first written to a private temporary folder under random names.
 * Each file is then identified by its content signature rather than its name, checked against the format registry,
 * scanned for malware, given a SHA-256 checksum and streamed to private object storage. The temporary file is
 * always deleted, whatever the outcome. Uploaded files are never executed.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { env } from '../config/env.js';
import { models } from '../database/models/index.js';
import { badRequest } from '../utils/errors.js';
import { scanFile } from '../integrations/clamav.js';
import { storage, buildKey } from './storage/index.js';

const TMP = path.resolve('uploads/tmp');
fs.mkdirSync(TMP, { recursive: true });

/**
 * Creates Multer middleware that saves uploaded files to the private temporary folder under random names.
 *
 * @param {number} [maxMb=env.MAX_UPLOAD_MB] Maximum size of each file in megabytes. At most 50 files are accepted
 *   per request.
 * @returns {import('multer').Multer}
 */
export const diskUpload = (maxMb = env.MAX_UPLOAD_MB) =>
  multer({
    storage: multer.diskStorage({
      destination: TMP,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: 50 },
  });

/**
 * Calculates the SHA-256 checksum of a file by streaming it.
 *
 * @param {string} file Path of the file.
 * @returns {Promise<string>} The checksum as lowercase hexadecimal.
 */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const TEXT_TYPES = {
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  eml: 'message/rfc822',
  mbox: 'application/mbox',
};

const OFFICE_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Signature detection reports some formats under alternative names; map them to the names in the format registry.
const MEDIA_TYPE_ALIASES = { 'audio/x-wav': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'audio/flac': 'audio/x-flac' };

/**
 * Identifies a file's type from its content signature (its "magic bytes"), never from the extension alone.
 *
 * Office documents are ZIP containers, so the extension is trusted only when the signature confirms a ZIP
 * container. Plain-text formats such as CSV and XML have no signature; they are accepted only when the beginning of
 * the file is valid UTF-8 without NUL bytes, which rules out binary files renamed to look like text.
 *
 * @param {string} filePath Path of the uploaded file.
 * @param {string} originalName File name given by the uploader.
 * @returns {Promise<{ mediaType: string|null, ext: string }>} The detected media type, or null when the type is
 *   unknown or not trusted.
 */
export async function detectType(filePath, originalName) {
  const ext = path
    .extname(originalName || '')
    .slice(1)
    .toLowerCase();
  const detected = await fileTypeFromFile(filePath);
  if (detected) {
    // Office Open XML files are ZIP containers; trust the extension only when the container type matches.
    if (detected.mime === 'application/zip' && OFFICE_TYPES[ext]) return { mediaType: OFFICE_TYPES[ext], ext };
    const mime = MEDIA_TYPE_ALIASES[detected.mime] ?? detected.mime;
    return { mediaType: mime, ext: detected.ext };
  }
  if (TEXT_TYPES[ext]) {
    const fh = await fsp.open(filePath, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
    await fh.close();
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return { mediaType: null, ext };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
      return { mediaType: TEXT_TYPES[ext], ext };
    } catch {
      return { mediaType: null, ext };
    }
  }
  return { mediaType: null, ext };
}

/**
 * Checks that a detected file type is registered in the format registry, accepted for ingest, and allowed in this
 * context.
 *
 * @param {string|null} mediaType Detected media type.
 * @param {string} originalName File name, used in error messages.
 * @param {string[]} [allowed] Media types permitted for this particular upload, if restricted.
 * @returns {Promise<object>} The format registry entry.
 * @throws {AppError} 400 when the type is not recognised or not permitted.
 */
export async function assertAcceptedFormat(mediaType, originalName, allowed) {
  if (!mediaType) throw badRequest(`"${originalName}" is not a recognised or permitted file type`);
  if (allowed && !allowed.includes(mediaType))
    throw badRequest(`"${originalName}" (${mediaType}) is not permitted here`);
  const fmt = await models.FormatRegistry.findOne({ where: { mediaType, isAcceptedForIngest: true } });
  if (!fmt) throw badRequest(`"${originalName}" (${mediaType}) is not an accepted format`);
  return fmt;
}

/**
 * Validates, scans, checksums and stores one uploaded file.
 *
 * Infected files are rejected and never stored. If the scanner was unavailable, the file is stored but marked with
 * malware status "error", which keeps it from being processed or published until it has been re-scanned.
 *
 * @param {{ path: string, originalname: string, size: number }} file The temporary file from Multer.
 * @param {{ area: string, allowed?: string[] }} options Storage area for the key, and the media types allowed here.
 * @returns {Promise<{ storageKey: string, sha256: string, mediaType: string, ext: string, size: number,
 *   malwareStatus: string, scan: object, format: object }>}
 * @throws {AppError} 400 when the file type is not accepted or the file is infected.
 */
export async function ingestTempFile(file, { area, allowed } = {}) {
  try {
    const { mediaType, ext } = await detectType(file.path, file.originalname);
    const format = await assertAcceptedFormat(mediaType, file.originalname, allowed);
    const scan = await scanFile(file.path);
    if (scan.status === 'infected') throw badRequest(`"${file.originalname}" failed the malware scan and was rejected`);
    const sha256 = await sha256File(file.path);
    const storageKey = buildKey(area, file.originalname);
    await storage.put(storageKey, fs.createReadStream(file.path), { contentType: mediaType, metadata: { sha256 } });
    return {
      storageKey,
      sha256,
      mediaType,
      ext,
      size: file.size,
      malwareStatus: scan.status === 'error' ? 'error' : scan.status,
      scan,
      format,
    };
  } finally {
    await fsp.rm(file.path, { force: true });
  }
}

/**
 * Deletes temporary upload files, for example after a request fails validation before ingest.
 *
 * @param {Array<{ path: string }>} [files=[]] The temporary files.
 * @returns {Promise<void>}
 */
export async function cleanupFiles(files = []) {
  await Promise.all(files.map((f) => fsp.rm(f.path, { force: true })));
}
