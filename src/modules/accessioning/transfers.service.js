/**
 * Business rules for transfer submissions from departments to the Archives.
 *
 * Covers who may see and edit a transfer, inventory validation, the transfer workflow with line-by-line decisions,
 * a snapshot of each submission, and conversion of an accepted transfer into an accession. Liaisons can act only
 * for their own organisation unit, and the person who submitted a transfer can never decide on it.
 *
 * @author Kwasi Adabo Boakye
 */

import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, validationError } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import {
  transition,
  assertTransition,
  assertSeparationOfDuties,
  availableActions,
} from '../../services/workflow.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { notifyPermissionHolders, notifyUsers } from '../../services/notification.service.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { normaliseDate } from '../../services/spreadsheet.service.js';

export const EDITABLE_STATES = ['draft', 'query_raised'];

/**
 * Tells whether a user may see a transfer: reviewers see every transfer, liaisons see only those from their own
 * organisation unit.
 *
 * @param {object} user Authenticated principal.
 * @param {{ originatingUnitId: string }} submission The transfer.
 * @returns {boolean}
 */
export function canSee(user, submission) {
  if (hasPerm(user, 'transfer.review')) return true;
  return hasPerm(user, 'transfer.submit') && submission.originatingUnitId === user.organisationUnitId;
}

/**
 * Loads a transfer that the user is allowed to see.
 *
 * A transfer from another unit is reported as not found rather than forbidden, so its existence is not revealed.
 *
 * @param {string} id Transfer identifier.
 * @param {object} user Authenticated principal.
 * @param {object} [opts={}] Sequelize options such as a transaction or a row lock.
 * @returns {Promise<object>} The transfer.
 * @throws {AppError} 404 when it does not exist or is not visible to the user.
 */
export async function loadVisible(id, user, opts = {}) {
  const s = await models.TransferSubmission.findByPk(id, opts);
  if (!s || !canSee(user, s)) throw notFound('Transfer submission');
  return s;
}

/**
 * Checks inventory lines before they are saved: every line needs a title; dates must be YYYY, YYYY-MM-DD or
 * DD/MM/YYYY with the end not before the start; quantities must be positive whole numbers; and source identifiers
 * must not repeat.
 *
 * @param {object[]} items Inventory lines in the order entered.
 * @returns {Array<{ line: number, field: string, message: string }>} One entry per problem; empty when the
 *   inventory is valid.
 */
export function validateInventory(items) {
  const errors = [];
  const seen = new Map();
  items.forEach((it, i) => {
    const line = it.lineNumber ?? i + 1;
    if (!it.title || !String(it.title).trim()) errors.push({ line, field: 'title', message: 'Title is required' });
    for (const f of ['dateStart', 'dateEnd']) {
      if (it[f] !== undefined && it[f] !== null && it[f] !== '' && normaliseDate(it[f]) === undefined)
        errors.push({ line, field: f, message: 'Use YYYY, YYYY-MM-DD or DD/MM/YYYY' });
    }
    const s = normaliseDate(it.dateStart);
    const e = normaliseDate(it.dateEnd);
    if (s && e && s > e) errors.push({ line, field: 'dateEnd', message: 'End date is before start date' });
    if (
      it.quantity !== undefined &&
      it.quantity !== null &&
      it.quantity !== '' &&
      !(Number.isInteger(Number(it.quantity)) && Number(it.quantity) > 0)
    )
      errors.push({ line, field: 'quantity', message: 'Quantity must be a positive whole number' });
    if (it.sourceIdentifier) {
      const key = String(it.sourceIdentifier).trim().toLowerCase();
      if (seen.has(key))
        errors.push({
          line,
          field: 'sourceIdentifier',
          message: `Duplicate identifier (also on line ${seen.get(key)})`,
        });
      else seen.set(key, line);
    }
  });
  return errors;
}

/**
 * Checks that a transfer is complete enough to submit: title, originating unit, contact name, transfer authority
 * and proposed date are present, there is at least one inventory line, and every line is valid.
 *
 * @param {object} s The transfer.
 * @param {object[]} items Its inventory lines.
 * @returns {Array<{ field: string, message: string }>} One entry per problem; empty when the transfer can be
 *   submitted.
 */
export function validateSubmission(s, items) {
  const errors = [];
  for (const f of ['title', 'originatingUnitId', 'contactName', 'transferAuthority', 'proposedTransferDate']) {
    if (!s[f]) errors.push({ field: f, message: 'Required before submission' });
  }
  if (!items.length) errors.push({ field: 'items', message: 'Add at least one inventory line' });
  return [
    ...errors,
    ...validateInventory(items).map((e) => ({ field: `items[${e.line}].${e.field}`, message: e.message })),
  ];
}

