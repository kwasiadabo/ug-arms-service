/**
 * HTTP routes for retention schedules and legal holds.
 *
 * `retentionRouter` is mounted at /api/v1/retention:
 * - GET /schedules, POST /schedules and PATCH /schedules/:id list, create and edit schedules ("retention.manage");
 * - POST /schedules/:id/status approves or retires a schedule ("appraisal.approve"); only approved schedules are
 *   applied;
 * - GET /due lists records whose retention period under an approved schedule has elapsed and that are not permanent
 *   holdings. Being due only means a review is needed, never that disposal is authorised.
 *
 * `holdsRouter` is mounted at /api/v1/legal-holds:
 * - GET / lists holds;
 * - POST / places a hold, which takes effect immediately and blocks any disposal not yet executed
 *   ("legalhold.manage");
 * - POST /:id/release releases a hold; it must be done by a different person from the one who placed it.
 *
 * Placing or releasing a hold queues the Object Lock sweep, which mirrors active holds onto the stored files as S3
 * legal holds (see services/objectLock.service.js).
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { notFound, badRequest, conflict } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { assertSeparationOfDuties } from '../../services/workflow.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { notifyPermissionHolders } from '../../services/notification.service.js';
import { enqueue } from '../../services/queue.service.js';
import { holdsFor } from './holds.service.js';

export const retentionRouter = Router();
export const holdsRouter = Router();
retentionRouter.use(authenticate, requireAnyPermission('retention.manage', 'appraisal.create', 'appraisal.approve'));
holdsRouter.use(authenticate, requireAnyPermission('legalhold.manage', 'appraisal.create', 'appraisal.approve'));

const scheduleBody = z.object({
  code: z.string().trim().min(2).max(60),
  title: z.string().trim().min(3).max(500),
  recordCategory: z.string().trim().min(2).max(255),
  description: optionalText(20000),
  triggerEvent: z.string().trim().min(2).max(255),
  retentionYears: z.number().int().min(0).max(1000).nullable().optional(),
  finalAction: z.enum(['permanent', 'review', 'transfer_to_archives', 'destroy', 'return_to_department']),
  legalBasis: optionalText(2000),
  policyNote: optionalText(2000),
});

/**
 * @openapi
 * /retention/schedules:
 *   get: { tags: [Retention], summary: Retention schedules (configurable; not official University policy until approved), responses: { 200: { description: Schedules } } }
 *   post: { tags: [Retention], summary: Draft a schedule (retention.manage), responses: { 201: { description: Created } } }
 */
retentionRouter.get('/schedules', async (req, res) =>
  res.json({
    data: await models.RetentionSchedule.findAll({
      order: [['code', 'ASC']],
      include: [{ model: models.User, as: 'approvedBy', attributes: ['id', 'fullName'] }],
    }),
  }),
);
retentionRouter.post(
  '/schedules',
  requirePermission('retention.manage'),
  validate({ body: scheduleBody }),
  async (req, res) => {
    if (await models.RetentionSchedule.findOne({ where: { code: req.body.code } }))
      throw conflict('Schedule code exists');
    const s = await models.RetentionSchedule.create({ ...req.body, status: 'draft' });
    await audit({
      action: 'retention.schedule_created',
      resourceType: 'RetentionSchedule',
      resourceId: s.id,
      after: req.body,
    });
    res.status(201).json({ data: s });
  },
);
retentionRouter.patch(
  '/schedules/:id',
  requirePermission('retention.manage'),
  validate({ params: idParams, body: scheduleBody.partial().omit({ code: true }) }),
  async (req, res) => {
    const s = await models.RetentionSchedule.findByPk(req.params.id);
    if (!s) throw notFound('Schedule');
    if (s.status === 'approved')
      throw badRequest('Approved schedules cannot be edited. Retire it and draft a new version.');
    const before = s.get({ plain: true });
    await s.update(req.body);
    const d = diff(before, s);
    await audit({
      action: 'retention.schedule_updated',
      resourceType: 'RetentionSchedule',
      resourceId: s.id,
      before: d.before,
      after: d.after,
    });
    res.json({ data: s });
  },
);
retentionRouter.post(
  '/schedules/:id/status',
  requirePermission('appraisal.approve'),
  validate({
    params: idParams,
    body: z.object({ status: z.enum(['approved', 'retired']), reason: z.string().trim().min(3).max(2000) }),
  }),
  async (req, res) => {
    const s = await models.RetentionSchedule.findByPk(req.params.id);
    if (!s) throw notFound('Schedule');
    if (req.body.status === 'approved' && s.status !== 'draft')
      throw badRequest('Only draft schedules can be approved');
    await s.update({
      status: req.body.status,
      ...(req.body.status === 'approved' && { approvedById: req.user.id, approvedAt: new Date() }),
    });
    await audit({
      action: `retention.schedule_${req.body.status}`,
      resourceType: 'RetentionSchedule',
      resourceId: s.id,
      reason: req.body.reason,
      sensitive: true,
    });
    res.json({ data: s });
  },
);

/**
 * @openapi
 * /retention/due:
 *   get: { tags: [Retention], summary: Departmental (non-permanent) records whose retention period has elapsed and need review. Nothing is disposed automatically., responses: { 200: { description: Due records } } }
 */
