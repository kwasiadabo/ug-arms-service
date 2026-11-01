/**
 * HTTP routes for storage locations and physical items. Both routers require "physical.read".
 *
 * `locationsRouter` is mounted at /api/v1/locations:
 * - GET / and GET /types list locations (with occupancy) and location types; GET /:id shows a location with its
 *   contents and path.
 * - POST / and PATCH /:id create and edit locations ("locations.manage").
 * - POST /labels produces printable barcode and QR labels as a PDF.
 * - POST /:id/audits, GET /audits/:auditId, POST /audits/:auditId/scan and POST /audits/:auditId/complete run an
 *   inventory audit ("physical.audit").
 *
 * `itemsRouter` is mounted at /api/v1/physical-items:
 * - GET /, GET /:id and GET /by-barcode/:barcode find items and show their movement, condition and circulation
 *   history.
 * - POST / and PATCH /:id create and edit items; POST /:id/move and POST /bulk-move record movements
 *   ("physical.move").
 * - POST /:id/report-missing and POST /:id/condition record a missing item or a condition assessment.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { PHYSICAL_STATUSES } from '../../database/models/physical.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import * as svc from './locations.service.js';
import { labelsPdf } from './labels.js';

export const locationsRouter = Router();
export const itemsRouter = Router();
locationsRouter.use(authenticate, requirePermission('physical.read'));
itemsRouter.use(authenticate, requirePermission('physical.read'));

const locationBody = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\w.-]+$/),
  name: z.string().trim().min(1).max(255),
  typeId: uuid,
  parentId: uuid.nullable().optional(),
  repositoryId: uuid.nullable().optional(),
  capacity: z.number().min(0).nullable().optional(),
  capacityUnit: z.enum(['items', 'boxes', 'linear_metres', 'cubic_metres']).optional(),
  materialRestrictions: z.array(z.string().max(80)).max(20).optional(),
  environmentRef: optionalText(255),
  isRestricted: z.boolean().optional(),
  restrictionNote: optionalText(1000),
  isActive: z.boolean().optional(),
  barcode: optionalText(120),
});

/**
 * @openapi
 * /locations:
 *   get: { tags: [Storage], summary: Storage locations with occupancy (parentId for tree browsing), responses: { 200: { description: Locations } } }
 *   post: { tags: [Storage], summary: Create a location (locations.manage), responses: { 201: { description: Created } } }
 */
locationsRouter.get(
  '/',
  validate({
    query: z.object({
      parentId: z.string().uuid().optional(),
      root: z.enum(['true', 'false']).optional(),
      q: z.string().max(100).optional(),
      includeInactive: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.includeInactive !== 'true') where.isActive = true;
    if (req.query.parentId) where.parentId = req.query.parentId;
    else if (req.query.root === 'true') where.parentId = null;
    if (req.query.q)
      where[Op.or] = [{ code: { [Op.like]: `%${req.query.q}%` } }, { name: { [Op.like]: `%${req.query.q}%` } }];
    const rows = await models.StorageLocation.findAll({
      where,
      include: [{ model: models.StorageLocationType, as: 'type', attributes: ['id', 'code', 'name', 'rank'] }],
      order: [['code', 'ASC']],
      limit: 1000,
    });
    const occ = await svc.occupancy(rows.map((r) => r.id));
    const childCounts = rows.length
      ? await models.StorageLocation.count({
          where: { parentId: rows.map((r) => r.id), isActive: true },
          group: ['parentId'],
        })
      : [];
    const kids = Object.fromEntries(childCounts.map((c) => [c.parentId, c.count]));
    res.json({
      data: rows.map((r) => {
        const o = occ[r.id] || { used: 0, items: 0 };
        const cap = r.capacity === null ? null : Number(r.capacity);
        return {
          ...r.get({ plain: true }),
          occupancy: o,
          utilisation: cap ? Math.round((o.used / cap) * 100) : null,
          isFull: cap !== null && o.used >= cap,
          childCount: kids[r.id] || 0,
        };
      }),
    });
  },
);

locationsRouter.get('/types', async (req, res) =>
  res.json({ data: await models.StorageLocationType.findAll({ order: [['rank', 'ASC']] }) }),
);

locationsRouter.post('/', requirePermission('locations.manage'), validate({ body: locationBody }), async (req, res) => {
  res.status(201).json({ data: await svc.createLocation(req.body) });
});

locationsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const loc = await models.StorageLocation.findByPk(req.params.id, {
    include: [{ model: models.StorageLocationType, as: 'type' }],
  });
  if (!loc) throw notFound('Location');
  const [items, crumbs, occ, audits] = await Promise.all([
    models.PhysicalItem.findAll({
      where: { currentLocationId: loc.id },
      attributes: ['id', 'barcode', 'title', 'status', 'itemType', 'sizeUnits', 'conditionRating'],
      order: [['barcode', 'ASC']],
      limit: 500,
    }),
    svc.locationBreadcrumbs(loc),
    svc.occupancy([loc.id]),
    models.InventoryAudit.findAll({ where: { locationId: loc.id }, order: [['createdAt', 'DESC']], limit: 10 }),
  ]);
  res.json({
    data: {
      ...loc.get({ plain: true }),
      items,
      breadcrumbs: crumbs,
      occupancy: occ[loc.id] || { used: 0, items: 0 },
      audits,
    },
  });
});

