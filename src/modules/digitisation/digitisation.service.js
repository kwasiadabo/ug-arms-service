/**
 * Business rules for digitisation projects, batches, items and quality assurance.
 *
 * A project must be approved, by someone other than the person who proposed it, before any batch can be worked on.
 * Each batch moves from planning through capture and processing to quality review. Quality review is done by
 * someone other than the capture operator, and every item must pass (or be skipped) before the batch can be
 * approved. Failed captures are never overwritten: replacements are uploaded as new files.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, validationError } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import {
  transition,
  assertTransition,
  assertSeparationOfDuties,
  availableActions,
} from '../../services/workflow.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { notifyUsers, notifyPermissionHolders } from '../../services/notification.service.js';
import { hasPerm } from '../../services/accessPolicy.service.js';

// Permission required for each batch workflow action; "digitisation.manage" may perform any of them.
const BATCH_ACTION_PERMISSION = {
  start: 'digitisation.capture',
  submit_capture: 'digitisation.capture',
  processing_complete: 'digitisation.capture',
  request_rework: 'digitisation.qa',
  approve: 'digitisation.qa',
  complete: 'digitisation.manage',
  fail: 'digitisation.manage',
};

// Statuses a digitisation project may move to from each status.
const PROJECT_STATUS_TRANSITIONS = {
  proposed: ['approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * Proposes a digitisation project with a newly allocated project code.
 *
 * @param {object} data Validated project details; an optional `sourceRecordId` must refer to an existing
 *   description.
 * @param {object} user Authenticated principal; recorded as the proposer.
 * @returns {Promise<object>} The new project.
 * @throws {AppError} 404 when the source description does not exist.
 */
export async function createProject(data, user) {
  return sequelize.transaction(async (t) => {
    if (
      data.sourceRecordId &&
      !(await models.ArchivalRecord.findByPk(data.sourceRecordId, { transaction: t, attributes: ['id'] }))
    )
      throw notFound('Source description');
    const p = await models.DigitisationProject.create(
      { ...data, code: await generateReference('digitisation_project', t), status: 'proposed', createdById: user.id },
      { transaction: t },
    );
    await audit(
      {
        action: 'digitisation.project_created',
        resourceType: 'DigitisationProject',
        resourceId: p.id,
        after: { code: p.code, title: p.title },
      },
      { transaction: t },
    );
    return p;
  });
}

/**
 * Moves a project to a new status. Allowed moves are listed in `PROJECT_STATUS_TRANSITIONS`.
 *
 * Approval authorises the selection of material for digitisation. It requires "records.approve" or
 * "digitisation.manage", and the approver must not be the person who proposed the project.
 *
 * @param {string} id Identifier of the project.
 * @param {string} status The new status.
 * @param {object} user Authenticated principal.
 * @param {string} [reason] Explanation recorded in the audit trail.
 * @returns {Promise<object>} The updated project.
 * @throws {AppError} 400 when the move is not allowed, 403 when the approver is not permitted.
 */
export async function setProjectStatus(id, status, user, reason) {
  return sequelize.transaction(async (t) => {
    const p = await models.DigitisationProject.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p) throw notFound('Project');
    if (!PROJECT_STATUS_TRANSITIONS[p.status].includes(status))
      throw badRequest(`A ${p.status} project cannot become ${status}`);
    if (status === 'approved') {
      if (!hasPerm(user, 'records.approve') && !hasPerm(user, 'digitisation.manage')) throw forbidden();
      await assertSeparationOfDuties(user.id, [p.createdById], 'You cannot approve a project you proposed');
    }
    const before = p.status;
    await p.update(
      { status, ...(status === 'approved' && { approvedById: user.id, approvedAt: new Date() }) },
      { transaction: t },
    );
    await audit(
      {
        action: `digitisation.project_${status}`,
        resourceType: 'DigitisationProject',
        resourceId: id,
        before: { status: before },
        after: { status },
        reason,
      },
      { transaction: t },
    );
    return p;
  });
}

/**
 * Creates a batch within an approved or active project and activates an approved project. The assigned capture
 * operator, if any, is notified.
 *
 * @param {string} projectId Identifier of the project.
 * @param {object} data Validated batch details, such as operator, resolution and OCR settings.
 * @returns {Promise<object>} The new batch with its allocated batch number.
 * @throws {AppError} 404 when the project does not exist, 400 when it is not approved.
 */
