/**
 * Health and readiness endpoints, mounted at /api/v1/health.
 *
 * - GET / is a liveness probe that needs no database.
 * - GET /ready is a readiness probe that checks the database; load balancers and Docker use it.
 * - GET /details reports the database, Redis, object storage, optional integrations, queue depths and disk space,
 *   for the System health page ("system.health").
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { sequelize } from '../../database/models/index.js';
import { env } from '../../config/env.js';
import { APP_VERSION, DEVELOPED_BY } from '../../config/about.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { redisConnection, QUEUES, getQueue } from '../../services/queue.service.js';
import { storage } from '../../services/storage/index.js';
import { diskUsage } from '../../services/disk.service.js';

const router = Router();

/**
 * Runs one health check and reports whether the dependency is up, how long the check took and any extra details.
 * Errors are reported as "down" instead of being thrown.
 *
 * @param {string} name Name of the dependency, for example "database".
 * @param {() => Promise<object|void>} fn The check to run.
 * @returns {Promise<{ name: string, status: 'up'|'down', latencyMs: number, error?: string }>}
 */
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, status: 'up', latencyMs: Date.now() - started, ...(detail || {}) };
  } catch (err) {
    return { name, status: 'down', latencyMs: Date.now() - started, error: err.message };
  }
}

/**
 * @openapi
 * /health:
 *   get: { tags: [Health], security: [], summary: Liveness probe, responses: { 200: { description: OK } } }
 */
router.get('/', (req, res) => res.json({ data: { status: 'ok', time: new Date().toISOString() } }));

/**
 * @openapi
 * /health/ready:
 *   get: { tags: [Health], security: [], summary: Readiness probe (database), responses: { 200: { description: Ready }, 503: { description: Not ready } } }
 */
router.get('/ready', async (req, res) => {
  const db = await check('database', () => sequelize.query('SELECT 1'));
  res.status(db.status === 'up' ? 200 : 503).json({ data: { status: db.status === 'up' ? 'ready' : 'not_ready' } });
});

/**
 * @openapi
 * /health/details:
 *   get: { tags: [Health], summary: Dependency and queue status (system.health), responses: { 200: { description: Status } } }
 */
router.get('/details', authenticate, requirePermission('system.health'), async (req, res) => {
  const checks = await Promise.all([
    check('database', async () => {
      await sequelize.query('SELECT 1');
    }),
    check('redis', async () => {
      if (!env.QUEUES_ENABLED) return { status: 'disabled' };
      await redisConnection().ping();
    }),
    check('storage', () => storage.healthCheck()),
  ]);
  const queues = {};
  if (env.QUEUES_ENABLED) {
    for (const q of QUEUES) {
      try {
        queues[q] = await getQueue(q).getJobCounts('waiting', 'active', 'failed', 'delayed', 'completed');
      } catch (err) {
        queues[q] = { error: err.message };
      }
    }
  }
  res.json({
    data: {
      checks,
      queues,
      disk: await diskUsage(),
      integrations: {
        clamav: env.CLAMAV_ENABLED,
        tika: env.TIKA_ENABLED,
        ocr: env.OCR_ENABLED,
        opensearch: env.OPENSEARCH_ENABLED,
        ai: env.AI_ENABLED,
        storageDriver: env.STORAGE_DRIVER,
      },
      version: APP_VERSION,
      developedBy: DEVELOPED_BY,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

export default router;
