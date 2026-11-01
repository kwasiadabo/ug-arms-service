/**
 * Optional OpenSearch integration.
 *
 * The index stores visibility fields alongside the content so queries can be filtered. Results are still checked
 * against the database access policy before they are returned, so an out-of-date index can never expose a record.
 * OCR text is indexed only after it has been approved.
 *
 * @author Kwasi Adabo Boakye
 */

import { env } from '../../config/env.js';
import { models } from '../../database/models/index.js';
import { staffReadableLevels, evaluateRecord } from '../../services/accessPolicy.service.js';

const INDEX = 'ug-arms-records';

/**
 * Sends a request to OpenSearch and returns the parsed response; a 404 returns null. Requests are abandoned after
 * 15 seconds.
 *
 * @param {string} method HTTP method.
 * @param {string} path Path, starting with a slash.
 * @param {object} [body] JSON body.
 * @returns {Promise<object|null>}
 * @throws {Error} For any other error status.
 */
async function opensearchRequest(method, path, body) {
  const res = await fetch(`${env.OPENSEARCH_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`OpenSearch ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 404 ? null : res.json();
}

/**
 * Creates the records index with its field mappings if it does not exist yet.
 *
 * @returns {Promise<void>}
 */
export async function ensureIndex() {
  const exists = await fetch(`${env.OPENSEARCH_URL}/${INDEX}`, { method: 'HEAD' })
    .then((r) => r.ok)
    .catch(() => false);
  if (exists) return;
  await opensearchRequest('PUT', `/${INDEX}`, {
    mappings: {
      properties: {
        title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        referenceCode: { type: 'keyword' },
        level: { type: 'keyword' },
        text: { type: 'text' },
        ocrText: { type: 'text' },
        rootId: { type: 'keyword' },
        pathIds: { type: 'keyword' },
        publicVisibility: { type: 'keyword' },
        effectiveAccessLevel: { type: 'keyword' },
        status: { type: 'keyword' },
        dateStart: { type: 'date' },
        dateEnd: { type: 'date' },
      },
    },
  });
}

/**
 * Indexes one description with its approved OCR text, or removes it from the index if it no longer exists.
 *
 * @param {string} recordId Identifier of the description.
 * @returns {Promise<object|null>}
 */
export async function indexRecord(recordId) {
  const r = await models.ArchivalRecord.findByPk(recordId);
  if (!r) return opensearchRequest('DELETE', `/${INDEX}/_doc/${recordId}`);
  await ensureIndex();
  // OCR text is indexed only once approved; restricted records' OCR is filtered at query time by level.
  const pages = await models.OCRPage.findAll({
    where: { approvedForSearch: true },
    include: [
      {
        model: models.DigitalAsset,
        as: 'asset',
        where: { recordId, status: 'available' },
        attributes: ['isPublished'],
      },
    ],
    attributes: ['text'],
  });
  return opensearchRequest('PUT', `/${INDEX}/_doc/${recordId}`, {
    title: r.title,
    referenceCode: r.referenceCode,
    level: r.level,
    text: r.searchText,
    ocrText: pages
      .map((p) => p.text)
      .join('\n')
      .slice(0, 2_000_000),
    rootId: r.rootId,
    pathIds: r.path.split('/').filter(Boolean),
    publicVisibility: r.publicVisibility,
    effectiveAccessLevel: r.effectiveAccessLevel,
    status: r.status,
    dateStart: r.dateStart,
    dateEnd: r.dateEnd,
  });
}

/**
 * Searches the index. Public and uncleared callers are limited to publicly discoverable records and do not search
 * OCR text. Every hit is checked against the database access policy before it is returned.
 *
 * @param {object|null} user Authenticated principal.
 * @param {{ q?: string, page?: number, pageSize?: number, scope?: string }} params Query and paging.
 * @returns {Promise<object>} Results in the same shape as the SQL search.
 */
export async function search(user, { q = '', page = 1, pageSize = 20, scope }) {
  const levels = staffReadableLevels(user);
  const filter =
    scope === 'public' || !levels.length ? [{ terms: { publicVisibility: ['full', 'metadata_only'] } }] : [];
  const contentFields =
    scope === 'public' || !levels.length
      ? ['title^3', 'referenceCode^5', 'text']
      : ['title^3', 'referenceCode^5', 'text', 'ocrText'];
  const res = await opensearchRequest('POST', `/${INDEX}/_search`, {
    from: (page - 1) * pageSize,
    size: pageSize,
    query: {
      bool: {
        filter,
        must: q
          ? [{ simple_query_string: { query: q, fields: contentFields, default_operator: 'and' } }]
          : [{ match_all: {} }],
      },
    },
  });
  const ids = res.hits.hits.map((h) => h._id);
  const rows = await models.ArchivalRecord.findAll({ where: { id: ids } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const d = await evaluateRecord(user, r);
    if (d.canDiscover)
      results.push({
        id: r.id,
        level: r.level,
        referenceCode: r.referenceCode,
        title: r.title,
        dateExpression: r.dateExpression,
        mode: d.mode,
        effectiveAccessLevel: r.effectiveAccessLevel,
      });
  }
  return {
    results,
    total: res.hits.total.value,
    page,
    pageSize,
    totalPages: Math.ceil(res.hits.total.value / pageSize),
    facets: null,
    engine: 'opensearch',
  };
}
