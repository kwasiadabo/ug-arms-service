/**
 * Local file system storage driver for development and automated tests.
 *
 * Keys are resolved inside the storage root, and any key that would point outside it (for example by using "..") is
 * rejected. Objects are never overwritten. Retention and legal holds cannot be enforced here, so production
 * deployments use the S3 driver.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from '../../config/env.js';

/**
 * Creates a storage driver that keeps objects as files under a root folder.
 *
 * @param {string} [root] Absolute root folder; defaults to STORAGE_LOCAL_ROOT.
 * @returns {object} A driver with the same methods as the S3 driver.
 */
export function createLocalDriver(root = path.resolve(env.STORAGE_LOCAL_ROOT)) {
  /**
   * Converts a storage key to an absolute file path inside the root.
   *
   * @param {string} key Storage key.
   * @returns {string} The absolute path.
   * @throws {Error} When the key would point outside the storage root.
   */
  const resolve = (key) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };
  return {
    name: 'local',

    /**
     * Stores a new object under the given key.
     *
     * An existing object is never overwritten: the call fails if the key already exists, so a preservation master
     * cannot be replaced by accident.
     *
     * @param {string} key Storage key built with `buildKey`.
     * @param {import('node:stream').Readable|Buffer|string} body Content to store.
     * @returns {Promise<{ key: string }>}
     */
    async put(key, body) {
      const full = resolve(key);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      if (await fsp.stat(full).catch(() => null)) throw new Error('Refusing to overwrite existing object');
      const src = Buffer.isBuffer(body) || typeof body === 'string' ? Readable.from([body]) : body;
      await pipeline(src, fs.createWriteStream(full, { flags: 'wx' }));
      return { key };
    },

    /**
     * Opens an object for reading, optionally for a byte range so that audio, video and large PDFs can be streamed.
     *
     * @param {string} key Storage key.
     * @param {{ range?: string }} [options] HTTP Range header value, for example "bytes=0-1023".
     * @returns {Promise<{ body: import('node:stream').Readable, contentLength: number, contentRange?: string }>}
     */
    async get(key, { range } = {}) {
      const full = resolve(key);
      const stat = await fsp.stat(full);
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        return {
          body: fs.createReadStream(full, { start, end }),
          contentLength: end - start + 1,
          contentRange: `bytes ${start}-${end}/${stat.size}`,
        };
      }
      return { body: fs.createReadStream(full), contentLength: stat.size };
    },

    /**
     * Checks whether an object exists and returns its size, without reading its content.
     *
     * @param {string} key Storage key.
     * @returns {Promise<{ exists: boolean, size?: number }>}
     */
    async head(key) {
      const stat = await fsp.stat(resolve(key)).catch(() => null);
      return stat ? { exists: true, size: stat.size } : { exists: false };
    },

    /**
     * Copies an object to a new key; the copy fails if the destination already exists. Used for replication and for
     * restoring an asset from a verified copy.
     *
     * @param {string} fromKey Key of the source object.
     * @param {string} toKey Key of the new copy.
     * @returns {Promise<void>}
     */
    async copy(fromKey, toKey) {
      const to = resolve(toKey);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(resolve(fromKey), to, fs.constants.COPYFILE_EXCL);
    },

    /**
     * Deletes an object. Removing a key that does not exist is not an error.
     *
     * @param {string} key Storage key.
     * @returns {Promise<void>}
     */
    async remove(key) {
      await fsp.rm(resolve(key), { force: true });
    },

    /**
     * Destroys an object under authorised disposal. The file system keeps no versions, so this is the same as
     * `remove`.
     *
     * @param {string} key Storage key.
     * @returns {Promise<{ versions: number }>}
     */
    async destroy(key) {
      const existed = Boolean(await fsp.stat(resolve(key)).catch(() => null));
      await fsp.rm(resolve(key), { force: true });
      return { versions: existed ? 1 : 0 };
    },

    /**
     * Tells whether retention and legal holds can be enforced by the storage. Never on the local file system.
     *
     * @returns {Promise<boolean>}
     */
    async objectLockEnabled() {
      return false;
    },

    /**
     * Confirms that the storage backend is reachable and usable; shown on the System health page.
     *
     * @returns {Promise<{ driver: string, root: string }>}
     */
    async healthCheck() {
      await fsp.mkdir(root, { recursive: true });
      return { driver: 'local', root };
    },
  };
}
