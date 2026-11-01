/**
 * Seeder: additional permissions for existing system roles.
 *
 * Permissions are only ever added here, never removed, so an administrator's later changes are preserved. Each
 * addition is recorded in the audit trail as a sensitive change.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';
import { audit } from '../../services/audit.service.js';

const ADDITIONS = {
  records_officer: ['transfer.submit'], // Records officers prepare and submit transfer inventories (§4.4).
};

/**
 * Grants each listed permission to its role if the role does not already have it, and audits every grant made.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  for (const [code, perms] of Object.entries(ADDITIONS)) {
    const role = await models.Role.findOne({ where: { code } });
    if (!role) continue;
    for (const p of perms) {
      const perm = await models.Permission.findOne({ where: { code: p } });
      const [, created] = await models.RolePermission.findOrCreate({
        where: { roleId: role.id, permissionId: perm.id },
        defaults: { roleId: role.id, permissionId: perm.id },
      });
      if (created)
        await audit({
          action: 'role.permission_added_by_seeder',
          resourceType: 'Role',
          resourceId: role.id,
          after: { permission: p },
          actorType: 'system',
          sensitive: true,
        });
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
