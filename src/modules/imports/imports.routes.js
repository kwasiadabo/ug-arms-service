/**
 * HTTP routes for bulk imports from CSV or Excel files, mounted at /api/v1/imports. Requires "imports.manage".
 *
 * - GET /templates lists the import types and their fields.
 * - GET / and POST / list imports and upload a new file.
 * - GET /:id returns an import with its reconciliation figures.
 * - PUT /:id/mapping saves the column mapping.
 * - POST /:id/validate checks every row without writing anything (a dry run).
 * - POST /:id/run imports the valid rows in the background.
 * - POST /:id/approve records sign-off of the reconciliation by a second person.
 * - GET /:id/rows lists the per-row results; GET /:id/rejected.csv downloads rejected rows for correction.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { history } from '../../services/workflow.service.js';
import * as svc from './imports.service.js';
import { TEMPLATES } from './templates.js';

const router = Router();
router.use(authenticate, requirePermission('imports.manage'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/**
 * @openapi
 * /imports/templates:
 *   get: { tags: [Imports], summary: Import templates and their fields, responses: { 200: { description: Templates } } }
 * /imports:
 *   post: { tags: [Imports], summary: Upload a CSV/XLSX (multipart "file", field importType). Returns detected headers, suggested mapping and sample rows., responses: { 201: { description: Uploaded } } }
 */
router.get('/templates', (req, res) =>
  res.json({
    data: Object.entries(TEMPLATES).map(([key, t]) => ({
      key,
      label: t.label,
      keyField: t.keyField,
      fields: Object.entries(t.fields).map(([name, f]) => ({ name, ...f })),
    })),
  }),
);

router.get('/', validate({ query: paginationSchema }), async (req, res) => {
  paged(
    res,
    await models.ImportJob.findAndCountAll({
      attributes: { exclude: ['storageKey'] },
      ...pageParams(req.query),
      order: [['createdAt', 'DESC']],
      include: [{ model: models.User, as: 'createdBy', attributes: ['id', 'fullName'] }],
    }),
    req.query,
  );
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Upload a CSV or Excel file in the "file" field');
  const importType = z.enum(Object.keys(TEMPLATES)).parse(req.body.importType);
  const { job, sample } = await svc.createJob(req.file, importType, req.user);
  const plain = job.get({ plain: true });
  delete plain.storageKey;
  res.status(201).json({ data: { ...plain, sample } });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const job = await models.ImportJob.findByPk(req.params.id, {
    attributes: { exclude: ['storageKey'] },
    include: [
      { model: models.User, as: 'createdBy', attributes: ['id', 'fullName'] },
      { model: models.User, as: 'approvedBy', attributes: ['id', 'fullName'] },
    ],
  });
  if (!job) throw notFound('Import');
  res.json({
    data: {
      ...job.get({ plain: true }),
      reconciliation: await svc.reconciliation(job.id),
      history: await history('ImportJob', job.id),
    },
  });
});

router.put(
  '/:id/mapping',
  validate({ params: idParams, body: z.object({ mapping: z.record(z.string(), z.string().nullable()) }) }),
  async (req, res) => {
    const job = await models.ImportJob.findByPk(req.params.id);
    if (!job) throw notFound('Import');
    if (['running', 'cancelled'].includes(job.status)) throw badRequest('Mapping cannot be changed now');
    const fields = Object.keys(TEMPLATES[job.importType].fields);
    for (const [col, field] of Object.entries(req.body.mapping)) {
      if (!job.headers.includes(col)) throw badRequest(`Unknown column "${col}"`);
      if (field && !fields.includes(field)) throw badRequest(`Unknown field "${field}"`);
    }
    await job.update({ mapping: req.body.mapping });
    await audit({
      action: 'import.mapping_updated',
      resourceType: 'ImportJob',
      resourceId: job.id,
      after: { mapping: req.body.mapping },
    });
    res.json({ data: { mapping: job.mapping } });
  },
);

router.post('/:id/validate', validate({ params: idParams }), async (req, res) =>
  res.json({ data: await svc.validateJob(req.params.id, req.user) }),
);
router.post('/:id/run', validate({ params: idParams }), async (req, res) =>
  res.status(202).json({ data: await svc.startRun(req.params.id, req.user) }),
);
router.post(
  '/:id/approve',
  validate({ params: idParams, body: z.object({ note: z.string().max(2000).optional() }) }),
  async (req, res) => res.json({ data: await svc.approveCompletion(req.params.id, req.user, req.body.note) }),
);

router.get(
  '/:id/rows',
  validate({ params: idParams, query: paginationSchema.extend({ status: z.string().max(80).optional() }) }),
  async (req, res) => {
    const where = { jobId: req.params.id };
    if (req.query.status) where.status = req.query.status.split(',');
    paged(
      res,
      await models.ImportRowResult.findAndCountAll({ where, ...pageParams(req.query), order: [['rowNumber', 'ASC']] }),
      req.query,
    );
  },
);

router.get('/:id/rejected.csv', validate({ params: idParams }), async (req, res) => {
  await audit({ action: 'import.rejected_rows_exported', resourceType: 'ImportJob', resourceId: req.params.id });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${req.params.id}-rejected.csv"`);
  res.send(await svc.rejectedCsv(req.params.id));
});

export default router;
