/**
 * HTTP routes for user administration, mounted at /api/v1/users. Requires "users.manage".
 *
 * - GET /directory lists active staff for pickers; GET / searches users; GET /:id shows one with roles and recent
 *   sign-ins.
 * - POST / creates a user and emails an activation link; administrators never set or see passwords. PATCH /:id
 *   updates details and roles; changes to sensitive roles are flagged in the audit trail.
 * - POST /:id/activate, POST /:id/suspend and POST /:id/deactivate change the account status; administrators cannot
 *   change their own.
 * - POST /:id/revoke-sessions signs the user out everywhere; POST /:id/resend-invitation re-sends the activation
 *   link; POST /:id/unlock clears a sign-in lockout.
 * - POST /import creates several accounts from a spreadsheet.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Op } from 'sequelize';
import { parse } from 'csv-parse/sync';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, email, uuid } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { notFound, conflict, badRequest, forbidden } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { revokeAllSessions, sendActivation } from '../auth/auth.service.js';
import { USER_STATUSES } from '../../database/models/identity.js';

const router = Router();

/**
 * @openapi
 * /users/directory:
 *   get: { tags: [Users], summary: Minimal staff directory (id, name, email) for assignment pickers. Optional permission filter., responses: { 200: { description: Users } } }
 */
router.get(
  '/directory',
  authenticate,
  validate({ query: z.object({ q: z.string().max(100).optional(), permission: z.string().max(80).optional() }) }),
  async (req, res) => {
    const staffPerms = [
      'records.read',
      'assets.read',
      'research.manage',
      'appointments.manage',
      'digitisation.capture',
      'users.manage',
    ];
    if (!staffPerms.some((p) => req.user.permissions.has(p))) throw forbidden();
    const where = { status: 'active', userType: 'staff' };
    if (req.query.q)
      where[Op.or] = [{ fullName: { [Op.like]: `%${req.query.q}%` } }, { email: { [Op.like]: `%${req.query.q}%` } }];
    const include = req.query.permission
      ? [
          {
            model: models.Role,
            as: 'roles',
            attributes: [],
            required: true,
            through: { attributes: [] },
            include: [
              {
                model: models.Permission,
                as: 'permissions',
                attributes: [],
                required: true,
                where: { code: req.query.permission },
                through: { attributes: [] },
              },
            ],
          },
        ]
      : [];
    const rows = await models.User.findAll({
      where,
      include,
      attributes: ['id', 'fullName', 'email'],
      order: [['fullName', 'ASC']],
      limit: 20,
      subQuery: false,
    });
    res.json({ data: rows });
  },
);

router.use(authenticate, requirePermission('users.manage'));

const userInclude = [
  { model: models.Role, as: 'roles', attributes: ['id', 'code', 'name'], through: { attributes: ['expiresAt'] } },
  { model: models.OrganisationUnit, as: 'organisationUnit', attributes: ['id', 'code', 'name'] },
];

const userBody = z.object({
  email,
  fullName: z.string().trim().min(2).max(200),
  userType: z.enum(['staff', 'researcher', 'public']).default('staff'),
  organisationUnitId: uuid.nullable().optional(),
  affiliation: z.string().trim().max(255).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  accountExpiresAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .nullable(),
  roleIds: z.array(uuid).max(20).default([]),
  sendInvitation: z.boolean().default(true),
});

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List users (users.manage)
 *     parameters: [{ in: query, name: q, schema: { type: string } }, { in: query, name: status, schema: { type: string } }, { in: query, name: roleId, schema: { type: string } }, { in: query, name: page, schema: { type: integer } }]
 *     responses: { 200: { description: Paged users } }
 *   post: { tags: [Users], summary: Create a user and send an activation email, responses: { 201: { description: Created } } }
 */
router.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(USER_STATUSES).optional(),
      roleId: uuid.optional(),
      organisationUnitId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    const { q, status, roleId, organisationUnitId } = req.query;
    const where = {};
    if (q) where[Op.or] = [{ email: { [Op.like]: `%${q}%` } }, { fullName: { [Op.like]: `%${q}%` } }];
    if (status) where.status = status;
    if (organisationUnitId) where.organisationUnitId = organisationUnitId;
    const include = userInclude.map((i) =>
      i.as === 'roles' && roleId ? { ...i, where: { id: roleId }, required: true } : i,
    );
    const result = await models.User.findAndCountAll({
      where,
      include,
      distinct: true,
      ...pageParams(req.query),
      order: orderBy(req.query.sort, req.query.order, ['email', 'fullName', 'createdAt', 'lastLoginAt', 'status']),
    });
    paged(res, result, req.query);
  },
);

