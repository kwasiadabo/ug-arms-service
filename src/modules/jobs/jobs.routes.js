/**
 * HTTP routes for background job status, mounted at /api/v1/jobs.
 *
 * - GET / lists background jobs with their status, attempts and last error ("system.health" or
 *   "preservation.manage").
 * - GET /:id returns one job; users may see jobs they requested.
 * - POST /:id/retry runs a failed job again ("system.health" or "preservation.manage").
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { authenticate, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { notFound, forbidden } from '../../utils/errors.js';
import { retryJob } from '../../services/queue.service.js';
import { audit } from '../../services/audit.service.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /jobs:
 *   get: { tags: [Jobs], summary: Background job status (system.health), responses: { 200: { description: Paged jobs } } }
 * /jobs/{id}:
 *   get: { tags: [Jobs], summary: Status of one job (own jobs or system.health), responses: { 200: { description: Job } } }
 */
router.get(
  '/',
  requireAnyPermission('system.health', 'preservation.manage'),
  validate({
    query: paginationSchema.extend({
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
      queue: z.string().max(60).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.queue) where.queue = req.query.queue;
    paged(
      res,
      await models.BackgroundJob.findAndCountAll({ where, order: [['createdAt', 'DESC']], ...pageParams(req.query) }),
      req.query,
    );
  },
);

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const job = await models.BackgroundJob.findByPk(req.params.id);
  if (!job) throw notFound('Job');
  if (job.requestedById !== req.user.id && !req.user.permissions.has('system.health')) throw forbidden();
  res.json({ data: job });
});

router.post(
  '/:id/retry',
  requireAnyPermission('system.health', 'preservation.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const job = await models.BackgroundJob.findByPk(req.params.id);
    if (!job) throw notFound('Job');
    if (job.status !== 'failed') throw forbidden('Only failed jobs can be retried');
    await retryJob(job.id);
    await audit({ action: 'job.retry', resourceType: 'BackgroundJob', resourceId: job.id });
    res.json({ data: { ok: true } });
  },
);

export default router;
