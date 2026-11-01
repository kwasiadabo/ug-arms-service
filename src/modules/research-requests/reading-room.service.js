/**
 * Reading-room scheduling: appointment slots, availability, bookings and the visit itself (check-in, completion,
 * cancellation and no-shows). Capacity is checked under a database lock so a slot can never be overbooked, and
 * identity must be verified at check-in before any item can be issued.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, conflict } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { transition } from '../../services/workflow.service.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { notifyUsers, notifyEmailOnly } from '../../services/notification.service.js';

const ACTIVE = ['booked', 'checked_in'];

/**
 * Creates appointment slots for a date range from a list of daily start times, skipping closure days and, by
 * default, weekends. Existing slots are not duplicated, slot capacity never exceeds the room's capacity, and at
 * most one year can be generated at a time.
 *
 * @param {string} roomId Identifier of the reading room.
 * @param {{ from: string, to: string, times: string[], durationMinutes: number, capacity: number, skipWeekends?:
 *   boolean }} input Dates (YYYY-MM-DD), start times (HH:MM, UTC), length and capacity.
 * @returns {Promise<number>} Number of slots created.
 * @throws {AppError} When the room does not exist or the range is too long.
 */
export async function generateSlots(roomId, { from, to, times, durationMinutes, capacity, skipWeekends = true }) {
  const room = await models.ReadingRoom.findByPk(roomId);
  if (!room) throw notFound('Reading room');
  const closures = new Set(
    (
      await models.ReadingRoomClosure.findAll({ where: { readingRoomId: roomId, date: { [Op.between]: [from, to] } } })
    ).map((c) => c.date),
  );
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if ((end - start) / 86400_000 > 366) throw badRequest('Generate at most one year of slots at a time');
  let created = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (closures.has(day) || (skipWeekends && [0, 6].includes(d.getUTCDay()))) continue;
    for (const time of times) {
      const startsAt = new Date(`${day}T${time}:00Z`);
      const [, isNew] = await models.AppointmentSlot.findOrCreate({
        where: { readingRoomId: roomId, startsAt },
        defaults: {
          readingRoomId: roomId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
          capacity: Math.min(capacity, room.capacity),
        },
      });
      if (isNew) created += 1;
    }
  }
  await audit({
    action: 'reading_room.slots_generated',
    resourceType: 'ReadingRoom',
    resourceId: roomId,
    metadata: { from, to, created },
  });
  return created;
}

/**
 * Lists a room's active slots in a date range with the number booked and places left, plus its closure days.
 *
 * @param {string} roomId Identifier of the reading room.
 * @param {string} from First date (YYYY-MM-DD).
 * @param {string} to Last date (YYYY-MM-DD).
 * @returns {Promise<{ slots: object[], closures: object[] }>}
 */
export async function availability(roomId, from, to) {
  const slots = await models.AppointmentSlot.findAll({
    where: {
      readingRoomId: roomId,
      isActive: true,
      startsAt: { [Op.between]: [new Date(from), new Date(`${to}T23:59:59Z`)] },
    },
    order: [['startsAt', 'ASC']],
  });
  const counts = slots.length
    ? await models.ResearchAppointment.count({
        where: { slotId: slots.map((s) => s.id), status: ACTIVE },
        group: ['slotId'],
      })
    : [];
  const used = Object.fromEntries(counts.map((c) => [c.slotId, c.count]));
  const closures = await models.ReadingRoomClosure.findAll({
    where: { readingRoomId: roomId, date: { [Op.between]: [from, to] } },
  });
  return {
    slots: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      capacity: s.capacity,
      booked: used[s.id] || 0,
      available: Math.max(0, s.capacity - (used[s.id] || 0)),
    })),
    closures,
  };
}

/**
 * Books a slot for an approved request.
 *
 * The slot must be active, in the future and not on a closure day. The request must be approved or scheduled, and
 * visible to the user (staff, or the requester). It may have only one active appointment, and the slot must still
 * have room; the slot is locked while this is checked. The request becomes scheduled and the researcher is told of
 * the booking.
 *
 * @param {{ slotId: string, requestId: string, notes?: string }} input The booking.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The appointment.
 * @throws {AppError} When any condition is not met.
 */
