/**
 * SQL-based search of archival descriptions, with facets, highlighting and suggestions.
 *
 * Visibility is enforced inside the SQL: rows the caller may not discover are never read, and facet counts are
 * computed over the same filtered set, so their numbers cannot reveal hidden records. Text and OCR matching is
 * limited to the content the caller may see. Identifying fields (title, reference code and dates) can match for any
 * discoverable record, while scope notes, histories, creators, subjects, places and OCR text match only where the
 * caller may read the content. Every returned row is passed through the access policy again before any field or
 * snippet is shown. When OpenSearch is enabled it is used first, and the SQL search is the fallback.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op, literal } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { env } from '../../config/env.js';
import {
  evaluateRecord,
  recordVisibilityWhere,
  activeGrants,
  presentRecord,
  hasPerm,
  staffReadableLevels,
} from '../../services/accessPolicy.service.js';
import { parseQuery, highlightTerms, snippet } from './query-parser.js';
import * as opensearch from './opensearch.adapter.js';

/**
 * Escapes a value for direct inclusion in SQL.
 *
 * @param {*} v The value.
 * @returns {string}
 */
const esc = (v) => sequelize.escape(v);

// Fields shown for metadata-only (restricted) results. Text search may match these for any discoverable row;
// everything else (scope, histories, creators, subjects, places, OCR) only where the caller can see content.

/**
 * SQL condition matching a pattern against the identifying fields that may be shown even for restricted results:
 * title, reference code and date expression.
 *
 * @param {string} like Escaped LIKE pattern.
 * @returns {string}
 */
const metadataMatchSql = (like) =>
  `([ArchivalRecord].[title] LIKE ${like} OR [ArchivalRecord].[referenceCode] LIKE ${like} OR [ArchivalRecord].[dateExpression] LIKE ${like})`;

/**
 * Builds the SQL condition for one query clause.
 *
 * A field clause searches that field. A clause without a field searches the identifying fields, the full search
 * text where content is visible and, unless disabled, approved OCR text of files the caller may read. Content
 * fields are wrapped in the content-visibility condition. Negated clauses are inverted.
 *
 * @param {{ field: string|null, value: string, negate: boolean }} c The clause.
 * @param {{ includeOcr: boolean, ocrScope: string, contentScope: string }} scopes Visibility conditions for this
 *   caller.
 * @returns {string}
 */
function clauseSql(c, { includeOcr, ocrScope, contentScope }) {
  const like = esc(`%${c.value}%`);

  /**
   * Wraps an SQL condition so that it applies only to rows whose content the caller may see.
   *
   * @param {string} sql The condition.
   * @returns {string}
   */
  const content = (sql) => `(${contentScope} AND ${sql})`;
  let sql;
  switch (c.field) {
    case 'title':
      sql = `([ArchivalRecord].[title] LIKE ${like} OR ${content(`[ArchivalRecord].[alternativeTitle] LIKE ${like}`)})`;
      break;
    case 'referenceCode':
      sql = `[ArchivalRecord].[referenceCode] LIKE ${like}`;
      break;
    case 'dateExpression':
      sql = `[ArchivalRecord].[dateExpression] LIKE ${like}`;
      break;
    case 'geographicCoverage':
      sql = content(`[ArchivalRecord].[geographicCoverage] LIKE ${like}`);
      break;
    case 'creator':
      sql = content(
        `(EXISTS (SELECT 1 FROM RecordCreators rc JOIN AuthorityRecords ar ON ar.id = rc.authorityId WHERE rc.recordId = [ArchivalRecord].[id] AND ar.authorizedName LIKE ${like}) OR [ArchivalRecord].[creatorNote] LIKE ${like})`,
      );
      break;
    case 'subject':
      sql = content(
        `EXISTS (SELECT 1 FROM RecordSubjects rs LEFT JOIN VocabularyTerms vt ON vt.id = rs.termId LEFT JOIN AuthorityRecords ar ON ar.id = rs.authorityId WHERE rs.recordId = [ArchivalRecord].[id] AND (vt.label LIKE ${like} OR ar.authorizedName LIKE ${like}))`,
      );
      break;
    default: {
      sql = `(${metadataMatchSql(like)} OR ${content(`[ArchivalRecord].[searchText] LIKE ${like}`)}`;
      // Approved OCR text is searchable only where the caller may see the record's content.
      if (includeOcr) {
        sql += ` OR EXISTS (SELECT 1 FROM OCRPages op JOIN DigitalAssets da ON da.id = op.assetId WHERE da.recordId = [ArchivalRecord].[id] AND op.approvedForSearch = 1 AND da.status = 'available' ${ocrScope} AND op.[text] LIKE ${like})`;
      }
      sql += ')';
    }
  }
  return c.negate ? `NOT ${sql}` : sql;
}

