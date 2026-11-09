/**
 * Links digitisation to accessions: DigitisationProjects.accessionId (the accession a project digitises) and
 * DigitisationItems.accessionId (the accession an item came in with). Existing items are linked through their boxes.
 *
 * The baseline migration builds tables from the current models, so on a fresh database the columns already exist;
 * each is only added when missing.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes } from 'sequelize';

const COLUMNS = [
  ['DigitisationProjects', 'accessionId'],
  ['DigitisationItems', 'accessionId'],
];

/**
 * Adds each missing column with its foreign key to Accessions (NO ACTION, as for every other key), then fills the
 * items' accession from their boxes.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function up({ queryInterface }) {
  for (const [table, column] of COLUMNS) {
    const columns = await queryInterface.describeTable(table);
    if (columns[column]) continue;
    await queryInterface.addColumn(table, column, { type: DataTypes.UUID, allowNull: true });
    await queryInterface.addConstraint(table, {
      type: 'foreign key',
      name: `FK_${table}_${column}`,
      fields: [column],
      references: { table: 'Accessions', field: 'id' },
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    });
  }
  await queryInterface.sequelize.query(`
    UPDATE di SET di.accessionId = pi.accessionId
    FROM DigitisationItems di
    JOIN PhysicalItems pi ON pi.id = di.physicalItemId
    WHERE di.accessionId IS NULL AND pi.accessionId IS NOT NULL`);
}

/**
 * Removes the columns and their foreign keys.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function down({ queryInterface }) {
  for (const [table, column] of COLUMNS) {
    const columns = await queryInterface.describeTable(table);
    if (!columns[column]) continue;
    await queryInterface.removeConstraint(table, `FK_${table}_${column}`).catch(() => {});
    await queryInterface.removeColumn(table, column);
  }
}
