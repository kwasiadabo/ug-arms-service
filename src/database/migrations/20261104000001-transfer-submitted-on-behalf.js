/**
 * Adds TransferSubmissions.submittedOnBehalf, which records that a Records Officer (or another reviewer) prepared a
 * transfer on behalf of the originating department because the department has no liaison acting for it.
 *
 * The baseline migration builds tables from the current models, so on a fresh database the column already exists;
 * it is only added when missing.
 *
 * @author Kwasi Adabo Boakye
 */

import { DataTypes } from 'sequelize';

const TABLE = 'TransferSubmissions';
const COLUMN = 'submittedOnBehalf';

/**
 * Adds the column with a default of false, so existing transfers are treated as submitted by their own unit.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function up({ queryInterface }) {
  const columns = await queryInterface.describeTable(TABLE);
  if (columns[COLUMN]) return;
  await queryInterface.addColumn(TABLE, COLUMN, { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
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
