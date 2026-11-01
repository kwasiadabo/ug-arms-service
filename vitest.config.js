/**
 * Vitest configuration for the backend test suite.
 *
 * Tests run against a separate SQL Server database (ug_arms_test) that is rebuilt from the migrations and seeders
 * before every run. Queues run in-process, files are stored on the local disk, malware scanning and OCR are
 * switched off, and test files run one after another because they share the database.
 *
 * @author Kwasi Adabo Boakye
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setupEnv.js'],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      DB_NAME: 'ug_arms_test',
      QUEUES_ENABLED: 'false',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_ROOT: './storage-test',
      SEED_DEMO_DATA: 'true',
      CLAMAV_ENABLED: 'false',
      OCR_ENABLED: 'false',
    },
  },
});
