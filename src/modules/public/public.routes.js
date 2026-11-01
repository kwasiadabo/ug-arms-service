/**
 * HTTP routes for the public discovery portal, mounted at /api/v1/public. No account is needed.
 *
 * - GET /home returns featured collections, recent publications, highlights and live counts.
 * - GET /search and GET /suggest search published descriptions and suggest titles, creators and subjects
 *   (rate-limited).
 * - GET /collections and GET /browse/:facet list collections and browse by creator, subject, decade or level of
 *   description.
 * - GET /records/:id, GET /records/:id/children and GET /records/:id/finding-aid show a description, its children
 *   and its whole collection as a finding aid.
 * - GET /thumbnails/:id streams a thumbnail after the same access check as any file.
 *
 * Only publicly discoverable material is shown. Restricted descriptions appear with identifying information only,
 * and hidden ones do not appear at all. A signed-in researcher additionally sees the full content of descriptions
 * covered by their access grants.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { optionalAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { publicSearchLimiter } from '../../middleware/rateLimit.js';
import { idParams } from '../../validators/common.js';
import { notFound } from '../../utils/errors.js';
import { evaluateRecord, evaluateAsset, pathIds } from '../../services/accessPolicy.service.js';
import { getSetting } from '../../services/settings.service.js';
import { storage } from '../../services/storage/index.js';
import * as search from '../search/search.service.js';
import { searchQuery } from '../search/search.routes.js';
import { buildCitation } from './citation.js';

const router = Router();
router.use(optionalAuth);

// Explicit whitelist: the public portal never receives internal notes, workflow fields or storage data.
const PUBLIC_FULL = [
  'id',
  'parentId',
  'rootId',
  'level',
  'referenceCode',
  'title',
  'alternativeTitle',
  'dateExpression',
  'dateStart',
  'dateEnd',
  'bulkDateStart',
  'bulkDateEnd',
  'extentAndMedium',
  'creatorNote',
  'adminBiographicalHistory',
  'archivalHistory',
  'immediateSource',
  'scopeAndContent',
  'accruals',
  'arrangement',
  'accessConditions',
  'reproductionConditions',
  'copyrightStatement',
  'languages',
  'scripts',
  'physicalCharacteristics',
  'findingAids',
  'locationOfOriginals',
  'locationOfCopies',
  'relatedMaterials',
  'publicationNote',
  'rulesConventions',
  'descriptionDate',
  'preferredCitation',
  'geographicCoverage',
  'keywords',
  'publishedAt',
  'effectiveAccessLevel',
  'effectiveFlags',
];
const PUBLIC_META = [
  'id',
  'parentId',
  'rootId',
  'level',
  'referenceCode',
  'title',
  'dateExpression',
  'extentAndMedium',
  'accessConditions',
  'reproductionConditions',
  'preferredCitation',
  'effectiveAccessLevel',
];

/**
 * Copies only the listed properties of an object, leaving out those that are undefined.
 *
 * @param {object} obj Source object.
 * @param {string[]} keys Properties to keep.
 * @returns {object}
 */
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const publicWhere = { publicVisibility: ['full', 'metadata_only'] };

/**
 * Loads a description for the public portal, with its repository.
 *
 * The description must be publicly discoverable, or covered by one of the signed-in researcher's grants; otherwise
 * it is reported as not found. The display mode is "full" for open descriptions and granted ones, and
 * "metadata_only" for restricted ones.
 *
 * @param {string} id Identifier of the description.
 * @param {object|null} user Signed-in researcher, or null.
 * @returns {Promise<{ record: object, decision: object, mode: 'full'|'metadata_only' }>}
 * @throws {AppError} 404 when the description is not publicly visible.
 */
