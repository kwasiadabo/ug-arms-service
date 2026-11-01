/**
 * HTTP routes for research services and the reading room.
 *
 * `researchRouter` (/api/v1/research-requests): POST /public submits an enquiry without an account (rate-limited,
 * when allowed); GET / lists requests for staff ("research.manage"); GET /mine lists the caller's own; POST /
 * creates a request; GET /:id shows one; POST /:id/actions performs an action; POST /:id/assign assigns it to a
 * staff member; POST /:id/comments adds a message; PATCH /reproductions/:id updates a copy order.
 *
 * `readingRoomRouter` (/api/v1/reading-rooms, "appointments.manage"): rooms, availability, slot generation, closure
 * days and the daily schedule.
 *
 * `appointmentsRouter` (/api/v1/appointments): booking, the staff list of appointments, and POST /:id/:action to
 * cancel, check in, complete or record a no-show.
 *
 * `meRouter` (/api/v1/me): the researcher's saved records, their appointments and catalogue feedback.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { REQUEST_STATUSES } from '../../database/models/research.js';
import { authenticate, optionalAuth, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { anonymousFormLimiter } from '../../middleware/rateLimit.js';
import { idParams, uuid, isoDate, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { notFound } from '../../utils/errors.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { history } from '../../services/workflow.service.js';
import { audit } from '../../services/audit.service.js';
import { notifyUsers } from '../../services/notification.service.js';
import * as svc from './research.service.js';
import * as rooms from './reading-room.service.js';

export const researchRouter = Router();
export const readingRoomRouter = Router();
export const appointmentsRouter = Router();
export const meRouter = Router();

const requestBody = z.object({
  requestType: z.enum(['consultation', 'digital_copy', 'restricted_access', 'enquiry', 'reproduction']),
  purpose: z.string().trim().min(10, 'Describe your research purpose').max(8000),
  preferredDate: isoDate,
  deliveryPreference: optionalText(255),
  affiliation: optionalText(255),
  contactName: z.string().trim().min(2).max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: optionalText(60),
  restrictionsAcknowledged: z.boolean().default(false),
  items: z
    .array(z.object({ recordId: uuid, physicalItemId: uuid.optional(), notes: optionalText(1000) }))
    .max(50)
    .default([]),
  saveAsDraft: z.boolean().default(false),
});

/**
 * @openapi
 * /research-requests/public:
 *   post: { tags: [Research services], security: [], summary: Submit an enquiry or consultation request (signed-in users or, if enabled, anonymous visitors), responses: { 201: { description: Submitted } } }
 */
researchRouter.post(
  '/public',
  anonymousFormLimiter,
  optionalAuth,
  validate({ body: requestBody }),
  async (req, res) => {
    const user = req.user ?? null;
    if (!user && (!req.body.contactName || !req.body.contactEmail))
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name and email are required',
          details: [{ path: 'contactEmail', message: 'Required' }],
        },
      });
    const r = await svc.createRequest(req.body, user, { submit: !req.body.saveAsDraft });
    res.status(201).json({ data: { id: r.id, requestNumber: r.requestNumber, status: r.status } });
  },
);

researchRouter.use(authenticate);

/**
 * @openapi
 * /research-requests:
 *   get: { tags: [Research services], summary: Request queue (research.manage), responses: { 200: { description: Paged } } }
 */
researchRouter.get(
  '/',
  requirePermission('research.manage'),
  validate({
    query: paginationSchema.extend({
      status: z.string().max(300).optional(),
      requestType: z.string().max(60).optional(),
      assignedToMe: z.enum(['true', 'false']).optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',').filter((s) => REQUEST_STATUSES.includes(s));
    if (req.query.requestType) where.requestType = req.query.requestType;
    if (req.query.assignedToMe === 'true') where.assignedToId = req.user.id;
    if (req.query.q)
      where[Op.or] = [
        { requestNumber: { [Op.like]: `%${req.query.q}%` } },
        { contactName: { [Op.like]: `%${req.query.q}%` } },
        { contactEmail: { [Op.like]: `%${req.query.q}%` } },
      ];
    paged(
      res,
      await models.ResearchRequest.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, ['createdAt', 'submittedAt', 'status', 'preferredDate']),
        include: [
          { model: models.User, as: 'assignedTo', attributes: ['id', 'fullName'] },
          { model: models.ResearchRequestItem, as: 'items', attributes: ['id'] },
        ],
        distinct: true,
      }),
      req.query,
    );
  },
);

