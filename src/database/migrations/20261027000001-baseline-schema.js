/**
 * Baseline schema migration.
 *
 * Tables are created from the model definitions as they stood at baseline. Foreign keys and indexes are added in a
 * second pass because some tables reference each other. A database trigger makes the AuditEvents table append-only,
 * so audit evidence cannot be changed or deleted even by a database account used by the application.
 *
 * Important: once this baseline has been applied to a shared or production database, every further schema change
 * must be written as a new, explicit migration. Never change the schema by editing the models alone.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';

/**
 * Returns a model's column definitions without the parts that `createTable` cannot handle.
 *
 * Foreign key references are removed so that every table can be created before any constraint points at it, and
 * Sequelize-only properties (getters, setters and validators) are dropped because they are not part of the database
 * schema.
 *
 * @param {import('sequelize').ModelStatic} model The model whose columns are copied.
 * @returns {Record<string, object>} Column definitions keyed by attribute name.
 */
function plainAttributes(model) {
  const out = {};
  for (const [name, attr] of Object.entries(model.getAttributes())) {
    const copy = { ...attr };
    delete copy.references;
    delete copy.onDelete;
    delete copy.onUpdate;
    delete copy.Model;
    delete copy.get;
    delete copy.set;
    delete copy.validate;
    out[name] = copy;
  }
  return out;
}

/**
 * Creates every table, then adds every foreign key and index, then installs the append-only trigger on AuditEvents.
 *
 * All foreign keys use NO ACTION so archival data is never removed by a cascade.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function up({ queryInterface }) {
  const list = Object.values(models);
  for (const model of list) {
    await queryInterface.createTable(model.getTableName(), plainAttributes(model));
  }
  for (const model of list) {
    const table = model.getTableName();
    for (const [name, attr] of Object.entries(model.getAttributes())) {
      if (!attr.references) continue;
      const refTable =
        typeof attr.references.model === 'string' ? attr.references.model : attr.references.model.tableName;
      await queryInterface.addConstraint(table, {
        type: 'foreign key',
        name: `FK_${table}_${name}`.slice(0, 128),
        fields: [attr.field || name],
        references: { table: refTable, field: attr.references.key || 'id' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      });
    }
    for (const index of model.options.indexes || []) {
      await queryInterface.addIndex(table, index);
    }
  }

  // Audit evidence is append-only for every application principal.
  await queryInterface.sequelize.query(`
    CREATE TRIGGER TR_AuditEvents_AppendOnly ON AuditEvents
    INSTEAD OF UPDATE, DELETE
    AS
    BEGIN
      SET NOCOUNT ON;
      THROW 51000, 'AuditEvents is append-only', 1;
    END`);
}

/**
 * Drops every foreign key and every table.
 *
 * Destructive and intended for development only; it is not a way to undo a release on a database that holds real
 * records.
 *
 * @param {{ queryInterface: import('sequelize').QueryInterface }} context Umzug migration context.
 * @returns {Promise<void>}
 */
export async function down({ queryInterface }) {
  // Intentionally destructive: development use only.
  await queryInterface.sequelize.query(`
    DECLARE @sql NVARCHAR(MAX) = N'';
    SELECT @sql += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id)) + '.' + QUOTENAME(OBJECT_NAME(parent_object_id)) + ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
    FROM sys.foreign_keys;
    EXEC sp_executesql @sql;`);
  for (const model of Object.values(models)) {
    await queryInterface.dropTable(model.getTableName());
  }
}