export async function createBatch(projectId, data) {
  return sequelize.transaction(async (t) => {
    const p = await models.DigitisationProject.findByPk(projectId, { transaction: t });
    if (!p) throw notFound('Project');
    if (!['approved', 'active'].includes(p.status))
      throw badRequest('Batches can be created only for approved projects');
    const b = await models.DigitisationBatch.create(
      { ...data, projectId, batchNumber: await generateReference('digitisation_batch', t), status: 'planned' },
      { transaction: t },
    );
    if (p.status === 'approved') await p.update({ status: 'active' }, { transaction: t });
    await audit(
      {
        action: 'digitisation.batch_created',
        resourceType: 'DigitisationBatch',
        resourceId: b.id,
        after: { batchNumber: b.batchNumber, operatorId: b.operatorId },
      },
      { transaction: t },
    );
    if (b.operatorId)
      await notifyUsers(
        [b.operatorId],
        {
          eventType: 'digitisation.assigned',
          title: `Digitisation batch assigned: ${b.batchNumber}`,
          body: p.title,
          link: `/admin/digitisation/batches/${b.id}`,
          entityType: 'DigitisationBatch',
          entityId: b.id,
        },
        { transaction: t },
      );
    return b;
  });
}

/**
 * Adds items to capture to a batch that has not yet been submitted for processing. Items are numbered after the
 * existing ones. A linked description must exist, and a linked physical item must exist and must not be issued to a
 * researcher.
 *
 * @param {string} batchId Identifier of the batch.
 * @param {object[]} items The items, each with a label and optional description, physical item and expected page
 *   count.
 * @returns {Promise<object[]>} The created items.
 * @throws {AppError} When the batch cannot accept items or a linked record is missing or unavailable.
 */