async function loadPublicRecord(id, user) {
  const record = await models.ArchivalRecord.findByPk(id, {
    include: [
      { model: models.Repository, as: 'repository', attributes: ['id', 'code', 'name', 'address', 'openingTimes'] },
    ],
  });
  if (!record) throw notFound('Archival description');
  const decision = await evaluateRecord(user, record);
  // The public portal shows only what is publicly discoverable, or what this researcher holds a grant for.
  const allowed = record.publicVisibility !== 'hidden' || decision.grant;
  if (!allowed) throw notFound('Archival description');
  const mode = record.publicVisibility === 'full' || decision.grant ? 'full' : 'metadata_only';
  return { record, decision: { ...decision, mode }, mode };
}

/**
 * @openapi
 * /public/home:
 *   get: { tags: [Public portal], security: [], summary: Homepage content (featured collections, recent publications, highlights, statistics), responses: { 200: { description: Home } } }
 */
router.get('/home', async (req, res) => {
  const [featured, recent, highlights, collections, descriptions, digital, institution] = await Promise.all([
    models.ArchivalRecord.findAll({
      where: { ...publicWhere, parentId: null, isFeatured: true },
      attributes: [
        'id',
        'title',
        'referenceCode',
        'dateExpression',
        'scopeAndContent',
        'extentAndMedium',
        'level',
        'publicVisibility',
      ],
      limit: 6,
      order: [['publishedAt', 'DESC']],
    }),
    models.ArchivalRecord.findAll({
      where: publicWhere,
      attributes: ['id', 'title', 'referenceCode', 'dateExpression', 'level', 'publishedAt'],
      limit: 8,
      order: [['publishedAt', 'DESC']],
    }),
    models.DigitalAsset.findAll({
      where: {
        role: 'thumbnail',
        status: 'available',
        isPublished: true,
        accessLevel: { [Op.in]: ['inherit', 'open'] },
      },
      attributes: ['id', 'recordId'],
      include: [
        {
          model: models.ArchivalRecord,
          as: 'record',
          where: { publicVisibility: 'full' },
          attributes: ['id', 'title', 'dateExpression'],
        },
      ],
      limit: 8,
      order: [['createdAt', 'DESC']],
    }),
    models.ArchivalRecord.count({ where: { ...publicWhere, parentId: null } }),
    models.ArchivalRecord.count({ where: publicWhere }),
    models.DigitalAsset.count({ where: { isPublished: true, status: 'available', role: { [Op.ne]: 'thumbnail' } } }),
    getSetting('institution.name'),
  ]);
  res.json({
    data: {
      institution,
      featured: featured.map((f) =>
        f.publicVisibility === 'full' ? f.get({ plain: true }) : pick(f.get({ plain: true }), PUBLIC_META),
      ),
      recent,
      highlights: highlights.map((h) => ({
        assetId: h.id,
        recordId: h.recordId,
        title: h.record.title,
        dateExpression: h.record.dateExpression,
      })),
      stats: { collections, descriptions, digitalItems: digital },
    },
  });
});

router.get('/search', publicSearchLimiter, validate({ query: searchQuery }), async (req, res) => {
  res.json({ data: await search.search(req.user ?? null, { ...req.query, scope: 'public' }) });
});

router.get(
  '/suggest',
  publicSearchLimiter,
  validate({ query: z.object({ q: z.string().max(100) }) }),
  async (req, res) => {
    res.json({ data: await search.suggest(req.user ?? null, req.query.q, 'public') });
  },
);

router.get(
  '/collections',
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(60).default(24),
      q: z.string().max(100).optional(),
    }),
  }),
  async (req, res) => {
    const where = { ...publicWhere, parentId: null };
    if (req.query.q) where.title = { [Op.like]: `%${req.query.q}%` };
    const { rows, count } = await models.ArchivalRecord.findAndCountAll({
      where,
      attributes: [
        'id',
        'title',
        'referenceCode',
        'dateExpression',
        'extentAndMedium',
        'scopeAndContent',
        'level',
        'publicVisibility',
      ],
      order: [['title', 'ASC']],
      limit: req.query.pageSize,
      offset: (req.query.page - 1) * req.query.pageSize,
    });
    res.json({
      data: rows.map((r) =>
        r.publicVisibility === 'full' ? r.get({ plain: true }) : pick(r.get({ plain: true }), PUBLIC_META),
      ),
      meta: {
        page: req.query.page,
        pageSize: req.query.pageSize,
        total: count,
        totalPages: Math.ceil(count / req.query.pageSize),
      },
    });
  },
);

