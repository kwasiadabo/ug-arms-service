/**
 * HTTP routes for the organisation structure (colleges, faculties, departments, institutes, administrative units
 * and external donors), mounted at /api/v1/organisation-units.
 *
 * Any signed-in user can read the structure (GET /). Creating and editing units (POST / and PATCH /:id) requires
 * "organisation.manage" and is audited. Units are deactivated rather than deleted, so historical records keep their
 * meaning.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid } from '../../validators/common.js';
import { notFound, badRequest, conflict } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { ORG_UNIT_TYPES } from '../../database/models/identity.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /organisation-units:
 *   get: { tags: [Organisation], summary: List organisational units (flat; use parentId to build the tree), responses: { 200: { description: Units } } }
 *   post: { tags: [Organisation], summary: Create a unit (organisation.manage), responses: { 201: { description: Created } } }
 */
router.get(
  '/',
  validate({
    query: z.object({
      q: z.string().max(100).optional(),
      type: z.enum(ORG_UNIT_TYPES).optional(),
      includeInactive: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.includeInactive !== 'true') where.isActive = true;
    if (req.query.type) where.unitType = req.query.type;
    if (req.query.q)
      where[Op.or] = [{ name: { [Op.like]: `%${req.query.q}%` } }, { code: { [Op.like]: `%${req.query.q}%` } }];
    res.json({ data: await models.OrganisationUnit.findAll({ where, order: [['name', 'ASC']] }) });
  },
);

const body = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(255),
  unitType: z.enum(ORG_UNIT_TYPES),
  parentId: uuid.nullable().optional(),
  contactEmail: z.string().email().optional().nullable(),
  historicalNames: z
    .array(
      z.object({ name: z.string().max(255), from: z.string().max(20).optional(), to: z.string().max(20).optional() }),
    )
    .max(50)
    .optional(),
  isActive: z.boolean().optional(),
});

/**
 * Checks that moving a unit under a new parent would not place it under itself or one of its descendants. At most
 * 50 levels are followed.
 *
 * @param {string} id Identifier of the unit being moved.
 * @param {string|null} parentId Proposed parent.
 * @returns {Promise<void>}
 * @throws {AppError} 400 when the move would create a cycle.
 */
async function assertNoCycle(id, parentId) {
  let cursor = parentId;
  for (let i = 0; cursor && i < 50; i += 1) {
    if (cursor === id) throw badRequest('A unit cannot be placed under itself or its descendants');
    cursor = (await models.OrganisationUnit.findByPk(cursor, { attributes: ['parentId'] }))?.parentId;
  }
}

router.post('/', requirePermission('organisation.manage'), validate({ body }), async (req, res) => {
  if (await models.OrganisationUnit.findOne({ where: { code: req.body.code } }))
    throw conflict('Unit code already exists');
  const unit = await sequelize.transaction(async (t) => {
    const u = await models.OrganisationUnit.create(req.body, { transaction: t });
    await audit(
      { action: 'organisation.create', resourceType: 'OrganisationUnit', resourceId: u.id, after: req.body },
      { transaction: t },
    );
    return u;
  });
  res.status(201).json({ data: unit });
});

router.patch(
  '/:id',
  requirePermission('organisation.manage'),
  validate({ params: idParams, body: body.partial() }),
  async (req, res) => {
    const unit = await models.OrganisationUnit.findByPk(req.params.id);
    if (!unit) throw notFound('Organisation unit');
    if (req.body.parentId) await assertNoCycle(unit.id, req.body.parentId);
    await sequelize.transaction(async (t) => {
      const before = unit.get({ plain: true });
      await unit.update(req.body, { transaction: t });
      const d = diff(before, unit);
      await audit(
        {
          action: 'organisation.update',
          resourceType: 'OrganisationUnit',
          resourceId: unit.id,
          before: d.before,
          after: d.after,
        },
        { transaction: t },
      );
    });
    res.json({ data: unit });
  },
);

export default router;
