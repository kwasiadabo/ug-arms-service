/**
 * Business rules for accessions: creation, editing, the approval workflow, quarantine, links to the catalogue and
 * the custody receipt.
 *
 * Information an approver needs but that is missing is flagged and stored with the accession rather than silently
 * ignored. The person who created or submitted an accession can never approve, query or reject it.
 *
 * @author Kwasi Adabo Boakye
 */

import PDFDocument from 'pdfkit';
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
import { getSetting } from '../../services/settings.service.js';
import { createRecord } from '../records/records.service.js';
import { BRAND, stampCrest } from '../../services/branding.js';

export const EDITABLE = ['draft', 'queried'];

// Permission required for each accession workflow action.
const ACTION_PERMISSION = {
  submit: 'accession.create',
  start_review: 'accession.approve',
  query: 'accession.approve',
  approve: 'accession.approve',
  reject: 'accession.approve',
  close: 'accession.approve',
  recall: 'accession.create',
};

/**
 * Tells whether an accession may be taken back to draft by an officer: any time before the review starts, and during
 * a review only while required information is missing, because approval is blocked until it is completed.
 *
 * @param {object} a The accession.
 * @param {number} missingCount Number of missing pieces of information.
 * @returns {boolean}
 */
const canRecall = (a, missingCount) => a.status === 'submitted' || (a.status === 'under_review' && missingCount > 0);

/**
 * Lists the information an approver needs that is not yet recorded: accession date, source, transfer authority or
 * legal basis, extent or quantity, physical condition, provenance, rights statement and at least one item.
 *
 * @param {object} a The accession.
 * @param {object[]} items Its received items.
 * @returns {string[]} Names of the missing pieces of information.
 */
export function computeMissing(a, items) {
  const missing = [];
  if (!a.accessionDate) missing.push('accessionDate');
  if (!a.sourceUnitId && !a.donorName) missing.push('source');
  if (!a.transferAuthority && !a.legalBasis) missing.push('transferAuthorityOrLegalBasis');
  if (!a.extent && !a.quantity) missing.push('extentOrQuantity');
  if (!a.physicalCondition) missing.push('physicalCondition');
  if (!a.provenance && !a.custodialHistory) missing.push('provenance');
  if (!a.rightsStatement) missing.push('rightsStatement');
  if (!items.length) missing.push('items');
  return missing;
}

/**
 * Explains each piece of missing information: what it is, where it was expected to come from, a hint for filling it
 * in and the accession fields (or the items list) that fix it.
 *
 * An accession created from a transfer copies the originating unit, contact, transfer authority, estimated extent and
 * item quantities. The transfer form does not ask for physical condition, provenance or rights, so those are always
 * missing until an archivist records them, through nobody's mistake.
 *
 * @param {object} a The accession.
 * @param {object[]} items Its received items.
 * @returns {Array<{ key: string, label: string, origin: string, hint: string, fix: { kind: 'fields', fields:
 *   string[] } | { kind: 'items' } }>} One entry per missing piece, in the order of `computeMissing`.
 */