/**
 * Creates a draft transfer. Liaisons may only create transfers for their own organisation unit. Reviewers, usually
 * a Records Officer acting as the liaison for a department that has none, may prepare one for any unit; it is then
 * marked as submitted on behalf of that unit.
 *
 * @param {object} data Validated transfer details.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new transfer.
 * @throws {AppError} 403 when a liaison names another unit.
 */
export async function createSubmission(data, user) {
  if (!hasPerm(user, 'transfer.review') && data.originatingUnitId !== user.organisationUnitId)
    throw forbidden('You can only prepare transfers for your own unit');
  const submittedOnBehalf = data.originatingUnitId !== user.organisationUnitId;
  return sequelize.transaction(async (t) => {
    const s = await models.TransferSubmission.create(
      { ...data, status: 'draft', submittedById: user.id, submittedOnBehalf },
      { transaction: t },
    );
    await audit(
      {
        action: 'transfer.create',
        resourceType: 'TransferSubmission',
        resourceId: s.id,
        after: { ...data, submittedOnBehalf },
      },
      { transaction: t },
    );
    return s;
  });
}

/**
 * Updates the details of a transfer that is still a draft or has been returned with a query. The change is audited
 * with the previous and new values.
 *
 * @param {string} id Transfer identifier.
 * @param {object} data Fields to change.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated transfer.
 * @throws {AppError} 403 when the transfer can no longer be edited, or a liaison tries to move it to another unit.
 */
export async function updateSubmission(id, data, user) {
  return sequelize.transaction(async (t) => {
    const s = await loadVisible(id, user, { transaction: t, lock: t.LOCK.UPDATE });
    if (!EDITABLE_STATES.includes(s.status))
      throw forbidden('Only draft submissions or submissions returned with a query can be edited');
    if (
      data.originatingUnitId &&
      !hasPerm(user, 'transfer.review') &&
      data.originatingUnitId !== user.organisationUnitId
    )
      throw forbidden();
    const before = s.get({ plain: true });
    if (data.originatingUnitId && data.originatingUnitId !== s.originatingUnitId) {
      const preparer = await models.User.findByPk(s.submittedById, {
        attributes: ['organisationUnitId'],
        transaction: t,
      });
      data = { ...data, submittedOnBehalf: data.originatingUnitId !== preparer?.organisationUnitId };
    }
    await s.update(data, { transaction: t });
    const d = diff(before, s);
    await audit(
      {
        action: 'transfer.update',
        resourceType: 'TransferSubmission',
        resourceId: s.id,
        before: d.before,
        after: d.after,
      },
      { transaction: t },
    );
    return s;
  });
}

/**
 * Replaces the whole inventory of an editable transfer.
 *
 * Lines are validated first, renumbered in order, their dates normalised and any earlier decisions cleared.
 *
 * @param {string} id Transfer identifier.
 * @param {object[]} items The new inventory lines.
 * @param {object} user Authenticated principal.
 * @returns {Promise<number>} The number of lines saved.
 * @throws {AppError} 422 when a line is invalid, 403 when the transfer is not editable.
 */
export async function replaceItems(id, items, user) {
  const errors = validateInventory(items);
  if (errors.length)
    throw validationError(
      errors.map((e) => ({ path: `items[${e.line}].${e.field}`, message: e.message })),
      'Inventory has errors',
    );
  return sequelize.transaction(async (t) => {
    const s = await loadVisible(id, user, { transaction: t, lock: t.LOCK.UPDATE });
    if (!EDITABLE_STATES.includes(s.status))
      throw forbidden('The inventory can only be changed while the submission is a draft or under query');
    await models.TransferInventoryItem.destroy({ where: { submissionId: id }, transaction: t });
    const rows = items.map((it, i) => ({
      ...it,
      submissionId: id,
      lineNumber: i + 1,
      dateStart: normaliseDate(it.dateStart) ?? null,
      dateEnd: normaliseDate(it.dateEnd) ?? null,
      quantity: it.quantity ? Number(it.quantity) : 1,
      decision: 'pending',
      decisionNote: null,
    }));
    await models.TransferInventoryItem.bulkCreate(rows, { transaction: t });
    await audit(
      {
        action: 'transfer.inventory_replaced',
        resourceType: 'TransferSubmission',
        resourceId: id,
        metadata: { lines: rows.length },
      },
      { transaction: t },
    );
    return rows.length;
  });
}

/**
 * Saves a copy of the transfer and its inventory as the next revision, so later edits can be compared with what was
 * submitted.
 *
 * @param {object} s The transfer; its revision number is advanced.
 * @param {object[]} items Its inventory lines.
 * @param {{ id: string }} user Person submitting.
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<void>}
 */
