/**
 * HTTP routes for authority records (persons, families, corporate bodies, University units, places, subjects and
 * functions), mounted at /api/v1/authority-records.
 *
 * Authority records follow ISAAR(CPF) and keep names consistent across descriptions. Reading requires
 * "records.read" or "authority.manage"; changes require "authority.manage" and are audited.
 *
 * - GET / searches authority records; GET /:id returns one with its relationships and linked descriptions.
 * - GET /duplicates finds possible duplicates of a name for a person to review.
 * - POST / and PATCH /:id create and edit records; creating returns possible duplicates.
 * - POST /:id/relationships and DELETE /:id/relationships/:relId manage relationships between authorities.
 * - POST /:id/merge merges a duplicate into another record, keeping its history and moving its links.
 * - GET /:id/history returns the change history; GET /:id/export/eac exports the record as EAC-CPF XML.
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
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { notFound, conflict, badRequest } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { toEacCpf } from './standards.js';

const router = Router();
router.use(authenticate);

const ENTITY_TYPES = ['person', 'family', 'corporate_body', 'university_unit', 'place', 'subject', 'function'];

/**
 * Normalises a name for duplicate detection.
 *
 * Accents are removed, letters are lower-cased, punctuation becomes spaces, common particles and titles (the, of,
 * and, Dr, Prof, Mr, Mrs, Ms) are dropped and spaces are collapsed. For example "Prof. Kwámé Nkrumah" and "Kwame
 * Nkrumah" give the same result.
 *
 * @param {string|null|undefined} s The name.
 * @returns {string} The normalised form; empty for an empty name.
 */
export const normaliseName = (s) =>
  (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|of|and|dr|prof|mr|mrs|ms)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const body = z.object({
  entityType: z.enum(ENTITY_TYPES),
  authorizedName: z.string().trim().min(1).max(500),
  otherNames: z.array(z.string().trim().max(500)).max(50).optional(),
  historicalNames: z
    .array(
      z.object({ name: z.string().max(500), from: z.string().max(20).optional(), to: z.string().max(20).optional() }),
    )
    .max(50)
    .optional(),
  identifier: optionalText(120),
  datesOfExistence: optionalText(255),
  history: optionalText(100000),
  places: optionalText(1000),
  legalStatus: optionalText(500),
  functions: optionalText(20000),
  mandates: optionalText(20000),
  internalStructure: optionalText(20000),
  generalContext: optionalText(20000),
  sources: optionalText(20000),
  externalIds: z
    .array(z.object({ source: z.string().max(60), id: z.string().max(255), uri: z.string().url().optional() }))
    .max(20)
    .optional(),
  verificationStatus: z.enum(['unverified', 'provisional', 'verified']).optional(),
  organisationUnitId: uuid.nullable().optional(),
  status: z.enum(['draft', 'approved', 'deprecated']).optional(),
});

/**
 * Finds existing authority records of the same type whose names may duplicate the given name.
 *
 * Candidates share the normalised name or one of its first four significant words. Each is scored by the share of
 * words the two names have in common (1 for an identical normalised name); those scoring at least 0.5 are returned,
 * best first. Merged records are ignored. Possible duplicates are only suggested; a person decides whether to
 * merge.
 *
 * @param {string} name The name to check.
 * @param {string} entityType Type of authority, for example "person".
 * @param {string} [excludeId] Record to leave out, such as the one being edited.
 * @returns {Promise<object[]>} Up to ten candidates with a `score` from 0.5 to 1.
 */
async function findSimilar(name, entityType, excludeId) {
  const n = normaliseName(name);
  if (!n) return [];
  const tokens = n
    .split(' ')
    .filter((tk) => tk.length > 2)
    .slice(0, 4);
  const ors = [{ normalisedName: n }, ...tokens.map((tk) => ({ normalisedName: { [Op.like]: `%${tk}%` } }))];
  const rows = await models.AuthorityRecord.findAll({
    where: {
      entityType,
      status: { [Op.ne]: 'merged' },
      [Op.or]: ors,
      ...(excludeId && { id: { [Op.ne]: excludeId } }),
    },
    attributes: ['id', 'authorizedName', 'datesOfExistence', 'normalisedName', 'verificationStatus'],
    limit: 50,
  });
  return rows
    .map((r) => {
      const other = new Set(r.normalisedName.split(' '));
      const mine = new Set(n.split(' '));
      const overlap = [...mine].filter((x) => other.has(x)).length / Math.max(mine.size, other.size);
      return { ...r.get({ plain: true }), score: r.normalisedName === n ? 1 : Number(overlap.toFixed(2)) };
    })
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

/**
 * @openapi
 * /authority-records:
 *   get: { tags: [Authority records], summary: Search authority records (ISAAR(CPF)-informed), responses: { 200: { description: Paged } } }
 *   post: { tags: [Authority records], summary: Create an authority record; returns possible duplicates for human review, responses: { 201: { description: Created } } }
 */
router.get(
  '/',
  requireAnyPermission('records.read', 'authority.manage'),
  validate({
    query: paginationSchema.extend({ entityType: z.enum(ENTITY_TYPES).optional(), status: z.string().optional() }),
  }),
  async (req, res) => {
    const where = { status: { [Op.ne]: 'merged' } };
    if (req.query.entityType) where.entityType = req.query.entityType;
    if (req.query.status) where.status = req.query.status;
    if (req.query.q)
      where[Op.or] = [
        { authorizedName: { [Op.like]: `%${req.query.q}%` } },
        { normalisedName: { [Op.like]: `%${normaliseName(req.query.q)}%` } },
        { identifier: req.query.q },
      ];
    paged(
      res,
      await models.AuthorityRecord.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, ['authorizedName', 'createdAt', 'updatedAt'], 'authorizedName'),
      }),
      req.query,
    );
  },
);