/**
 * Builds the SQL condition for rows whose full content the caller may see: publicly open rows for the public
 * portal, rows within the caller's clearance for staff, plus rows covered by the caller's grants.
 *
 * @param {object|null} user Authenticated principal.
 * @param {'public'|'staff'} scope Which interface is searching.
 * @param {object[]} grants The caller's active grants.
 * @returns {string}
 */
function contentScopeFor(user, scope, grants) {
  const grantIds = grants.filter((g) => g.targetType === 'record').map((g) => g.targetId);
  const grantSql = grantIds.length
    ? ` OR ${grantIds.map((id) => `[ArchivalRecord].[id] = ${esc(id)} OR [ArchivalRecord].[path] LIKE ${esc(`%/${id}/%`)}`).join(' OR ')}`
    : '';
  if (scope === 'public') return `([ArchivalRecord].[publicVisibility] = 'full'${grantSql})`;
  const levels = staffReadableLevels(user);
  if (levels.length) return `([ArchivalRecord].[effectiveAccessLevel] IN (${levels.map(esc).join(',')})${grantSql})`;
  return `([ArchivalRecord].[publicVisibility] = 'full'${grantSql})`;
}

/**
 * Builds the SQL condition that limits OCR matching to text the caller may read: within the caller's clearance for
 * staff, otherwise only published files of publicly open descriptions.
 *
 * @param {object|null} user Authenticated principal.
 * @returns {string}
 */
function ocrScopeFor(user) {
  const levels = staffReadableLevels(user);
  if (levels.length) return `AND [ArchivalRecord].[effectiveAccessLevel] IN (${levels.map(esc).join(',')})`;
  return `AND [ArchivalRecord].[publicVisibility] = 'full' AND da.isPublished = 1`;
}

/**
 * Translates search filters into Sequelize conditions: level, collection, repository, originating unit, date range,
 * access level and status, plus EXISTS conditions for creator, subject, file format, published digital copies and
 * language.
 *
 * @param {object} [f={}] Filter parameters.
 * @returns {{ where: object, and: Array<object> }}
 */
export function buildFilters(f = {}) {
  const where = {};
  if (f.level) where.level = Array.isArray(f.level) ? f.level : f.level.split(',');
  if (f.collectionId) where.rootId = f.collectionId;
  if (f.repositoryId) where.repositoryId = f.repositoryId;
  if (f.originatingUnitId) where.originatingUnitId = f.originatingUnitId;
  if (f.dateFrom) where.dateEnd = { [Op.gte]: `${f.dateFrom}`.length === 4 ? `${f.dateFrom}-01-01` : f.dateFrom };
  if (f.dateTo) where.dateStart = { [Op.lte]: `${f.dateTo}`.length === 4 ? `${f.dateTo}-12-31` : f.dateTo };
  if (f.accessLevel) where.effectiveAccessLevel = f.accessLevel;
  if (f.status) where.status = f.status.split(',');
  const and = [];
  if (f.creatorId)
    and.push(
      literal(
        `EXISTS (SELECT 1 FROM RecordCreators rc WHERE rc.recordId = [ArchivalRecord].[id] AND rc.authorityId = ${esc(f.creatorId)})`,
      ),
    );
  if (f.subjectId)
    and.push(
      literal(
        `EXISTS (SELECT 1 FROM RecordSubjects rs WHERE rs.recordId = [ArchivalRecord].[id] AND (rs.termId = ${esc(f.subjectId)} OR rs.authorityId = ${esc(f.subjectId)}))`,
      ),
    );
  if (f.format)
    and.push(
      literal(
        `EXISTS (SELECT 1 FROM DigitalAssets da WHERE da.recordId = [ArchivalRecord].[id] AND da.status = 'available' AND da.mediaType LIKE ${esc(`${f.format}%`)})`,
      ),
    );
  if (f.hasDigital === 'true')
    and.push(
      literal(
        `EXISTS (SELECT 1 FROM DigitalAssets da WHERE da.recordId = [ArchivalRecord].[id] AND da.status = 'available' AND da.isPublished = 1)`,
      ),
    );
  if (f.language) and.push({ languages: { [Op.like]: `%${JSON.stringify(f.language).slice(1, -1)}%` } });
  return { where, and };
}

