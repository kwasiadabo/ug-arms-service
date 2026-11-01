/**
 * Checks the object store after installation or an upgrade (`npm run storage:check`).
 *
 * Part 1 tests every S3 feature UG-ARMS relies on, using test objects under a "storage-check/" prefix of the
 * application bucket: refusal of unsigned and wrongly signed requests, versioning, a multipart upload (40 MB in three
 * parts) with metadata, full and ranged downloads, server-side copy, not-found handling, retention of earlier
 * versions on overwrite, and complete removal of every version. The test objects are removed afterwards.
 *
 * Part 2 tests Object Lock as the application uses it: the bucket has Object Lock enabled; the application
 * credential can place and extend governance retention but cannot shorten it or delete a version under retention,
 * even with the bypass header; a legal hold stops even the disposal credential; and, once the hold is lifted, the
 * disposal credential can destroy the version. Without a disposal credential the last steps are skipped and the test
 * object stays until its one-day retention ends.
 *
 * Part 3 verifies every file recorded in the database (digital assets and supporting documents) against the
 * SHA-256 recorded when it was ingested, then confirms that every live preservation file and replica is under
 * governance retention for at least another year, with an S3 legal hold exactly where a legal hold applies.
 *
 * Exits with status 0 only if every check passes. Uses the backend's storage and database settings.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectRetentionCommand,
  PutObjectLegalHoldCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Op } from 'sequelize';
import { env } from '../src/config/env.js';
import { models, sequelize } from '../src/database/models/index.js';
import { storage } from '../src/services/storage/index.js';
import { PROTECTED_ROLES, heldAssetIds } from '../src/services/objectLock.service.js';

/**
 * Creates an S3 client for the configured storage service with the given credentials.
 *
 * @param {{ accessKeyId: string, secretAccessKey: string }} credentials Credentials to sign with.
 * @returns {S3Client}
 */
const client = (credentials) =>
  new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials,
  });

const s3 = client({ accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY });
const disposal = env.S3_DISPOSAL_ACCESS_KEY
  ? client({ accessKeyId: env.S3_DISPOSAL_ACCESS_KEY, secretAccessKey: env.S3_DISPOSAL_SECRET_KEY })
  : null;
const Bucket = env.S3_BUCKET;
const prefix = `storage-check/${Date.now()}/`;
let failures = 0;

/**
 * Prints the result of one check and counts failures.
 *
 * @param {string} name What was checked.
 * @param {boolean} passed Whether it passed.
 * @param {string} [detail=''] Extra information to print.
 */
function check(name, passed, detail = '') {
  if (!passed) failures += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

/**
 * Checks that a request is refused by the storage service.
 *
 * @param {string} name What was checked.
 * @param {() => Promise<*>} attempt The request that should fail.
 * @returns {Promise<void>}
 */
async function refused(name, attempt) {
  try {
    await attempt();
    check(name, false, 'request was accepted');
  } catch (e) {
    check(name, true, e.name);
  }
}

/**
 * Calculates the SHA-256 of a buffer.
 *
 * @param {Buffer} b Data.
 * @returns {string} Hexadecimal digest.
 */
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Reads a response body stream into a buffer.
 *
 * @param {AsyncIterable<Buffer>} body The stream.
 * @returns {Promise<Buffer>}
 */
async function read(body) {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

/**
 * Lists every version and delete marker under a prefix.
 *
 * @param {string} p Key prefix.
 * @returns {Promise<Array<{ Key: string, VersionId: string }>>}
 */
async function versionsUnder(p) {
  const out = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: p }));
  return [...(out.Versions || []), ...(out.DeleteMarkers || [])];
}

/**
 * Tests every S3 feature the application uses, on test objects that are removed afterwards.
 *
 * @returns {Promise<void>}
 */
