/**
 * Reading-room circulation: issuing items to researchers, receiving them back, recording losses, flagging overdue
 * items and sending appointment reminders.
 *
 * The condition of an item is recorded when it is issued and when it is returned, together with a movement record.
 * Damage can therefore be traced to a specific visit, and an item damaged during a visit is referred to
 * conservation automatically.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, conflict, validationError } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { getSetting } from '../../services/settings.service.js';
import { notifyPermissionHolders, notifyEmailOnly } from '../../services/notification.service.js';
import { pathIds } from '../../services/accessPolicy.service.js';

/**
 * Issues a physical item for supervised consultation.
 *
 * Impossible situations are refused: the item must be available or reserved and not still out from an earlier
 * issue; the research request must be approved and must cover the item, directly or through its description or an
 * ancestor; if an appointment is given, the researcher must have been checked in for it; and the condition before
 * issue must be recorded. The expected return time defaults to the configured loan period.
 *
 * @param {{ physicalItemId: string, requestId: string, appointmentId?: string, conditionBefore: string,
 *   conditionBeforeNotes?: string, expectedReturnAt?: string }} input Issue details.
 * @param {object} user Reading-room officer issuing the item.
 * @returns {Promise<object>} The circulation transaction.
 * @throws {AppError} When any of the conditions above is not met.
 */
export async function issue(
  { physicalItemId, requestId, appointmentId, conditionBefore, conditionBeforeNotes, expectedReturnAt },
  user,
) {
  return sequelize.transaction(async (t) => {
    const item = await models.PhysicalItem.findByPk(physicalItemId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!item) throw notFound('Physical item');
    if (item.status !== 'available' && item.status !== 'reserved')
      throw conflict(`${item.barcode} cannot be issued: it is ${item.status.replace(/_/g, ' ')}`);
    const open = await models.CirculationTransaction.findOne({
      where: { physicalItemId, status: ['issued', 'overdue'] },
      transaction: t,
    });
    if (open) throw conflict(`${item.barcode} has not been returned from a previous issue`);
    const req = await models.ResearchRequest.findByPk(requestId, { transaction: t });
    if (!req || !['approved', 'scheduled', 'in_progress'].includes(req.status))
      throw badRequest('The request is not approved for consultation');
    const items = await models.ResearchRequestItem.findAll({
      where: { requestId, decision: 'approved' },
      transaction: t,
    });
    const itemRecord = item.recordId
      ? await models.ArchivalRecord.findByPk(item.recordId, { attributes: ['id', 'path'], transaction: t })
      : null;
    const covered = items.some(
      (ri) =>
        ri.physicalItemId === item.id ||
        (itemRecord && (ri.recordId === itemRecord.id || pathIds(itemRecord.path).includes(ri.recordId))),
    );
    if (!covered) throw badRequest('This item is not covered by the approved request');
    if (appointmentId) {
      const appt = await models.ResearchAppointment.findByPk(appointmentId, { transaction: t });
      if (!appt || appt.requestId !== requestId) throw badRequest('Appointment does not belong to this request');
      if (appt.status !== 'checked_in') throw badRequest('Check the researcher in before issuing items');
    }
    if (!conditionBefore)
      throw validationError([{ path: 'conditionBefore', message: 'Record the condition before issue' }]);
    const hours = await getSetting('research.defaultLoanHours');
    const tx = await models.CirculationTransaction.create(
      {
        physicalItemId,
        requestId,
        appointmentId,
        researcherId: req.requesterId,
        researcherName: req.contactName,
        status: 'issued',
        issuedById: user.id,
        issuedAt: new Date(),
        expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : new Date(Date.now() + hours * 3600_000),
        conditionBefore,
        conditionBeforeNotes,
      },
      { transaction: t },
    );
    await item.update({ status: 'issued' }, { transaction: t });
    await models.ConditionAssessment.create(
      {
        itemId: item.id,
        context: 'issue',
        rating: conditionBefore,
        notes: conditionBeforeNotes,
        assessedById: user.id,
        circulationId: tx.id,
      },
      { transaction: t },
    );
    await models.PhysicalItemMovement.create(
      {
        itemId: item.id,
        fromLocationId: item.currentLocationId,
        toLocationId: null,
        movementType: 'issue',
        reason: `Issued for request ${req.requestNumber}`,
        movedById: user.id,
        movedAt: new Date(),
        circulationId: tx.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'circulation.issue',
        resourceType: 'PhysicalItem',
        resourceId: item.id,
        after: { circulationId: tx.id, requestId, conditionBefore },
      },
      { transaction: t },
    );
    return tx;
  });
}

/**
 * Records the return of an issued item.
 *
 * The condition on return is required. If the item comes back in poor or critical condition that is worse than
 * recorded at issue, it is marked damaged, sent to conservation and preservation staff are notified; otherwise it
 * becomes available again. An item can be received only once.
 *
 * @param {string} id Identifier of the circulation transaction.
 * @param {{ conditionAfter: string, conditionAfterNotes?: string, incidentNotes?: string }} input Condition and any
 *   incident.
 * @param {object} user Reading-room officer receiving the item.
 * @returns {Promise<object>} The updated transaction.
 * @throws {AppError} 409 when the item is not currently issued, 422 when the condition is missing.
 */