export async function addItems(batchId, items) {
  return sequelize.transaction(async (t) => {
    const b = await models.DigitisationBatch.findByPk(batchId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw notFound('Batch');
    if (!['planned', 'in_progress', 'rework_required'].includes(b.status))
      throw badRequest('Items can only be added before capture is submitted');
    const max = (await models.DigitisationItem.max('sequence', { where: { batchId }, transaction: t })) || 0;
    const rows = [];
    for (const [i, it] of items.entries()) {
      if (it.recordId && !(await models.ArchivalRecord.findByPk(it.recordId, { transaction: t, attributes: ['id'] })))
        throw notFound('Description');
      if (it.physicalItemId) {
        const pi = await models.PhysicalItem.findByPk(it.physicalItemId, { transaction: t });
        if (!pi) throw notFound('Physical item');
        if (pi.status === 'issued') throw badRequest(`${pi.barcode} is currently issued to a researcher`);
      }
      rows.push(
        await models.DigitisationItem.create(
          { ...it, batchId, sequence: max + i + 1, status: 'pending' },
          { transaction: t },
        ),
      );
    }
    await audit(
      {
        action: 'digitisation.items_added',
        resourceType: 'DigitisationBatch',
        resourceId: batchId,
        metadata: { count: rows.length },
      },
      { transaction: t },
    );
    return rows;
  });
}

/**
 * Summarises a batch's progress: items captured, items that passed or failed quality review, master files and their
 * processing and OCR status, expected and captured pages, and the percentage of items finished.
 *
 * @param {string} batchId Identifier of the batch.
 * @returns {Promise<object>} The progress figures.
 */
export async function progress(batchId) {
  const items = await models.DigitisationItem.findAll({
    where: { batchId },
    attributes: ['id', 'status', 'expectedPages', 'capturedPages'],
  });
  const assets = await models.DigitalAsset.findAll({
    where: { digitisationItemId: items.map((i) => i.id), role: 'preservation_master', status: { [Op.ne]: 'deleted' } },
    attributes: ['id', 'digitisationItemId', 'status', 'ocrStatus', 'qaStatus'],
  });
  const done = items.filter((i) => ['qa_passed', 'skipped'].includes(i.status)).length;
  return {
    items: items.length,
    captured: items.filter((i) => i.status !== 'pending').length,
    qaPassed: items.filter((i) => i.status === 'qa_passed').length,
    qaFailed: items.filter((i) => ['qa_failed', 'rework'].includes(i.status)).length,
    assets: assets.length,
    assetsProcessing: assets.filter((a) => ['processing', 'uploaded'].includes(a.status)).length,
    ocrPending: assets.filter((a) => ['queued', 'running', 'pending'].includes(a.ocrStatus)).length,
    ocrFailed: assets.filter((a) => a.ocrStatus === 'failed').length,
    expectedPages: items.reduce((n, i) => n + (i.expectedPages || 0), 0),
    capturedPages: items.reduce((n, i) => n + (i.capturedPages || 0), 0),
    percentComplete: items.length ? Math.round((done / items.length) * 100) : 0,
  };
}

/**
 * Performs a workflow action on a batch, with completeness checks at each stage.
 *
 * - Submitting capture requires every item to be captured or skipped.
 * - Completing processing requires every file to have finished processing.
 * - Approval requires every item to have passed quality review or been skipped, and must be done by someone other
 *   than the capture operator.
 * - Requesting rework requires a description of what is needed; the operator is notified.
 *
 * Quality reviewers are notified when capture is submitted.
 *
 * @param {string} batchId Identifier of the batch.
 * @param {{ action: string, reason?: string }} input The action and an explanation.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated batch.
 * @throws {AppError} When the action is not permitted, not allowed or a completeness check fails.
 */
export async function transitionBatch(batchId, { action, reason }, user) {
  if (!hasPerm(user, BATCH_ACTION_PERMISSION[action]) && !hasPerm(user, 'digitisation.manage')) throw forbidden();
  return sequelize.transaction(async (t) => {
    const b = await models.DigitisationBatch.findByPk(batchId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw notFound('Batch');
    assertTransition('digitisation_batch', b.status, action);
    const items = await models.DigitisationItem.findAll({ where: { batchId }, transaction: t });
    if (action === 'submit_capture') {
      const pending = items.filter((i) => i.status === 'pending' || i.status === 'rework');
      if (!items.length) throw validationError([{ path: 'items', message: 'Add items to the batch first' }]);
      if (pending.length)
        throw validationError(
          pending.map((i) => ({ path: `items[${i.sequence}]`, message: `${i.label}: not yet captured` })),
          'Every item must be captured or skipped',
        );
    }
    if (action === 'processing_complete') {
      const stillProcessing = await models.DigitalAsset.count({
        where: { digitisationItemId: items.map((i) => i.id), status: ['uploaded', 'processing'] },
        transaction: t,
      });
      if (stillProcessing) throw badRequest(`${stillProcessing} file(s) are still being processed`);
    }
    if (action === 'approve') {
      await assertSeparationOfDuties(user.id, [b.operatorId], 'The capture operator cannot approve their own batch');
      const notPassed = items.filter((i) => !['qa_passed', 'skipped'].includes(i.status));
      if (notPassed.length)
        throw validationError(
          notPassed.map((i) => ({
            path: `items[${i.sequence}]`,
            message: `${i.label}: QA ${i.status.replace('qa_', '')}`,
          })),
          'All items must pass QA before approval',
        );
    }
    if (action === 'request_rework' && !reason)
      throw validationError([{ path: 'reason', message: 'Describe the rework required' }]);
    await transition('digitisation_batch', b, action, {
      actor: user,
      reason,
      transaction: t,
      apply: (r) => {
        if (action === 'start' && !r.captureStartedAt) r.captureStartedAt = new Date();
        if (action === 'approve') r.qaReviewerId = user.id;
        if (action === 'complete') r.completedAt = new Date();
      },
    });
    if (action === 'submit_capture')
      await notifyPermissionHolders(
        ['digitisation.qa'],
        {
          eventType: 'digitisation.assigned',
          title: `Batch ready for QA: ${b.batchNumber}`,
          body: '',
          link: `/admin/digitisation/batches/${b.id}`,
          entityType: 'DigitisationBatch',
          entityId: b.id,
        },
        { transaction: t },
      );
    if (action === 'request_rework' && b.operatorId)
      await notifyUsers(
        [b.operatorId],
        {
          eventType: 'qa.failed',
          title: `Rework required: ${b.batchNumber}`,
          body: reason,
          link: `/admin/digitisation/batches/${b.id}`,
          entityType: 'DigitisationBatch',
          entityId: b.id,
        },
        { transaction: t },
      );
    return b;
  });
}

/**
 * Records that an item has been captured, or skipped. A captured item must already have at least one master file
 * uploaded, and the batch must be in progress or in rework.
 *
 * @param {string} itemId Identifier of the item.
 * @param {{ capturedPages?: number, notes?: string, skip?: boolean }} input Pages captured, notes, or whether to
 *   skip the item.
 * @returns {Promise<object>} The updated item.
 * @throws {AppError} When the batch has not started or no files have been uploaded.
 */
export async function markCaptured(itemId, { capturedPages, notes, skip }) {
  return sequelize.transaction(async (t) => {
    const item = await models.DigitisationItem.findByPk(itemId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.DigitisationBatch, as: 'batch' }],
    });
    if (!item) throw notFound('Item');
    if (!['in_progress', 'rework_required'].includes(item.batch.status))
      throw badRequest('Start the batch before recording capture');
    if (!skip) {
      const files = await models.DigitalAsset.count({
        where: {
          digitisationItemId: itemId,
          role: 'preservation_master',
          status: { [Op.notIn]: ['deleted', 'rejected', 'failed'] },
        },
        transaction: t,
      });
      if (!files) throw badRequest('Upload the captured files for this item first');
    }
    await item.update(
      {
        status: skip ? 'skipped' : 'captured',
        capturedPages: capturedPages ?? item.capturedPages,
        notes: notes ?? item.notes,
      },
      { transaction: t },
    );
    await audit(
      {
        action: skip ? 'digitisation.item_skipped' : 'digitisation.item_captured',
        resourceType: 'DigitisationItem',
        resourceId: itemId,
        metadata: { capturedPages },
        reason: notes,
      },
      { transaction: t },
    );
    return item;
  });
}

