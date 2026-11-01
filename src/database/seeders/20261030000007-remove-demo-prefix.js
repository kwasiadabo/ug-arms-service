/**
 * Seeder: removes the "[Demo] " title prefix from demonstration data seeded before the prefix was dropped.
 *
 * Fresh installations no longer receive the prefix. For existing development databases, this seeder strips it from
 * every text column that starts with it, across all tables except those that hold historical evidence (the audit
 * trail, description versions, submission snapshots, workflow history, preservation events and comments), which
 * must keep what was recorded at the time. The demonstration content still states that it is fictional in its
 * descriptions. Search text is rebuilt for the descriptions that changed, and one audit event records the clean-up.
 * Runs only when demonstration data is enabled, never in production, and is safe to run again.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes } from 'sequelize';
import { env } from '../../config/env.js';
import { models, sequelize } from '../models/index.js';
import { audit } from '../../services/audit.service.js';
import { refreshSearchText } from '../../modules/records/records.service.js';

const PREFIX = '[Demo] ';
const EVIDENCE_TABLES = new Set([
  'AuditEvent',
  'ArchivalRecordVersion',
  'TransferSubmissionRevision',
  'WorkflowHistory',
  'PreservationEvent',
  'Comment',
]);

/**
 * Strips the prefix from every non-evidence text column that starts with it, then refreshes the search text of the
 * affected descriptions and records the clean-up in the audit trail.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  if (!env.SEED_DEMO_DATA || env.NODE_ENV === 'production') return;
  const recordIds = await models.ArchivalRecord.findAll({
    where: sequelize.where(sequelize.fn('LEFT', sequelize.col('title'), PREFIX.length), PREFIX),
    attributes: ['id'],
  });
  let changed = 0;
  for (const [name, model] of Object.entries(models)) {
    if (EVIDENCE_TABLES.has(name)) continue;
    const table = model.getTableName();
    for (const attr of Object.values(model.getAttributes())) {
      if (!(attr.type instanceof DataTypes.STRING || attr.type instanceof DataTypes.TEXT)) continue;
      const column = attr.field || attr.fieldName;
      const [, affected] = await sequelize.query(
        `UPDATE [${table}] SET [${column}] = SUBSTRING([${column}], :start, 2147483647) WHERE LEFT([${column}], :len) = :prefix`,
        { replacements: { start: PREFIX.length + 1, len: PREFIX.length, prefix: PREFIX } },
      );
      changed += Number(affected) || 0;
    }
  }
  for (const r of recordIds) await refreshSearchText(r.id);
  if (changed)
    await audit({
      action: 'demo.prefix_removed',
      actorType: 'system',
      metadata: { valuesChanged: changed, descriptions: recordIds.length },
    });
}

/**
 * Reverses this seeder. Intentionally does nothing: the prefix carried no information that needs restoring.
 *
 * @returns {Promise<void>}
 */
export async function down() {}
