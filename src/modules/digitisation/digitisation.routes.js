/**
 * HTTP routes for digitisation projects, batches and items, mounted at /api/v1/digitisation. Requires
 * "digitisation.manage", "digitisation.capture" or "digitisation.qa".
 *
 * - GET /projects, POST /projects and GET /projects/:id list, propose and show projects; POST /projects/:id/status
 *   approves, activates, completes or cancels a project.
 * - GET /quality-profiles and POST /quality-profiles manage the capture standards (resolution, colour, bit depth
 *   and formats).
 * - POST /accessions/:id/projects and POST /accessions/:id/batches plan digitisation from an approved accession:
 *   a project linked to it, then batches filled with its material not yet digitised.
 * - POST /projects/:id/batches creates a batch; GET /batches and GET /batches/:id list and show batches with their
 *   progress.
 * - POST /batches/:id/items adds items to capture; POST /batches/:id/transition moves the batch through capture,
 *   processing and quality review.
 * - POST /items/:id/captured records that an item has been captured ("digitisation.capture").
 * - POST /items/:id/review records a quality review of an item ("digitisation.qa").
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { BATCH_STATUSES } from '../../database/models/digitisation.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, isoDate, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { notFound } from '../../utils/errors.js';
import { history } from '../../services/workflow.service.js';
import * as svc from './digitisation.service.js';
import { proposeProjectForAccession, planBatchFromAccession } from './fromAccession.js';

const router = Router();
router.use(authenticate, requireAnyPermission('digitisation.manage', 'digitisation.capture', 'digitisation.qa'));

/**
 * @openapi
 * /digitisation/projects:
 *   get: { tags: [Digitisation], summary: Digitisation projects with progress, responses: { 200: { description: Paged } } }
 *   post: { tags: [Digitisation], summary: Propose a project (digitisation.manage), responses: { 201: { description: Created } } }
 */
router.get(
  '/projects',
  validate({ query: paginationSchema.extend({ status: z.string().max(60).optional() }) }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',');
    if (req.query.q)
      where[Op.or] = [{ title: { [Op.like]: `%${req.query.q}%` } }, { code: { [Op.like]: `%${req.query.q}%` } }];
    paged(
      res,
      await models.DigitisationProject.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, ['createdAt', 'title', 'status', 'targetDate']),
        include: [
          { model: models.ArchivalRecord, as: 'sourceRecord', attributes: ['id', 'referenceCode', 'title'] },
          { model: models.DigitisationBatch, as: 'batches', attributes: ['id', 'status'] },
        ],
        distinct: true,
      }),
      req.query,
    );
  },
);

/**
 * @openapi
 * /digitisation/accessions/{id}/projects:
 *   post: { tags: [Digitisation], summary: Propose a project to digitise an approved accession (digitisation.manage), responses: { 201: { description: Created } } }
 * /digitisation/accessions/{id}/batches:
 *   post: { tags: [Digitisation], summary: "Create a batch filled with the accession's material not yet digitised (digitisation.manage)", responses: { 201: { description: Created } } }
 */