retentionRouter.get('/due', async (req, res) => {
  const schedules = await models.RetentionSchedule.findAll({
    where: { status: 'approved', retentionYears: { [Op.ne]: null } },
  });
  const due = [];
  for (const s of schedules) {
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - s.retentionYears);
    const rows = await models.ArchivalRecord.findAll({
      where: {
        retentionScheduleId: s.id,
        retentionTriggerDate: { [Op.lte]: cutoff.toISOString().slice(0, 10) },
        [Op.or]: [{ isPermanent: false }, { custodyStatus: 'departmental' }],
      },
      attributes: ['id', 'referenceCode', 'title', 'retentionTriggerDate', 'custodyStatus', 'isPermanent'],
      limit: 500,
    });
    for (const r of rows)
      due.push({
        ...r.get({ plain: true }),
        schedule: { id: s.id, code: s.code, finalAction: s.finalAction, retentionYears: s.retentionYears },
      });
  }
  res.json({ data: due });
});

/**
 * @openapi
 * /legal-holds:
 *   get: { tags: [Retention], summary: Legal holds, responses: { 200: { description: Holds } } }
 *   post: { tags: [Retention], summary: Place a legal hold (blocks disposal of covered material), responses: { 201: { description: Placed } } }
 */
holdsRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ status: z.enum(['active', 'released']).optional() }) }),
  async (req, res) => {
    const where = req.query.status ? { status: req.query.status } : {};
    paged(
      res,
      await models.LegalHold.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['placedAt', 'DESC']],
        include: [
          {
            model: models.LegalHoldItem,
            as: 'items',
            include: [{ model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] }],
          },
          { model: models.User, as: 'placedBy', attributes: ['id', 'fullName'] },
        ],
        distinct: true,
      }),
      req.query,
    );
  },
);
holdsRouter.post(
  '/',
  requirePermission('legalhold.manage'),
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(500),
      description: optionalText(20000),
      authority: optionalText(500),
      items: z
        .array(
          z.object({
            recordId: uuid.optional(),
            assetId: uuid.optional(),
            physicalItemId: uuid.optional(),
            includeDescendants: z.boolean().default(true),
          }),
        )
        .min(1)
        .max(500),
    }),
  }),
  async (req, res) => {
    const hold = await sequelize.transaction(async (t) => {
      const h = await models.LegalHold.create(
        {
          reference: await generateReference('legal_hold', t),
          title: req.body.title,
          description: req.body.description,
          authority: req.body.authority,
          placedById: req.user.id,
          placedAt: new Date(),
          status: 'active',
        },
        { transaction: t },
      );
      for (const it of req.body.items) await models.LegalHoldItem.create({ holdId: h.id, ...it }, { transaction: t });
      // Block any not-yet-executed disposal whose targets are now covered by this hold.
      const open = await models.DisposalCase.findAll({
        where: { status: ['draft', 'pending_approval', 'approved'] },
        transaction: t,
      });
      for (const d of open) {
        for (const target of d.dryRunSnapshot?.targets || []) {
          const key =
            target.type === 'digital_asset'
              ? { assetId: target.id }
              : target.type === 'physical_item'
                ? { physicalItemId: target.id }
                : { recordId: target.id };
          if ((await holdsFor(key, t)).some((x) => x.holdId === h.id)) {
            await d.update({ status: 'blocked', blockReason: `Legal hold ${h.reference} placed` }, { transaction: t });
            break;
          }
        }
      }
      await audit(
        {
          action: 'legal_hold.placed',
          resourceType: 'LegalHold',
          resourceId: h.id,
          after: { reference: h.reference, items: req.body.items.length },
          sensitive: true,
        },
        { transaction: t },
      );
      // Mirror the hold onto the stored files as S3 legal holds once the hold is committed.
      await enqueue(
        'maintenance',
        'preservation.object_lock_sweep',
        {},
        { entityType: 'LegalHold', entityId: h.id, transaction: t },
      );
      return h;
    });
    await notifyPermissionHolders(['disposal.approve', 'disposal.execute'], {
      eventType: 'disposal.approval',
      title: `Legal hold placed: ${hold.reference}`,
      body: hold.title,
      link: '/admin/legal-holds',
    });
    res.status(201).json({ data: hold });
  },
);
holdsRouter.post(
  '/:id/release',
  requirePermission('legalhold.manage'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(5).max(2000) }) }),
  async (req, res) => {
    const h = await models.LegalHold.findByPk(req.params.id);
    if (!h || h.status !== 'active') throw notFound('Active legal hold');
    await assertSeparationOfDuties(
      req.user.id,
      [h.placedById],
      'A legal hold must be released by someone other than the person who placed it',
    );
    await sequelize.transaction(async (t) => {
      await h.update(
        { status: 'released', releasedById: req.user.id, releasedAt: new Date(), releaseReason: req.body.reason },
        { transaction: t },
      );
      await audit(
        {
          action: 'legal_hold.released',
          resourceType: 'LegalHold',
          resourceId: h.id,
          reason: req.body.reason,
          sensitive: true,
        },
        { transaction: t },
      );
      // Lift the S3 legal holds on files no other active hold covers.
      await enqueue(
        'maintenance',
        'preservation.object_lock_sweep',
        {},
        { entityType: 'LegalHold', entityId: h.id, transaction: t },
      );
    });
    res.json({ data: h });
  },
);
