/**
 * HTTP routes for the reading-room circulation desk, mounted at /api/v1/circulation. Requires "circulation.issue"
 * or "circulation.return".
 *
 * - GET / lists circulation transactions, for example the items currently out or overdue.
 * - POST /issue issues a physical item to a checked-in researcher ("circulation.issue").
 * - POST /:id/return records the return and condition of an item ("circulation.return").
 * - POST /:id/lost records an outstanding item as lost ("circulation.return").
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { CIRCULATION_STATUSES } from '../../database/models/research.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import * as svc from './circulation.service.js';

const router = Router();
router.use(authenticate, requireAnyPermission('circulation.issue', 'circulation.return'));
const condition = z.enum(['good', 'fair', 'poor', 'critical']);

/**
 * @openapi
 * /circulation:
 *   get: { tags: [Reading room], summary: Circulation desk (filter by status, e.g. issued,overdue), responses: { 200: { description: Paged } } }
 * /circulation/issue:
 *   post: { tags: [Reading room], summary: Issue an item for supervised consultation, responses: { 201: { description: Issued }, 409: { description: Item not available } } }
 */
router.get(
  '/',
  validate({ query: paginationSchema.extend({ status: z.string().max(100).optional() }) }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',').filter((s) => CIRCULATION_STATUSES.includes(s));
    if (req.query.q) where[Op.or] = [{ researcherName: { [Op.like]: `%${req.query.q}%` } }];
    paged(
      res,
      await models.CirculationTransaction.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['issuedAt', 'DESC']],
        include: [
          { model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title', 'status'] },
          { model: models.ResearchRequest, as: 'request', attributes: ['id', 'requestNumber'] },
          { model: models.User, as: 'issuedBy', attributes: ['id', 'fullName'] },
        ],
      }),
      req.query,
    );
  },
);
router.post(
  '/issue',
  requirePermission('circulation.issue'),
  validate({
    body: z.object({
      physicalItemId: uuid,
      requestId: uuid,
      appointmentId: uuid.optional(),
      conditionBefore: condition,
      conditionBeforeNotes: optionalText(2000),
      expectedReturnAt: z.string().datetime({ offset: true }).optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.issue(req.body, req.user) });
  },
);
router.post(
  '/:id/return',
  requirePermission('circulation.return'),
  validate({
    params: idParams,
    body: z.object({
      conditionAfter: condition,
      conditionAfterNotes: optionalText(2000),
      incidentNotes: optionalText(4000),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.receive(req.params.id, req.body, req.user) });
  },
);
router.post(
  '/:id/lost',
  requirePermission('circulation.return'),
  validate({ params: idParams, body: z.object({ notes: z.string().trim().min(5).max(4000) }) }),
  async (req, res) => {
    res.json({ data: await svc.markLost(req.params.id, req.body.notes) });
  },
);

export default router;