researchRouter.get('/mine', validate({ query: paginationSchema }), async (req, res) => {
  paged(
    res,
    await models.ResearchRequest.findAndCountAll({
      where: { requesterId: req.user.id },
      attributes: { exclude: ['internalDecisionNote'] },
      ...pageParams(req.query),
      order: [['createdAt', 'DESC']],
    }),
    req.query,
  );
});

researchRouter.post('/', validate({ body: requestBody }), async (req, res) => {
  const r = await svc.createRequest(req.body, req.user, { submit: !req.body.saveAsDraft });
  res.status(201).json({ data: r });
});

researchRouter.get('/:id', validate({ params: idParams }), async (req, res) => {
  const r = await svc.loadVisible(req.params.id, req.user);
  const staff = hasPerm(req.user, 'research.manage');
  const [items, comments, appointments, circulations, reproductions, hist, approvals] = await Promise.all([
    models.ResearchRequestItem.findAll({
      where: { requestId: r.id },
      include: [
        {
          model: models.ArchivalRecord,
          as: 'record',
          attributes: ['id', 'referenceCode', 'title', 'level', 'effectiveAccessLevel'],
        },
        { model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title', 'status'] },
      ],
    }),
    models.Comment.findAll({
      where: { entityType: 'ResearchRequest', entityId: r.id, ...(staff ? {} : { visibility: 'shared' }) },
      include: [{ model: models.User, as: 'author', attributes: ['id', 'fullName'] }],
      order: [['createdAt', 'ASC']],
    }),
    models.ResearchAppointment.findAll({
      where: { requestId: r.id },
      include: [
        {
          model: models.AppointmentSlot,
          as: 'slot',
          include: [{ model: models.ReadingRoom, as: 'readingRoom', attributes: ['id', 'name', 'location'] }],
        },
      ],
      order: [['createdAt', 'DESC']],
    }),
    staff
      ? models.CirculationTransaction.findAll({
          where: { requestId: r.id },
          include: [{ model: models.PhysicalItem, as: 'physicalItem', attributes: ['id', 'barcode', 'title'] }],
        })
      : [],
    models.ReproductionRequest.findAll({
      where: { requestId: r.id },
      include: [{ model: models.ArchivalRecord, as: 'record', attributes: ['id', 'title', 'referenceCode'] }],
    }),
    staff ? history('ResearchRequest', r.id) : [],
    staff
      ? models.Approval.findAll({
          where: { entityType: 'ResearchRequest', entityId: r.id },
          include: [{ model: models.User, as: 'approver', attributes: ['id', 'fullName'] }],
        })
      : [],
  ]);
  const data = r.get({ plain: true });
  if (!staff) delete data.internalDecisionNote;
  // Researchers see physical items' identity only; staff see linked records' access levels.
  res.json({
    data: {
      ...data,
      items,
      comments,
      appointments,
      circulations,
      reproductions,
      history: hist,
      approvals,
      availableActions: svc.actionsFor(r, req.user),
    },
  });
});

researchRouter.post(
  '/:id/actions',
  validate({
    params: idParams,
    body: z.object({
      action: z.enum([
        'submit',
        'start_review',
        'request_clarification',
        'respond',
        'approve',
        'reject',
        'start_fulfilment',
        'fulfil',
        'close',
        'cancel',
      ]),
      publicNote: optionalText(4000),
      internalNote: optionalText(4000),
      message: optionalText(4000),
      conditions: optionalText(2000),
      itemDecisions: z
        .array(z.object({ itemId: uuid, decision: z.enum(['approved', 'rejected']), note: optionalText(1000) }))
        .max(50)
        .optional(),
    }),
  }),
  async (req, res) => {
    const r = await svc.act(req.params.id, req.body, req.user);
    res.json({ data: { id: r.id, status: r.status } });
  },
);

researchRouter.post(
  '/:id/assign',
  requirePermission('research.manage'),
  validate({ params: idParams, body: z.object({ userId: uuid, note: optionalText(1000) }) }),
  async (req, res) => {
    const r = await svc.loadVisible(req.params.id, req.user);
    const assignee = await models.User.findOne({
      where: { id: req.body.userId, status: 'active' },
      include: [
        {
          model: models.Role,
          as: 'roles',
          required: true,
          include: [
            { model: models.Permission, as: 'permissions', where: { code: 'research.manage' }, required: true },
          ],
        },
      ],
    });
    if (!assignee) throw notFound('A staff member who can manage research requests');
    const before = r.assignedToId;
    await r.update({ assignedToId: assignee.id });
    await audit({
      action: 'research.assigned',
      resourceType: 'ResearchRequest',
      resourceId: r.id,
      before: { assignedToId: before },
      after: { assignedToId: assignee.id },
      reason: req.body.note,
    });
    await notifyUsers([assignee.id], {
      eventType: 'task.assigned',
      title: `Research request assigned to you: ${r.requestNumber}`,
      body: req.body.note || '',
      link: `/admin/research-requests/${r.id}`,
    });
    res.json({ data: { id: r.id, assignedToId: assignee.id } });
  },
);

researchRouter.post(
  '/:id/comments',
  validate({
    params: idParams,
    body: z.object({
      body: z.string().trim().min(1).max(4000),
      visibility: z.enum(['internal', 'shared']).default('shared'),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await svc.addComment(req.params.id, req.body, req.user) });
  },
);

researchRouter.patch(
  '/reproductions/:id',
  requirePermission('research.manage'),
  validate({
    params: idParams,
    body: z.object({
      status: z.enum(['pending', 'approved', 'in_production', 'delivered', 'rejected']).optional(),
      rightsCleared: z.boolean().optional(),
      rightsNote: optionalText(1000),
      deliveredAssetId: uuid.optional(),
      format: optionalText(80),
    }),
  }),
  async (req, res) => {
    res.json({ data: await svc.updateReproduction(req.params.id, req.body, req.user) });
  },
);

// ------------------------------------------------------------------ reading rooms
/**
 * @openapi
 * /reading-rooms:
 *   get: { tags: [Reading room], security: [], summary: Active reading rooms, responses: { 200: { description: Rooms } } }
 * /reading-rooms/{id}/availability:
 *   get: { tags: [Reading room], security: [], summary: Slots with remaining capacity, responses: { 200: { description: Slots } } }
 */
readingRoomRouter.get('/', async (req, res) =>
  res.json({ data: await models.ReadingRoom.findAll({ where: { isActive: true }, order: [['name', 'ASC']] }) }),
);
readingRoomRouter.get(
  '/:id/availability',
  validate({
    params: idParams,
    query: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  }),
  async (req, res) => {
    res.json({ data: await rooms.availability(req.params.id, req.query.from, req.query.to) });
  },
);
readingRoomRouter.use(authenticate, requirePermission('appointments.manage'));
readingRoomRouter.post(
  '/',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(200),
      location: optionalText(500),
      capacity: z.number().int().min(1).max(500),
      rules: optionalText(8000),
      openingHours: z.record(z.string(), z.string()).optional(),
      repositoryId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: await models.ReadingRoom.create(req.body) });
  },
);
readingRoomRouter.patch(
  '/:id',
  validate({
    params: idParams,
    body: z.object({
      name: z.string().max(200).optional(),
      location: optionalText(500),
      capacity: z.number().int().min(1).optional(),
      rules: optionalText(8000),
      isActive: z.boolean().optional(),
      openingHours: z.record(z.string(), z.string()).optional(),
    }),
  }),
  async (req, res) => {
    const room = await models.ReadingRoom.findByPk(req.params.id);
    if (!room) throw notFound('Reading room');
    res.json({ data: await room.update(req.body) });
  },
);
readingRoomRouter.post(
  '/:id/slots/generate',
  validate({
    params: idParams,
    body: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      times: z
        .array(z.string().regex(/^\d{2}:\d{2}$/))
        .min(1)
        .max(12),
      durationMinutes: z.number().int().min(15).max(600),
      capacity: z.number().int().min(1).max(500),
      skipWeekends: z.boolean().default(true),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ data: { created: await rooms.generateSlots(req.params.id, req.body) } });
  },
);
readingRoomRouter.post(
  '/:id/closures',
  validate({
    params: idParams,
    body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: optionalText(500) }),
  }),
  async (req, res) => {
    const [c] = await models.ReadingRoomClosure.findOrCreate({
      where: { readingRoomId: req.params.id, date: req.body.date },
      defaults: { readingRoomId: req.params.id, ...req.body },
    });
    await models.AppointmentSlot.update(
      { isActive: false },
      {
        where: {
          readingRoomId: req.params.id,
          startsAt: { [Op.between]: [new Date(`${req.body.date}T00:00:00Z`), new Date(`${req.body.date}T23:59:59Z`)] },
        },
      },
    );
    res.status(201).json({ data: c });
  },
);
readingRoomRouter.get(
  '/:id/schedule',
  validate({ params: idParams, query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) }),
  async (req, res) => {
    const slots = await models.AppointmentSlot.findAll({
      where: {
        readingRoomId: req.params.id,
        startsAt: { [Op.between]: [new Date(`${req.query.date}T00:00:00Z`), new Date(`${req.query.date}T23:59:59Z`)] },
      },
      include: [
        {
          model: models.ResearchAppointment,
          as: 'appointments',
          include: [{ model: models.ResearchRequest, as: 'request', attributes: ['id', 'requestNumber', 'status'] }],
        },
      ],
      order: [['startsAt', 'ASC']],
    });
    res.json({ data: slots });
  },
);

