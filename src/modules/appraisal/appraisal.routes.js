/**
 * HTTP routes for appraisal and disposal.
 *
 * `appraisalRouter` is mounted at /api/v1/appraisal and requires "appraisal.create" or "appraisal.approve":
 * - GET /cases and POST /cases list and open appraisal cases;
 * - GET /cases/:id returns a case with its items, eligibility, available actions and history;
 * - POST /cases/:id/report refreshes eligibility and stores a summary;
 * - POST /cases/:id/transition performs a workflow action;
 * - POST /cases/:id/items/:itemId/exclude removes an item from consideration.
 *
 * `disposalRouter` is mounted at /api/v1/disposal and requires one of "appraisal.create", "disposal.approve" or
 * "disposal.execute":
 * - GET /cases and POST /cases list and create disposal cases from approved appraisals;
 * - GET /cases/:id returns a case with its dry run, approvals and certificate;
 * - POST /cases/:id/dry-run regenerates the dry run;
 * - POST /cases/:id/request-approval, /approve and /execute move the case through approval to execution;
 * - POST /cases/:id/destroy-files retries the destruction of stored files that an execution could not destroy;
 * - GET /certificates/:id/pdf downloads a disposal certificate (the download is audited).
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { APPRAISAL_STATUSES } from '../../database/models/governance.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { notFound } from '../../utils/errors.js';
import { history } from '../../services/workflow.service.js';
import { storage } from '../../services/storage/index.js';
import { audit } from '../../services/audit.service.js';
import * as svc from './appraisal.service.js';

export const appraisalRouter = Router();
export const disposalRouter = Router();
appraisalRouter.use(authenticate, requireAnyPermission('appraisal.create', 'appraisal.approve'));
disposalRouter.use(authenticate, requireAnyPermission('appraisal.create', 'disposal.approve', 'disposal.execute'));

/**
 * @openapi
 * /appraisal/cases:
 *   get: { tags: [Appraisal], summary: Appraisal cases, responses: { 200: { description: Paged } } }
 *   post: { tags: [Appraisal], summary: Open a case; eligibility (holds, permanent status, active requests) is checked per item, responses: { 201: { description: Created } } }
 */
