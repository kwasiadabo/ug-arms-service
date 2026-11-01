/**
 * Vitest global setup for the backend: rebuilds the test database and clears the test file store before the suite
 * runs.
 *
 * @author Kwasi Adabo Boakye
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Drops and recreates the ug_arms_test database, applies every migration and seeder, and deletes the local test
 * storage. This also proves that the migrations and seeders work on an empty database.
 */
export default function setup() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_NAME: 'ug_arms_test',
    QUEUES_ENABLED: 'false',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: './storage-test',
  };
  fs.rmSync('./storage-test', { recursive: true, force: true });
  execFileSync('node', ['src/database/cli.js', 'reset'], { env, stdio: 'pipe' });
}