locationsRouter.patch(
  '/:id',
  requirePermission('locations.manage'),
  validate({ params: idParams, body: locationBody.partial().omit({ code: true, parentId: true, typeId: true }) }),
  async (req, res) => {
    res.json({ data: await svc.updateLocation(req.params.id, req.body) });
  },
);

locationsRouter.post(
  '/labels',
  validate({
    body: z.object({ locationIds: z.array(uuid).max(500).optional(), itemIds: z.array(uuid).max(500).optional() }),
  }),
  async (req, res) => {
    const labels = [];
    if (req.body.locationIds?.length)
      for (const l of await models.StorageLocation.findAll({
        where: { id: req.body.locationIds },
        order: [['code', 'ASC']],
      }))
        labels.push({ code: l.code, title: l.name, subtitle: 'Storage location' });
    if (req.body.itemIds?.length) {
      for (const i of await models.PhysicalItem.findAll({
        where: { id: req.body.itemIds },
        include: [{ model: models.ArchivalRecord, as: 'record', attributes: ['referenceCode'] }],
        order: [['barcode', 'ASC']],
      })) {
        labels.push({ code: i.barcode, title: i.title, subtitle: i.record?.referenceCode });
      }
    }
    if (!labels.length) throw badRequest('Choose locations or items to label');
    await audit({ action: 'labels.printed', resourceType: 'StorageLocation', metadata: { count: labels.length } });
    const doc = await labelsPdf(labels);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="labels.pdf"');
    doc.pipe(res);
  },
);

locationsRouter.post(
  '/:id/audits',
  requirePermission('physical.audit'),
  validate({ params: idParams, body: z.object({ notes: optionalText(2000) }) }),
  async (req, res) => {
    res.status(201).json({ data: await svc.startAudit(req.params.id, req.user, req.body.notes) });
  },
);
locationsRouter.get('/audits/:auditId', validate({ params: z.object({ auditId: uuid }) }), async (req, res) => {
  const a = await models.InventoryAudit.findByPk(req.params.auditId, {
    include: [
      {
        model: models.InventoryAuditLine,
        as: 'lines',
        include: [
          { model: models.PhysicalItem, as: 'item', attributes: ['id', 'barcode', 'title', 'currentLocationId'] },
        ],
      },
      { model: models.StorageLocation, as: 'location', attributes: ['id', 'code', 'name'] },
    ],
  });
  if (!a) throw notFound('Audit');
  res.json({ data: a });
});
locationsRouter.post(
  '/audits/:auditId/scan',
  requirePermission('physical.audit'),
  validate({ params: z.object({ auditId: uuid }), body: z.object({ barcode: z.string().trim().min(1).max(120) }) }),
  async (req, res) => {
    res.json({ data: await svc.recordScan(req.params.auditId, req.body.barcode) });
  },
);
locationsRouter.post(
  '/audits/:auditId/complete',
  requirePermission('physical.audit'),
  validate({ params: z.object({ auditId: uuid }), body: z.object({ markMissing: z.boolean().default(false) }) }),
  async (req, res) => {
    res.json({ data: await svc.completeAudit(req.params.auditId, req.body, req.user) });
  },
);

// ---------------------------------------------------------------- physical items
const itemBody = z.object({
  barcode: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w./-]+$/),
  itemType: z
    .enum([
      'box',
      'folder',
      'volume',
      'item',
      'map',
      'drawing',
      'photograph',
      'audiovisual_carrier',
      'artefact',
      'other',
    ])
    .default('box'),
  title: z.string().trim().min(1).max(1000),
  recordId: uuid.nullable().optional(),
  accessionId: uuid.nullable().optional(),
  materialType: optionalText(80),
  sizeUnits: z.number().min(0).max(10000).optional(),
  isFragile: z.boolean().optional(),
  handlingNotes: optionalText(2000),
  notes: optionalText(20000),
  locationId: uuid.optional(),
  override: z.boolean().optional(),
  overrideReason: optionalText(1000),
});

/**
 * @openapi
 * /physical-items:
 *   get: { tags: [Storage], summary: Physical items (boxes, folders, volumes...), responses: { 200: { description: Paged } } }
 *   post: { tags: [Storage], summary: Register a physical item and its initial placement, responses: { 201: { description: Created } } }
 */
itemsRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(PHYSICAL_STATUSES).optional(),
      recordId: uuid.optional(),
      locationId: uuid.optional(),
      accessionId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.recordId) where.recordId = req.query.recordId;
    if (req.query.locationId) where.currentLocationId = req.query.locationId;
    if (req.query.accessionId) where.accessionId = req.query.accessionId;
    if (req.query.q)
      where[Op.or] = [{ barcode: { [Op.like]: `%${req.query.q}%` } }, { title: { [Op.like]: `%${req.query.q}%` } }];
    paged(
      res,
      await models.PhysicalItem.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, ['barcode', 'title', 'status', 'createdAt'], 'barcode'),
        include: [
          { model: models.StorageLocation, as: 'currentLocation', attributes: ['id', 'code', 'name'] },
          { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] },
        ],
      }),
      req.query,
    );
  },
);

itemsRouter.post('/', requirePermission('physical.move'), validate({ body: itemBody }), async (req, res) => {
  res.status(201).json({ data: await svc.createItem(req.body, req.user) });
});

itemsRouter.get(
  '/by-barcode/:barcode',
  validate({ params: z.object({ barcode: z.string().max(120) }) }),
  async (req, res) => {
    const item = await models.PhysicalItem.findOne({
      where: { barcode: req.params.barcode },
      include: [{ model: models.StorageLocation, as: 'currentLocation', attributes: ['id', 'code', 'name'] }],
    });
    if (!item) throw notFound('Physical item');
    res.json({ data: item });
  },
);

itemsRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const item = await models.PhysicalItem.findByPk(req.params.id, {
    include: [
      { model: models.StorageLocation, as: 'currentLocation', attributes: ['id', 'code', 'name', 'path'] },
      { model: models.StorageLocation, as: 'homeLocation', attributes: ['id', 'code', 'name'] },
      { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title'] },
      { model: models.Accession, as: 'accession', attributes: ['id', 'accessionNumber'] },
    ],
  });
  if (!item) throw notFound('Physical item');
  const [movements, conditions, circulations] = await Promise.all([
    models.PhysicalItemMovement.findAll({
      where: { itemId: item.id },
      order: [['movedAt', 'DESC']],
      limit: 100,
      include: [
        { model: models.StorageLocation, as: 'fromLocation', attributes: ['id', 'code'] },
        { model: models.StorageLocation, as: 'toLocation', attributes: ['id', 'code'] },
        { model: models.User, as: 'movedBy', attributes: ['id', 'fullName'] },
      ],
    }),
    models.ConditionAssessment.findAll({
      where: { itemId: item.id },
      order: [['createdAt', 'DESC']],
      limit: 50,
      include: [{ model: models.User, as: 'assessedBy', attributes: ['id', 'fullName'] }],
    }),
    models.CirculationTransaction.findAll({
      where: { physicalItemId: item.id },
      order: [['createdAt', 'DESC']],
      limit: 50,
    }),
  ]);
  res.json({ data: { ...item.get({ plain: true }), movements, conditions, circulations } });
});

itemsRouter.patch(
  '/:id',
  requirePermission('physical.move'),
  validate({
    params: idParams,
    body: itemBody.partial().omit({ barcode: true, locationId: true, override: true, overrideReason: true }),
  }),
  async (req, res) => {
    const item = await models.PhysicalItem.findByPk(req.params.id);
    if (!item) throw notFound('Physical item');
    const before = item.get({ plain: true });
    await item.update(req.body);
    await audit({
      action: 'physical_item.update',
      resourceType: 'PhysicalItem',
      resourceId: item.id,
      before: { title: before.title, recordId: before.recordId },
      after: req.body,
    });
    res.json({ data: item });
  },
);

const moveBody = z.object({
  toLocationId: uuid,
  movementType: z.enum(['temporary', 'permanent', 'conservation', 'audit_correction']),
  reason: z.string().trim().min(3).max(1000),
  expectedReturnAt: z.string().datetime({ offset: true }).optional(),
  override: z.boolean().optional(),
  overrideReason: optionalText(1000),
});
itemsRouter.post(
  '/:id/move',
  requirePermission('physical.move'),
  validate({ params: idParams, body: moveBody }),
  async (req, res) => {
    res.json({ data: await svc.moveItem(req.params.id, req.body, req.user) });
  },
);
itemsRouter.post(
  '/bulk-move',
  requirePermission('physical.move'),
  validate({ body: moveBody.extend({ itemIds: z.array(uuid).min(1).max(500) }) }),
  async (req, res) => {
    const { itemIds, ...payload } = req.body;
    res.json({ data: { moved: await svc.bulkMove(itemIds, payload, req.user) } });
  },
);
itemsRouter.post(
  '/:id/report-missing',
  requireAnyPermission('physical.move', 'circulation.issue'),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) }),
  async (req, res) => {
    res.json({ data: await svc.reportMissing(req.params.id, req.body.reason) });
  },
);
itemsRouter.post(
  '/:id/condition',
  requireAnyPermission('physical.move', 'circulation.return'),
  validate({
    params: idParams,
    body: z.object({
      context: z.enum(['accession', 'audit', 'conservation', 'digitisation', 'routine']),
      rating: z.enum(['good', 'fair', 'poor', 'critical']),
      notes: optionalText(4000),
      recommendedAction: optionalText(1000),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.assessCondition(req.params.id, req.body, req.user) });
  },
);