export function describeMissing(a, items) {
  const fromTransfer = Boolean(a.transferSubmissionId);
  const notOnTransfer = 'Not asked for on the transfer form, so it is never carried over from the department.';
  const notRecorded = 'Not recorded yet on this accession.';
  const conditions = [...new Set(items.map((i) => i.condition?.trim()).filter(Boolean))];
  const withCondition = items.filter((i) => i.condition?.trim()).length;
  const details = {
    accessionDate: {
      label: 'Accession date',
      origin: notRecorded,
      hint: 'The date the Archives took custody of the material.',
      fix: { kind: 'fields', fields: ['accessionDate'] },
    },
    source: {
      label: 'Source',
      origin: 'No originating unit or donor is recorded.',
      hint: 'Name the donor or depositor who gave the material.',
      fix: { kind: 'fields', fields: ['donorName'] },
    },
    transferAuthorityOrLegalBasis: {
      label: 'Transfer authority or legal basis',
      origin: fromTransfer ? 'The transfer was accepted without a transfer authority.' : notRecorded,
      hint: 'The memo, decision, retention schedule or deposit agreement that allows the Archives to hold it.',
      fix: { kind: 'fields', fields: ['transferAuthority', 'legalBasis'] },
    },
    extentOrQuantity: {
      label: 'Extent or quantity',
      origin: fromTransfer ? 'The transfer gave no estimated extent.' : notRecorded,
      hint: 'How much material was received, for example 0.5 linear metres or 12 boxes.',
      fix: { kind: 'fields', fields: ['extent', 'quantity'] },
    },
    physicalCondition: {
      label: 'Physical condition',
      origin: fromTransfer
        ? `${notOnTransfer}${
            withCondition
              ? ` ${withCondition} received item${withCondition === 1 ? '' : 's'} carry the department's condition notes: ${conditions.slice(0, 4).join('; ')}.`
              : ''
          }`
        : notRecorded,
      hint: 'Record the overall state after inspecting the material: damage, mould, pests, fragile items.',
      fix: { kind: 'fields', fields: ['physicalCondition'] },
    },
    provenance: {
      label: 'Provenance',
      origin: fromTransfer ? notOnTransfer : notRecorded,
      hint: fromTransfer
        ? 'Who created and kept the records before they came to the Archives. The originating unit and the reason given on the transfer are a starting point.'
        : 'Who created and kept the material before it came to the Archives.',
      fix: { kind: 'fields', fields: ['provenance', 'custodialHistory'] },
    },
    rightsStatement: {
      label: 'Rights statement',
      origin: fromTransfer ? notOnTransfer : notRecorded,
      hint: 'Who holds copyright and what copying is allowed. Confirm against the University’s rights policy.',
      fix: { kind: 'fields', fields: ['rightsStatement'] },
    },
    items: {
      label: 'Received items',
      origin: fromTransfer ? 'No transfer lines were accepted into this accession.' : 'No items are listed yet.',
      hint: 'List what was received, one item per file, volume or box.',
      fix: { kind: 'items' },
    },
  };
  return computeMissing(a, items).map((key) => ({ key, ...details[key] }));
}

/**
 * Creates a draft accession with a newly allocated accession number. The repository defaults to the first active
 * repository and the responsible officer to the creator.
 *
 * @param {object} data Validated accession details.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new accession.
 */
export async function createAccession(data, user) {
  return sequelize.transaction(async (t) => {
    const repositoryId =
      data.repositoryId ??
      (await models.Repository.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']], transaction: t }))
        ?.id;
    const a = await models.Accession.create(
      {
        ...data,
        repositoryId,
        accessionNumber: await generateReference('accession', t),
        status: 'draft',
        responsibleOfficerId: data.responsibleOfficerId ?? user.id,
        createdById: user.id,
        updatedById: user.id,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'accession.create',
        resourceType: 'Accession',
        resourceId: a.id,
        after: { accessionNumber: a.accessionNumber, title: a.title },
      },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Updates a draft or queried accession.
 *
 * If the client sends the version it last loaded and someone else has saved the accession since, the update is
 * refused so neither person's changes are lost. The change is audited with the previous and new values.
 *
 * @param {string} id Accession identifier.
 * @param {object} data Fields to change, optionally including `version`.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated accession.
 * @throws {AppError} 404, 403 when it cannot be edited, or 400 when the version is out of date.
 */
export async function updateAccession(id, data, user) {
  return sequelize.transaction(async (t) => {
    const a = await models.Accession.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound('Accession');
    if (!EDITABLE.includes(a.status)) throw forbidden('Only draft or queried accessions can be edited');
    const { version, ...changes } = data;
    if (version !== undefined && version !== a.version)
      throw badRequest('This accession was changed by someone else. Reload and try again.');
    const before = a.get({ plain: true });
    await a.update({ ...changes, updatedById: user.id }, { transaction: t });
    const d = diff(before, a);
    await audit(
      { action: 'accession.update', resourceType: 'Accession', resourceId: a.id, before: d.before, after: d.after },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Saves the list of received items of an accession.
 *
 * Existing items are updated, new ones are created and items no longer listed are deleted, unless they are already
 * linked to a description or a physical item. Items can be changed while the accession is a draft, queried or under
 * review.
 *
 * @param {string} id Accession identifier.
 * @param {object[]} items The items in order; existing items carry their `id`.
 * @returns {Promise<void>}
 */
export async function replaceItems(id, items) {
  return sequelize.transaction(async (t) => {
    const a = await models.Accession.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound('Accession');
    if (!EDITABLE.includes(a.status) && a.status !== 'under_review')
      throw forbidden('Items cannot be changed at this stage');
    const existing = await models.AccessionItem.findAll({ where: { accessionId: id }, transaction: t });
    const keep = new Set(items.filter((i) => i.id).map((i) => i.id));
    for (const e of existing)
      if (!keep.has(e.id) && !e.recordId && !e.physicalItemId) await e.destroy({ transaction: t });
    for (const [n, it] of items.entries()) {
      const row = { ...it, accessionId: id, lineNumber: n + 1 };
      if (it.id) await models.AccessionItem.update(row, { where: { id: it.id, accessionId: id }, transaction: t });
      else await models.AccessionItem.create(row, { transaction: t });
    }
    await audit(
      {
        action: 'accession.items_updated',
        resourceType: 'Accession',
        resourceId: id,
        metadata: { lines: items.length },
      },
      { transaction: t },
    );
  });
}

/**
 * Performs a workflow action on an accession.
 *
 * - Submitting and approving are refused while required information is missing (`computeMissing`), unless the
 *   "workflow.requireCompleteAccessions" setting is off; the refusal lists each missing piece and where it comes
 *   from. With the setting off, submitting records what is missing for the approver. At least one item is always
 *   required.
 * - Approving, querying and rejecting are refused to the person who created or submitted the accession; querying
 *   and rejecting require a reason.
 * - Recalling takes a submitted accession back to draft so the officer can complete it: before the review starts,
 *   or during a review while information is missing. Approvers are notified.
 * - Approval is refused while the accession is in quarantine, requires a decision for every item (pending items are
 *   accepted by default) and at least one accepted item.
 *
 * Each decision is stored as an approval record. Approvers are notified of submissions, and the submitter and
 * responsible officer are notified of decisions.
 *
 * @param {string} id Accession identifier.
 * @param {{ action: string, reason?: string, itemDecisions?: Array<{ itemId: string, decision: string }> }} input
 *   The action, an explanation and per-item decisions.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated accession.
 * @throws {AppError} When the action is not permitted, not allowed from the current state, or the input is
 *   incomplete.
 */
export async function transitionAccession(id, { action, reason, itemDecisions }, user) {
  if (!hasPerm(user, ACTION_PERMISSION[action])) throw forbidden();
  return sequelize.transaction(async (t) => {
    const a = await models.Accession.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound('Accession');
    assertTransition('accession', a.status, action);
    const items = await models.AccessionItem.findAll({ where: { accessionId: id }, transaction: t });
    const missing = computeMissing(a, items);

    if (action === 'submit') {
      a.missingInformation = missing;
      if (!items.length) throw validationError([{ path: 'items', message: 'Add at least one item before submitting' }]);
    }
    if (
      ['submit', 'approve'].includes(action) &&
      missing.length &&
      (await getSetting('workflow.requireCompleteAccessions'))
    )
      throw validationError(
        describeMissing(a, items).map((m) => ({ path: m.key, message: `${m.label}: ${m.origin} ${m.hint}` })),
        action === 'submit'
          ? 'Complete the missing information before submitting'
          : 'This accession is missing required information. Query it back to the officer, or complete it, before approval',
      );
    if (action === 'recall' && !canRecall(a, missing.length))
      throw badRequest('The review has started and nothing is missing; ask the approver to query it back instead');
    if (['approve', 'reject', 'query'].includes(action)) {
      await assertSeparationOfDuties(
        user.id,
        [a.submittedById, a.createdById],
        'You cannot decide on an accession you created or submitted',
      );
    }
    if (['query', 'reject'].includes(action) && !reason)
      throw validationError([{ path: 'reason', message: 'A reason is required' }]);
    if (action === 'approve') {
      if (a.isQuarantined) throw badRequest('Release the accession from quarantine before approval');
      const decisions = new Map((itemDecisions || []).map((d) => [d.itemId, d.decision]));
      for (const it of items) {
        const decision = decisions.get(it.id) ?? (it.status === 'pending' ? 'accepted' : it.status);
        if (!['accepted', 'rejected'].includes(decision))
          throw validationError([{ path: `items[${it.lineNumber}]`, message: 'Decide every item' }]);
        await it.update({ status: decision }, { transaction: t });
      }
      if (!items.some((i) => i.status === 'accepted'))
        throw badRequest('At least one item must be accepted. Reject the accession instead.');
    }
    await transition('accession', a, action, {
      actor: user,
      reason,
      transaction: t,
      metadata: { missingInformation: missing },
      apply: (r) => {
        r.updatedById = user.id;
        if (action === 'submit') Object.assign(r, { submittedById: user.id, submittedAt: new Date() });
        if (['approve', 'reject'].includes(action))
          Object.assign(r, {
            approvedById: action === 'approve' ? user.id : null,
            approvedAt: action === 'approve' ? new Date() : null,
            decisionNote: reason ?? null,
          });
      },
    });
    if (['approve', 'reject', 'query'].includes(action)) {
      await models.Approval.create(
        {
          entityType: 'Accession',
          entityId: a.id,
          stage: 'accession_decision',
          approverId: user.id,
          decision: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'returned',
          reason,
        },
        { transaction: t },
      );
    }
    if (action === 'submit') {
      await notifyPermissionHolders(
        ['accession.approve'],
        {
          eventType: 'accession.submitted',
          title: `Accession awaiting review: ${a.accessionNumber}`,
          body: `${a.title}${missing.length ? `\nMissing information: ${missing.join(', ')}` : ''}`,
          link: `/admin/accessions/${a.id}`,
          entityType: 'Accession',
          entityId: a.id,
        },
        { transaction: t },
      );
    } else if (action === 'recall') {
      await notifyPermissionHolders(
        ['accession.approve'],
        {
          eventType: 'accession.recalled',
          title: `Accession returned to draft: ${a.accessionNumber}`,
          body: `${user.fullName} took "${a.title}" back to complete it${reason ? `: ${reason}` : '.'}`,
          link: `/admin/accessions/${a.id}`,
          entityType: 'Accession',
          entityId: a.id,
        },
        { transaction: t },
      );
    } else if (['approve', 'reject', 'query'].includes(action)) {
      await notifyUsers(
        [a.submittedById, a.responsibleOfficerId],
        {
          eventType: 'accession.decision',
          title: `Accession ${a.accessionNumber}: ${action}`,
          body: reason || '',
          link: `/admin/accessions/${a.id}`,
          entityType: 'Accession',
          entityId: a.id,
        },
        { transaction: t },
      );
    }
    return a;
  });
}

/**
 * Places an accession in quarantine (for example because of mould, pests or suspected malware) or releases it. A
 * quarantined accession cannot be approved.
 *
 * @param {string} id Accession identifier.
 * @param {{ quarantine: boolean, reason?: string }} input Whether to quarantine, and why.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated accession.
 */
export async function setQuarantine(id, { quarantine, reason }, user) {
  return sequelize.transaction(async (t) => {
    const a = await models.Accession.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound('Accession');
    await a.update(
      { isQuarantined: quarantine, quarantineReason: quarantine ? reason : null, updatedById: user.id },
      { transaction: t },
    );
    await audit(
      {
        action: quarantine ? 'accession.quarantined' : 'accession.quarantine_released',
        resourceType: 'Accession',
        resourceId: id,
        reason,
      },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Links an approved or closed accession to existing catalogue descriptions, recording where the described material
 * came from. Existing links are kept.
 *
 * @param {string} id Accession identifier.
 * @param {string[]} recordIds Descriptions to link.
 * @returns {Promise<void>}
 * @throws {AppError} When the accession is not approved or a description does not exist.
 */
export async function linkRecords(id, recordIds) {
  return sequelize.transaction(async (t) => {
    const a = await models.Accession.findByPk(id, { transaction: t });
    if (!a) throw notFound('Accession');
    if (a.status !== 'approved' && a.status !== 'closed')
      throw badRequest('Only approved accessions can be linked to the catalogue');
    const count = await models.ArchivalRecord.count({ where: { id: recordIds }, transaction: t });
    if (count !== new Set(recordIds).size) throw notFound('One or more descriptions');
    for (const recordId of recordIds)
      await models.AccessionRecordLink.findOrCreate({
        where: { accessionId: id, recordId },
        defaults: { accessionId: id, recordId },
        transaction: t,
      });
    await audit(
      { action: 'accession.records_linked', resourceType: 'Accession', resourceId: id, after: { recordIds } },
      { transaction: t },
    );
  });
}

/**
 * Creates a draft collection-level description from an approved accession and links the two.
 *
 * The title, extent, source, custodial history, creator and rights are copied from the accession. The description
 * starts as staff-only, or embargoed if the accession carries an embargo, so nothing becomes public until it has
 * been catalogued, reviewed and published.
 *
 * @param {string} id Accession identifier.
 * @param {{ level?: string, localIdentifier: string, title?: string }} input Level of description, local identifier
 *   for the reference code, and an optional title.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new description.
 * @throws {AppError} When the accession is not approved.
 */
export async function createCollectionFromAccession(id, { level = 'fonds', localIdentifier, title }, user) {
  const a = await models.Accession.findByPk(id);
  if (!a) throw notFound('Accession');
  if (a.status !== 'approved') throw badRequest('Only approved accessions can create a collection');
  const unit = a.sourceUnitId ? await models.OrganisationUnit.findByPk(a.sourceUnitId) : null;
  const record = await createRecord(
    {
      level,
      localIdentifier,
      title: title || a.title,
      repositoryId: a.repositoryId,
      extentAndMedium: a.extent,
      immediateSource: `Accession ${a.accessionNumber}${unit ? ` from ${unit.name}` : a.donorName ? ` from ${a.donorName}` : ''}`,
      archivalHistory: a.custodialHistory,
      creatorNote: unit?.name || a.donorName,
      originatingUnitId: a.sourceUnitId,
      reproductionConditions: a.rightsStatement,
      accessLevel: a.embargoUntil ? 'embargoed' : 'staff_only',
      embargoUntil: a.embargoUntil,
    },
    user,
  );
  await linkRecords(id, [record.id]);
  return record;
}

/**
 * Produces the accession acknowledgement and transfer receipt as a PDF bearing the University crest.
 *
 * The receipt number is allocated the first time and reused afterwards. The receipt lists every item with its
 * decision and states that accessioning does not by itself make material publicly available. Issuing and
 * downloading the receipt are both audited.
 *
 * @param {string} id Accession identifier.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ doc: PDFKit.PDFDocument, filename: string }>} The finished PDF stream and a safe file name.
 * @throws {AppError} When the accession is not approved or closed.
 */
export async function receiptPdf(id, user) {
  const a = await models.Accession.findByPk(id, {
    include: [
      { model: models.AccessionItem, as: 'items' },
      { model: models.OrganisationUnit, as: 'sourceUnit' },
      { model: models.User, as: 'approvedBy', attributes: ['fullName'] },
    ],
  });
  if (!a) throw notFound('Accession');
  if (!['approved', 'closed'].includes(a.status)) throw badRequest('A receipt is issued only for approved accessions');
  if (!a.receiptNumber) {
    await sequelize.transaction(async (t) => {
      await a.update(
        { receiptNumber: await generateReference('receipt', t), receiptIssuedAt: new Date() },
        { transaction: t },
      );
      await audit(
        {
          action: 'accession.receipt_issued',
          resourceType: 'Accession',
          resourceId: id,
          after: { receiptNumber: a.receiptNumber },
        },
        { transaction: t },
      );
    });
  }
  const institution = await getSetting('institution.name');
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Accession receipt ${a.accessionNumber}` } });
  stampCrest(doc);
  doc.fillColor(BRAND.indigo).fontSize(10).text(institution.toUpperCase(), { characterSpacing: 1 });
  doc.moveDown(0.3).fillColor('#111').fontSize(18).text('Accession Acknowledgement and Transfer Receipt');
  doc
    .moveDown(0.5)
    .fontSize(10)
    .fillColor('#555')
    .text(`Receipt ${a.receiptNumber} · Issued ${new Date(a.receiptIssuedAt).toISOString().slice(0, 10)}`);
  doc.moveDown();

  /**
   * Writes one "label: value" line of the receipt, showing a dash when the value is empty.
   *
   * @param {string} k Label.
   * @param {*} v Value.
   * @returns {PDFKit.PDFDocument}
   */
  const row = (k, v) =>
    doc
      .fillColor('#555')
      .fontSize(9)
      .text(k, { continued: true, width: 500 })
      .fillColor('#111')
      .fontSize(10)
      .text(`  ${v ?? '—'}`);
  row('Accession number:', a.accessionNumber);
  row('Title:', a.title);
  row('Source:', a.sourceUnit?.name || a.donorName);
  row('Contact:', a.contactPerson);
  row('Transfer date:', a.transferDate);
  row('Transfer authority:', a.transferAuthority || a.legalBasis);
  row('Extent:', a.extent || (a.quantity ? `${a.quantity} item(s)` : null));
  row('Approved by:', a.approvedBy?.fullName);
  doc.moveDown().fillColor(BRAND.indigo).fontSize(11).text('Items');
  doc.moveDown(0.3);
  for (const it of a.items.sort((x, y) => x.lineNumber - y.lineNumber)) {
    doc
      .fillColor('#111')
      .fontSize(9)
      .text(
        `${it.lineNumber}. ${it.description}  [${it.status}]${it.quantity ? ` × ${it.quantity}` : ''}${it.extent ? ` — ${it.extent}` : ''}`,
      );
  }
  doc
    .moveDown(2)
    .fillColor('#555')
    .fontSize(8)
    .text(
      'This receipt confirms custody of the materials listed above as accepted. Items marked rejected were not taken into custody. ' +
        'Accessioning does not by itself make materials publicly available; access is governed by the applicable access conditions.',
      { width: 495 },
    );
  doc
    .moveDown(3)
    .fillColor('#111')
    .fontSize(9)
    .text('Received for the Archives: ____________________________          Date: ______________');
  doc.end();
  await audit({ action: 'accession.receipt_downloaded', resourceType: 'Accession', resourceId: id, actor: user });
  return { doc, filename: `${a.accessionNumber.replace(/[^\w-]+/g, '_')}-receipt.pdf` };
}

/**
 * Lists the workflow actions this user may take on an accession now, given its state and the user's permissions.
 * Recall is offered only when it is allowed (before the review starts, or while information is missing).
 *
 * @param {object} a The accession.
 * @param {object} user Authenticated principal.
 * @param {number} [missingCount=0] Number of missing pieces of information, which decides whether a review in
 *   progress may be recalled.
 * @returns {string[]} The available action names.
 */
export function actionsFor(a, user, missingCount = 0) {
  return availableActions('accession', a.status).filter(
    (x) => hasPerm(user, ACTION_PERMISSION[x]) && (x !== 'recall' || canRecall(a, missingCount)),
  );
}
