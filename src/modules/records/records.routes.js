/**
 * HTTP routes for archival descriptions, mounted at /api/v1/records.
 *
 * Lists and details are filtered by the access policy, so staff without clearance see restricted descriptions with
 * identifying information only, and liaisons see their own unit's descriptions.
 *
 * - GET / lists descriptions with filters; GET /tree returns a level of the hierarchy for tree navigation.
 * - POST / creates a description ("records.create"); GET /:id shows it with its access decision and breadcrumbs
 *   and, when its content is visible, the number of children, available actions, fields still missing for review
 *   and publication, and linked accessions.
 * - PATCH /:id edits it ("records.update"), with optimistic locking through the `version` field; POST /:id/move
 *   moves it in the hierarchy.
 * - POST /:id/transition performs a workflow action (submit for review, approve, publish, withdraw and so on).
 * - GET /:id/history, GET /:id/versions, GET /:id/versions/compare and GET /:id/versions/:versionNumber show its
 *   history and versions; POST /:id/versions/:versionNumber/restore restores one ("records.restore_version").
 * - PUT /:id/creators, PUT /:id/subjects and PUT /:id/identifiers replace its links; POST and DELETE
 *   /:id/relationships manage related descriptions.
 * - GET /:id/export/:format exports it as an EAD finding aid ("ead") or Dublin Core ("dc") ("records.export").
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { pageParams, orderBy } from '../../utils/pagination.js';
import { notFound } from '../../utils/errors.js';
import {
  evaluateRecord,
  presentRecord,
  recordVisibilityWhere,
  activeGrants,
  hasPerm,
} from '../../services/accessPolicy.service.js';
import { history } from '../../services/workflow.service.js';
import { audit } from '../../services/audit.service.js';
import * as svc from './records.service.js';
import { toEad, toDublinCore } from '../cataloguing/standards.js';
import * as v from './records.validators.js';

const router = Router();
router.use(authenticate);

const LIST_ATTRS = [
  'id',
  'parentId',
  'rootId',
  'level',
  'referenceCode',
  'title',
  'dateExpression',
  'dateStart',
  'dateEnd',
  'status',
  'accessLevel',
  'effectiveAccessLevel',
  'publicVisibility',
  'isFeatured',
  'depth',
  'path',
  'updatedAt',
  'createdAt',
  'extentAndMedium',
  'originatingUnitId',
];

/**
 * Translates the list filters into a Sequelize `where` clause: level, statuses, effective access level, parent,
 * collection, repository, originating unit, top-level only, featured only, date range (a four-digit year covers the
 * whole year) and free text across reference code, title and search text.
 *
 * @param {object} q Validated query parameters.
 * @returns {object} The `where` clause.
 */
function listWhere(q) {
  const where = {};
  if (q.level) where.level = q.level;
  if (q.status) where.status = q.status.split(',');
  if (q.accessLevel) where.effectiveAccessLevel = q.accessLevel;
  if (q.parentId) where.parentId = q.parentId;
  if (q.rootId) where.rootId = q.rootId;
  if (q.repositoryId) where.repositoryId = q.repositoryId;
  if (q.originatingUnitId) where.originatingUnitId = q.originatingUnitId;
  if (q.topLevel === 'true') where.parentId = null;
  if (q.featured === 'true') where.isFeatured = true;
  if (q.dateFrom) where.dateEnd = { [Op.gte]: q.dateFrom.length === 4 ? `${q.dateFrom}-01-01` : q.dateFrom };
  if (q.dateTo) where.dateStart = { [Op.lte]: q.dateTo.length === 4 ? `${q.dateTo}-12-31` : q.dateTo };
  if (q.q)
    where[Op.or] = [
      { referenceCode: { [Op.like]: `%${q.q}%` } },
      { title: { [Op.like]: `%${q.q}%` } },
      { searchText: { [Op.like]: `%${q.q}%` } },
    ];
  return where;
}