async function snapshotRevision(s, items, user, t) {
  const revision = s.revision + 1;
  await models.TransferSubmissionRevision.create(
    {
      submissionId: s.id,
      revision,
      snapshot: { submission: s.get({ plain: true }), items: items.map((i) => i.get({ plain: true })) },
      createdById: user.id,
    },
    { transaction: t },
  );
  s.revision = revision;
}

/**
 * Performs a workflow action on a transfer.
 *
 * - Submit and resubmit require a complete, valid transfer; a reference number is allocated on first submission and
 *   a revision snapshot is saved.
 * - Review actions require "transfer.review", and the person who submitted the transfer may not decide on it.
 * - Raising a query and rejecting require a reason, which is also posted to the discussion.
 * - Acceptance needs a decision for every inventory line; partial acceptance needs at least one accepted and one
 *   rejected line.
 *
 * Reviewers are notified of submissions, and the submitter is notified of every decision.
 *
 * @param {string} id Transfer identifier.
 * @param {{ action: string, reason?: string, itemDecisions?: Array<{ itemId: string, decision: string, note?:
 *   string }> }} input The action, an explanation and per-line decisions.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated transfer.
 * @throws {AppError} When the action is not allowed, not permitted or the input is incomplete.
 */
export async function transitionSubmission(id, { action, reason, itemDecisions }, user) {
  const reviewerActions = ['start_review', 'raise_query', 'accept', 'partially_accept', 'reject'];
  if (reviewerActions.includes(action) && !hasPerm(user, 'transfer.review')) throw forbidden();
  return sequelize.transaction(async (t) => {
    const s = await loadVisible(id, user, { transaction: t, lock: t.LOCK.UPDATE });
    assertTransition('transfer', s.status, action);
    const items = await models.TransferInventoryItem.findAll({
      where: { submissionId: id },
      order: [['lineNumber', 'ASC']],
      transaction: t,
    });

    if (['submit', 'resubmit'].includes(action)) {
      const errors = validateSubmission(s, items);
      if (errors.length)
        throw validationError(
          errors.map((e) => ({ path: e.field, message: e.message })),
          'Fix the highlighted problems before submitting',
        );
    }
    if (reviewerActions.includes(action) && action !== 'start_review') {
      await assertSeparationOfDuties(user.id, [s.submittedById], 'You cannot decide on a transfer you submitted');
    }
    if (['raise_query', 'reject'].includes(action) && !reason)
      throw validationError([{ path: 'reason', message: 'Explain the query or rejection' }]);
    if (['accept', 'partially_accept'].includes(action)) {
      const decisions = new Map((itemDecisions || []).map((d) => [d.itemId, d]));
      for (const it of items) {
        const d = decisions.get(it.id);
        it.decision = action === 'accept' ? 'accepted' : d?.decision;
        it.decisionNote = d?.note ?? null;
        if (!['accepted', 'rejected'].includes(it.decision))
          throw validationError([
            { path: `items[${it.lineNumber}]`, message: 'Accept or reject every inventory line' },
          ]);
      }
      const accepted = items.filter((i) => i.decision === 'accepted').length;
      if (action === 'partially_accept' && (accepted === 0 || accepted === items.length))
        throw badRequest('Partial acceptance needs at least one accepted and one rejected line');
      for (const it of items) await it.save({ transaction: t });
    }
    if (action === 'reject') for (const it of items) await it.update({ decision: 'rejected' }, { transaction: t });

    await transition('transfer', s, action, {
      actor: user,
      reason,
      transaction: t,
      metadata: itemDecisions ? { itemDecisions } : undefined,
      apply: async (r) => {
        if (action === 'submit') {
          r.referenceNumber = r.referenceNumber || (await generateReference('transfer', t));
          r.submittedAt = new Date();
          r.submittedById = r.submittedById || user.id;
        }
        if (action === 'start_review') r.reviewerId = user.id;
        if (['accept', 'partially_accept', 'reject'].includes(action))
          Object.assign(r, { decisionById: user.id, decisionAt: new Date(), decisionNote: reason ?? null });
        if (['submit', 'resubmit'].includes(action)) await snapshotRevision(r, items, user, t);
      },
    });
    if (['raise_query', 'reject', 'accept', 'partially_accept'].includes(action) && reason) {
      await models.Comment.create(
        { entityType: 'TransferSubmission', entityId: s.id, authorId: user.id, body: reason, visibility: 'shared' },
        { transaction: t },
      );
    }
    const link = `/admin/transfers/${s.id}`;
    if (['submit', 'resubmit'].includes(action)) {
      await notifyPermissionHolders(
        ['transfer.review'],
        {
          eventType: 'transfer.submitted',
          title: `Transfer ${action === 'submit' ? 'submitted' : 'resubmitted'}: ${s.referenceNumber}`,
          body: s.title,
          link,
          entityType: 'TransferSubmission',
          entityId: s.id,
        },
        { transaction: t },
      );
    } else if (action !== 'start_review') {
      await notifyUsers(
        [s.submittedById],
        {
          eventType: action === 'raise_query' ? 'transfer.query' : 'transfer.decision',
          title: `Transfer ${s.referenceNumber}: ${action.replace(/_/g, ' ')}`,
          body: reason || '',
          link,
          entityType: 'TransferSubmission',
          entityId: s.id,
        },
        { transaction: t },
      );
    }
    return s;
  });
}