router.post(
  '/accessions/:id/projects',
  requirePermission('digitisation.manage'),
  validate({
    params: idParams,
    body: z.object({
      title: z.string().trim().min(3).max(500).optional(),
      description: optionalText(20000),
      sourceRecordId: uuid.nullable().optional(),
      qualityProfileId: uuid.nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await proposeProjectForAccession(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/accessions/:id/batches',
  requirePermission('digitisation.manage'),
  validate({
    params: idParams,
    body: z.object({
      projectId: uuid,
      physicalItemIds: z.array(uuid).max(1000).optional(),
      includeUnboxed: z.boolean().optional(),
      operatorId: uuid.nullable().optional(),
      resolutionDpi: z.number().int().min(50).max(10000).optional(),
      colourProfile: optionalText(80),
      bitDepth: z.number().int().min(1).max(64).optional(),
      ocrEnabled: z.boolean().optional(),
      ocrLanguage: z.string().trim().max(40).optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await planBatchFromAccession(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/projects',
  requirePermission('digitisation.manage'),
  validate({
    body: z.object({
      title: z.string().trim().min(3).max(500),
      description: optionalText(20000),
      sourceRecordId: uuid.nullable().optional(),
      accessionId: uuid.nullable().optional(),
      qualityProfileId: uuid.nullable().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
      startDate: isoDate,
      targetDate: isoDate,
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.createProject(req.body, req.user) });
  },
);

router.get('/projects/:id', validate({ params: idParams }), async (req, res) => {
  const p = await models.DigitisationProject.findByPk(req.params.id, {
    include: [
      { model: models.ArchivalRecord, as: 'sourceRecord', attributes: ['id', 'referenceCode', 'title'] },
      { model: models.Accession, as: 'accession', attributes: ['id', 'accessionNumber', 'title'] },
      { model: models.QualityProfile, as: 'qualityProfile' },
      { model: models.User, as: 'approvedBy', attributes: ['id', 'fullName'] },
      {
        model: models.DigitisationBatch,
        as: 'batches',
        include: [{ model: models.User, as: 'operator', attributes: ['id', 'fullName'] }],
      },
    ],
  });
  if (!p) throw notFound('Project');
  const batches = [];
  for (const b of p.batches) batches.push({ ...b.get({ plain: true }), progress: await svc.progress(b.id) });
  res.json({ data: { ...p.get({ plain: true }), batches } });
});

router.post(
  '/projects/:id/status',
  requireAnyPermission('digitisation.manage', 'records.approve'),
  validate({
    params: idParams,
    body: z.object({ status: z.enum(['approved', 'active', 'completed', 'cancelled']), reason: optionalText(1000) }),
  }),
  async (req, res) => {
    res.json({ data: await svc.setProjectStatus(req.params.id, req.body.status, req.user, req.body.reason) });
  },
);

router.get('/quality-profiles', async (req, res) =>
  res.json({ data: await models.QualityProfile.findAll({ where: { isActive: true }, order: [['name', 'ASC']] }) }),
);
router.post(
  '/quality-profiles',
  requirePermission('digitisation.manage'),
  validate({
    body: z.object({
      name: z.string().min(2).max(200),
      materialType: z.string().min(2).max(80),
      minResolutionDpi: z.number().int().min(72).max(4800),
      colourMode: optionalText(40),
      bitDepth: z.number().int().optional(),
      masterFormat: optionalText(40),
      accessFormat: optionalText(40),
      requiresColourTarget: z.boolean().optional(),
      notes: optionalText(2000),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await models.QualityProfile.create(req.body) });
  },
);

router.post(
  '/projects/:id/batches',
  requirePermission('digitisation.manage'),
  validate({
    params: idParams,
    body: z.object({
      operatorId: uuid.nullable().optional(),
      captureDevice: optionalText(255),
      resolutionDpi: z.number().int().min(72).max(4800).optional(),
      colourProfile: optionalText(80),
      bitDepth: z.number().int().optional(),
      fileNamingPattern: optionalText(255),
      ocrEnabled: z.boolean().default(true),
      ocrLanguage: z
        .string()
        .regex(/^[a-z_+]{3,40}$/)
        .default('eng'),
      notes: optionalText(20000),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.createBatch(req.params.id, req.body) });
  },
);

/**
 * @openapi
 * /digitisation/batches:
 *   get: { tags: [Digitisation], summary: Batches (filter mine=true for the operator's queue), responses: { 200: { description: Paged } } }
 */
router.get(
  '/batches',
  validate({
    query: paginationSchema.extend({
      status: z.string().max(200).optional(),
      mine: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',').filter((s) => BATCH_STATUSES.includes(s));
    if (req.query.mine === 'true') where[Op.or] = [{ operatorId: req.user.id }, { qaReviewerId: req.user.id }];
    const result = await models.DigitisationBatch.findAndCountAll({
      where,
      ...pageParams(req.query),
      order: [['createdAt', 'DESC']],
      include: [
        { model: models.DigitisationProject, as: 'project', attributes: ['id', 'code', 'title'] },
        { model: models.User, as: 'operator', attributes: ['id', 'fullName'] },
      ],
    });
    const rows = [];
    for (const b of result.rows) rows.push({ ...b.get({ plain: true }), progress: await svc.progress(b.id) });
    paged(res, { rows, count: result.count }, req.query);
  },
);

router.get('/batches/:id', validate({ params: idParams }), async (req, res) => {
  const b = await models.DigitisationBatch.findByPk(req.params.id, {
    include: [
      {
        model: models.DigitisationProject,
        as: 'project',
        include: [{ model: models.QualityProfile, as: 'qualityProfile' }],
      },
      { model: models.User, as: 'operator', attributes: ['id', 'fullName'] },
      { model: models.User, as: 'qaReviewer', attributes: ['id', 'fullName'] },
      {
        model: models.DigitisationItem,
        as: 'items',
        include: [
          { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] },
          { model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title'] },
          {
            model: models.DigitalAsset,
            as: 'assets',
            attributes: [
              'id',
              'originalFilename',
              'status',
              'ocrStatus',
              'qaStatus',
              'role',
              'sha256',
              'width',
              'height',
              'pageCount',
              'mediaType',
            ],
            where: { status: { [Op.ne]: 'deleted' } },
            required: false,
          },
        ],
      },
      {
        model: models.QualityAssuranceReview,
        as: 'reviews',
        include: [{ model: models.User, as: 'reviewer', attributes: ['id', 'fullName'] }],
      },
    ],
    order: [[{ model: models.DigitisationItem, as: 'items' }, 'sequence', 'ASC']],
  });
  if (!b) throw notFound('Batch');
  res.json({
    data: {
      ...b.get({ plain: true }),
      progress: await svc.progress(b.id),
      history: await history('DigitisationBatch', b.id),
      availableActions: svc.actionsFor(b, req.user),
    },
  });
});

router.post(
  '/batches/:id/items',
  requireAnyPermission('digitisation.manage', 'digitisation.capture'),
  validate({
    params: idParams,
    body: z.object({
      items: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(500),
            recordId: uuid.nullable().optional(),
            physicalItemId: uuid.nullable().optional(),
            accessionId: uuid.nullable().optional(),
            expectedPages: z.number().int().min(0).max(100000).optional(),
            notes: optionalText(2000),
          }),
        )
        .min(1)
        .max(1000),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.addItems(req.params.id, req.body.items, req.user) });
  },
);

router.post(
  '/batches/:id/transition',
  validate({
    params: idParams,
    body: z.object({
      action: z.enum([
        'start',
        'submit_capture',
        'processing_complete',
        'request_rework',
        'approve',
        'complete',
        'fail',
      ]),
      reason: optionalText(4000),
    }),
  }),
  async (req, res) => {
    const b = await svc.transitionBatch(req.params.id, req.body, req.user);
    res.json({ data: { id: b.id, status: b.status } });
  },
);

router.post(
  '/items/:id/captured',
  requirePermission('digitisation.capture'),
  validate({
    params: idParams,
    body: z.object({
      capturedPages: z.number().int().min(0).optional(),
      notes: optionalText(2000),
      skip: z.boolean().default(false),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.markCaptured(req.params.id, req.body) });
  },
);

router.post(
  '/items/:id/review',
  requirePermission('digitisation.qa'),
  validate({
    params: idParams,
    body: z.object({
      outcome: z.enum(['pass', 'fail', 'rework']),
      assetId: uuid.optional(),
      comments: optionalText(4000),
      checks: z
        .object({
          completeness: z.boolean().optional(),
          orientation: z.boolean().optional(),
          pageOrder: z.boolean().optional(),
          colour: z.boolean().optional(),
          resolution: z.boolean().optional(),
          focus: z.boolean().optional(),
          fileNaming: z.boolean().optional(),
        })
        .default({}),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.reviewItem(req.params.id, req.body, req.user) });
  },
);

export default router;
