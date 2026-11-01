/**
 * Entry point to object storage.
 *
 * Selects the configured driver: S3-compatible storage (MinIO in development, or a cloud bucket) or the local file
 * system for development and tests. Storage keys are opaque, are never returned to clients and follow the layout
 * <area>/<yyyy>/<mm>/<uuid>/<safe-name>, so files are delivered only through routes that check access first.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { createS3Driver } from './s3.driver.js';
import { createLocalDriver } from './local.driver.js';

export const storage = env.STORAGE_DRIVER === 'local' ? createLocalDriver() : createS3Driver();

/**
 * Creates a new, unique storage key for a file.
 *
 * The original name is reduced to safe characters and its last 120 characters are kept, so the key stays readable
 * for administrators without allowing path tricks.
 *
 * @param {string} area Top-level area, for example "assets" or "transfer-documents".
 * @param {string} [filename='object'] Original file name.
 * @returns {string} The storage key.
 */
export function buildKey(area, filename = 'object') {
  const now = new Date();
  const safe =
    filename
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '_')
      .slice(-120) || 'object';
  return `${area}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}/${safe}`;
}

/**
 * Reads a whole stored object into memory. Intended for small objects only, such as generated reports and labels.
 *
 * @param {string} key Storage key.
 * @returns {Promise<Buffer>}
 */
export async function readToBuffer(key) {
  const { body } = await storage.get(key);
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}