// ------------------------------------------------------------------ appointments
appointmentsRouter.use(authenticate);
appointmentsRouter.post(
  '/',
  validate({ body: z.object({ slotId: uuid, requestId: uuid, notes: optionalText(2000) }) }),
  async (req, res) => {
    res.status(201).json({ data: await rooms.book(req.body, req.user) });
  },
);
appointmentsRouter.get(
  '/',
  requirePermission('appointments.manage'),
  validate({
    query: paginationSchema.extend({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      status: z.string().max(100).optional(),
    }),
  }),
  async (req, res) => {
    const slotWhere = req.query.date
      ? {
          startsAt: {
            [Op.between]: [new Date(`${req.query.date}T00:00:00Z`), new Date(`${req.query.date}T23:59:59Z`)],
          },
        }
      : {};
    const where = req.query.status ? { status: req.query.status.split(',') } : {};
    paged(
      res,
      await models.ResearchAppointment.findAndCountAll({
        where,
        ...pageParams(req.query),
        include: [
          {
            model: models.AppointmentSlot,
            as: 'slot',
            where: slotWhere,
            include: [{ model: models.ReadingRoom, as: 'readingRoom', attributes: ['id', 'name'] }],
          },
          {
            model: models.ResearchRequest,
            as: 'request',
            attributes: ['id', 'requestNumber', 'status', 'requestType'],
          },
        ],
        order: [[{ model: models.AppointmentSlot, as: 'slot' }, 'startsAt', 'ASC']],
      }),
      req.query,
    );
  },
);
appointmentsRouter.post(
  '/:id/:action',
  validate({
    params: z.object({ id: uuid, action: z.enum(['cancel', 'check_in', 'complete', 'no_show']) }),
    body: z.object({ reason: optionalText(1000), identityMethod: optionalText(120) }),
  }),
  async (req, res) => {
    res.json({
      data: await rooms.changeAppointment(req.params.id, { action: req.params.action, ...req.body }, req.user),
    });
  },
);