router.post('/', validate({ body: userBody }), async (req, res) => {
  const { roleIds, sendInvitation, ...data } = req.body;
  if (await models.User.findOne({ where: { email: data.email } }))
    throw conflict('A user with this email already exists');
  const user = await sequelize.transaction(async (t) => {
    const u = await models.User.create({ ...data, status: 'pending' }, { transaction: t });
    for (const roleId of roleIds)
      await models.UserRole.create({ userId: u.id, roleId, assignedById: req.user.id }, { transaction: t });
    await audit(
      { action: 'user.create', resourceType: 'User', resourceId: u.id, after: { ...data, roleIds } },
      { transaction: t },
    );
    return u;
  });
  if (sendInvitation) await sendActivation(user);
  res.status(201).json({ data: await models.User.findByPk(user.id, { include: userInclude }) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const user = await models.User.findByPk(req.params.id, { include: userInclude });
  if (!user) throw notFound('User');
  const recentLogins = await models.LoginAttempt.findAll({
    where: { userId: user.id },
    order: [['createdAt', 'DESC']],
    limit: 10,
  });
  const sessions = await models.UserSession.count({
    where: { userId: user.id, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
  });
  res.json({ data: { ...user.get({ plain: true }), recentLogins, activeSessions: sessions } });
});

router.patch(
  '/:id',
  validate({ params: idParams, body: userBody.partial().omit({ sendInvitation: true, email: true }) }),
  async (req, res) => {
    const { roleIds, ...data } = req.body;
    const user = await models.User.findByPk(req.params.id, { include: userInclude });
    if (!user) throw notFound('User');
    await sequelize.transaction(async (t) => {
      const before = user.get({ plain: true });
      await user.update(data, { transaction: t });
      if (roleIds) {
        if (user.id === req.user.id) throw forbidden('You cannot change your own roles');
        const current = before.roles.map((r) => r.id);
        const removed = current.filter((id) => !roleIds.includes(id));
        const added = roleIds.filter((id) => !current.includes(id));
        if (removed.length)
          await models.UserRole.destroy({ where: { userId: user.id, roleId: removed }, transaction: t });
        for (const roleId of added)
          await models.UserRole.create({ userId: user.id, roleId, assignedById: req.user.id }, { transaction: t });
        if (removed.length || added.length) {
          await audit(
            {
              action: 'user.roles_changed',
              resourceType: 'User',
              resourceId: user.id,
              before: { roleIds: current },
              after: { roleIds },
              sensitive: true,
            },
            { transaction: t },
          );
          if (removed.length) await revokeAllSessions(user.id, 'roles_changed', t);
        }
      }
      const d = diff(before, user);
      if (d.fields.length)
        await audit(
          { action: 'user.update', resourceType: 'User', resourceId: user.id, before: d.before, after: d.after },
          { transaction: t },
        );
    });
    res.json({ data: await models.User.findByPk(user.id, { include: userInclude }) });
  },
);

/**
 * Creates a route handler that sets a user's account status.
 *
 * Administrators cannot change their own status. The lockout is cleared, the deactivation time and reason are
 * recorded, and every session is revoked when the account becomes anything other than active. The change is audited
 * with the reason.
 *
 * @param {string} action Name used in the audit action, for example "suspend".
 * @param {string} status The new status, for example "suspended".
 * @returns {import('express').RequestHandler}
 */
const statusChange = (action, status) => async (req, res) => {
  const user = await models.User.findByPk(req.params.id);
  if (!user) throw notFound('User');
  if (user.id === req.user.id) throw forbidden('You cannot change the status of your own account');
  await sequelize.transaction(async (t) => {
    const before = user.status;
    await user.update(
      {
        status,
        deactivatedAt: status === 'deactivated' ? new Date() : user.deactivatedAt,
        deactivationReason: req.body.reason ?? null,
        lockedUntil: null,
        failedLoginCount: 0,
      },
      { transaction: t },
    );
    if (status !== 'active') await revokeAllSessions(user.id, `account_${status}`, t);
    await audit(
      {
        action: `user.${action}`,
        resourceType: 'User',
        resourceId: user.id,
        before: { status: before },
        after: { status },
        reason: req.body.reason,
      },
      { transaction: t },
    );
  });
  res.json({ data: { id: user.id, status } });
};
const reasonBody = z.object({ reason: z.string().trim().max(500).optional() });
router.post('/:id/activate', validate({ params: idParams, body: reasonBody }), statusChange('activate', 'active'));
router.post('/:id/suspend', validate({ params: idParams, body: reasonBody }), statusChange('suspend', 'suspended'));
// Deactivation keeps the row so historical audit and workflow references stay attributable.
router.post(
  '/:id/deactivate',
  validate({ params: idParams, body: reasonBody }),
  statusChange('deactivate', 'deactivated'),
);

router.post('/:id/revoke-sessions', validate({ params: idParams }), async (req, res) => {
  await sequelize.transaction(async (t) => {
    await revokeAllSessions(req.params.id, 'admin_revoked', t);
    await audit(
      { action: 'user.sessions_revoked', resourceType: 'User', resourceId: req.params.id },
      { transaction: t },
    );
  });
  res.json({ data: { ok: true } });
});

router.post('/:id/resend-invitation', validate({ params: idParams }), async (req, res) => {
  const user = await models.User.findByPk(req.params.id);
  if (!user) throw notFound('User');
  if (user.status !== 'pending') throw badRequest('Only pending accounts can be re-invited');
  await sendActivation(user);
  await audit({ action: 'user.invitation_sent', resourceType: 'User', resourceId: user.id });
  res.json({ data: { ok: true } });
});

router.post('/:id/unlock', validate({ params: idParams }), async (req, res) => {
  await models.User.update({ lockedUntil: null, failedLoginCount: 0 }, { where: { id: req.params.id } });
  await audit({ action: 'user.unlocked', resourceType: 'User', resourceId: req.params.id });
  res.json({ data: { ok: true } });
});

// Bulk provisioning from CSV: email, fullName, roleCodes (semicolon separated), unitCode, userType.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Upload a CSV file in the "file" field');
  const dryRun = req.query.dryRun === 'true';
  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw badRequest(`CSV could not be parsed: ${err.message}`);
  }
  if (rows.length > 2000) throw badRequest('Import at most 2000 users at a time');
  const roles = new Map((await models.Role.findAll()).map((r) => [r.code, r.id]));
  const units = new Map((await models.OrganisationUnit.findAll()).map((u) => [u.code, u.id]));
  const results = [];
  const seen = new Set();
  for (const [i, row] of rows.entries()) {
    const errors = [];
    const parsedEmail = email.safeParse(row.email ?? '');
    if (!parsedEmail.success) errors.push('Invalid email');
    if (!row.fullName || row.fullName.length < 2) errors.push('fullName is required');
    const roleCodes = (row.roleCodes || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknownRoles = roleCodes.filter((c) => !roles.has(c));
    if (unknownRoles.length) errors.push(`Unknown roles: ${unknownRoles.join(', ')}`);
    if (row.unitCode && !units.has(row.unitCode)) errors.push(`Unknown unit: ${row.unitCode}`);
    const em = parsedEmail.success ? parsedEmail.data : null;
    if (em && seen.has(em)) errors.push('Duplicate email in file');
    if (em) seen.add(em);
    if (em && !errors.length && (await models.User.findOne({ where: { email: em } })))
      errors.push('User already exists');
    results.push({
      row: i + 2,
      email: row.email,
      status: errors.length ? 'invalid' : dryRun ? 'valid' : 'pending',
      errors,
      roleCodes,
      unitCode: row.unitCode,
      fullName: row.fullName,
      userType: row.userType,
    });
  }
  if (!dryRun) {
    for (const r of results.filter((x) => x.status === 'pending')) {
      try {
        const u = await sequelize.transaction(async (t) => {
          const user = await models.User.create(
            {
              email: r.email.trim().toLowerCase(),
              fullName: r.fullName,
              userType: ['staff', 'researcher', 'public'].includes(r.userType) ? r.userType : 'staff',
              organisationUnitId: units.get(r.unitCode) ?? null,
              status: 'pending',
            },
            { transaction: t },
          );
          for (const c of r.roleCodes)
            await models.UserRole.create(
              { userId: user.id, roleId: roles.get(c), assignedById: req.user.id },
              { transaction: t },
            );
          return user;
        });
        await sendActivation(u);
        r.status = 'created';
      } catch (err) {
        r.status = 'failed';
        r.errors.push(err.message);
      }
    }
    await audit({
      action: 'user.bulk_import',
      resourceType: 'User',
      metadata: {
        filename: req.file.originalname,
        created: results.filter((r) => r.status === 'created').length,
        failed: results.filter((r) => r.status !== 'created').length,
      },
    });
  }
  res.json({ data: { dryRun, total: results.length, results } });
});

export default router;
