/**
 * HTTP routes for staff search, mounted at /api/v1/search.
 *
 * - GET / searches descriptions and approved OCR text, filtered by the caller's access, with facets ("records.read"
 *   or "transfer.submit").
 * - GET /suggest suggests titles, creators and subjects.
 * - GET /recent lists the caller's recent searches; GET /saved, POST /saved and DELETE /saved/:id manage saved
 *   searches.
 * - GET /analytics summarises search use ("reports.view").
 *
 * `searchQuery` is the shared schema of search parameters, also used by the public portal.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op, literal } from 'sequelize';
import { models } from '../../database/models/index.js';
import { authenticate, requireAnyPermission, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { notFound } from '../../utils/errors.js';
import * as svc from './search.service.js';

export const searchQuery = z.object({
  q: z.string().max(300).optional().default(''),
  page: z.coerce.number().int().min(1).max(500).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['relevance', 'date_asc', 'date_desc', 'title', 'reference', 'recent']).default('relevance'),
  level: z.string().max(100).optional(),
  collectionId: z.string().uuid().optional(),
  creatorId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  repositoryId: z.string().uuid().optional(),
  originatingUnitId: z.string().uuid().optional(),
  format: z.string().max(60).optional(),
  language: z.string().max(60).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}(-\d{2}-\d{2})?$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}(-\d{2}-\d{2})?$/)
    .optional(),
  hasDigital: z.enum(['true', 'false']).optional(),
  facets: z.enum(['true', 'false']).optional(),
  includeOcr: z.enum(['true', 'false']).optional(),
});

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /search:
 *   get:
 *     tags: [Search]
 *     summary: Staff search across descriptions and approved OCR text, filtered by the caller's access. Supports "phrases", -exclusion, field:value (title, ref, creator, subject, place, date) and OR.
 *     responses: { 200: { description: Results with facets } }
 */
router.get(
  '/',
  requireAnyPermission('records.read', 'transfer.submit'),
  validate({
    query: searchQuery.extend({ accessLevel: z.string().max(40).optional(), status: z.string().max(100).optional() }),
  }),
  async (req, res) => {
    res.json({ data: await svc.search(req.user, { ...req.query, scope: 'staff' }) });
  },
);

router.get('/suggest', validate({ query: z.object({ q: z.string().max(100) }) }), async (req, res) => {
  res.json({ data: await svc.suggest(req.user, req.query.q, 'staff') });
});

router.get('/recent', async (req, res) => {
  const rows = await models.SearchLog.findAll({
    where: { userId: req.user.id, queryText: { [Op.ne]: '' } },
    attributes: ['queryText', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit: 30,
  });
  const seen = new Set();
  res.json({ data: rows.filter((r) => !seen.has(r.queryText) && seen.add(r.queryText)).slice(0, 10) });
});

router.get('/saved', async (req, res) =>
  res.json({
    data: await models.SavedSearch.findAll({ where: { userId: req.user.id }, order: [['createdAt', 'DESC']] }),
  }),
);
router.post(
  '/saved',
  validate({ body: z.object({ name: z.string().trim().min(1).max(200), query: z.record(z.string(), z.any()) }) }),
  async (req, res) => {
    if ((await models.SavedSearch.count({ where: { userId: req.user.id } })) >= 100)
      throw notFound('Saved search slot');
    res.status(201).json({ data: await models.SavedSearch.create({ userId: req.user.id, ...req.body }) });
  },
);
router.delete('/saved/:id', validate({ params: idParams }), async (req, res) => {
  await models.SavedSearch.destroy({ where: { id: req.params.id, userId: req.user.id } });
  res.status(204).end();
});

router.get(
  '/analytics',
  requirePermission('reports.view'),
  validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
  async (req, res) => {
    const since = new Date(Date.now() - req.query.days * 86400_000);
    const [top, zero, volume] = await Promise.all([
      models.SearchLog.findAll({
        where: { createdAt: { [Op.gte]: since }, queryText: { [Op.ne]: '' } },
        attributes: ['queryText', [literal('COUNT(*)'), 'count']],
        group: ['queryText'],
        order: [[literal('COUNT(*)'), 'DESC']],
        limit: 20,
        raw: true,
      }),
      models.SearchLog.findAll({
        where: { createdAt: { [Op.gte]: since }, resultCount: 0, queryText: { [Op.ne]: '' } },
        attributes: ['queryText', [literal('COUNT(*)'), 'count']],
        group: ['queryText'],
        order: [[literal('COUNT(*)'), 'DESC']],
        limit: 20,
        raw: true,
      }),
      models.SearchLog.findAll({
        where: { createdAt: { [Op.gte]: since } },
        attributes: ['scope', [literal('COUNT(*)'), 'count'], [literal('AVG(CAST(durationMs AS FLOAT))'), 'avgMs']],
        group: ['scope'],
        raw: true,
      }),
    ]);
    res.json({ data: { topQueries: top, zeroResultQueries: zero, volume } });
  },
);

export default router;
