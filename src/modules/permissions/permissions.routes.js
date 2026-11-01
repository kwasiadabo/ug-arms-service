/**
 * HTTP routes for access control on descriptions and files, mounted at /api/v1/permissions.
 *
 * - GET /records/:id summarises a description's access: its own and inherited levels, restrictions, exceptions,
 *   grants and recent change requests.
 * - PUT /records/:id/level changes a description's access level ("records.restrict").
 * - POST /records/:id/restrictions and POST /assets/:id/restrictions add restrictions; POST /restrictions/:id/lift
 *   requests their removal.
 * - POST /records/:id/exceptions requests an inheritance exception; POST /exceptions/:id/revoke revokes one
 *   ("permissions.approve").
 * - GET /requests and POST /requests/:id/decision list and decide pending access changes ("permissions.approve").
 * - POST /grants and POST /grants/:id/revoke manage individual access grants ("permissions.approve").
 * - GET /review-queue lists restrictions and embargoes that have reached their review date.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { ACCESS_LEVELS } from '../../database/models/archival.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, isoDate } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import * as svc from './permissions.service.js';

const router = Router();
router.use(authenticate);

const restrictionBody = z.object({
  restrictionType: z.enum([
    'staff_only',
    'restricted',
    'embargoed',
    'confidential',
    'closed',
    'onsite_only',
    'view_only',
    'no_download',
    'reproduction_by_permission',
    'copyright',
    'personal_data',
  ]),
  legalBasis: z.string().trim().max(1000).optional(),
  effectiveFrom: isoDate,
  expiresAt: isoDate,
  reviewDate: isoDate,
  publicExplanation: z.string().trim().max(1000).optional(),
  internalNotes: z.string().trim().max(8000).optional(),
});
const reasonReq = z.object({ reason: z.string().trim().min(3).max(2000) });

/**
 * @openapi
 * /permissions/records/{id}:
 *   get: { tags: [Access], summary: Effective access, restrictions, exceptions, grants and pending changes for a description, responses: { 200: { description: Summary } } }
 * /permissions/records/{id}/level:
 *   put: { tags: [Access], summary: Change access level (tightening is immediate; loosening needs second approval), responses: { 200: { description: Applied or pending } } }
 */
router.get(
  '/records/:id',
  requireAnyPermission('records.restrict', 'permissions.approve'),
  validate({ params: idParams }),
  async (req, res) => {
    res.json({ data: await svc.accessSummary(req.params.id) });
  },
);

router.put(
  '/records/:id/level',
  requirePermission('records.restrict'),
  validate({
    params: idParams,
    body: z.object({
      accessLevel: z.enum(ACCESS_LEVELS),
      embargoUntil: isoDate,
      reason: z.string().trim().min(3).max(2000),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.changeAccessLevel(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/records/:id/restrictions',
  requirePermission('records.restrict'),
  validate({ params: idParams, body: restrictionBody }),
  async (req, res) => {
    res.status(201).json({ data: await svc.addRestriction('record', req.params.id, req.body, req.user) });
  },
);
router.post(
  '/assets/:id/restrictions',
  requirePermission('records.restrict'),
  validate({ params: idParams, body: restrictionBody }),
  async (req, res) => {
    res.status(201).json({ data: await svc.addRestriction('asset', req.params.id, req.body, req.user) });
  },
);

router.post(
  '/restrictions/:id/lift',
  requirePermission('records.restrict'),
  validate({ params: idParams, body: reasonReq }),
  async (req, res) => {
    res.json({ data: await svc.requestLiftRestriction(req.params.id, req.body.reason, req.user) });
  },
);

router.post(
  '/records/:id/exceptions',
  requirePermission('records.restrict'),
  validate({
    params: idParams,
    body: z.object({ grantedAccessLevel: z.enum(ACCESS_LEVELS), reason: z.string().trim().min(10).max(1000) }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.requestException(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/exceptions/:id/revoke',
  requirePermission('permissions.approve'),
  validate({ params: idParams, body: reasonReq }),
  async (req, res) => {
    await svc.revokeException(req.params.id, req.body.reason, req.user);
    res.json({ data: { ok: true } });
  },
);

/**
 * @openapi
 * /permissions/requests:
 *   get: { tags: [Access], summary: Access change requests (permissions.approve), responses: { 200: { description: Paged requests } } }
 */
router.get(
  '/requests',
  requireAnyPermission('permissions.approve', 'records.restrict'),
  validate({
    query: paginationSchema.extend({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    const result = await models.AccessChangeRequest.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      ...pageParams(req.query),
      include: [
        { model: models.User, as: 'requestedBy', attributes: ['id', 'fullName'] },
        { model: models.User, as: 'decidedBy', attributes: ['id', 'fullName'] },
      ],
    });
    const recordIds = result.rows.filter((r) => r.targetType === 'record').map((r) => r.targetId);
    const records = new Map(
      (
        await models.ArchivalRecord.findAll({ where: { id: recordIds }, attributes: ['id', 'referenceCode', 'title'] })
      ).map((r) => [r.id, r]),
    );
    result.rows = result.rows.map((r) => ({ ...r.get({ plain: true }), target: records.get(r.targetId) ?? null }));
    paged(res, result, req.query);
  },
);

router.post(
  '/requests/:id/decision',
  requirePermission('permissions.approve'),
  validate({
    params: idParams,
    body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(3).max(2000) }),
  }),
  async (req, res) => {
    res.json({ data: await svc.decideRequest(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/grants',
  requirePermission('permissions.approve'),
  validate({
    body: z.object({
      userId: z.string().uuid(),
      targetType: z.enum(['record', 'asset']),
      targetId: z.string().uuid(),
      permissionLevel: z.enum(['view', 'download']).default('view'),
      expiresAt: z.string().datetime({ offset: true }).optional(),
      includeDescendants: z.boolean().default(true),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.grantAccess(req.body, req.user) });
  },
);
router.post(
  '/grants/:id/revoke',
  requirePermission('permissions.approve'),
  validate({ params: idParams, body: reasonReq }),
  async (req, res) => {
    await svc.revokeGrant(req.params.id, req.body.reason, req.user);
    res.json({ data: { ok: true } });
  },
);

router.get('/review-queue', requireAnyPermission('records.restrict', 'permissions.approve'), async (req, res) => {
  const [restrictions, embargoes] = await Promise.all([
    models.AccessRestriction.findAll({
      where: { status: 'expired_pending_review' },
      order: [['expiresAt', 'ASC']],
      limit: 200,
    }),
    models.ArchivalRecord.findAll({
      where: { accessLevel: 'embargoed', embargoUntil: { [Op.lte]: new Date().toISOString().slice(0, 10) } },
      attributes: ['id', 'referenceCode', 'title', 'embargoUntil'],
      limit: 200,
    }),
  ]);
  res.json({ data: { restrictions, embargoes } });
});

export default router;
