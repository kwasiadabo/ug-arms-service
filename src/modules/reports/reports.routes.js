/**
 * HTTP routes for the reports centre, mounted at /api/v1/reports. Requires "reports.view", "audit.read" or
 * "preservation.read"; each report also checks its own permission.
 *
 * - GET / lists the reports available to the caller.
 * - GET /:key runs a report on screen for a date range.
 * - POST /:key/export exports a report as CSV, Excel or PDF. Small exports are produced immediately; large ones are
 *   queued.
 * - GET /exports and GET /exports/:id/download list and download the caller's exports.
 *
 * Every export is recorded and audited.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { authenticate, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { notFound, forbidden, badRequest } from '../../utils/errors.js';
import { storage } from '../../services/storage/index.js';
import { audit } from '../../services/audit.service.js';
import * as svc from './reports.service.js';
import { REPORTS } from './catalog.js';

const router = Router();
router.use(authenticate, requireAnyPermission('reports.view', 'audit.read', 'preservation.read'));
const filters = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * @openapi
 * /reports:
 *   get: { tags: [Reports], summary: Reports available to the caller, responses: { 200: { description: Catalogue } } }
 * /reports/{key}:
 *   get: { tags: [Reports], summary: Run a report and return rows as JSON (preview), responses: { 200: { description: Rows } } }
 * /reports/{key}/export:
 *   post: { tags: [Reports], summary: Export as csv, xlsx or pdf. Large results are queued and a job id is returned (202)., responses: { 200: { description: File }, 202: { description: Queued } } }
 */
router.get('/', (req, res) => res.json({ data: svc.available(req.user) }));

router.get('/exports', async (req, res) => {
  res.json({
    data: await models.ExportJob.findAll({
      where: { requestedById: req.user.id },
      attributes: { exclude: ['storageKey'] },
      order: [['createdAt', 'DESC']],
      limit: 50,
    }),
  });
});

router.get('/exports/:id/download', validate({ params: idParams }), async (req, res) => {
  const job = await models.ExportJob.findByPk(req.params.id);
  if (!job || job.requestedById !== req.user.id) throw notFound('Export');
  if (job.status !== 'succeeded' || !job.storageKey) throw badRequest('This export is not ready');
  if (job.expiresAt && job.expiresAt < new Date()) throw badRequest('This export has expired. Run it again.');
  if (!REPORTS[job.reportType] || !req.user.permissions.has(REPORTS[job.reportType].perm)) throw forbidden();
  await audit({ action: 'report.download', resourceType: 'ExportJob', resourceId: job.id, sensitive: job.isSensitive });
  const obj = await storage.get(job.storageKey);
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  res.setHeader(
    'Content-Type',
    {
      csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pdf: 'application/pdf',
    }[job.format] || 'application/octet-stream',
  );
  obj.body.pipe(res);
});

router.get('/:key', validate({ params: z.object({ key: z.string().max(80) }), query: filters }), async (req, res) => {
  const { report, rows } = await svc.runReport(req.params.key, req.query, req.user);
  res.json({
    data: {
      key: req.params.key,
      title: report.title,
      columns: report.columns,
      rows: rows.slice(0, 1000),
      total: rows.length,
      truncated: rows.length > 1000,
    },
  });
});

router.post(
  '/:key/export',
  requireAnyPermission('reports.export', 'audit.read'),
  validate({
    params: z.object({ key: z.string().max(80) }),
    body: filters.extend({ format: z.enum(['csv', 'xlsx', 'pdf']) }),
  }),
  async (req, res) => {
    const { format, ...f } = req.body;
    const { report, rows } = await svc.runReport(req.params.key, f, req.user);
    if (rows.length > svc.INLINE_ROW_LIMIT) {
      const job = await svc.queueExport(req.params.key, format, f, req.user);
      return res.status(202).json({ data: { exportJobId: job.id, status: 'queued', rows: rows.length } });
    }
    const out = await svc.render(report, rows, format, f);
    const filename = `${req.params.key}-${new Date().toISOString().slice(0, 10)}.${out.ext}`;
    await svc.recordExport(req.params.key, format, f, req.user, { rowCount: rows.length, filename });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(out.buffer);
  },
);

export default router;
