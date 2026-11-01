/**
 * HTTP routes for roles and the permission matrix, mounted at /api/v1/roles.
 *
 * - GET / and GET /permissions list roles with their permissions and the permission catalogue ("users.manage").
 * - POST /, PATCH /:id and DELETE /:id create, edit and delete roles ("roles.manage").
 *
 * System roles cannot be deleted, and a role cannot be deleted while it has members. Changes are audited as
 * sensitive.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { notFound, conflict, forbidden } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /roles:
 *   get: { tags: [Roles], summary: List roles with permissions and member counts, responses: { 200: { description: Roles } } }
 *   post: { tags: [Roles], summary: Create a custom role (roles.manage), responses: { 201: { description: Created } } }
 */
router.get('/', requirePermission('users.manage'), async (req, res) => {
  const roles = await models.Role.findAll({
    include: [{ model: models.Permission, as: 'permissions', through: { attributes: [] }, attributes: ['id', 'code'] }],
    order: [['name', 'ASC']],
  });
  const counts = await models.UserRole.findAll({
    attributes: ['roleId', [sequelize.fn('COUNT', sequelize.col('userId')), 'n']],
    group: ['roleId'],
    raw: true,
  });
  const byRole = Object.fromEntries(counts.map((c) => [c.roleId, Number(c.n)]));
  res.json({ data: roles.map((r) => ({ ...r.get({ plain: true }), memberCount: byRole[r.id] || 0 })) });
});

router.get('/permissions', requirePermission('users.manage'), async (req, res) => {
  res.json({
    data: await models.Permission.findAll({
      order: [
        ['groupName', 'ASC'],
        ['code', 'ASC'],
      ],
    }),
  });
});

const roleBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,60}$/, 'Lowercase letters, digits and underscores'),
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(1000).optional().nullable(),
  isSensitive: z.boolean().default(false),
  permissionIds: z.array(z.string().uuid()).max(200).default([]),
});

router.post('/', requirePermission('roles.manage'), validate({ body: roleBody }), async (req, res) => {
  const { permissionIds, ...data } = req.body;
  if (await models.Role.findOne({ where: { code: data.code } })) throw conflict('Role code already exists');
  const role = await sequelize.transaction(async (t) => {
    const r = await models.Role.create({ ...data, isSystem: false }, { transaction: t });
    for (const permissionId of permissionIds)
      await models.RolePermission.create({ roleId: r.id, permissionId }, { transaction: t });
    await audit(
      {
        action: 'role.create',
        resourceType: 'Role',
        resourceId: r.id,
        after: { ...data, permissionIds },
        sensitive: true,
      },
      { transaction: t },
    );
    return r;
  });
  res.status(201).json({ data: role });
});

router.patch(
  '/:id',
  requirePermission('roles.manage'),
  validate({ params: idParams, body: roleBody.partial().omit({ code: true }) }),
  async (req, res) => {
    const role = await models.Role.findByPk(req.params.id, {
      include: [{ model: models.Permission, as: 'permissions', through: { attributes: [] } }],
    });
    if (!role) throw notFound('Role');
    const { permissionIds, ...data } = req.body;
    await sequelize.transaction(async (t) => {
      const beforePerms = role.permissions.map((p) => p.code).sort();
      await role.update(data, { transaction: t });
      if (permissionIds) {
        const myRoleIds = (await models.UserRole.findAll({ where: { userId: req.user.id }, transaction: t })).map(
          (x) => x.roleId,
        );
        if (myRoleIds.includes(role.id)) throw forbidden('You cannot change permissions of a role you hold');
        await models.RolePermission.destroy({ where: { roleId: role.id }, transaction: t });
        for (const permissionId of permissionIds)
          await models.RolePermission.create({ roleId: role.id, permissionId }, { transaction: t });
        const afterPerms = (await models.Permission.findAll({ where: { id: permissionIds }, transaction: t }))
          .map((p) => p.code)
          .sort();
        await audit(
          {
            action: 'role.permissions_changed',
            resourceType: 'Role',
            resourceId: role.id,
            before: { permissions: beforePerms },
            after: { permissions: afterPerms },
            sensitive: true,
          },
          { transaction: t },
        );
      }
      if (Object.keys(data).length)
        await audit(
          { action: 'role.update', resourceType: 'Role', resourceId: role.id, after: data },
          { transaction: t },
        );
    });
    res.json({
      data: await models.Role.findByPk(role.id, {
        include: [{ model: models.Permission, as: 'permissions', through: { attributes: [] } }],
      }),
    });
  },
);

router.delete('/:id', requirePermission('roles.manage'), validate({ params: idParams }), async (req, res) => {
  const role = await models.Role.findByPk(req.params.id);
  if (!role) throw notFound('Role');
  if (role.isSystem) throw forbidden('System roles cannot be deleted');
  if (await models.UserRole.count({ where: { roleId: role.id } }))
    throw conflict('Remove all members before deleting this role');
  await sequelize.transaction(async (t) => {
    await models.RolePermission.destroy({ where: { roleId: role.id }, transaction: t });
    await role.destroy({ transaction: t });
    await audit(
      { action: 'role.delete', resourceType: 'Role', resourceId: role.id, before: { code: role.code } },
      { transaction: t },
    );
  });
  res.status(204).end();
});

export default router;
