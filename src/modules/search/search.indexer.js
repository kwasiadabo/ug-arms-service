/**
 * Background job handlers that keep the optional OpenSearch index up to date. The SQL search reads the descriptions
 * table directly, so when OpenSearch is disabled these jobs do nothing.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { env } from '../../config/env.js';
import { models } from '../../database/models/index.js';
import * as opensearch from './opensearch.adapter.js';

export const searchHandlers = {
  'search.index_record': async ({ recordId }) => {
    if (!env.OPENSEARCH_ENABLED) return { engine: 'sql', skipped: true };
    await opensearch.indexRecord(recordId);
    return { indexed: recordId };
  },
  'search.reindex_subtree': async ({ recordId }) => {
    if (!env.OPENSEARCH_ENABLED) return { engine: 'sql', skipped: true };
    const root = await models.ArchivalRecord.findByPk(recordId, { attributes: ['path'] });
    if (!root) return { skipped: true };
    const ids = await models.ArchivalRecord.findAll({
      where: { path: { [Op.like]: `${root.path}%` } },
      attributes: ['id'],
    });
    for (const r of ids) await opensearch.indexRecord(r.id);
    return { indexed: ids.length };
  },
};
