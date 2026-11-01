/**
 * Copies every object between an S3-compatible bucket and a local folder, for backups, restores and migrations
 * between storage services (for example MinIO to SeaweedFS).
 *
 *   node scripts/object-store-sync.mjs download <bucket> <folder>   bucket -> folder (backup)
 *   node scripts/object-store-sync.mjs upload <folder> <bucket>     folder -> bucket (restore)
 *
 * The storage service is taken from the backend configuration (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY,
 * S3_REGION, S3_FORCE_PATH_STYLE); environment variables override .env, so the same script can read from one
 * service and write to another. Object keys become relative file paths and back again; a key that would escape the
 * folder is refused. Every transfer is checked by size, and the script exits with a non-zero status if any fails.
 *
 * The destination bucket of an upload must already exist, or be creatable with Object Lock by the credential in use
 * (with SeaweedFS, create it with `s3.bucket.create -name <bucket> -withLock` in `weed shell`). Uploaded files have
 * no retention of their own; run `npm run storage:lock` afterwards, or wait for the nightly sweep, to place
 * preservation files under retention again.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { env } from '../src/config/env.js';

const [mode, from, to] = process.argv.slice(2);
if (!['download', 'upload'].includes(mode) || !from || !to) {
  console.error('Usage: object-store-sync.mjs download <bucket> <folder> | upload <folder> <bucket>');
  process.exit(2);
}

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT || undefined,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: env.S3_ACCESS_KEY ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } : undefined,
});

/**
 * Resolves an object key to a path inside the folder, refusing keys that would point outside it.
 *
 * @param {string} folder Absolute folder.
 * @param {string} key Object key.
 * @returns {string} The file path.
 * @throws {Error} When the key would escape the folder.
 */
function fileFor(folder, key) {
  const file = path.resolve(folder, key);
  if (!file.startsWith(folder + path.sep)) throw new Error(`Refusing unsafe object key: ${key}`);
  return file;
}

/**
 * Lists every object in a bucket, following continuation tokens.
 *
 * @param {string} bucket Bucket name.
 * @returns {AsyncGenerator<{ Key: string, Size: number }>}
 */
async function* listObjects(bucket) {
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents || []) yield o;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Lists every file under a folder, as paths relative to it with forward slashes.
 *
 * @param {string} folder Absolute folder.
 * @returns {Promise<string[]>}
 */
async function listFiles(folder) {
  const entries = await fsp.readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(folder, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Makes sure the destination bucket exists, creating it with Object Lock (and so versioning) if the credential is
 * allowed to; otherwise stops with instructions.
 *
 * @param {string} bucket Bucket name.
 * @returns {Promise<void>}
 */
async function ensureBucket(bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    } catch (err) {
      console.error(
        `Bucket ${bucket} does not exist and this credential cannot create it (${err.name}). Create it first, for ` +
          `example: docker compose exec seaweedfs sh -c 'echo "s3.bucket.create -name ${bucket} -withLock" | ` +
          `weed shell -master=127.0.0.1:9333'`,
      );
      process.exit(1);
    }
  }
}

let copied = 0;
let failed = 0;
if (mode === 'download') {
  const folder = path.resolve(to);
  await fsp.mkdir(folder, { recursive: true });
  for await (const o of listObjects(from)) {
    try {
      const file = fileFor(folder, o.Key);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: from, Key: o.Key }));
      await pipeline(Body, fs.createWriteStream(file));
      if ((await fsp.stat(file)).size !== o.Size) throw new Error('size mismatch');
      copied += 1;
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${o.Key}: ${err.message}`);
    }
  }
} else {
  const folder = path.resolve(from);
  await ensureBucket(to);
  for (const key of await listFiles(folder)) {
    try {
      const file = fileFor(folder, key);
      await new Upload({ client: s3, params: { Bucket: to, Key: key, Body: fs.createReadStream(file) } }).done();
      copied += 1;
    } catch (err) {
      failed += 1;
      console.error(`FAILED ${key}: ${err.message}`);
    }
  }
}
console.log(`${mode}: ${copied} object(s) copied, ${failed} failed`);
process.exit(failed ? 1 : 0);