router.get(
  '/duplicates',
  requirePermission('authority.manage'),
  validate({
    query: z.object({ name: z.string().min(2).max(500), entityType: z.enum(ENTITY_TYPES), excludeId: uuid.optional() }),
  }),
  async (req, res) => {
    res.json({ data: await findSimilar(req.query.name, req.query.entityType, req.query.excludeId) });
  },
);

router.post('/', requirePermission('authority.manage'), validate({ body }), async (req, res) => {
  if (req.body.identifier && (await models.AuthorityRecord.findOne({ where: { identifier: req.body.identifier } })))
    throw conflict('Authority identifier already in use');
  const possibleDuplicates = await findSimilar(req.body.authorizedName, req.body.entityType);
  const rec = await sequelize.transaction(async (t) => {
    const r = await models.AuthorityRecord.create(
      {
        ...req.body,
        normalisedName: normaliseName(req.body.authorizedName),
        createdById: req.user.id,
        updatedById: req.user.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'authority.create',
        resourceType: 'AuthorityRecord',
        resourceId: r.id,
        after: { authorizedName: r.authorizedName, entityType: r.entityType },
      },
      { transaction: t },
    );
    return r;
  });
  res.status(201).json({ data: rec, meta: { possibleDuplicates } });
});

router.get(
  '/:id',
  requireAnyPermission('records.read', 'authority.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const rec = await models.AuthorityRecord.findByPk(req.params.id, {
      include: [
        { model: models.OrganisationUnit, as: 'organisationUnit', attributes: ['id', 'name'] },
        { model: models.AuthorityRecord, as: 'mergedInto', attributes: ['id', 'authorizedName'] },
      ],
    });
    if (!rec) throw notFound('Authority record');
    const [outgoing, incoming, creatorOf] = await Promise.all([
      models.AuthorityRelationship.findAll({
        where: { sourceId: rec.id },
        include: [{ model: models.AuthorityRecord, as: 'target', attributes: ['id', 'authorizedName', 'entityType'] }],
      }),
      models.AuthorityRelationship.findAll({
        where: { targetId: rec.id },
        include: [{ model: models.AuthorityRecord, as: 'source', attributes: ['id', 'authorizedName', 'entityType'] }],
      }),
      models.RecordCreator.findAll({
        where: { authorityId: rec.id },
        include: [
          { model: models.ArchivalRecord, as: 'record', attributes: ['id', 'referenceCode', 'title', 'level'] },
        ],
        limit: 100,
      }),
    ]);
    res.json({
      data: {
        ...rec.get({ plain: true }),
        relationships: { outgoing, incoming },
        linkedRecords: creatorOf.map((c) => ({ ...c.record.get({ plain: true }), role: c.role })),
      },
    });
  },
);

router.patch(
  '/:id',
  requirePermission('authority.manage'),
  validate({ params: idParams, body: body.partial().extend({ version: z.number().int() }) }),
  async (req, res) => {
    const rec = await models.AuthorityRecord.findByPk(req.params.id);
    if (!rec) throw notFound('Authority record');
    if (rec.status === 'merged') throw badRequest('Merged authority records cannot be edited');
    if (rec.version !== req.body.version)
      throw conflict('This authority record was changed by someone else. Reload and try again.');
    const { version, ...changes } = req.body;
    await sequelize.transaction(async (t) => {
      const before = rec.get({ plain: true });
      await rec.update(
        {
          ...changes,
          ...(changes.authorizedName && { normalisedName: normaliseName(changes.authorizedName) }),
          updatedById: req.user.id,
        },
        { transaction: t },
      );
      const d = diff(before, rec);
      await audit(
        {
          action: 'authority.update',
          resourceType: 'AuthorityRecord',
          resourceId: rec.id,
          before: d.before,
          after: d.after,
        },
        { transaction: t },
      );
    });
    res.json({ data: rec });
  },
);

