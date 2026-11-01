/**
 * Seeder: permissions and system roles.
 *
 * Creates every permission from the permission catalogue and every system role with its default permissions. The
 * seeder is idempotent and safe to run again: it only adds permissions and roles that are missing, and it assigns
 * default permissions only to roles it creates itself, so changes an administrator has made to an existing role are
 * never overwritten.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';
import { PERMISSIONS, ROLES } from '../../config/permissions.js';

/**
 * Creates missing permissions and roles and grants each newly created role its default permissions.
 *
 * @returns {Promise<void>}
 * @throws {Error} When a role refers to a permission that is not in the catalogue, which indicates a configuration
 *   mistake.
 */
export async function up() {
  const permIds = {};
  for (const [groupName, codes] of Object.entries(PERMISSIONS)) {
    for (const code of codes) {
      const [p] = await models.Permission.findOrCreate({
        where: { code },
        defaults: { code, groupName, description: code.replace('.', ': ').replace(/_/g, ' ') },
      });
      permIds[code] = p.id;
    }
  }
  for (const [code, def] of Object.entries(ROLES)) {
    const [role, created] = await models.Role.findOrCreate({
      where: { code },
      defaults: {
        code,
        name: def.name,
        description: def.description,
        isSystem: true,
        isSensitive: Boolean(def.sensitive),
      },
    });
    if (!created) continue;
    for (const p of new Set(def.permissions)) {
      if (!permIds[p]) throw new Error(`Unknown permission ${p} in role ${code}`);
      await models.RolePermission.create({ roleId: role.id, permissionId: permIds[p] });
    }
  }
}

/**
 * Reverses this seeder. Intentionally does nothing: seeded reference data and accounts may already be referenced by
 * real records and audit events, so they are never deleted automatically. Use `npm run db:reset` to rebuild a
 * development database from scratch.
 *
 * @returns {Promise<void>}
 */
export async function down() {}
