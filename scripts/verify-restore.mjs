/**
 * Command-line script that verifies a restored copy of the system against the live system (`npm run
 * restore:verify`).
 *
 * Set RESTORE_AS to the restored database and RESTORE_BUCKET to the restored bucket. The script checks that:
 * - every table has the same row count as the live database (append-only tables such as the audit trail and logs
 *   may have grown since the backup);
 * - the audit hash chain in the restored copy links correctly;
 * - every non-deleted digital object exists in the restored bucket with the SHA-256 recorded in the restored
 *   database.
 *
 * It exits with code 0 only if every check passes, so a restore is never reported as verified without evidence.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/config/env.js';
import { buildSequelize } from '../src/config/database.js';

const restoredDb = process.env.RESTORE_AS;
const restoredBucket = process.env.RESTORE_BUCKET;
if (!restoredDb || !restoredBucket) {
  console.error('Set RESTORE_AS and RESTORE_BUCKET');
  process.exit(2);
}

const live = buildSequelize(env.DB_NAME);
const restored = buildSequelize(restoredDb);

/**
 * Runs a read-only SQL query against one of the two databases.
 *
 * @param {import('sequelize').Sequelize} db Live or restored database.
 * @param {string} sql SQL text.
 * @returns {Promise<object[]>}
 */
const q = (db, sql) => db.query(sql, { type: 'SELECT' });
let failures = 0;

/**
 * Records and prints one failed check.
 *
 * @param {string} m Description of the failure.
 */
const fail = (m) => {
  failures += 1;
  console.log(`FAIL ${m}`);
};

const tables = (
  await q(live, "SELECT name FROM sys.tables WHERE name NOT IN ('SequelizeMeta','SequelizeData') ORDER BY name")
).map((t) => t.name);
let rows = 0;
for (const t of tables) {
  const [a] = await q(live, `SELECT COUNT_BIG(*) AS n FROM [${t}]`);
  const [b] = await q(restored, `SELECT COUNT_BIG(*) AS n FROM [${t}]`);
  rows += Number(b.n);
  // Tables written continuously (audit, logs, jobs) may legitimately have grown since the backup.
  const growing = [
    'AuditEvents',
    'SearchLogs',
    'BackgroundJobs',
    'LoginAttempts',
    'UserSessions',
    'Notifications',
    'PreservationEvents',
    'FixityChecks',
  ].includes(t);
  if (growing ? Number(b.n) > Number(a.n) : Number(a.n) !== Number(b.n)) fail(`${t}: live ${a.n}, restored ${b.n}`);
}
console.log(`Row counts compared for ${tables.length} tables (${rows} rows restored)`);

// Audit hash chain in the restored copy.
const events = await q(restored, 'SELECT seq, prevHash, hash FROM AuditEvents ORDER BY seq');
let prev = null;
for (const e of events) {
  if (e.prevHash !== prev) {
    fail(`audit chain broken at seq ${e.seq}`);
    break;
  }
  prev = e.hash;
}
console.log(`Audit chain linkage checked for ${events.length} events`);

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
});
const assets = await q(
  restored,
  "SELECT id, storageKey, sha256 FROM DigitalAssets WHERE status <> 'deleted' AND storageKey IS NOT NULL",
);
let ok = 0;
for (const a of assets) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: restoredBucket, Key: a.storageKey }));
    const h = crypto.createHash('sha256');
    for await (const c of obj.Body) h.update(c);
    if (h.digest('hex') === a.sha256) ok += 1;
    else fail(`checksum mismatch for asset ${a.id}`);
  } catch (err) {
    fail(`missing object for asset ${a.id}: ${err.name}`);
  }
}
console.log(`Digital objects verified: ${ok}/${assets.length}`);
await live.close();
await restored.close();
console.log(failures ? `VERIFICATION FAILED (${failures} problem(s))` : 'VERIFICATION PASSED');
process.exit(failures ? 1 : 0);
