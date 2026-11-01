/**
 * HTTP routes for digital assets and file delivery.
 *
 * `filesRouter` is mounted at /api/v1/files. GET /:token streams a file after re-checking access; tokens are
 * short-lived and are issued only by POST /digital-assets/:id/link.
 *
 * `assetsRouter` is mounted at /api/v1/digital-assets:
 * - POST /:id/link issues a delivery link after an access check; it also works for anonymous visitors viewing open
 *   material.
 * - GET / and GET /:id list and show assets the caller may see ("assets.read").
 * - POST / uploads files ("assets.upload"); PATCH /:id updates an asset's metadata, link or access settings.
 * - POST /:id/publish publishes or withdraws an access copy ("assets.publish").
 * - POST /:id/ocr runs OCR again, for example in another language ("ocr.review" or "digitisation.capture").
 * - DELETE /:id removes a non-master asset ("assets.delete").
 * - POST /:id/reprocess re-runs ingest processing ("preservation.manage").
 *
 * Storage keys are never included in responses.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { ASSET_ROLES } from '../../database/models/digital.js';
import { authenticate, optionalAuth, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy } from '../../utils/pagination.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { diskUpload } from '../../services/upload.service.js';
import { evaluateAsset, staffReadableLevels, assetLevel } from '../../services/accessPolicy.service.js';
import * as svc from './assets.service.js';
import { enqueue } from '../../services/queue.service.js';
import { assertOcrEligible } from '../digitisation/ocr.service.js';

export const assetsRouter = Router();
export const filesRouter = Router();

/**
 * @openapi
 * /files/{token}:
 *   get: { tags: [Digital assets], security: [], summary: Stream a file using a short-lived delivery token (supports Range). Access is re-checked on every request., responses: { 200: { description: File }, 206: { description: Partial content }, 404: { description: Not found or no longer permitted } } }
 */
filesRouter.get('/:token', async (req, res) => svc.streamByToken(req.params.token, req, res));

/**
 * @openapi
 * /digital-assets/{id}/link:
 *   post: { tags: [Digital assets], summary: Get a short-lived delivery URL after an access check (works for anonymous public access too), responses: { 200: { description: URL } } }
 */
assetsRouter.post(
  '/:id/link',
  optionalAuth,
  validate({ params: idParams, body: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }) }),
  async (req, res) => {
    res.json({ data: await svc.issueDeliveryToken(req.params.id, req.user ?? null, req.body) });
  },
);

assetsRouter.use(authenticate);

/**
 * @openapi
 * /digital-assets:
 *   get: { tags: [Digital assets], summary: List digital assets the caller may see, responses: { 200: { description: Paged } } }
 *   post:
 *     tags: [Digital assets]
 *     summary: Upload files (multipart field "files"). Signature-checked, malware-scanned, SHA-256 hashed, stored privately; processing is queued.
 *     parameters: [{ in: header, name: Idempotency-Key, schema: { type: string }, description: Safe retries return the original result }]
 *     responses: { 201: { description: Created assets and any rejected files } }
 */
