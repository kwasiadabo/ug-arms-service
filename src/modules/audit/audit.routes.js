/**
 * HTTP routes for the audit trail, mounted at /api/v1/audit. Every route requires "audit.read" and is read-only.
 *
 * - GET /events searches events by actor, action, resource, outcome, correlation ID and date range.
 * - GET /events/export exports the filtered events as CSV; the export itself is audited.
 * - GET /verify-chain recomputes the hash chain and reports whether the trail is intact.
 * - GET /workflow-history lists workflow steps for an item.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { stringify } from 'csv-stringify';
import { models } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { paginationSchema, pageParams } from '../../utils/pagination.js';
import { audit, verifyChain } from '../../services/audit.service.js';
import { csvSafeRow } from '../../services/spreadsheet.service.js';

const router = Router();
router.use(authenticate, requirePermission('audit.read'));

const filters = paginationSchema.extend({
  actorUserId: z.string().uuid().optional(),
  action: z.string().max(120).optional(),
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().max(64).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  correlationId: z.string().max(64).optional(),
});

/**
 * Translates the audit search filters into a Sequelize `where` clause.
 *
 * Actions match by prefix, so "accession" finds every accession action. A date-only "to" value includes the whole
 * day. The free-text term matches the actor label or the action, or exactly matches a resource ID.
 *
 * @param {object} q Validated query parameters.
 * @returns {object} The `where` clause.
 */
function buildWhere(q) {
  const where = {};
  if (q.actorUserId) where.actorUserId = q.actorUserId;
  if (q.action) where.action = { [Op.like]: `${q.action}%` };
  if (q.resourceType) where.resourceType = q.resourceType;
  if (q.resourceId) where.resourceId = q.resourceId;
  if (q.outcome) where.outcome = q.outcome;
  if (q.correlationId) where.correlationId = q.correlationId;
  if (q.from || q.to)
    where.occurredAt = {
      ...(q.from && { [Op.gte]: new Date(q.from) }),
      ...(q.to && { [Op.lte]: new Date(q.to.length === 10 ? `${q.to}T23:59:59Z` : q.to) }),
    };
  if (q.q)
    where[Op.or] = [
      { actorLabel: { [Op.like]: `%${q.q}%` } },
      { action: { [Op.like]: `%${q.q}%` } },
      { resourceId: q.q },
    ];
  return where;
}

/**
 * @openapi
 * /audit/events:
 *   get: { tags: [Audit], summary: Search audit events (audit.read), responses: { 200: { description: Paged events } } }
 */
router.get('/events', validate({ query: filters }), async (req, res) => {
  const { rows, count } = await models.AuditEvent.findAndCountAll({
    where: buildWhere(req.query),
    order: [['seq', 'DESC']],
    ...pageParams(req.query),
  });
  res.json({
    data: rows,
    meta: {
      page: req.query.page,
      pageSize: req.query.pageSize,
      total: count,
      totalPages: Math.ceil(count / req.query.pageSize),
    },
  });
});

router.get('/events/export', validate({ query: filters }), async (req, res) => {
  const where = buildWhere(req.query);
  await audit({
    action: 'audit.export',
    resourceType: 'AuditEvent',
    metadata: { filters: req.query },
    sensitive: true,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="audit-events-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  const csv = stringify({
    header: true,
    columns: [
      'seq',
      'eventId',
      'occurredAt',
      'actorLabel',
      'action',
      'resourceType',
      'resourceId',
      'outcome',
      'correlationId',
      'ipAddress',
      'reason',
      'hash',
    ],
  });
  csv.pipe(res);
  let lastSeq = null;
  for (;;) {
    const batch = await models.AuditEvent.findAll({
      where: lastSeq ? { ...where, seq: { [Op.lt]: lastSeq } } : where,
      order: [['seq', 'DESC']],
      limit: 2000,
      raw: true,
    });
    if (!batch.length) break;
    for (const e of batch) csv.write(csvSafeRow({ ...e, occurredAt: new Date(e.occurredAt).toISOString() }));
    lastSeq = batch[batch.length - 1].seq;
  }
  csv.end();
});

router.get('/verify-chain', async (req, res) => {
  const result = await verifyChain();
  await audit({ action: 'audit.verify_chain', resourceType: 'AuditEvent', metadata: result });
  res.json({ data: result });
});

router.get(
  '/workflow-history',
  validate({ query: z.object({ entityType: z.string().max(60), entityId: z.string().uuid() }) }),
  async (req, res) => {
    const rows = await models.WorkflowHistory.findAll({
      where: { entityType: req.query.entityType, entityId: req.query.entityId },
      include: [{ model: models.User, as: 'actor', attributes: ['id', 'fullName', 'email'] }],
      order: [['createdAt', 'ASC']],
    });
    res.json({ data: rows });
  },
);

export default router;
