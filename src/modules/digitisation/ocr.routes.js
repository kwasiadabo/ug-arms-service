/**
 * HTTP routes for OCR review, mounted at /api/v1/ocr. Requires "ocr.review".
 *
 * - GET /queue lists files with OCR output, with page counts and mean confidence.
 * - GET /assets/:id returns the latest OCR pages of a file for side-by-side review.
 * - GET /pages/:id/revisions lists every revision of a page.
 * - PUT /pages/:id saves a corrected transcription, optionally approving it.
 * - POST /assets/:id/approve approves pages for search.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { notFound } from '../../utils/errors.js';
import { evaluateAsset } from '../../services/accessPolicy.service.js';
import * as svc from './ocr.service.js';

const router = Router();
router.use(authenticate, requirePermission('ocr.review'));

/**
 * @openapi
 * /ocr/queue:
 *   get: { tags: [OCR], summary: Assets with OCR output awaiting review, and failed OCR jobs, responses: { 200: { description: Queue } } }
 */
router.get(
  '/queue',
  validate({
    query: paginationSchema.extend({ status: z.enum(['succeeded', 'failed', 'queued', 'running']).optional() }),
  }),
  async (req, res) => {
    const where = {
      ocrStatus: req.query.status ? req.query.status : { [Op.in]: ['succeeded', 'failed', 'queued', 'running'] },
    };
    paged(
      res,
      await models.DigitalAsset.findAndCountAll({
        where,
        attributes: ['id', 'originalFilename', 'ocrStatus', 'recordId', 'pageCount', 'updatedAt'],
        include: [
          { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] },
          {
            model: models.OCRJob,
            as: 'ocrJobs',
            attributes: ['id', 'status', 'meanConfidence', 'error', 'engine', 'createdAt'],
            separate: true,
            order: [['createdAt', 'DESC']],
            limit: 1,
          },
        ],
        ...pageParams(req.query),
        order: [['updatedAt', 'DESC']],
        distinct: true,
      }),
      req.query,
    );
  },
);

router.get('/assets/:id', validate({ params: idParams }), async (req, res) => {
  const asset = await models.DigitalAsset.findByPk(req.params.id, {
    attributes: { exclude: ['storageKey'] },
    include: [{ model: models.ArchivalRecord, as: 'record' }],
  });
  if (!asset) throw notFound('Asset');
  const decision = await evaluateAsset(req.user, asset, asset.record);
  if (!decision.canView) throw notFound('Asset');
  const { job, pages } = await svc.latestPages(asset.id);
  const jobs = await models.OCRJob.findAll({ where: { assetId: asset.id }, order: [['createdAt', 'DESC']] });
  const preview = await models.DigitalAsset.findOne({
    where: { parentAssetId: asset.id, role: 'access_derivative', status: 'available' },
    attributes: ['id'],
  });
  res.json({
    data: {
      asset: {
        id: asset.id,
        originalFilename: asset.originalFilename,
        mediaType: asset.mediaType,
        pageCount: asset.pageCount,
        recordId: asset.recordId,
        previewAssetId: preview?.id ?? asset.id,
      },
      job,
      jobs,
      pages,
    },
  });
});

router.get('/pages/:id/revisions', validate({ params: idParams }), async (req, res) => {
  res.json({
    data: await models.OCRRevision.findAll({
      where: { pageId: req.params.id },
      order: [['revision', 'DESC']],
      include: [{ model: models.User, as: 'editedBy', attributes: ['id', 'fullName'] }],
    }),
  });
});

router.put(
  '/pages/:id',
  validate({
    params: idParams,
    body: z.object({
      text: z.string().max(500000),
      note: z.string().max(1000).optional(),
      approve: z.boolean().default(false),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.correctPage(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/assets/:id/approve',
  validate({ params: idParams, body: z.object({ pageIds: z.array(uuid).max(5000).optional() }) }),
  async (req, res) => {
    res.json({ data: { approved: await svc.approvePages(req.params.id, req.body.pageIds, req.user) } });
  },
);

export default router;