async function compatibility() {
  const anon = await fetch(`${env.S3_ENDPOINT}/${Bucket}?list-type=2`);
  check('unsigned request refused', [401, 403].includes(anon.status), `HTTP ${anon.status}`);
  await refused('wrongly signed request refused', () =>
    client({ accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: 'wrong-secret-value' }).send(
      new ListObjectsV2Command({ Bucket }),
    ),
  );

  const v = await s3.send(new GetBucketVersioningCommand({ Bucket }));
  check('bucket versioning', v.Status === 'Enabled', v.Status);
  const master = `${prefix}a/master.tif`;
  const big = crypto.randomBytes(40 * 1024 * 1024);
  await new Upload({
    client: s3,
    params: { Bucket, Key: master, Body: big, Metadata: { sha256: sha256(big) } },
    partSize: 16 * 1024 * 1024,
    queueSize: 4,
  }).done();
  const head = await s3.send(new HeadObjectCommand({ Bucket, Key: master }));
  check('multipart upload size', head.ContentLength === big.length, String(head.ContentLength));
  check('object metadata kept', head.Metadata?.sha256 === sha256(big));
  const full = await read((await s3.send(new GetObjectCommand({ Bucket, Key: master }))).Body);
  check('download matches SHA-256', sha256(full) === sha256(big));
  const part = await s3.send(new GetObjectCommand({ Bucket, Key: master, Range: 'bytes=1000-1999' }));
  check('range read', (await read(part.Body)).equals(big.subarray(1000, 2000)), part.ContentRange);
  await s3.send(
    new CopyObjectCommand({ Bucket, Key: `${prefix}copy.tif`, CopySource: `${Bucket}/${encodeURIComponent(master)}` }),
  );
  const copy = await read((await s3.send(new GetObjectCommand({ Bucket, Key: `${prefix}copy.tif` }))).Body);
  check('server-side copy', sha256(copy) === sha256(big));
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key: `${prefix}missing` }));
    check('missing object reported as 404', false);
  } catch (e) {
    check('missing object reported as 404', e.$metadata?.httpStatusCode === 404, e.name);
  }
  await new Upload({ client: s3, params: { Bucket, Key: master, Body: Buffer.from('replaced') } }).done();
  check('overwrite keeps earlier version', (await versionsUnder(master)).length >= 2);

  // The driver's remove() must leave no version behind, not just a delete marker.
  await storage.remove(master);
  await storage.remove(`${prefix}copy.tif`);
  check('remove deletes every version', (await versionsUnder(prefix)).length === 0);
}

/**
 * Tests retention, legal hold and authorised destruction on one test object.
 *
 * @returns {Promise<void>}
 */
async function objectLock() {
  try {
    const cfg = await s3.send(new GetObjectLockConfigurationCommand({ Bucket }));
    check('bucket has Object Lock enabled', cfg.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled');
  } catch (e) {
    check('bucket has Object Lock enabled', false, e.name);
    return;
  }
  const Key = `${prefix}locked.tif`;
  const day = new Date(Date.now() + 86_400_000);
  const put = await s3.send(
    new PutObjectCommand({ Bucket, Key, Body: 'locked', ObjectLockMode: 'GOVERNANCE', ObjectLockRetainUntilDate: day }),
  );
  const VersionId = put.VersionId;
  const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
  check(
    'governance retention applied',
    head.ObjectLockMode === 'GOVERNANCE',
    head.ObjectLockRetainUntilDate?.toISOString(),
  );
  const later = new Date(day.getTime() + 3_600_000);
  await s3.send(
    new PutObjectRetentionCommand({
      Bucket,
      Key,
      VersionId,
      Retention: { Mode: 'GOVERNANCE', RetainUntilDate: later },
    }),
  );
  check('application can extend retention', true);
  await refused('application cannot shorten retention', () =>
    s3.send(
      new PutObjectRetentionCommand({
        Bucket,
        Key,
        VersionId,
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 60_000) },
      }),
    ),
  );
  await refused('application cannot delete a retained version', () =>
    s3.send(new DeleteObjectCommand({ Bucket, Key, VersionId })),
  );
  await refused('application cannot bypass retention', () =>
    s3.send(new DeleteObjectCommand({ Bucket, Key, VersionId, BypassGovernanceRetention: true })),
  );
  if (!disposal) {
    console.log('SKIP disposal credential tests (S3_DISPOSAL_ACCESS_KEY not set; test object kept for one day)');
    return;
  }
  await s3.send(new PutObjectLegalHoldCommand({ Bucket, Key, VersionId, LegalHold: { Status: 'ON' } }));
  await refused('legal hold stops the disposal credential', () =>
    disposal.send(new DeleteObjectCommand({ Bucket, Key, VersionId, BypassGovernanceRetention: true })),
  );
  await s3.send(new PutObjectLegalHoldCommand({ Bucket, Key, VersionId, LegalHold: { Status: 'OFF' } }));
  await refused('disposal credential needs the bypass header', () =>
    disposal.send(new DeleteObjectCommand({ Bucket, Key, VersionId })),
  );
  await storage.destroy(Key);
  check('authorised destruction leaves no version', (await versionsUnder(Key)).length === 0);
}