assetsRouter.get(
  '/',
  requirePermission('assets.read'),
  validate({
    query: paginationSchema.extend({
      recordId: uuid.optional(),
      role: z.enum(ASSET_ROLES).optional(),
      status: z.string().max(100).optional(),
      ocrStatus: z.string().max(100).optional(),
      preservationStatus: z.string().max(100).optional(),
      mediaType: z.string().max(150).optional(),
      includeDerivatives: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = { status: { [Op.ne]: 'deleted' } };
    for (const k of ['recordId', 'role']) if (req.query[k]) where[k] = req.query[k];
    for (const k of ['status', 'ocrStatus', 'preservationStatus']) if (req.query[k]) where[k] = req.query[k].split(',');
    if (req.query.mediaType) where.mediaType = { [Op.like]: `${req.query.mediaType}%` };
    if (req.query.includeDerivatives !== 'true' && !req.query.role)
      where.role = { [Op.notIn]: ['thumbnail', 'access_derivative'] };
    if (req.query.q)
      where[Op.or] = [
        { originalFilename: { [Op.like]: `%${req.query.q}%` } },
        { title: { [Op.like]: `%${req.query.q}%` } },
        { sha256: req.query.q },
      ];
    const levels = staffReadableLevels(req.user);
    const { rows, count } = await models.DigitalAsset.findAndCountAll({
      where,
      attributes: svc.PUBLIC_ATTRS,
      ...pageParams(req.query),
      order: orderBy(req.query.sort, req.query.order, ['createdAt', 'originalFilename', 'sizeBytes', 'status']),
      include: [
        {
          model: models.ArchivalRecord,
          as: 'record',
          attributes: ['id', 'referenceCode', 'title', 'effectiveAccessLevel'],
        },
      ],
    });
    const data = rows.map((a) => {
      const p = a.get({ plain: true });
      const visible = levels.includes(assetLevel(a, a.record));
      return visible
        ? p
        : { id: p.id, recordId: p.recordId, role: p.role, status: p.status, restricted: true, record: p.record };
    });
    res.json({
      data,
      meta: {
        page: req.query.page,
        pageSize: req.query.pageSize,
        total: count,
        totalPages: Math.ceil(count / req.query.pageSize),
      },
    });
  },
);

assetsRouter.post('/', requirePermission('assets.upload'), diskUpload().array('files', 50), async (req, res) => {
  if (!req.files?.length) throw badRequest('Attach at least one file in the "files" field');
  const opts = z
    .object({
      recordId: uuid.optional(),
      physicalItemId: uuid.optional(),
      digitisationItemId: uuid.optional(),
      parentAssetId: uuid.optional(),
      role: z
        .enum(['preservation_master', 'original_upload', 'access_derivative', 'migrated_version'])
        .default('preservation_master'),
      title: z.string().max(500).optional(),
      allowDuplicate: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
    })
    .parse(req.body);
  const result = await svc.uploadAssets(
    req.files,
    { ...opts, idempotencyKey: req.get('idempotency-key')?.slice(0, 100) },
    req.user,
  );
  res
    .status(result.replayed ? 200 : result.assets.length ? 201 : 422)
    .json({ data: result.assets, meta: { rejected: result.rejected, replayed: result.replayed } });
});

assetsRouter.get('/:id', requirePermission('assets.read'), validate({ params: idParams }), async (req, res) => {
  const a = await models.DigitalAsset.findByPk(req.params.id, {
    attributes: svc.PUBLIC_ATTRS,
    include: [
      {
        model: models.ArchivalRecord,
        as: 'record',
        attributes: [
          'id',
          'referenceCode',
          'title',
          'effectiveAccessLevel',
          'effectiveFlags',
          'status',
          'publicVisibility',
          'path',
        ],
      },
    ],
  });
  if (!a) throw notFound('Digital asset');
  const decision = await evaluateAsset(req.user, a, a.record);
  if (!decision.canView)
    return res.json({
      data: { id: a.id, recordId: a.recordId, role: a.role, status: a.status, restricted: true, record: a.record },
    });
  const [derivatives, checksums, events, fixity, ocrJobs, versions, restrictions] = await Promise.all([
    models.DigitalAsset.findAll({
      where: { parentAssetId: a.id, status: { [Op.ne]: 'deleted' } },
      attributes: svc.PUBLIC_ATTRS,
    }),
    models.AssetChecksum.findAll({ where: { assetId: a.id }, order: [['createdAt', 'ASC']] }),
    models.PreservationEvent.findAll({ where: { assetId: a.id }, order: [['eventAt', 'DESC']], limit: 100 }),
    models.FixityCheck.findAll({ where: { assetId: a.id }, order: [['createdAt', 'DESC']], limit: 20 }),
    models.OCRJob.findAll({ where: { assetId: a.id }, order: [['createdAt', 'DESC']] }),
    a.parentAssetId
      ? models.DigitalAsset.findAll({
          where: { [Op.or]: [{ id: a.parentAssetId }, { parentAssetId: a.parentAssetId, role: 'migrated_version' }] },
          attributes: ['id', 'originalFilename', 'role', 'versionNumber', 'createdAt'],
        })
      : [],
    models.AccessRestriction.findAll({ where: { targetType: 'asset', targetId: a.id } }),
  ]);
  res.json({
    data: {
      ...a.get({ plain: true }),
      access: decision,
      derivatives,
      checksums,
      events,
      fixity,
      ocrJobs,
      versions,
      restrictions,
    },
  });
});

assetsRouter.patch(
  '/:id',
  requirePermission('assets.upload'),
  validate({
    params: idParams,
    body: z.object({
      title: optionalText(500),
      recordId: uuid.nullable().optional(),
      physicalItemId: uuid.nullable().optional(),
      accessLevel: z
        .enum(['inherit', 'open', 'staff_only', 'restricted', 'embargoed', 'confidential', 'closed'])
        .optional(),
      downloadAllowed: z.boolean().optional(),
      rightsStatement: optionalText(1000),
      copyrightHolder: optionalText(500),
      licence: optionalText(255),
    }),
  }),
  async (req, res) => {
    res.json({ data: svc.presentAsset(await svc.updateAsset(req.params.id, req.body)) });
  },
);

assetsRouter.post(
  '/:id/publish',
  requirePermission('assets.publish'),
  validate({ params: idParams, body: z.object({ publish: z.boolean(), reason: optionalText(1000) }) }),
  async (req, res) => {
    res.json({
      data: svc.presentAsset(await svc.setPublished(req.params.id, req.body.publish, req.user, req.body.reason)),
    });
  },
);

assetsRouter.post(
  '/:id/ocr',
  requireAnyPermission('ocr.review', 'digitisation.capture'),
  validate({
    params: idParams,
    body: z.object({
      language: z
        .string()
        .regex(/^[a-z_+]{3,40}$/)
        .default('eng'),
    }),
  }),
  async (req, res) => {
    const a = await models.DigitalAsset.findByPk(req.params.id);
    if (!a || a.status !== 'available') throw notFound('Available asset');
    assertOcrEligible(a);
    res.status(202).json({ data: await svc.queueOcr(a, req.body.language, req.user) });
  },
);

assetsRouter.delete(
  '/:id',
  requirePermission('assets.delete'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(5).max(1000) }) }),
  async (req, res) => {
    await svc.deleteAsset(req.params.id, req.body.reason, req.user);
    res.status(204).end();
  },
);

assetsRouter.post(
  '/:id/reprocess',
  requirePermission('preservation.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const a = await models.DigitalAsset.findByPk(req.params.id);
    if (!a || !['failed', 'processing'].includes(a.status))
      throw badRequest('Only failed or stuck assets can be reprocessed');
    await a.update({ status: 'processing', ingestError: null });
    const jobId = await enqueue(
      'ingest',
      'asset.process',
      { assetId: a.id },
      { entityType: 'DigitalAsset', entityId: a.id, requestedById: req.user.id },
    );
    res.status(202).json({ data: { jobId } });
  },
);
