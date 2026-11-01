/**
 * Sequelize model definitions for the identity and access domain.
 *
 * Defines the tables for users, roles, permissions and their assignments, sessions, login attempts, one-time action
 * tokens (email verification and password reset), organisation units, notifications and notification preferences.
 * Password hashes are excluded from the default scope and can only be read through the explicit "withSecrets"
 * scope, so they are never serialised in an API response by mistake.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, bool, int, date, status, json, enumStr } from './_helpers.js';

export const USER_STATUSES = ['pending', 'active', 'suspended', 'deactivated'];
export const ORG_UNIT_TYPES = [
  'university',
  'college',
  'faculty',
  'school',
  'department',
  'institute',
  'centre',
  'administrative_unit',
  'external_donor',
  'external_organisation',
];

/**
 * Defines the identity and access models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineIdentity(sequelize) {
  const User = sequelize.define(
    'User',
    {
      id: pk(),
      email: req(320),
      fullName: req(200),
      passwordHash: str(255),
      status: status(USER_STATUSES, 'pending'),
      userType: status(['staff', 'researcher', 'public'], 'staff'),
      affiliation: str(255),
      phone: str(40),
      timezone: str(60, { defaultValue: 'Africa/Accra' }),
      organisationUnitId: fk(),
      emailVerifiedAt: date(),
      lastLoginAt: date(),
      failedLoginCount: int(0),
      lockedUntil: date(),
      accountExpiresAt: date(),
      tokenVersion: int(0),
      mustChangePassword: bool(false),
      deactivatedAt: date(),
      deactivationReason: str(500),
    },
    {
      indexes: [{ unique: true, fields: ['email'] }, { fields: ['status'] }, { fields: ['organisationUnitId'] }],
      defaultScope: { attributes: { exclude: ['passwordHash'] } },
      scopes: { withSecrets: { attributes: { include: ['passwordHash'] } } },
    },
  );

  const Role = sequelize.define(
    'Role',
    {
      id: pk(),
      code: req(80),
      name: req(150),
      description: str(1000),
      isSystem: bool(false),
      isSensitive: bool(false),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const Permission = sequelize.define(
    'Permission',
    {
      id: pk(),
      code: req(100),
      groupName: req(80),
      description: str(500),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const UserRole = sequelize.define(
    'UserRole',
    {
      id: pk(),
      userId: fk(false),
      roleId: fk(false),
      assignedById: fk(),
      expiresAt: date(),
    },
    { indexes: [{ unique: true, fields: ['userId', 'roleId'] }] },
  );

  const RolePermission = sequelize.define(
    'RolePermission',
    {
      id: pk(),
      roleId: fk(false),
      permissionId: fk(false),
    },
    { indexes: [{ unique: true, fields: ['roleId', 'permissionId'] }] },
  );

  // One row per refresh-token family member. Rotation marks the old row replaced; reuse of a
  // replaced token revokes the whole family (refresh-token theft detection).
  const UserSession = sequelize.define(
    'UserSession',
    {
      id: pk(),
      userId: fk(false),
      familyId: fk(false),
      refreshTokenHash: req(128),
      userAgent: str(500),
      ipAddress: str(64),
      expiresAt: date({ allowNull: false }),
      lastUsedAt: date(),
      revokedAt: date(),
      revokedReason: str(200),
      replacedById: fk(),
    },
    { indexes: [{ unique: true, fields: ['refreshTokenHash'] }, { fields: ['userId'] }, { fields: ['familyId'] }] },
  );

  const LoginAttempt = sequelize.define(
    'LoginAttempt',
    {
      id: pk(),
      email: str(320),
      userId: fk(),
      ipAddress: str(64),
      userAgent: str(500),
      success: bool(false),
      reason: str(100),
    },
    { updatedAt: false, indexes: [{ fields: ['email', 'createdAt'] }] },
  );

  const ActionToken = sequelize.define(
    'ActionToken',
    {
      id: pk(),
      userId: fk(false),
      purpose: status(['verify_email', 'reset_password', 'activate_account']),
      tokenHash: req(128),
      expiresAt: date({ allowNull: false }),
      usedAt: date(),
    },
    { indexes: [{ unique: true, fields: ['tokenHash'] }] },
  );

  // Departments, faculties, colleges, institutes, centres, and donors share one configurable hierarchy.
  const OrganisationUnit = sequelize.define(
    'OrganisationUnit',
    {
      id: pk(),
      code: req(40),
      name: req(255),
      unitType: status(ORG_UNIT_TYPES, 'department'),
      parentId: fk(),
      historicalNames: json('historicalNames', []),
      contactEmail: str(320),
      isActive: bool(true),
      validFrom: date(),
      validTo: date(),
    },
    { indexes: [{ unique: true, fields: ['code'] }, { fields: ['parentId'] }, { fields: ['unitType'] }] },
  );

  const Notification = sequelize.define(
    'Notification',
    {
      id: pk(),
      userId: fk(false),
      eventType: req(80),
      title: req(255),
      body: str(2000),
      link: str(500),
      entityType: str(60),
      entityId: str(64),
      readAt: date(),
      emailStatus: enumStr(['not_required', 'pending', 'sent', 'failed']),
    },
    { indexes: [{ fields: ['userId', 'readAt'] }] },
  );

  const NotificationPreference = sequelize.define(
    'NotificationPreference',
    {
      id: pk(),
      userId: fk(false),
      eventType: req(80),
      inApp: bool(true),
      email: bool(true),
    },
    { indexes: [{ unique: true, fields: ['userId', 'eventType'] }] },
  );

  return {
    User,
    Role,
    Permission,
    UserRole,
    RolePermission,
    UserSession,
    LoginAttempt,
    ActionToken,
    OrganisationUnit,
    Notification,
    NotificationPreference,
  };
}