router.get(
  '/browse/:facet',
  validate({ params: z.object({ facet: z.enum(['creators', 'subjects', 'decades', 'levels']) }) }),
  async (req, res) => {
    const result = await search.search(req.user ?? null, { q: '', page: 1, pageSize: 1, scope: 'public' });
    const map = { creators: 'creator', subjects: 'subject', decades: 'decade', levels: 'level' };
    res.json({ data: result.facets?.[map[req.params.facet]] ?? [] });
  },
);

/**
 * @openapi
 * /public/records/{id}:
 *   get: { tags: [Public portal], security: [], summary: Public view of a description. Restricted items show only safe metadata; hidden items return 404., responses: { 200: { description: Record }, 404: { description: Not found } } }
 */
router.get('/records/:id', validate({ params: idParams }), async (req, res) => {
  const { record, decision, mode } = await loadPublicRecord(req.params.id, req.user ?? null);
  const plain = record.get({ plain: true });
  const data = pick(plain, mode === 'full' ? PUBLIC_FULL : PUBLIC_META);
  data.access = { mode, canDownload: decision.canDownload, viaGrant: Boolean(decision.grant) };
  data.repository = plain.repository;
  // Public explanation of restrictions only; internal notes and legal basis stay private.
  data.accessExplanations = (
    await models.AccessRestriction.findAll({
      where: { targetType: 'record', targetId: pathIds(record.path), status: ['active', 'expired_pending_review'] },
      attributes: ['restrictionType', 'publicExplanation', 'expiresAt'],
    })
  ).map((r) => ({
    type: r.restrictionType,
    explanation: r.publicExplanation,
    until: r.restrictionType === 'embargoed' ? r.expiresAt : undefined,
  }));
  const ancestors = pathIds(record.path).filter((x) => x !== record.id);
  data.breadcrumbs = ancestors.length
    ? (
        await models.ArchivalRecord.findAll({
          where: { id: ancestors, ...publicWhere },
          attributes: ['id', 'title', 'referenceCode', 'level'],
        })
      ).sort((a, b) => ancestors.indexOf(a.id) - ancestors.indexOf(b.id))
    : [];
  data.childCount = await models.ArchivalRecord.count({ where: { parentId: record.id, ...publicWhere } });
  if (mode === 'full') {
    const [creators, subjects, related] = await Promise.all([
      models.RecordCreator.findAll({
        where: { recordId: record.id },
        include: [
          {
            model: models.AuthorityRecord,
            as: 'authority',
            attributes: ['id', 'authorizedName', 'entityType', 'datesOfExistence'],
          },
        ],
      }),
      models.RecordSubject.findAll({
        where: { recordId: record.id },
        include: [
          { model: models.VocabularyTerm, as: 'term', attributes: ['id', 'label'] },
          { model: models.AuthorityRecord, as: 'authority', attributes: ['id', 'authorizedName'] },
        ],
      }),
      models.RecordRelationship.findAll({
        where: { sourceId: record.id },
        include: [
          {
            model: models.ArchivalRecord,
            as: 'target',
            where: publicWhere,
            attributes: ['id', 'title', 'referenceCode'],
          },
        ],
      }),
    ]);
    data.creators = creators.map((c) => ({ ...c.authority.get({ plain: true }), role: c.role }));
    data.subjects = subjects.map((s) => ({
      id: s.term?.id ?? s.authority?.id,
      label: s.term?.label ?? s.authority?.authorizedName,
      type: s.subjectType,
    }));
    data.related = related.map((r) => ({ ...r.target.get({ plain: true }), relationType: r.relationType }));
    const assets = await models.DigitalAsset.findAll({
      where: {
        recordId: record.id,
        status: 'available',
        role: { [Op.in]: ['access_derivative', 'original_upload', 'migrated_version'] },
      },
      attributes: [
        'id',
        'title',
        'originalFilename',
        'mediaType',
        'role',
        'pageCount',
        'width',
        'height',
        'durationSeconds',
        'downloadAllowed',
        'isPublished',
        'accessLevel',
        'status',
        'malwareStatus',
        'parentAssetId',
      ],
    });
    const thumbs = await models.DigitalAsset.findAll({
      where: { recordId: record.id, role: 'thumbnail', status: 'available', isPublished: true },
      attributes: ['id', 'parentAssetId'],
    });
    const thumbByParent = new Map(thumbs.map((t) => [t.parentAssetId, t.id]));
    data.digitalItems = [];
    for (const a of assets) {
      const d = await evaluateAsset(req.user ?? null, a, record);
      if (d.canView)
        data.digitalItems.push({
          id: a.id,
          title: a.title || a.originalFilename,
          mediaType: a.mediaType,
          pageCount: a.pageCount,
          width: a.width,
          height: a.height,
          durationSeconds: a.durationSeconds,
          canDownload: d.canDownload,
          thumbnailAssetId: thumbByParent.get(a.parentAssetId) ?? null,
        });
    }
  }
  data.citation = await buildCitation(record, data.breadcrumbs);
  res.json({ data });
});