/**
 * Counts results by level, collection, decade, creator and subject over the same visibility-filtered set as the
 * results (top 15 for collections, creators and subjects).
 *
 * @param {object} whereAll The complete `where` clause of the search.
 * @returns {Promise<object>}
 */
async function facets(whereAll) {
  const qg = sequelize.getQueryInterface().queryGenerator;
  const idsSql = qg
    .selectQuery('ArchivalRecords', { attributes: ['id'], where: whereAll }, models.ArchivalRecord)
    .replace(/;\s*$/, '');

  /**
   * Runs a read-only SQL query and returns its rows.
   *
   * @param {string} sql SQL text.
   * @returns {Promise<object[]>}
   */
  const q = (sql) => sequelize.query(sql, { type: 'SELECT' });
  const [levels, collections, decades, creators, subjects] = await Promise.all([
    q(`SELECT level AS value, COUNT(*) AS count FROM ArchivalRecords WHERE id IN (${idsSql}) GROUP BY level`),
    q(
      `SELECT TOP 15 r.rootId AS value, root.title AS label, COUNT(*) AS count FROM ArchivalRecords r JOIN ArchivalRecords root ON root.id = r.rootId WHERE r.id IN (${idsSql}) GROUP BY r.rootId, root.title ORDER BY COUNT(*) DESC`,
    ),
    q(
      `SELECT (YEAR(dateStart) / 10) * 10 AS value, COUNT(*) AS count FROM ArchivalRecords WHERE dateStart IS NOT NULL AND id IN (${idsSql}) GROUP BY (YEAR(dateStart) / 10) * 10 ORDER BY value`,
    ),
    q(
      `SELECT TOP 15 rc.authorityId AS value, ar.authorizedName AS label, COUNT(*) AS count FROM RecordCreators rc JOIN AuthorityRecords ar ON ar.id = rc.authorityId WHERE rc.recordId IN (${idsSql}) GROUP BY rc.authorityId, ar.authorizedName ORDER BY COUNT(*) DESC`,
    ),
    q(
      `SELECT TOP 15 rs.termId AS value, vt.label AS label, COUNT(*) AS count FROM RecordSubjects rs JOIN VocabularyTerms vt ON vt.id = rs.termId WHERE rs.recordId IN (${idsSql}) GROUP BY rs.termId, vt.label ORDER BY COUNT(*) DESC`,
    ),
  ]);
  return {
    level: levels,
    collection: collections,
    decade: decades.map((d) => ({ ...d, label: `${d.value}s` })),
    creator: creators,
    subject: subjects,
  };
}

/**
 * Searches descriptions for the staff interface or the public portal.
 *
 * Results are ordered by relevance (reference code, title and text matches) or by date, title, reference or most
 * recent. Each row is checked against the access policy, and restricted rows show identifying information only.
 * Results include a highlighted snippet, the collection and a thumbnail where allowed, and optionally facets. Each
 * search is logged for analytics.
 *
 * @param {object|null} user Authenticated principal, or null on the public portal.
 * @param {object} params Query, filters, paging, sort, scope and options.
 * @returns {Promise<{ results: object[], total: number, page: number, pageSize: number, totalPages: number, facets:
 *   object|null, engine: string, tookMs?: number }>}
 */
