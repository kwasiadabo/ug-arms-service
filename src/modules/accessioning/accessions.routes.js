/**
 * HTTP routes for accessions, mounted at /api/v1/accessions.
 *
 * An accession is the formal record that the Archives has taken custody of material. Every route requires
 * "accession.read"; creating and editing require "accession.create", and decisions require "accession.approve"
 * (checked in the service).
 *
 * - GET / lists accessions with filters and paging.
 * - POST / creates a draft accession directly (for example for a donation).
 * - GET /:id returns an accession with its items, linked descriptions, physical items, approvals, missing
 *   information, available actions, documents and history.
 * - PATCH /:id and PUT /:id/items edit the accession and its received items.
 * - POST /:id/transition performs a workflow action (submit, start review, query, approve, reject or close).
 * - POST /:id/quarantine places the material in quarantine or releases it.
 * - POST /:id/link-records and POST /:id/create-collection connect the accession to the catalogue.
 * - GET /:id/receipt downloads the acknowledgement and transfer receipt as a PDF.
 * - POST /:id/documents and GET /:id/documents/:docId upload and download supporting documents.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { ACCESSION_STATUSES } from '../../database/models/accessioning.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, isoDate, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { history } from '../../services/workflow.service.js';
import { diskUpload } from '../../services/upload.service.js';
import * as svc from './accessions.service.js';
import { storeDocuments, listDocuments, streamDocument } from './documents.js';

const router = Router();
router.use(authenticate, requirePermission('accession.read'));

const body = z.object({
  title: z.string().trim().min(3).max(500),
  repositoryId: uuid.optional(),
  accessionDate: isoDate,
  transferDate: isoDate,
  sourceType: z
    .enum(['department', 'donor', 'external_organisation', 'purchase', 'deposit', 'other'])
    .default('department'),
  sourceUnitId: uuid.nullable().optional(),
  donorName: optionalText(255),
  contactPerson: optionalText(200),
  contactEmail: z.string().email().optional().nullable(),
  transferAuthority: optionalText(1000),
  legalBasis: optionalText(1000),
  transferMethod: optionalText(255),
  formats: z.array(z.string().max(80)).max(30).optional(),
  quantity: z.number().int().min(0).optional().nullable(),
  extent: optionalText(500),
  physicalCondition: optionalText(20000),
  provenance: optionalText(20000),
  custodialHistory: optionalText(20000),
  confidentialityConcerns: optionalText(20000),
  rightsStatement: optionalText(20000),
  restrictionsNote: optionalText(20000),
  embargoUntil: isoDate,
  completenessNote: optionalText(20000),
  appraisalNote: optionalText(20000),
  responsibleOfficerId: uuid.nullable().optional(),
});
const itemSchema = z.object({
  id: uuid.optional(),
  description: z.string().trim().min(1).max(1000),
  format: optionalText(80),
  quantity: z.number().int().min(1).optional(),
  extent: optionalText(255),
  condition: optionalText(255),
});

/**
 * @openapi
 * /accessions:
 *   get: { tags: [Accessioning], summary: Accession register, responses: { 200: { description: Paged } } }
 *   post: { tags: [Accessioning], summary: Register a proposed accession (number generated from the configured format), responses: { 201: { description: Created } } }
 */
router.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(ACCESSION_STATUSES).optional(),
      year: z.coerce.number().int().optional(),
      quarantined: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.quarantined) where.isQuarantined = req.query.quarantined === 'true';
    if (req.query.year) where.accessionDate = { [Op.between]: [`${req.query.year}-01-01`, `${req.query.year}-12-31`] };
    if (req.query.q)
      where[Op.or] = [
        { title: { [Op.like]: `%${req.query.q}%` } },
        { accessionNumber: { [Op.like]: `%${req.query.q}%` } },
        { donorName: { [Op.like]: `%${req.query.q}%` } },
      ];
    paged(
      res,
      await models.Accession.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, [
          'createdAt',
          'accessionDate',
          'accessionNumber',
          'status',
          'title',
        ]),
        include: [{ model: models.OrganisationUnit, as: 'sourceUnit', attributes: ['id', 'name'] }],
      }),
      req.query,
    );
  },
);