/**
 * @openapi
 * /records:
 *   get:
 *     tags: [Archival records]
 *     summary: List archival descriptions visible to the caller (all levels; use topLevel=true for collections/fonds)
 *     parameters:
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: level, schema: { type: string, enum: [fonds, collection, subfonds, series, subseries, file, item] } }
 *       - { in: query, name: status, schema: { type: string }, description: Comma-separated statuses }
 *       - { in: query, name: parentId, schema: { type: string, format: uuid } }
 *       - { in: query, name: topLevel, schema: { type: boolean } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *     responses: { 200: { description: Paged list } }
 *   post:
 *     tags: [Archival records]
 *     summary: Create a description (records.create). Reference code is derived from the parent when omitted.
 *     responses: { 201: { description: Created }, 409: { description: Duplicate reference code } }
 */
router.get(
  '/',
  requireAnyPermission('records.read', 'transfer.submit'),
  validate({ query: v.listRecordsSchema }),
  async (req, res) => {
    const grants = await activeGrants(req.user);
    const visibility = await recordVisibilityWhere(req.user, { grants });
    const where = { [Op.and]: [listWhere(req.query), visibility] };
    const { rows, count } = await models.ArchivalRecord.findAndCountAll({
      where,
      attributes: LIST_ATTRS,
      ...pageParams(req.query),
      order: orderBy(
        req.query.sort,
        req.query.order,
        ['referenceCode', 'title', 'dateStart', 'updatedAt', 'createdAt', 'sortOrder', 'status'],
        req.query.parentId ? 'sortOrder' : 'updatedAt',
      ),
    });
    const childCounts = rows.length
      ? await models.ArchivalRecord.count({ where: { parentId: rows.map((r) => r.id) }, group: ['parentId'] })
      : [];
    const byParent = Object.fromEntries(childCounts.map((c) => [c.parentId, c.count]));
    const data = [];
    for (const r of rows) {
      const decision = await evaluateRecord(req.user, r, { grants });
      data.push({ ...presentRecord(r, decision, { staffView: true }), childCount: byParent[r.id] || 0 });
    }
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

router.post('/', requirePermission('records.create'), validate({ body: v.createRecordSchema }), async (req, res) => {
  const record = await svc.createRecord(req.body, req.user);
  res.status(201).json({ data: record });
});

/**
 * @openapi
 * /records/tree:
 *   get: { tags: [Archival records], summary: Children of a node (or top-level descriptions) for lazy tree navigation, responses: { 200: { description: Nodes } } }
 */
router.get(
  '/tree',
  requireAnyPermission('records.read', 'transfer.submit'),
  validate({ query: z.object({ parentId: z.string().uuid().optional() }) }),
  async (req, res) => {
    const visibility = await recordVisibilityWhere(req.user);
    const rows = await models.ArchivalRecord.findAll({
      where: { [Op.and]: [{ parentId: req.query.parentId ?? null }, visibility] },
      attributes: [
        'id',
        'parentId',
        'level',
        'referenceCode',
        'title',
        'status',
        'effectiveAccessLevel',
        'dateExpression',
      ],
      order: [
        ['sortOrder', 'ASC'],
        ['referenceCode', 'ASC'],
      ],
      limit: 500,
    });
    const counts = rows.length
      ? await models.ArchivalRecord.count({ where: { parentId: rows.map((r) => r.id) }, group: ['parentId'] })
      : [];
    const byParent = Object.fromEntries(counts.map((c) => [c.parentId, c.count]));
    res.json({ data: rows.map((r) => ({ ...r.get({ plain: true }), childCount: byParent[r.id] || 0 })) });
  },
);

/**
 * @openapi
 * /records/{id}:
 *   get: { tags: [Archival records], summary: Full description with hierarchy, links and allowed workflow actions, responses: { 200: { description: Description }, 404: { description: Not found or not visible } } }
 *   patch: { tags: [Archival records], summary: Update descriptive fields (optimistic concurrency via version), responses: { 200: { description: Updated }, 409: { description: Stale version } } }
 */
router.get(
  '/:id',
  requireAnyPermission('records.read', 'transfer.submit'),
  validate({ params: idParams }),
  async (req, res) => {
    const record = await svc.getRecordDetail(req.params.id);
    const decision = await evaluateRecord(req.user, record);
    if (!decision.canDiscover) throw notFound('Archival description');
    const crumbs = await svc.breadcrumbs(record);
    const data = presentRecord(record, decision, { staffView: hasPerm(req.user, 'records.read') });
    data.breadcrumbs = crumbs;
    if (decision.mode === 'full') {
      data.childCount = await models.ArchivalRecord.count({ where: { parentId: record.id } });
      data.availableActions = svc.actionsFor(record, req.user);
      data.missingForReview = svc.missingFields(record, svc.REQUIRED_FOR_REVIEW[record.level]);
      data.missingForPublication = svc.missingFields(record, [
        ...svc.REQUIRED_FOR_REVIEW[record.level],
        ...svc.REQUIRED_FOR_PUBLICATION,
      ]);
      data.accessions = (
        await models.AccessionRecordLink.findAll({
          where: { recordId: record.id },
          include: [
            { model: models.Accession, as: 'accession', attributes: ['id', 'accessionNumber', 'title', 'status'] },
          ],
        })
      ).map((l) => l.accession);
    }
    res.json({ data });
  },
);

router.patch(
  '/:id',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.updateRecordSchema }),
  async (req, res) => {
    res.json({ data: await svc.updateRecord(req.params.id, req.body, req.user) });
  },
);