export async function receive(id, { conditionAfter, conditionAfterNotes, incidentNotes }, user) {
  return sequelize.transaction(async (t) => {
    const tx = await models.CirculationTransaction.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!tx) throw notFound('Circulation record');
    if (!['issued', 'overdue'].includes(tx.status)) throw conflict('This item is not currently issued');
    if (!conditionAfter) throw validationError([{ path: 'conditionAfter', message: 'Record the condition on return' }]);
    const item = await models.PhysicalItem.findByPk(tx.physicalItemId, { transaction: t, lock: t.LOCK.UPDATE });
    const damaged = ['poor', 'critical'].includes(conditionAfter) && conditionAfter !== tx.conditionBefore;
    await tx.update(
      {
        status: damaged ? 'damaged' : 'returned',
        returnedAt: new Date(),
        receivedById: user.id,
        conditionAfter,
        conditionAfterNotes,
        incidentNotes,
      },
      { transaction: t },
    );
    await item.update(
      { status: damaged ? 'in_conservation' : 'available', conditionRating: conditionAfter },
      { transaction: t },
    );
    await models.ConditionAssessment.create(
      {
        itemId: item.id,
        context: 'return',
        rating: conditionAfter,
        notes: [conditionAfterNotes, incidentNotes].filter(Boolean).join('\n'),
        assessedById: user.id,
        circulationId: tx.id,
      },
      { transaction: t },
    );
    await models.PhysicalItemMovement.create(
      {
        itemId: item.id,
        fromLocationId: null,
        toLocationId: item.currentLocationId,
        movementType: 'return',
        reason: damaged ? 'Returned with damage; referred to conservation' : 'Returned from reading room',
        movedById: user.id,
        movedAt: new Date(),
        circulationId: tx.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'circulation.return',
        resourceType: 'PhysicalItem',
        resourceId: item.id,
        before: { conditionBefore: tx.conditionBefore },
        after: { conditionAfter, damaged },
        reason: incidentNotes,
      },
      { transaction: t },
    );
    if (damaged || incidentNotes)
      await notifyPermissionHolders(
        ['preservation.manage'],
        {
          eventType: 'circulation.overdue',
          title: `Incident recorded for ${item.barcode}`,
          body: incidentNotes || `Returned in ${conditionAfter} condition`,
          link: `/admin/storage/items/${item.id}`,
        },
        { transaction: t },
      );
    return tx;
  });
}

/**
 * Records an outstanding item as lost and marks the physical item as missing.
 *
 * @param {string} id Identifier of the circulation transaction.
 * @param {string} [notes] What is known about the loss.
 * @returns {Promise<object>} The updated transaction.
 * @throws {AppError} 409 when the item is not outstanding.
 */
export async function markLost(id, notes) {
  return sequelize.transaction(async (t) => {
    const tx = await models.CirculationTransaction.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!tx || !['issued', 'overdue'].includes(tx.status)) throw conflict('Only outstanding items can be marked lost');
    await tx.update({ status: 'lost', incidentNotes: notes }, { transaction: t });
    await models.PhysicalItem.update({ status: 'missing' }, { where: { id: tx.physicalItemId }, transaction: t });
    await audit(
      { action: 'circulation.lost', resourceType: 'PhysicalItem', resourceId: tx.physicalItemId, reason: notes },
      { transaction: t },
    );
    return tx;
  });
}

/**
 * Scheduled job: marks issued items past their expected return time as overdue, audits each one and notifies
 * reading-room staff. Running it again does not flag the same item twice.
 *
 * @returns {Promise<{ overdue: number }>} Number of items newly flagged.
 */
export async function flagOverdue() {
  const due = await models.CirculationTransaction.findAll({
    where: { status: 'issued', expectedReturnAt: { [Op.lt]: new Date() } },
    include: [{ model: models.PhysicalItem, as: 'physicalItem', attributes: ['barcode'] }],
  });
  for (const tx of due) {
    await tx.update({ status: 'overdue' });
    await audit({
      action: 'circulation.overdue',
      resourceType: 'PhysicalItem',
      resourceId: tx.physicalItemId,
      actorType: 'system',
    });
  }
  if (due.length)
    await notifyPermissionHolders(['circulation.return'], {
      eventType: 'circulation.overdue',
      title: `${due.length} item(s) overdue in the reading room`,
      body: due.map((d) => d.physicalItem?.barcode).join(', '),
      link: '/admin/circulation?status=overdue',
    });
  return { overdue: due.length };
}

/**
 * Scheduled job: emails researchers whose reading-room visit starts within the next 24 hours, once per appointment,
 * reminding them to bring photo identification.
 *
 * @returns {Promise<{ reminded: number }>} Number of appointments processed.
 */
export async function sendReminders() {
  const soon = await models.ResearchAppointment.findAll({
    where: { status: 'booked', reminderSentAt: null },
    include: [
      {
        model: models.AppointmentSlot,
        as: 'slot',
        where: { startsAt: { [Op.between]: [new Date(), new Date(Date.now() + 86400_000)] } },
        include: [{ model: models.ReadingRoom, as: 'readingRoom' }],
      },
    ],
  });
  for (const a of soon) {
    if (a.researcherEmail)
      await notifyEmailOnly(a.researcherEmail, {
        subject: 'Reminder: reading-room visit tomorrow',
        body: `Your visit to ${a.slot.readingRoom.name} is at ${a.slot.startsAt.toISOString().replace('T', ' ').slice(0, 16)} UTC. Bring photo identification.`,
      });
    await a.update({ reminderSentAt: new Date() });
  }
  return { reminded: soon.length };
}