router.get(
  '/records/:id/children',
  validate({
    params: idParams,
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  async (req, res) => {
    await loadPublicRecord(req.params.id, req.user ?? null);
    const { rows, count } = await models.ArchivalRecord.findAndCountAll({
      where: { parentId: req.params.id, ...publicWhere },
      attributes: ['id', 'title', 'referenceCode', 'level', 'dateExpression', 'publicVisibility'],
      order: [
        ['sortOrder', 'ASC'],
        ['referenceCode', 'ASC'],
      ],
      limit: req.query.pageSize,
      offset: (req.query.page - 1) * req.query.pageSize,
    });
    const counts = rows.length
      ? await models.ArchivalRecord.count({
          where: { parentId: rows.map((r) => r.id), ...publicWhere },
          group: ['parentId'],
        })
      : [];
    const byParent = Object.fromEntries(counts.map((c) => [c.parentId, c.count]));
    res.json({
      data: rows.map((r) => ({ ...r.get({ plain: true }), childCount: byParent[r.id] || 0 })),
      meta: { page: req.query.page, total: count, totalPages: Math.ceil(count / req.query.pageSize) },
    });
  },
);

router.get('/records/:id/finding-aid', validate({ params: idParams }), async (req, res) => {
  const { record } = await loadPublicRecord(req.params.id, req.user ?? null);
  const rows = await models.ArchivalRecord.findAll({
    where: { path: { [Op.like]: `${record.path}%` }, ...publicWhere },
    attributes: [
      'id',
      'parentId',
      'title',
      'referenceCode',
      'level',
      'dateExpression',
      'depth',
      'extentAndMedium',
      'publicVisibility',
    ],
    order: [
      ['depth', 'ASC'],
      ['sortOrder', 'ASC'],
      ['referenceCode', 'ASC'],
    ],
    limit: 5000,
  });
  res.json({
    data: { root: { id: record.id, title: record.title, referenceCode: record.referenceCode }, entries: rows },
  });
});

/**
 * @openapi
 * /public/thumbnails/{id}:
 *   get: { tags: [Public portal], security: [], summary: Stream a thumbnail after the same access check as any file (no token needed for small previews), responses: { 200: { description: JPEG }, 404: { description: Not permitted } } }
 */
router.get('/thumbnails/:id', validate({ params: idParams }), async (req, res) => {
  const asset = await models.DigitalAsset.findByPk(req.params.id, {
    include: [{ model: models.ArchivalRecord, as: 'record' }],
  });
  if (!asset || asset.role !== 'thumbnail') throw notFound('Thumbnail');
  const d = await evaluateAsset(req.user ?? null, asset, asset.record);
  if (!d.canView) throw notFound('Thumbnail');
  const obj = await storage.get(asset.storageKey);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  obj.body.pipe(res);
});

export default router;