export async function book({ slotId, requestId, notes }, user) {
  return sequelize.transaction(async (t) => {
    const slot = await models.AppointmentSlot.findByPk(slotId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.ReadingRoom, as: 'readingRoom' }],
    });
    if (!slot || !slot.isActive) throw notFound('Slot');
    if (slot.startsAt < new Date()) throw badRequest('This slot is in the past');
    const closed = await models.ReadingRoomClosure.findOne({
      where: { readingRoomId: slot.readingRoomId, date: slot.startsAt.toISOString().slice(0, 10) },
      transaction: t,
    });
    if (closed) throw badRequest(`The reading room is closed on this day: ${closed.reason || 'closure'}`);
    const req = await models.ResearchRequest.findByPk(requestId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!req) throw notFound('Research request');
    const staff = hasPerm(user, 'appointments.manage');
    if (!staff && req.requesterId !== user.id) throw notFound('Research request');
    if (!['approved', 'scheduled'].includes(req.status)) throw badRequest('Only approved requests can be scheduled');
    if (await models.ResearchAppointment.findOne({ where: { requestId, status: ACTIVE }, transaction: t }))
      throw conflict('This request already has an active appointment. Cancel or reschedule it.');
    const booked = await models.ResearchAppointment.count({ where: { slotId, status: ACTIVE }, transaction: t });
    if (booked >= slot.capacity) throw conflict('This slot is fully booked');
    const appt = await models.ResearchAppointment.create(
      {
        slotId,
        requestId,
        researcherId: req.requesterId,
        researcherName: req.contactName,
        researcherEmail: req.contactEmail,
        status: 'booked',
        notes,
      },
      { transaction: t },
    );
    if (req.status === 'approved')
      await transition('research_request', req, 'schedule', { actor: user, transaction: t });
    await audit(
      {
        action: 'appointment.booked',
        resourceType: 'ResearchAppointment',
        resourceId: appt.id,
        after: { slotId, requestId },
      },
      { transaction: t },
    );
    const when = slot.startsAt.toISOString().replace('T', ' ').slice(0, 16);
    if (req.requesterId)
      await notifyUsers(
        [req.requesterId],
        {
          eventType: 'appointment.confirmed',
          title: `Reading-room visit confirmed: ${when} UTC`,
          body: `${slot.readingRoom.name}. ${slot.readingRoom.rules || 'Bring photo identification.'}`,
          link: `/my/requests/${req.id}`,
        },
        { transaction: t },
      );
    else
      await notifyEmailOnly(
        req.contactEmail,
        {
          subject: `Reading-room visit confirmed: ${when} UTC`,
          body: `${slot.readingRoom.name}. Bring photo identification.`,
        },
        { transaction: t },
      );
    return appt;
  });
}

/**
 * Changes the status of an appointment.
 *
 * - Cancel is allowed for the researcher or staff while the appointment is only booked; the request returns to
 *   approved.
 * - Check in (staff) requires how identity was verified and starts fulfilment of the request.
 * - Complete (staff) ends the visit; items still out are not returned automatically, and this is audited.
 * - No-show (staff) is allowed while the appointment is only booked.
 *
 * @param {string} id Identifier of the appointment.
 * @param {{ action: 'cancel'|'check_in'|'complete'|'no_show', reason?: string, identityMethod?: string }} input The
 *   action and its details.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated appointment.
 * @throws {AppError} When the action is not allowed.
 */
export async function changeAppointment(id, { action, reason, identityMethod }, user) {
  return sequelize.transaction(async (t) => {
    const appt = await models.ResearchAppointment.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [
        { model: models.ResearchRequest, as: 'request' },
        { model: models.AppointmentSlot, as: 'slot' },
      ],
    });
    if (!appt) throw notFound('Appointment');
    const staff = hasPerm(user, 'appointments.manage');
    if (!staff && appt.researcherId !== user.id) throw notFound('Appointment');
    if (action !== 'cancel' && !staff) throw forbidden();
    const before = appt.status;
    if (action === 'cancel') {
      if (appt.status !== 'booked') throw badRequest('Only booked appointments can be cancelled');
      await appt.update(
        { status: 'cancelled', cancelledAt: new Date(), cancellationReason: reason },
        { transaction: t },
      );
      if (appt.request?.status === 'scheduled') {
        appt.request.status = 'approved';
        await appt.request.save({ transaction: t });
      }
    } else if (action === 'check_in') {
      if (appt.status !== 'booked') throw badRequest('Only booked appointments can be checked in');
      if (!identityMethod) throw badRequest('Record how identity was verified');
      await appt.update(
        {
          status: 'checked_in',
          checkedInAt: new Date(),
          checkedInById: user.id,
          identityVerified: true,
          identityMethod,
        },
        { transaction: t },
      );
      if (appt.request && ['scheduled', 'approved'].includes(appt.request.status))
        await transition('research_request', appt.request, 'start_fulfilment', { actor: user, transaction: t });
    } else if (action === 'complete') {
      if (appt.status !== 'checked_in') throw badRequest('Only checked-in appointments can be completed');
      // Ending the visit does not return items: open issues stay outstanding until returned.
      const open = await models.CirculationTransaction.count({
        where: { appointmentId: appt.id, status: ['issued', 'overdue'] },
        transaction: t,
      });
      await appt.update({ status: 'completed' }, { transaction: t });
      if (open)
        await audit(
          {
            action: 'appointment.completed_with_outstanding_items',
            resourceType: 'ResearchAppointment',
            resourceId: appt.id,
            metadata: { outstanding: open },
          },
          { transaction: t },
        );
    } else if (action === 'no_show') {
      if (appt.status !== 'booked') throw badRequest('Only booked appointments can be marked as no-show');
      await appt.update({ status: 'no_show' }, { transaction: t });
    }
    await audit(
      {
        action: `appointment.${action}`,
        resourceType: 'ResearchAppointment',
        resourceId: appt.id,
        before: { status: before },
        after: { status: appt.status },
        reason,
      },
      { transaction: t },
    );
    return appt;
  });
}