/**
 * Creates a draft accession from an accepted or partially accepted transfer.
 *
 * Only accepted lines are copied as received items, with the department's box numbers, and the transfer's details (source unit, contact, authority,
 * dates and extent) are carried across. Calling it again returns the accession already created instead of making a
 * second one.
 *
 * @param {string} id Transfer identifier.
 * @param {object} user Authenticated principal; becomes the responsible officer.
 * @returns {Promise<{ accession: object, created: boolean }>}
 * @throws {AppError} When the transfer does not exist or has not been accepted.
 */
export async function createAccessionFromSubmission(id, user) {
  return sequelize.transaction(async (t) => {
    const s = await models.TransferSubmission.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw notFound('Transfer submission');
    if (!['accepted', 'partially_accepted'].includes(s.status))
      throw badRequest('Only accepted transfers can be accessioned');
    if (s.accessionId)
      return { accession: await models.Accession.findByPk(s.accessionId, { transaction: t }), created: false };
    const repo = await models.Repository.findOne({
      where: { isActive: true },
      order: [['createdAt', 'ASC']],
      transaction: t,
    });
    const items = await models.TransferInventoryItem.findAll({
      where: { submissionId: id, decision: 'accepted' },
      order: [['lineNumber', 'ASC']],
      transaction: t,
    });
    const accession = await models.Accession.create(
      {
        accessionNumber: await generateReference('accession', t),
        title: s.title,
        repositoryId: repo.id,
        transferSubmissionId: s.id,
        accessionDate: new Date().toISOString().slice(0, 10),
        transferDate: s.proposedTransferDate,
        sourceType: 'department',
        sourceUnitId: s.originatingUnitId,
        contactPerson: s.contactName,
        contactEmail: s.contactEmail,
        transferAuthority: s.transferAuthority,
        extent: s.totalExtent,
        confidentialityConcerns: s.confidentialityNotes,
        quantity: items.reduce((n, i) => n + (i.quantity || 1), 0),
        formats: [...new Set(items.map((i) => i.format).filter(Boolean))],
        status: 'draft',
        responsibleOfficerId: user.id,
        createdById: user.id,
        updatedById: user.id,
      },
      { transaction: t },
    );
    await models.AccessionItem.bulkCreate(
      items.map((i, n) => ({
        accessionId: accession.id,
        inventoryItemId: i.id,
        lineNumber: n + 1,
        description: i.title,
        format: i.format,
        quantity: i.quantity,
        extent: i.extent,
        condition: i.condition,
        boxNumber: i.boxNumber,
        status: 'pending',
      })),
      { transaction: t },
    );
    await s.update({ accessionId: accession.id }, { transaction: t });
    await audit(
      {
        action: 'accession.create_from_transfer',
        resourceType: 'Accession',
        resourceId: accession.id,
        after: { accessionNumber: accession.accessionNumber, transferSubmissionId: s.id, lines: items.length },
      },
      { transaction: t },
    );
    return { accession, created: true };
  });
}

/**
 * Lists the workflow actions this user may take on a transfer now. Submitting, resubmitting and cancelling are open
 * to the transfer's own unit; every other action is for reviewers only. A reviewer who prepared the transfer on a
 * department's behalf is not offered the review actions, because separation of duties leaves the decision to
 * another reviewer.
 *
 * @param {object} s The transfer.
 * @param {object} user Authenticated principal.
 * @param {boolean} [separationOfDuties=true] Whether the separation-of-duties setting is on.
 * @returns {string[]} The available action names.
 */
export function actionsFor(s, user, separationOfDuties = true) {
  const reviewer = hasPerm(user, 'transfer.review');
  const own = s.submittedById === user.id || s.originatingUnitId === user.organisationUnitId;
  const preparer = separationOfDuties && s.submittedById === user.id;
  return availableActions('transfer', s.status).filter((a) =>
    ['submit', 'resubmit', 'cancel'].includes(a) ? own || reviewer : reviewer && !preparer,
  );
}