router.post(
  '/:id/move',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.moveSchema }),
  async (req, res) => {
    res.json({ data: await svc.moveRecord(req.params.id, req.body, req.user) });
  },
);

/**
 * @openapi
 * /records/{id}/transition:
 *   post:
 *     tags: [Archival records]
 *     summary: Apply a workflow action (submit_for_review, return_to_draft, approve, publish, withdraw, reinstate)
 *     responses: { 200: { description: New state }, 409: { description: Invalid transition }, 422: { description: Required metadata missing } }
 */
router.post('/:id/transition', validate({ params: idParams, body: v.transitionSchema }), async (req, res) => {
  const record = await svc.transitionRecord(req.params.id, req.body, req.user);
  res.json({ data: { id: record.id, status: record.status, availableActions: svc.actionsFor(record, req.user) } });
});

router.get('/:id/history', requirePermission('records.read'), validate({ params: idParams }), async (req, res) => {
  res.json({ data: await history('ArchivalRecord', req.params.id) });
});

router.get('/:id/versions', requirePermission('records.read'), validate({ params: idParams }), async (req, res) => {
  const rows = await models.ArchivalRecordVersion.findAll({
    where: { recordId: req.params.id },
    attributes: ['id', 'versionNumber', 'status', 'changeSummary', 'changedFields', 'createdAt'],
    include: [{ model: models.User, as: 'changedBy', attributes: ['id', 'fullName'] }],
    order: [['versionNumber', 'DESC']],
  });
  res.json({ data: rows });
});

router.get(
  '/:id/versions/compare',
  requirePermission('records.read'),
  validate({
    params: idParams,
    query: z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
  }),
  async (req, res) => {
    const [a, b] = await Promise.all(
      [req.query.from, req.query.to].map((n) =>
        models.ArchivalRecordVersion.findOne({ where: { recordId: req.params.id, versionNumber: n } }),
      ),
    );
    if (!a || !b) throw notFound('Version');
    res.json({
      data: { from: a.versionNumber, to: b.versionNumber, changes: svc.compareSnapshots(a.snapshot, b.snapshot) },
    });
  },
);

router.get(
  '/:id/versions/:versionNumber',
  requirePermission('records.read'),
  validate({ params: z.object({ id: z.string().uuid(), versionNumber: z.coerce.number().int().min(1) }) }),
  async (req, res) => {
    const v1 = await models.ArchivalRecordVersion.findOne({
      where: { recordId: req.params.id, versionNumber: req.params.versionNumber },
      include: [{ model: models.User, as: 'changedBy', attributes: ['id', 'fullName'] }],
    });
    if (!v1) throw notFound('Version');
    res.json({ data: v1 });
  },
);