export async function search(user, params) {
  const started = Date.now();
  const { q = '', page = 1, pageSize = 20, sort = 'relevance', scope = 'staff' } = params;
  if (env.OPENSEARCH_ENABLED) {
    try {
      return await opensearch.search(user, params);
    } catch (err) {
      // Fall back to SQL search; infrastructure failure must not break discovery.
    }
  }
  const grants = await activeGrants(user);
  const visibility =
    scope === 'public'
      ? { publicVisibility: ['full', 'metadata_only'] }
      : await recordVisibilityWhere(user, { grants });
  const { where: filterWhere, and: filterAnd } = buildFilters(params);
  const groups = parseQuery(q);
  const includeOcr = params.includeOcr !== 'false';
  const ocrScope =
    scope === 'public' ? `AND [ArchivalRecord].[publicVisibility] = 'full' AND da.isPublished = 1` : ocrScopeFor(user);
  const contentScope = contentScopeFor(user, scope, grants);
  const textSql = groups.length
    ? `(${groups.map((g) => `(${g.map((c) => clauseSql(c, { includeOcr, ocrScope, contentScope })).join(' AND ')})`).join(' OR ')})`
    : null;
  const whereAll = { [Op.and]: [visibility, filterWhere, ...filterAnd, ...(textSql ? [literal(textSql)] : [])] };

  const terms = highlightTerms(groups);
  const firstTerm = terms[0] ? esc(`%${terms[0]}%`) : null;
  const relevance = firstTerm
    ? literal(
        `(CASE WHEN [ArchivalRecord].[referenceCode] LIKE ${firstTerm} THEN 50 ELSE 0 END + CASE WHEN [ArchivalRecord].[title] LIKE ${firstTerm} THEN 30 ELSE 0 END + CASE WHEN [ArchivalRecord].[scopeAndContent] LIKE ${firstTerm} THEN 5 ELSE 0 END + CASE WHEN [ArchivalRecord].[level] IN ('fonds','collection') THEN 3 ELSE 0 END)`,
      )
    : null;
  const order = {
    relevance: relevance
      ? [
          [relevance, 'DESC'],
          ['title', 'ASC'],
        ]
      : [
          ['isFeatured', 'DESC'],
          ['publishedAt', 'DESC'],
          ['title', 'ASC'],
        ],
    date_asc: [
      ['dateStart', 'ASC'],
      ['title', 'ASC'],
    ],
    date_desc: [
      ['dateStart', 'DESC'],
      ['title', 'ASC'],
    ],
    title: [['title', 'ASC']],
    reference: [['referenceCode', 'ASC']],
    recent: [['updatedAt', 'DESC']],
  }[sort] || [['title', 'ASC']];

  const { rows, count } = await models.ArchivalRecord.findAndCountAll({
    where: whereAll,
    order,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    attributes: [
      'id',
      'parentId',
      'rootId',
      'level',
      'referenceCode',
      'title',
      'dateExpression',
      'dateStart',
      'dateEnd',
      'scopeAndContent',
      'extentAndMedium',
      'status',
      'effectiveAccessLevel',
      'effectiveFlags',
      'publicVisibility',
      'path',
      'originatingUnitId',
      'repositoryId',
      'accessConditions',
    ],
  });
  const rootIds = [...new Set(rows.map((r) => r.rootId).filter(Boolean))];
  const roots = new Map(
    (
      await models.ArchivalRecord.findAll({
        where: { id: rootIds },
        attributes: ['id', 'title', 'referenceCode', 'publicVisibility'],
      })
    ).map((r) => [r.id, r]),
  );
  const thumbs = await thumbnailsFor(rows, user, scope);
  const results = [];
  for (const r of rows) {
    const decision =
      scope === 'public' && !hasPerm(user, 'records.read')
        ? {
            canDiscover: true,
            canViewContent: r.publicVisibility === 'full',
            mode: r.publicVisibility === 'full' ? 'full' : 'metadata_only',
          }
        : await evaluateRecord(user, r, { grants });
    if (!decision.canDiscover) continue;
    const shown = presentRecord(r, decision, { staffView: scope !== 'public' });
    const root = roots.get(r.rootId);
    results.push({
      id: r.id,
      level: r.level,
      referenceCode: r.referenceCode,
      title: r.title,
      dateExpression: r.dateExpression,
      status: scope === 'public' ? undefined : r.status,
      effectiveAccessLevel: r.effectiveAccessLevel,
      mode: decision.mode,
      collection:
        root && root.id !== r.id && (scope !== 'public' || root.publicVisibility !== 'hidden')
          ? { id: root.id, title: root.title, referenceCode: root.referenceCode }
          : null,
      snippet: snippet(decision.mode === 'full' ? shown.scopeAndContent : null, terms) || snippet(r.title, terms),
      extentAndMedium: decision.mode === 'full' ? r.extentAndMedium : undefined,
      thumbnailAssetId: thumbs.get(r.id) ?? null,
    });
  }
  const facetData = params.facets === 'false' ? null : await facets(whereAll);
  await models.SearchLog.create({
    userId: user?.id ?? null,
    scope,
    queryText: q.slice(0, 500),
    filters: params,
    resultCount: count,
    durationMs: Date.now() - started,
  }).catch(() => {});
  return {
    results,
    total: count,
    page,
    pageSize,
    totalPages: Math.ceil(count / pageSize),
    facets: facetData,
    engine: 'sql',
    tookMs: Date.now() - started,
  };
}