router.post(
  '/:id/relationships',
  requirePermission('authority.manage'),
  validate({
    params: idParams,
    body: z.object({
      targetId: uuid,
      relationType: z.string().trim().min(2).max(60),
      dates: z.string().max(255).optional(),
      note: z.string().max(1000).optional(),
    }),
  }),
  async (req, res) => {
    if (req.body.targetId === req.params.id) throw badRequest('An authority cannot relate to itself');
    const rel = await models.AuthorityRelationship.create({ sourceId: req.params.id, ...req.body });
    await audit({
      action: 'authority.relationship_added',
      resourceType: 'AuthorityRecord',
      resourceId: req.params.id,
      after: req.body,
    });
    res.status(201).json({ data: rel });
  },
);

router.delete(
  '/:id/relationships/:relId',
  requirePermission('authority.manage'),
  validate({ params: z.object({ id: uuid, relId: uuid }) }),
  async (req, res) => {
    const rel = await models.AuthorityRelationship.findOne({
      where: { id: req.params.relId, sourceId: req.params.id },
    });
    if (!rel) throw notFound('Relationship');
    await rel.destroy();
    await audit({
      action: 'authority.relationship_removed',
      resourceType: 'AuthorityRecord',
      resourceId: req.params.id,
      before: { targetId: rel.targetId, relationType: rel.relationType },
    });
    res.status(204).end();
  },
);

/**
 * @openapi
 * /authority-records/{id}/merge:
 *   post: { tags: [Authority records], summary: Merge this record INTO targetId after human review. Links move to the target; this record is kept as 'merged'., responses: { 200: { description: Merged } } }
 */
router.post(
  '/:id/merge',
  requirePermission('authority.manage'),
  validate({
    params: idParams,
    body: z.object({ targetId: uuid, reason: z.string().trim().min(5).max(1000), confirm: z.literal(true) }),
  }),
  async (req, res) => {
    const [source, target] = await Promise.all([
      models.AuthorityRecord.findByPk(req.params.id),
      models.AuthorityRecord.findByPk(req.body.targetId),
    ]);
    if (!source || !target) throw notFound('Authority record');
    if (source.id === target.id || source.status === 'merged' || target.status === 'merged')
      throw badRequest('Invalid merge');
    if (source.entityType !== target.entityType) throw badRequest('Only records of the same entity type can be merged');
    await sequelize.transaction(async (t) => {
      const creatorLinks = await models.RecordCreator.findAll({ where: { authorityId: source.id }, transaction: t });
      for (const link of creatorLinks) {
        const exists = await models.RecordCreator.findOne({
          where: { recordId: link.recordId, authorityId: target.id, role: link.role },
          transaction: t,
        });
        if (exists) await link.destroy({ transaction: t });
        else await link.update({ authorityId: target.id }, { transaction: t });
      }
      await models.RecordSubject.update(
        { authorityId: target.id },
        { where: { authorityId: source.id }, transaction: t },
      );
      await models.AuthorityRelationship.update(
        { sourceId: target.id },
        { where: { sourceId: source.id }, transaction: t },
      );
      await models.AuthorityRelationship.update(
        { targetId: target.id },
        { where: { targetId: source.id }, transaction: t },
      );
      const otherNames = [
        ...new Set([...(target.otherNames || []), source.authorizedName, ...(source.otherNames || [])]),
      ];
      await target.update({ otherNames }, { transaction: t });
      await source.update({ status: 'merged', mergedIntoId: target.id }, { transaction: t });
      await audit(
        {
          action: 'authority.merge',
          resourceType: 'AuthorityRecord',
          resourceId: source.id,
          after: { mergedInto: target.id, movedCreatorLinks: creatorLinks.length },
          reason: req.body.reason,
        },
        { transaction: t },
      );
    });
    res.json({ data: { ok: true, mergedInto: target.id } });
  },
);

router.get(
  '/:id/history',
  requireAnyPermission('records.read', 'authority.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const rows = await models.AuditEvent.findAll({
      where: { resourceType: 'AuthorityRecord', resourceId: req.params.id },
      attributes: ['seq', 'occurredAt', 'actorLabel', 'action', 'before', 'after', 'reason'],
      order: [['seq', 'DESC']],
      limit: 200,
    });
    res.json({ data: rows });
  },
);

router.get(
  '/:id/export/eac',
  requireAnyPermission('records.read', 'authority.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const rec = await models.AuthorityRecord.findByPk(req.params.id);
    if (!rec) throw notFound('Authority record');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="authority-${rec.id}-eac.xml"`);
    res.send(toEacCpf(rec));
  },
);

export default router;