/**
 * Verifies every recorded file against its SHA-256, and the retention and legal hold of every preservation file.
 *
 * @returns {Promise<void>}
 */
async function integrity() {
  const rows = [
    ...(await sequelize.query(
      "SELECT id, storageKey AS k, sha256 FROM DigitalAssets WHERE status <> 'deleted' AND storageKey IS NOT NULL",
      { type: 'SELECT' },
    )),
    ...(await sequelize.query(
      'SELECT id, storageKey AS k, sha256 FROM TransferDocuments WHERE storageKey IS NOT NULL',
      {
        type: 'SELECT',
      },
    )),
  ];
  let ok = 0;
  for (const r of rows) {
    try {
      const body = (await s3.send(new GetObjectCommand({ Bucket, Key: r.k }))).Body;
      if (sha256(await read(body)) === r.sha256) ok += 1;
      else console.log(`  checksum mismatch: ${r.id}`);
    } catch (e) {
      console.log(`  missing: ${r.id} (${e.name})`);
    }
  }
  check('recorded files match their SHA-256', ok === rows.length, `${ok} of ${rows.length}`);

  if (!(await storage.objectLockEnabled())) return;
  const held = await heldAssetIds();
  const assets = await models.DigitalAsset.findAll({
    where: { role: PROTECTED_ROLES, status: { [Op.ne]: 'deleted' }, storageKey: { [Op.ne]: null } },
    attributes: ['id', 'storageKey'],
    include: [{ model: models.StorageReplica, as: 'replicas', attributes: ['storageKey'], required: false }],
  });
  const yearFromNow = new Date(Date.now() + 365 * 86_400_000);
  let files = 0;
  let retained = 0;
  let holdsRight = 0;
  for (const a of assets) {
    for (const key of [a.storageKey, ...(a.replicas || []).map((r) => r.storageKey)]) {
      const s = await storage.lockStatus(key);
      if (!s.exists) continue;
      files += 1;
      if (s.mode === 'GOVERNANCE' && s.retainUntil >= yearFromNow) retained += 1;
      else console.log(`  not under retention: ${a.id}`);
      if (s.legalHold === held.has(a.id)) holdsRight += 1;
      else console.log(`  legal hold out of step: ${a.id}`);
    }
  }
  check('preservation files under retention for at least a year', retained === files, `${retained} of ${files}`);
  check('S3 legal holds match the legal holds register', holdsRight === files, `${holdsRight} of ${files}`);
}

try {
  await compatibility();
  await objectLock();
  await integrity();
} catch (err) {
  check('storage check completed', false, err.message);
}
await sequelize.close();
console.log(failures ? `STORAGE CHECK FAILED (${failures})` : 'STORAGE CHECK PASSED');
process.exit(failures ? 1 : 0);
