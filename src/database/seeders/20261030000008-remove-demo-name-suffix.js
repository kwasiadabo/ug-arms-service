/**
 * Seeder: removes the " (demo)" suffix from the names of demonstration people and images seeded before it was dropped.
 *
 * Fresh installations no longer receive the suffix. For existing development databases, this seeder removes it from
 * every text column that contains it, across all tables except those that hold historical evidence (the same list as
 * the "[Demo] " clean-up), which must keep what was recorded at the time. Search text is rebuilt for the
 * descriptions that changed, and one audit event records the clean-up. Runs only when demonstration data is enabled,
 * never in production, and is safe to run again.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes, Op } from 'sequelize';
import { env } from '../../config/env.js';
import { models, sequelize } from '../models/index.js';
import { audit } from '../../services/audit.service.js';
import { refreshSearchText } from '../../modules/records/records.service.js';

const SUFFIX = ' (demo)';
const EVIDENCE_TABLES = new Set([
  'AuditEvent',
  'ArchivalRecordVersion',
  'TransferSubmissionRevision',
  'WorkflowHistory',
  'PreservationEvent',
  'Comment',
]);

/**
 * Removes the suffix from every non-evidence text column that contains it, then refreshes the search text of the
 * affected descriptions and records the clean-up in the audit trail.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  if (!env.SEED_DEMO_DATA || env.NODE_ENV === 'production') return;
  const like = `%${SUFFIX}%`;
  const recordIds = await models.ArchivalRecord.findAll({
    where: { [Op.or]: [{ title: { [Op.like]: like } }, { scopeAndContent: { [Op.like]: like } }] },
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
        `UPDATE [${table}] SET [${column}] = REPLACE([${column}], :suffix, '') WHERE [${column}] LIKE :like`,
        { replacements: { suffix: SUFFIX, like } },
      );
      changed += Number(affected) || 0;
    }
  }
  for (const r of recordIds) await refreshSearchText(r.id);
  if (changed)
    await audit({
      action: 'demo.name_suffix_removed',
      actorType: 'system',
      metadata: { valuesChanged: changed, descriptions: recordIds.length },
    });
}

/**
 * Reverses this seeder. Intentionally does nothing: the suffix carried no information that needs restoring.
 *
 * @returns {Promise<void>}
 */
export async function down() {}
