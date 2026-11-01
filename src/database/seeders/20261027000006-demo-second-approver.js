/**
 * Seeder: a second chief archivist account for demonstration databases.
 *
 * Two-person rules, such as opening access to a description or approving a disposal, need two different people who
 * hold the approving role. Fresh installations receive the deputy account from the organisation and users seeder;
 * this seeder adds it to databases created before that account existed. It runs only when demonstration data is
 * enabled and never in production.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';
import { env } from '../../config/env.js';

/**
 * Creates the deputy chief archivist demonstration account with the same demonstration password as the chief
 * archivist, unless it already exists.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  if (!env.SEED_DEMO_DATA || env.NODE_ENV === 'production') return;
  const email = 'deputy.archivist@ugarms.local';
  if (await models.User.findOne({ where: { email } })) return;
  const peer = await models.User.scope('withSecrets').findOne({ where: { email: 'chief.archivist@ugarms.local' } });
  const role = await models.Role.findOne({ where: { code: 'chief_archivist' } });
  if (!peer || !role) return;
  const unit = await models.OrganisationUnit.findOne({ where: { code: 'LIB' } });
  const user = await models.User.create({
    email,
    fullName: 'Nana Agyeman',
    passwordHash: peer.passwordHash,
    status: 'active',
    emailVerifiedAt: new Date(),
    userType: 'staff',
    organisationUnitId: unit?.id ?? null,
    mustChangePassword: false,
  });
  await models.UserRole.create({ userId: user.id, roleId: role.id });
}

/**
 * Reverses this seeder. Intentionally does nothing: seeded reference data and accounts may already be referenced by
 * real records and audit events, so they are never deleted automatically. Use `npm run db:reset` to rebuild a
 * development database from scratch.
 *
 * @returns {Promise<void>}
 */
export async function down() {}