appraisalRouter.get(
  '/cases',
  validate({ query: paginationSchema.extend({ status: z.enum(APPRAISAL_STATUSES).optional() }) }),
  async (req, res) => {
    const where = req.query.status ? { status: req.query.status } : {};
    paged(
      res,
      await models.AppraisalCase.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['createdAt', 'DESC']],
        include: [
          { model: models.RetentionSchedule, as: 'schedule', attributes: ['id', 'code', 'title'] },
          { model: models.AppraisalCaseItem, as: 'items', attributes: ['id', 'eligibility'] },
        ],
        distinct: true,
      }),
      req.query,
    );
  },
);
appraisalRouter.post(
  '/cases',
  requirePermission('appraisal.create'),
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(500),
      scheduleId: uuid.nullable().optional(),
      items: z
        .array(
          z
            .object({
              recordId: uuid.optional(),
              physicalItemId: uuid.optional(),
              assetId: uuid.optional(),
              triggerDate: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional(),
            })
            .refine(
              (i) => i.recordId || i.physicalItemId || i.assetId,
              'Each item needs a record, physical item or file',
            ),
        )
        .min(1)
        .max(2000),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.createCase(req.body, req.user) });
  },
);
appraisalRouter.get('/cases/:id', validate({ params: idParams }), async (req, res) => {
  const c = await models.AppraisalCase.findByPk(req.params.id, {
    include: [
      { model: models.RetentionSchedule, as: 'schedule' },
      { model: models.User, as: 'openedBy', attributes: ['id', 'fullName'] },
      { model: models.User, as: 'recommendedBy', attributes: ['id', 'fullName'] },
      { model: models.User, as: 'decidedBy', attributes: ['id', 'fullName'] },
      {
        model: models.AppraisalCaseItem,
        as: 'items',
        include: [
          {
            model: models.ArchivalRecord,
            as: 'record',
            attributes: ['id', 'referenceCode', 'title', 'isPermanent', 'custodyStatus'],
          },
          { model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title'] },
          { model: models.DigitalAsset, as: 'asset', attributes: ['id', 'originalFilename', 'role'] },
        ],
      },
      { model: models.DisposalCase, as: 'disposalCases', attributes: ['id', 'caseNumber', 'status', 'action'] },
    ],
  });
  if (!c) throw notFound('Appraisal case');
  res.json({
    data: {
      ...c.get({ plain: true }),
      history: await history('AppraisalCase', c.id),
      availableActions: svc.caseActions(c, req.user),
    },
  });
});
appraisalRouter.post('/cases/:id/report', validate({ params: idParams }), async (req, res) =>
  res.json({ data: await svc.report(req.params.id) }),
);
appraisalRouter.post(
  '/cases/:id/transition',
  validate({
    params: idParams,
    body: z.object({
      action: z.enum([
        'start_review',
        'place_on_hold',
        'release_hold',
        'recommend',
        'request_approval',
        'approve',
        'reject',
        'close',
      ]),
      reason: optionalText(4000),
      recommendation: z
        .enum(['retain_permanent', 'transfer_to_archives', 'extend_retention', 'dispose', 'return_to_department'])
        .optional(),
      rationale: optionalText(20000),
    }),
  }),
  async (req, res) => {
    const c = await svc.transitionCase(req.params.id, req.body, req.user);
    res.json({ data: { id: c.id, status: c.status } });
  },
);
appraisalRouter.post(
  '/cases/:id/items/:itemId/exclude',
  requirePermission('appraisal.create'),
  validate({
    params: z.object({ id: uuid, itemId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(1000) }),
  }),
  async (req, res) => {
    const it = await models.AppraisalCaseItem.findOne({ where: { id: req.params.itemId, caseId: req.params.id } });
    if (!it) throw notFound('Case item');
    await it.update({ eligibility: 'excluded', blockReason: req.body.reason });
    await audit({
      action: 'appraisal.item_excluded',
      resourceType: 'AppraisalCase',
      resourceId: req.params.id,
      reason: req.body.reason,
      metadata: { itemId: it.id },
    });
    res.json({ data: it });
  },
);

/**
 * @openapi
 * /disposal/cases:
 *   post: { tags: [Disposal], summary: Create a disposal case with a dry-run preview from an approved appraisal, responses: { 201: { description: Created } } }
 * /disposal/cases/{id}/execute:
 *   post: { tags: [Disposal], summary: Execute the approved action. Requires the case number as confirmation; re-checks eligibility first., responses: { 200: { description: Executed }, 409: { description: Eligibility changed; case blocked } } }
 */
disposalRouter.get(
  '/cases',
  validate({ query: paginationSchema.extend({ status: z.string().max(60).optional() }) }),
  async (req, res) => {
    const where = req.query.status ? { status: req.query.status.split(',') } : {};
    paged(
      res,
      await models.DisposalCase.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['createdAt', 'DESC']],
        attributes: { exclude: ['dryRunSnapshot'] },
        include: [{ model: models.AppraisalCase, as: 'appraisalCase', attributes: ['id', 'caseNumber', 'title'] }],
      }),
      req.query,
    );
  },
);
disposalRouter.post(
  '/cases',
  requirePermission('appraisal.create'),
  validate({
    body: z.object({
      appraisalCaseId: uuid,
      action: z.enum(['destroy_physical', 'delete_digital', 'transfer_external', 'return_to_department']),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.createDisposal(req.body.appraisalCaseId, req.body.action, req.user) });
  },
);
disposalRouter.get('/cases/:id', validate({ params: idParams }), async (req, res) => {
  const d = await models.DisposalCase.findByPk(req.params.id, {
    include: [
      { model: models.AppraisalCase, as: 'appraisalCase' },
      { model: models.DisposalCertificate, as: 'certificates', attributes: { exclude: ['storageKey'] } },
      { model: models.User, as: 'executedBy', attributes: ['id', 'fullName'] },
    ],
  });
  if (!d) throw notFound('Disposal case');
  const approvals = await models.Approval.findAll({
    where: { entityType: 'DisposalCase', entityId: d.id },
    include: [{ model: models.User, as: 'approver', attributes: ['id', 'fullName'] }],
    order: [['createdAt', 'ASC']],
  });
  res.json({
    data: {
      ...d.get({ plain: true }),
      approvals: approvals.map((a) => ({
        ...a.get({ plain: true }),
        current: a.stage === `approval:${d.dryRunSnapshot?.fingerprint}`,
      })),
      history: await history('DisposalCase', d.id),
    },
  });
});
disposalRouter.post(
  '/cases/:id/dry-run',
  requirePermission('appraisal.create'),
  validate({ params: idParams }),
  async (req, res) => res.json({ data: await svc.regenerateDryRun(req.params.id) }),
);
disposalRouter.post(
  '/cases/:id/request-approval',
  requirePermission('appraisal.create'),
  validate({ params: idParams }),
  async (req, res) => res.json({ data: await svc.requestApproval(req.params.id, req.user) }),
);
disposalRouter.post(
  '/cases/:id/approve',
  requirePermission('disposal.approve'),
  validate({ params: idParams, body: z.object({ fingerprint: z.string().length(64), reason: optionalText(2000) }) }),
  async (req, res) => res.json({ data: await svc.approveDisposal(req.params.id, req.body, req.user) }),
);
disposalRouter.post(
  '/cases/:id/execute',
  requirePermission('disposal.execute'),
  validate({ params: idParams, body: z.object({ confirmation: z.string().max(60) }) }),
  async (req, res) => res.json({ data: await svc.executeDisposal(req.params.id, req.body, req.user) }),
);
disposalRouter.post(
  '/cases/:id/destroy-files',
  requirePermission('disposal.execute'),
  validate({ params: idParams }),
  async (req, res) => res.json({ data: await svc.retryFileDestruction(req.params.id, req.user) }),
);
disposalRouter.get('/certificates/:id/pdf', validate({ params: idParams }), async (req, res) => {
  const c = await models.DisposalCertificate.findByPk(req.params.id);
  if (!c) throw notFound('Certificate');
  await audit({ action: 'disposal.certificate_downloaded', resourceType: 'DisposalCertificate', resourceId: c.id });
  const obj = await storage.get(c.storageKey);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${c.certificateNumber.replace(/[^\w-]+/g, '_')}.pdf"`);
  obj.body.pipe(res);
});
