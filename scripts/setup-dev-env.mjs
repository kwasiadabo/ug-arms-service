/**
 * Command-line script that writes backend/.env for LOCAL DEVELOPMENT ONLY (`npm run setup:dev`).
 *
 * The file is generated from .env.example with the ports and service credentials of the development docker-compose
 * services. JWT secrets are random for each developer, and the demonstration password is generated (or taken from
 * DEMO_PASSWORD) and printed once. An existing .env is never overwritten unless --force is given. This file must
 * never be used in production.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const target = new URL('../.env', import.meta.url);
if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.log('backend/.env already exists. Re-run with --force to regenerate it.');
  process.exit(0);
}

/**
 * Generates a random URL-safe string.
 *
 * @param {number} n Number of random bytes.
 * @returns {string}
 */
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const demoPassword = process.env.DEMO_PASSWORD || `Demo-${rnd(9)}1a`;
let text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

/**
 * Sets a variable in the generated .env text, replacing the line that defines it.
 *
 * @param {string} k Variable name.
 * @param {string} v Value to write.
 */
const set = (k, v) => {
  text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
};
set('DB_PORT', '1437');
set('DB_USER', 'sa');
set('DB_PASSWORD', '"UgArms_Dev#2026"');
set('DB_ENCRYPT', 'false');
set('DB_TRUST_SERVER_CERT', 'true');
set('REDIS_URL', 'redis://localhost:6393');
set('JWT_ACCESS_SECRET', rnd(48));
set('JWT_REFRESH_SECRET', rnd(48));
set('COOKIE_SECURE', 'false');
set('S3_ENDPOINT', 'http://localhost:9010');
set('S3_ACCESS_KEY', 'ugarms');
set('S3_SECRET_KEY', 'ugarms-dev-secret');
set('SMTP_HOST', 'localhost');
set('SMTP_PORT', '1028');
set('MAIL_FROM', '"UG Archives (dev) <no-reply@ugarms.local>"');
set('CLAMAV_ENABLED', 'true'); // requires: docker compose --profile scan up -d clamav
set('SEED_ADMIN_EMAIL', 'admin@ugarms.local');
set('SEED_ADMIN_PASSWORD', demoPassword);
set('SEED_DEMO_DATA', 'true');
fs.writeFileSync(target, text);
console.log('Wrote backend/.env for local development.');
console.log(`Demo accounts (development only) use the password: ${demoPassword}`);
console.log('The administrator account must change this password at first sign-in.');
