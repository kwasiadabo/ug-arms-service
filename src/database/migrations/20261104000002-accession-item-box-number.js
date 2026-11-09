/**
 * Adds AccessionItems.boxNumber, the department's own box number carried over from the transfer inventory, so a
 * registered box can be matched to the items packed in it.
 *
 * The baseline migration builds tables from the current models, so on a fresh database the column already exists;
 * it is only added when missing.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes } from 'sequelize';

const TABLE = 'AccessionItems';
const COLUMN = 'boxNumber';

/**
 * Adds the column, then fills it for existing accession items from the transfer lines they were copied from.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function up({ queryInterface }) {
  const columns = await queryInterface.describeTable(TABLE);
  if (columns[COLUMN]) return;
  await queryInterface.addColumn(TABLE, COLUMN, { type: DataTypes.STRING(60), allowNull: true });
  await queryInterface.sequelize.query(`
    UPDATE ai SET ai.boxNumber = ti.boxNumber
    FROM AccessionItems ai
    JOIN TransferInventoryItems ti ON ti.id = ai.inventoryItemId
    WHERE ai.boxNumber IS NULL AND ti.boxNumber IS NOT NULL`);
}

/**
 * Removes the column.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function down({ queryInterface }) {
  const columns = await queryInterface.describeTable(TABLE);
  if (columns[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
}