// ------------------------------------------------------------------ researcher's own space
meRouter.use(authenticate);
meRouter.get('/research-list', async (req, res) => {
  res.json({
    data: await models.ResearchListItem.findAll({
      where: { userId: req.user.id },
      include: [
        {
          model: models.ArchivalRecord,
          as: 'record',
          attributes: ['id', 'title', 'referenceCode', 'dateExpression', 'publicVisibility'],
        },
      ],
      order: [['createdAt', 'DESC']],
    }),
  });
});
meRouter.post(
  '/research-list',
  validate({ body: z.object({ recordId: uuid, note: optionalText(1000) }) }),
  async (req, res) => {
    const rec = await models.ArchivalRecord.findByPk(req.body.recordId, { attributes: ['id', 'publicVisibility'] });
    if (!rec || (rec.publicVisibility === 'hidden' && !hasPerm(req.user, 'records.read')))
      throw notFound('Archival description');
    const [row] = await models.ResearchListItem.findOrCreate({
      where: { userId: req.user.id, recordId: rec.id },
      defaults: { userId: req.user.id, recordId: rec.id, note: req.body.note },
    });
    res.status(201).json({ data: row });
  },
);
meRouter.delete('/research-list/:id', validate({ params: idParams }), async (req, res) => {
  await models.ResearchListItem.destroy({ where: { id: req.params.id, userId: req.user.id } });
  res.status(204).end();
});
meRouter.get('/appointments', async (req, res) => {
  res.json({
    data: await models.ResearchAppointment.findAll({
      where: { researcherId: req.user.id },
      include: [
        {
          model: models.AppointmentSlot,
          as: 'slot',
          include: [{ model: models.ReadingRoom, as: 'readingRoom', attributes: ['id', 'name', 'location'] }],
        },
        { model: models.ResearchRequest, as: 'request', attributes: ['id', 'requestNumber'] },
      ],
      order: [['createdAt', 'DESC']],
    }),
  });
});
meRouter.post(
  '/feedback',
  validate({ body: z.object({ recordId: uuid, message: z.string().trim().min(5).max(4000) }) }),
  async (req, res) => {
    const rec = await models.ArchivalRecord.findByPk(req.body.recordId, { attributes: ['id', 'publicVisibility'] });
    if (!rec || rec.publicVisibility === 'hidden') throw notFound('Archival description');
    res.status(201).json({
      data: await models.CatalogueFeedback.create({
        recordId: rec.id,
        userId: req.user.id,
        contactEmail: req.user.email,
        message: req.body.message,
      }),
    });
  },
);
