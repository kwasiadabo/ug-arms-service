/**
 * Command-line script that rebuilds the OpenSearch index from the SQL catalogue (`npm run search:reindex`).
 *
 * Descriptions are indexed in batches of 500 in identifier order, so the script is safe to run again or to restart
 * after an interruption. When OPENSEARCH_ENABLED is false it only reports that the SQL search needs no index.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { env } from '../src/config/env.js';
import { models, sequelize } from '../src/database/models/index.js';
import * as opensearch from '../src/modules/search/opensearch.adapter.js';

if (!env.OPENSEARCH_ENABLED) {
  console.log('OPENSEARCH_ENABLED=false: SQL search reads the database directly; nothing to rebuild.');
  process.exit(0);
}
await opensearch.ensureIndex();
let last = null;
let n = 0;
for (;;) {
  const rows = await models.ArchivalRecord.findAll({
    where: last ? { id: { [Op.gt]: last } } : {},
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit: 500,
  });
  if (!rows.length) break;
  for (const r of rows) {
    await opensearch.indexRecord(r.id);
    n += 1;
  }
  last = rows[rows.length - 1].id;
  console.log(`Indexed ${n}`);
}
console.log(`Reindex complete: ${n} descriptions.`);
await sequelize.close();
process.exit(0);