/**
 * Records a quality review of an item in a batch that is in quality review.
 *
 * The reviewer must not be the capture operator, and a failing review needs comments. The outcome is stored and
 * copied to the item's files and their derivatives, so files that failed review cannot be published. Failing items
 * go to rework; replacements are uploaded as new files rather than overwriting the originals.
 *
 * @param {string} itemId Identifier of the item.
 * @param {{ outcome: 'pass'|'fail'|'rework', checks?: object, comments?: string, assetId?: string }} input The
 *   review; `assetId` limits it to one file.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The updated item.
 * @throws {AppError} When the batch is not in review, the reviewer is the operator, or comments are missing.
 */
export async function reviewItem(itemId, { outcome, checks, comments, assetId }, user) {
  return sequelize.transaction(async (t) => {
    const item = await models.DigitisationItem.findByPk(itemId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
      include: [{ model: models.DigitisationBatch, as: 'batch' }],
    });
    if (!item) throw notFound('Item');
    if (item.batch.status !== 'quality_review') throw badRequest('The batch is not in quality review');
    await assertSeparationOfDuties(
      user.id,
      [item.batch.operatorId],
      'The capture operator cannot review their own work',
    );
    if (outcome !== 'pass' && !comments) throw validationError([{ path: 'comments', message: 'Explain what failed' }]);
    await models.QualityAssuranceReview.create(
      { batchId: item.batchId, itemId, assetId, reviewerId: user.id, outcome, checks, comments },
      { transaction: t },
    );
    await item.update(
      { status: outcome === 'pass' ? 'qa_passed' : outcome === 'fail' ? 'qa_failed' : 'rework' },
      { transaction: t },
    );
    const assetWhere = { digitisationItemId: itemId, status: { [Op.ne]: 'deleted' }, ...(assetId && { id: assetId }) };
    await models.DigitalAsset.update(
      { qaStatus: outcome === 'pass' ? 'passed' : 'failed' },
      { where: assetWhere, transaction: t },
    );
    const masters = await models.DigitalAsset.findAll({
      where: { ...assetWhere, role: 'preservation_master' },
      attributes: ['id'],
      transaction: t,
    });
    await models.DigitalAsset.update(
      { qaStatus: outcome === 'pass' ? 'passed' : 'failed' },
      { where: { parentAssetId: masters.map((m) => m.id) }, transaction: t },
    );
    await audit(
      {
        action: `digitisation.qa_${outcome}`,
        resourceType: 'DigitisationItem',
        resourceId: itemId,
        after: { outcome, checks },
        reason: comments,
      },
      { transaction: t },
    );
    return item;
  });
}

/**
 * Lists the workflow actions this user may take on a batch now. Holders of "digitisation.manage" may take any of
 * them.
 *
 * @param {object} b The batch.
 * @param {object} user Authenticated principal.
 * @returns {string[]} The available action names.
 */
export function actionsFor(b, user) {
  return availableActions('digitisation_batch', b.status).filter(
    (a) => hasPerm(user, BATCH_ACTION_PERMISSION[a]) || hasPerm(user, 'digitisation.manage'),
  );
}
