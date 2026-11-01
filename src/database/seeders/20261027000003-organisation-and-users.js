/**
 * Seeder: organisation units, the initial administrator and the demonstration accounts.
 *
 * The organisation units are illustrative and must be replaced with the official University hierarchy. The initial
 * administrator always starts with a temporary password that must be changed at first sign-in; if
 * SEED_ADMIN_PASSWORD is not supplied, a random password is generated and printed once. Demonstration accounts, one
 * per role, are created only in development and test when SEED_DEMO_DATA is enabled, never in production.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';
import { env } from '../../config/env.js';
import crypto from 'node:crypto';
import { hashPassword } from '../../modules/auth/auth.service.js';

// Organisational units are illustrative. The official hierarchy must be configured by administrators.
const UNITS = [
  ['UG', 'University of Ghana', 'university', null],
  ['CBAS', 'College of Basic and Applied Sciences', 'college', 'UG'],
  ['CHS', 'College of Health Sciences', 'college', 'UG'],
  ['COH', 'College of Humanities', 'college', 'UG'],
  ['COE', 'College of Education', 'college', 'UG'],
  ['REG', 'Office of the Registrar', 'administrative_unit', 'UG'],
  ['VCO', 'Office of the Vice-Chancellor', 'administrative_unit', 'UG'],
  ['LIB', 'University Library (Balme Library)', 'administrative_unit', 'UG'],
  ['IAS', 'Institute of African Studies', 'institute', 'COH'],
  ['HIST', 'Department of History', 'department', 'COH'],
  ['PHYS', 'Department of Physics', 'department', 'CBAS'],
  ['ACAD', 'Academic Affairs Directorate', 'administrative_unit', 'REG'],
  ['DPPD', 'Physical Planning and Development', 'administrative_unit', 'UG'],
];

const DEMO_USERS = [
  ['chief.archivist@ugarms.local', 'Ama Mensah', 'chief_archivist', 'LIB'],
  ['deputy.archivist@ugarms.local', 'Nana Agyeman', 'chief_archivist', 'LIB'],
  ['archivist@ugarms.local', 'Kofi Boateng', 'archivist', 'LIB'],
  ['archivist2@ugarms.local', 'Adwoa Sarpong', 'archivist', 'IAS'],
  ['records.officer@ugarms.local', 'Efua Asante', 'records_officer', 'REG'],
  ['digitisation@ugarms.local', 'Yaw Owusu', 'digitisation_officer', 'LIB'],
  ['readingroom@ugarms.local', 'Akosua Darko', 'reading_room_officer', 'LIB'],
  ['liaison.history@ugarms.local', 'Kwame Addo', 'departmental_liaison', 'HIST'],
  ['auditor@ugarms.local', 'Abena Ofori', 'auditor', 'VCO'],
  ['researcher@ugarms.local', 'Esi Quaye', 'researcher', null],
];

/**
 * Creates the organisation units, the initial administrator and, where allowed, the demonstration accounts.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  const ids = {};
  for (const [code, name, unitType, parent] of UNITS) {
    const [u] = await models.OrganisationUnit.findOrCreate({
      where: { code },
      defaults: { code, name, unitType, parentId: parent ? ids[parent] : null },
    });
    ids[code] = u.id;
  }
  const roles = Object.fromEntries((await models.Role.findAll()).map((r) => [r.code, r.id]));
  // The initial administrator always starts with a temporary credential that must be changed at first
  // sign-in (except in the automated test environment). If none is supplied, a random one is generated.
  let adminPassword = env.SEED_ADMIN_PASSWORD;
  if (!adminPassword && !(await models.User.findOne({ where: { email: env.SEED_ADMIN_EMAIL } }))) {
    adminPassword = `${crypto.randomBytes(12).toString('base64url')}9a`;
    console.log(`\nInitial administrator ${env.SEED_ADMIN_EMAIL} temporary password (shown once): ${adminPassword}\n`);
  }
  const hash = adminPassword ? await hashPassword(adminPassword) : null;

  /**
   * Creates a user if no account with the email exists, and makes sure the user holds the given role.
   *
   * @param {string} email Sign-in email address.
   * @param {string} fullName Display name.
   * @param {string} roleCode Code of the role to assign, for example "archivist".
   * @param {string|null} unit Code of the user's organisation unit, or null.
   * @param {string} [userType='staff'] Account type, "staff" or "researcher".
   * @param {boolean} [mustChange=false] Whether the password must be changed at first sign-in.
   * @returns {Promise<void>}
   */
  const ensure = async (email, fullName, roleCode, unit, userType = 'staff', mustChange = false) => {
    const [user] = await models.User.findOrCreate({
      where: { email },
      defaults: {
        email,
        fullName,
        passwordHash: hash,
        status: 'active',
        emailVerifiedAt: new Date(),
        userType,
        organisationUnitId: unit ? ids[unit] : null,
        mustChangePassword: mustChange,
      },
    });
    await models.UserRole.findOrCreate({
      where: { userId: user.id, roleId: roles[roleCode] },
      defaults: { userId: user.id, roleId: roles[roleCode] },
    });
  };
  await ensure(
    env.SEED_ADMIN_EMAIL,
    'System Administrator',
    'system_administrator',
    'LIB',
    'staff',
    env.NODE_ENV !== 'test',
  );
  // Sample accounts exist only in development and test, never in production.
  if (env.SEED_DEMO_DATA && env.NODE_ENV !== 'production') {
    for (const [email, name, role, unit] of DEMO_USERS)
      await ensure(email, name, role, unit, role === 'researcher' ? 'researcher' : 'staff');
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