router.post('/', requirePermission('accession.create'), validate({ body }), async (req, res) => {
  res.status(201).json({ data: await svc.createAccession(req.body, req.user) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const a = await models.Accession.findByPk(req.params.id, {
    include: [
      {
        model: models.AccessionItem,
        as: 'items',
        include: [
          { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] },
          { model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title'] },
        ],
      },
      {
        model: models.AccessionRecordLink,
        as: 'recordLinks',
        include: [
          {
            model: models.ArchivalRecord,
            as: 'record',
            attributes: ['id', 'referenceCode', 'title', 'level', 'status'],
          },
        ],
      },
      { model: models.OrganisationUnit, as: 'sourceUnit', attributes: ['id', 'name'] },
      { model: models.TransferSubmission, as: 'transferSubmission', attributes: ['id', 'referenceNumber', 'title'] },
      { model: models.User, as: 'responsibleOfficer', attributes: ['id', 'fullName'] },
      { model: models.User, as: 'approvedBy', attributes: ['id', 'fullName'] },
    ],
    order: [[{ model: models.AccessionItem, as: 'items' }, 'lineNumber', 'ASC']],
  });
  if (!a) throw notFound('Accession');
  const [documents, hist, approvals, physicalItems] = await Promise.all([
    listDocuments('accession', a.id),
    history('Accession', a.id),
    models.Approval.findAll({
      where: { entityType: 'Accession', entityId: a.id },
      include: [{ model: models.User, as: 'approver', attributes: ['id', 'fullName'] }],
    }),
    models.PhysicalItem.findAll({
      where: { accessionId: a.id },
      attributes: ['id', 'barcode', 'title', 'status', 'currentLocationId'],
      include: [{ model: models.StorageLocation, as: 'currentLocation', attributes: ['id', 'code', 'name'] }],
    }),
  ]);
  res.json({
    data: {
      ...a.get({ plain: true }),
      documents,
      history: hist,
      approvals,
      physicalItems,
      missing: svc.computeMissing(a, a.items),
      availableActions: svc.actionsFor(a, req.user),
    },
  });
});

router.patch(
  '/:id',
  requirePermission('accession.create'),
  validate({ params: idParams, body: body.partial().extend({ version: z.number().int().optional() }) }),
  async (req, res) => {
    res.json({ data: await svc.updateAccession(req.params.id, req.body, req.user) });
  },
);

router.put(
  '/:id/items',
  requirePermission('accession.create'),
  validate({ params: idParams, body: z.object({ items: z.array(itemSchema).max(5000) }) }),
  async (req, res) => {
    await svc.replaceItems(req.params.id, req.body.items);
    res.json({ data: { ok: true } });
  },
);

router.post(
  '/:id/transition',
  validate({
    params: idParams,
    body: z.object({
      action: z.enum(['submit', 'start_review', 'query', 'approve', 'reject', 'close']),
      reason: z.string().trim().max(4000).optional(),
      itemDecisions: z
        .array(z.object({ itemId: uuid, decision: z.enum(['accepted', 'rejected']) }))
        .max(5000)
        .optional(),
    }),
  }),
  async (req, res) => {
    const a = await svc.transitionAccession(req.params.id, req.body, req.user);
    res.json({ data: { id: a.id, status: a.status } });
  },
);

router.post(
  '/:id/quarantine',
  requirePermission('accession.create'),
  validate({
    params: idParams,
    body: z.object({ quarantine: z.boolean(), reason: z.string().trim().min(3).max(1000) }),
  }),
  async (req, res) => {
    res.json({ data: await svc.setQuarantine(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/:id/link-records',
  requirePermission('records.update'),
  validate({ params: idParams, body: z.object({ recordIds: z.array(uuid).min(1).max(100) }) }),
  async (req, res) => {
    await svc.linkRecords(req.params.id, req.body.recordIds);
    res.json({ data: { ok: true } });
  },
);

router.post(
  '/:id/create-collection',
  requirePermission('records.create'),
  validate({
    params: idParams,
    body: z.object({
      level: z.enum(['fonds', 'collection']).default('fonds'),
      localIdentifier: z.string().trim().min(1).max(120),
      title: z.string().trim().max(1000).optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.createCollectionFromAccession(req.params.id, req.body, req.user) });
  },
);

router.get('/:id/receipt', validate({ params: idParams }), async (req, res) => {
  const { doc, filename } = await svc.receiptPdf(req.params.id, req.user);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
});

router.post(
  '/:id/documents',
  requirePermission('accession.create'),
  validate({ params: idParams }),
  diskUpload(100).array('files', 20),
  async (req, res) => {
    if (!(await models.Accession.findByPk(req.params.id))) throw notFound('Accession');
    if (!req.files?.length) throw badRequest('Attach at least one file in the "files" field');
    res.status(201).json({
      data: await storeDocuments(
        'accession',
        req.params.id,
        req.files,
        req.body.documentType || 'supporting',
        req.user,
      ),
    });
  },
);

router.get('/:id/documents/:docId', validate({ params: z.object({ id: uuid, docId: uuid }) }), async (req, res) => {
  await streamDocument('accession', req.params.id, req.params.docId, res);
});

export default router;