/**
 * Finds a thumbnail for each result where the caller may see it: published thumbnails of open descriptions on the
 * public portal, or thumbnails within the caller's clearance for staff.
 *
 * @param {object[]} rows Result rows.
 * @param {object|null} user Authenticated principal.
 * @param {'public'|'staff'} scope Which interface is searching.
 * @returns {Promise<Map<string, string>>} Description ID to thumbnail asset ID.
 */
async function thumbnailsFor(rows, user, scope) {
  const ids = rows
    .filter((r) =>
      scope === 'public' ? r.publicVisibility === 'full' : staffReadableLevels(user).includes(r.effectiveAccessLevel),
    )
    .map((r) => r.id);
  if (!ids.length) return new Map();
  const where = {
    recordId: ids,
    role: 'thumbnail',
    status: 'available',
    accessLevel: { [Op.in]: ['inherit', 'open'] },
  };
  if (scope === 'public') where.isPublished = true;
  const thumbs = await models.DigitalAsset.findAll({
    where,
    attributes: ['id', 'recordId'],
    order: [['createdAt', 'ASC']],
  });
  const m = new Map();
  for (const t of thumbs) if (!m.has(t.recordId)) m.set(t.recordId, t.id);
  return m;
}

/**
 * Suggests up to six description titles the caller may discover, four creators and four subject terms that start
 * with the typed text.
 *
 * @param {object|null} user Authenticated principal.
 * @param {string} q Text typed so far; at least two characters.
 * @param {'public'|'staff'} scope Which interface is asking.
 * @returns {Promise<Array<{ type: string, id: string, label: string, sub?: string }>>}
 */
export async function suggest(user, q, scope) {
  if (!q || q.length < 2) return [];
  const like = { [Op.like]: `${q.replace(/[%_[\]]/g, (c) => `[${c}]`)}%` };
  const visibility =
    scope === 'public' ? { publicVisibility: ['full', 'metadata_only'] } : await recordVisibilityWhere(user);
  const [titles, authorities, terms] = await Promise.all([
    models.ArchivalRecord.findAll({
      where: { [Op.and]: [visibility, { title: like }] },
      attributes: ['id', 'title', 'referenceCode'],
      limit: 6,
      order: [['title', 'ASC']],
    }),
    models.AuthorityRecord.findAll({
      where: { authorizedName: like, status: { [Op.in]: ['approved', 'draft'] } },
      attributes: ['id', 'authorizedName', 'entityType'],
      limit: 4,
    }),
    models.VocabularyTerm.findAll({ where: { label: like, isActive: true }, attributes: ['id', 'label'], limit: 4 }),
  ]);
  return [
    ...titles.map((t) => ({ type: 'record', id: t.id, label: t.title, sub: t.referenceCode })),
    ...authorities.map((a) => ({
      type: 'creator',
      id: a.id,
      label: a.authorizedName,
      sub: a.entityType.replace(/_/g, ' '),
    })),
    ...terms.map((t) => ({ type: 'subject', id: t.id, label: t.label })),
  ];
}