router.post(
  '/:id/versions/:versionNumber/restore',
  requirePermission('records.restore_version'),
  validate({
    params: z.object({ id: z.string().uuid(), versionNumber: z.coerce.number().int().min(1) }),
    body: z.object({ reason: z.string().trim().min(3).max(1000) }),
  }),
  async (req, res) => {
    res.json({ data: await svc.restoreVersion(req.params.id, req.params.versionNumber, req.user, req.body.reason) });
  },
);

router.put(
  '/:id/creators',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.creatorsSchema }),
  async (req, res) => {
    await svc.setCreators(req.params.id, req.body.creators, req.user);
    res.json({ data: { ok: true } });
  },
);
router.put(
  '/:id/subjects',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.subjectsSchema }),
  async (req, res) => {
    await svc.setSubjects(req.params.id, req.body.subjects, req.user);
    res.json({ data: { ok: true } });
  },
);
router.put(
  '/:id/identifiers',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.identifiersSchema }),
  async (req, res) => {
    await svc.setIdentifiers(req.params.id, req.body.identifiers, req.user);
    res.json({ data: { ok: true } });
  },
);

router.post(
  '/:id/relationships',
  requirePermission('records.update'),
  validate({ params: idParams, body: v.relationshipSchema }),
  async (req, res) => {
    if (req.body.targetId === req.params.id) throw notFound('Related description');
    const [source, target] = await Promise.all([
      models.ArchivalRecord.findByPk(req.params.id),
      models.ArchivalRecord.findByPk(req.body.targetId),
    ]);
    if (!source || !target) throw notFound('Archival description');
    const [rel] = await models.RecordRelationship.findOrCreate({
      where: { sourceId: source.id, targetId: target.id, relationType: req.body.relationType },
      defaults: { sourceId: source.id, targetId: target.id, ...req.body },
    });
    await audit({
      action: 'record.relationship_added',
      resourceType: 'ArchivalRecord',
      resourceId: source.id,
      after: { targetId: target.id, relationType: req.body.relationType },
    });
    res.status(201).json({ data: rel });
  },
);

router.delete(
  '/:id/relationships/:relId',
  requirePermission('records.update'),
  validate({ params: z.object({ id: z.string().uuid(), relId: z.string().uuid() }) }),
  async (req, res) => {
    const rel = await models.RecordRelationship.findOne({ where: { id: req.params.relId, sourceId: req.params.id } });
    if (!rel) throw notFound('Relationship');
    await rel.destroy();
    await audit({
      action: 'record.relationship_removed',
      resourceType: 'ArchivalRecord',
      resourceId: req.params.id,
      before: { targetId: rel.targetId, relationType: rel.relationType },
    });
    res.status(204).end();
  },
);

/**
 * @openapi
 * /records/{id}/export/{format}:
 *   get: { tags: [Archival records], summary: "Export a description as EAD3-style XML (with descendants) or Dublin Core. Not schema-validated.", responses: { 200: { description: XML } } }
 */
router.get(
  '/:id/export/:format',
  requirePermission('records.export'),
  validate({ params: z.object({ id: z.string().uuid(), format: z.enum(['ead', 'dc']) }) }),
  async (req, res) => {
    const record = await models.ArchivalRecord.findByPk(req.params.id);
    if (!record) throw notFound('Archival description');
    const decision = await evaluateRecord(req.user, record);
    if (!decision.canDiscover) throw notFound('Archival description');
    const xml =
      req.params.format === 'ead'
        ? await toEad(record, req.user)
        : await toDublinCore(record, decision.mode === 'full');
    await audit({
      action: `record.export_${req.params.format}`,
      resourceType: 'ArchivalRecord',
      resourceId: record.id,
    });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${record.referenceCode.replace(/[^\w-]+/g, '_')}-${req.params.format}.xml"`,
    );
    res.send(xml);
  },
);

export default router;
