/**
 * HTTP routes for repositories (the archival institutions or services that hold collections), mounted at
 * /api/v1/repositories.
 *
 * - GET / lists repositories for any signed-in user.
 * - POST / creates a repository; codes must be unique ("repositories.manage").
 * - PATCH /:id updates a repository ("repositories.manage").
 *
 * Every change is audited.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models, sequelize } from '../../database/models/index.js';
import { ACCESS_LEVELS } from '../../database/models/archival.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { notFound, conflict } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { refreshEffectiveAccess } from '../../services/accessPolicy.service.js';

const router = Router();
router.use(authenticate);

const body = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(255),
  authorizedFormOfName: z.string().trim().max(255).optional().nullable(),
  address: z.string().trim().max(1000).optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: z.string().max(60).optional().nullable(),
  description: z.string().max(20000).optional().nullable(),
  openingTimes: z.string().max(1000).optional().nullable(),
  accessConditions: z.string().max(20000).optional().nullable(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
  isActive: z.boolean().optional(),
});

/**
 * @openapi
 * /repositories:
 *   get: { tags: [Collections], summary: List repositories (ISDIAH-informed), responses: { 200: { description: Repositories } } }
 *   post: { tags: [Collections], summary: Create a repository (repositories.manage), responses: { 201: { description: Created } } }
 */
router.get('/', async (req, res) => res.json({ data: await models.Repository.findAll({ order: [['name', 'ASC']] }) }));

router.post('/', requirePermission('repositories.manage'), validate({ body }), async (req, res) => {
  if (await models.Repository.findOne({ where: { code: req.body.code } }))
    throw conflict('Repository code already exists');
  const repo = await sequelize.transaction(async (t) => {
    const r = await models.Repository.create(req.body, { transaction: t });
    await audit(
      { action: 'repository.create', resourceType: 'Repository', resourceId: r.id, after: req.body },
      { transaction: t },
    );
    return r;
  });
  res.status(201).json({ data: repo });
});

router.patch(
  '/:id',
  requirePermission('repositories.manage'),
  validate({ params: idParams, body: body.partial().omit({ code: true }) }),
  async (req, res) => {
    const repo = await models.Repository.findByPk(req.params.id);
    if (!repo) throw notFound('Repository');
    await sequelize.transaction(async (t) => {
      const before = repo.get({ plain: true });
      await repo.update(req.body, { transaction: t });
      if (req.body.accessLevel && req.body.accessLevel !== before.accessLevel) {
        const tops = await models.ArchivalRecord.findAll({
          where: { repositoryId: repo.id, parentId: null },
          attributes: ['id'],
          transaction: t,
        });
        for (const top of tops) await refreshEffectiveAccess(top.id, t);
      }
      const d = diff(before, repo);
      await audit(
        {
          action: 'repository.update',
          resourceType: 'Repository',
          resourceId: repo.id,
          before: d.before,
          after: d.after,
        },
        { transaction: t },
      );
    });
    res.json({ data: repo });
  },
);

export default router;
