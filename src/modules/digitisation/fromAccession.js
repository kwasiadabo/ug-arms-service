/**
 * Digitisation planned from an accession: a summary of what has been digitised, proposing a project linked to the
 * accession, and creating a batch filled with the accession's material that has not yet been digitised.
 *
 * Material is the accession's registered boxes and volumes, and any accepted items that are described but not in a
 * box. Material already digitised (its item passed quality review in a completed batch) or already planned in a
 * batch that has not ended is left out of new batches.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { createProject, createBatch, addItems, progress } from './digitisation.service.js';

// Batches still under way: material in them is planned or being digitised.
const OPEN_BATCH = ['planned', 'in_progress', 'processing', 'quality_review', 'rework_required', 'approved'];
// Physical items that no longer form part of the holdings.
const GONE = ['disposed', 'withdrawn'];

/**
 * Loads an accession that material may be digitised from.
 *
 * @param {string} id Accession identifier.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object>}
 * @throws {AppError} 404 when it does not exist.
 */
async function loadAccession(id, transaction) {
  const a = await models.Accession.findByPk(id, {
    attributes: ['id', 'accessionNumber', 'title', 'status'],
    include: [{ model: models.AccessionItem, as: 'items' }],
    transaction,
  });
  if (!a) throw notFound('Accession');
  return a;
}

/**
 * Returns the one description linked to an accession, used as the default for items and projects, or null when
 * there are none or several.
 *
 * @param {string} accessionId The accession.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<string|null>}
 */
async function singleLinkedRecord(accessionId, transaction) {
  const links = await models.AccessionRecordLink.findAll({
    where: { accessionId },
    attributes: ['recordId'],
    transaction,
  });
  return links.length === 1 ? links[0].recordId : null;
}

/**
 * Works out where each piece of the accession's material stands in digitisation.
 *
 * @param {object} a The accession with its items.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<{ boxes: object[], unboxed: object[] }>} Each entry with `state`: "digitised", "in_batch" or
 *   "not_started", and the batch number when it is in one.
 */
async function materialStates(a, transaction) {
  const boxes = await models.PhysicalItem.findAll({
    where: { accessionId: a.id, status: { [Op.notIn]: GONE } },
    attributes: ['id', 'barcode', 'title', 'status', 'recordId'],
    order: [['createdAt', 'ASC']],
    transaction,
  });
  const unboxedItems = a.items.filter((i) => i.status === 'accepted' && !i.physicalItemId && i.recordId);
  const boxIds = boxes.map((b) => b.id);
  const recordIds = unboxedItems.map((i) => i.recordId);
  const digItems = await models.DigitisationItem.findAll({
    where: {
      [Op.or]: [
        ...(boxIds.length ? [{ physicalItemId: boxIds }] : []),
        ...(recordIds.length ? [{ recordId: recordIds, physicalItemId: null }] : []),
      ],
    },
    attributes: ['physicalItemId', 'recordId', 'status'],
    include: [{ model: models.DigitisationBatch, as: 'batch', attributes: ['batchNumber', 'status'] }],
    transaction,
  });

  /**
   * Finds the state of one piece of material from the batch items that hold it.
   *
   * @param {object[]} held The batch items for this piece.
   * @returns {{ state: string, batchNumber?: string }}
   */
  const stateOf = (held) => {
    const done = held.find((d) => d.batch?.status === 'completed' && d.status === 'qa_passed');
    if (done) return { state: 'digitised', batchNumber: done.batch.batchNumber };
    const open = held.find((d) => OPEN_BATCH.includes(d.batch?.status));
    if (open) return { state: 'in_batch', batchNumber: open.batch.batchNumber };
    return { state: 'not_started' };
  };
  return {
    boxes: boxes.map((b) => ({
      physicalItemId: b.id,
      barcode: b.barcode,
      title: b.title,
      recordId: b.recordId,
      ...stateOf(digItems.filter((d) => d.physicalItemId === b.id)),
    })),
    unboxed: unboxedItems.map((i) => ({
      accessionItemId: i.id,
      description: i.description,
      recordId: i.recordId,
      ...stateOf(digItems.filter((d) => !d.physicalItemId && d.recordId === i.recordId)),
    })),
  };
}

/**
 * Summarises digitisation for an accession: the projects and batches that include it, with their progress, and
 * where each of its boxes and unboxed described items stands.
 *
 * @param {string} accessionId The accession.
 * @returns {Promise<object>}
 */
export async function accessionDigitisation(accessionId) {
  const a = await loadAccession(accessionId);
  const { boxes, unboxed } = await materialStates(a);
  const itemBatchIds = (
    await models.DigitisationItem.findAll({ where: { accessionId }, attributes: ['batchId'], group: ['batchId'] })
  ).map((i) => i.batchId);
  const projects = await models.DigitisationProject.findAll({
    where: {
      [Op.or]: [{ accessionId }, ...(itemBatchIds.length ? [{ '$batches.id$': itemBatchIds }] : [])],
    },
    attributes: ['id', 'code', 'title', 'status', 'accessionId'],
    include: [{ model: models.DigitisationBatch, as: 'batches', attributes: ['id', 'batchNumber', 'status'] }],
    order: [['createdAt', 'ASC']],
  });
  const withProgress = await Promise.all(
    projects.map(async (p) => ({
      id: p.id,
      code: p.code,
      title: p.title,
      status: p.status,
      linked: p.accessionId === accessionId,
      batches: await Promise.all(
        p.batches.map(async (b) => ({
          id: b.id,
          batchNumber: b.batchNumber,
          status: b.status,
          ...(await progress(b.id)),
        })),
      ),
    })),
  );
  const all = [...boxes, ...unboxed];
  return {
    canPlan: ['approved', 'closed'].includes(a.status),
    reason: ['approved', 'closed'].includes(a.status)
      ? undefined
      : 'Material can be digitised once the accession is approved',
    projects: withProgress,
    boxes,
    unboxed,
    counts: {
      total: all.length,
      digitised: all.filter((x) => x.state === 'digitised').length,
      inBatch: all.filter((x) => x.state === 'in_batch').length,
      notStarted: all.filter((x) => x.state === 'not_started').length,
    },
  };
}

/**
 * Proposes a digitisation project for an approved accession, linked to it and, when the accession is linked to a
 * single description, to that description as its source. The project still needs approval by someone else.
 *
 * @param {string} accessionId The accession.
 * @param {object} data Project details, as for `createProject`.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new project.
 */
export async function proposeProjectForAccession(accessionId, data, user) {
  const a = await loadAccession(accessionId);
  return createProject(
    {
      ...data,
      title: data.title || `Digitisation of ${a.title} (${a.accessionNumber})`,
      accessionId,
      sourceRecordId: data.sourceRecordId ?? (await singleLinkedRecord(accessionId)),
    },
    user,
  );
}

/**
 * Creates a batch in an approved project linked to the accession, filled with the accession's material that is not
 * yet digitised or planned: one item per box (with its description, or the accession's only description) and one per
 * described item that is not in a box. A selection of boxes can be given. The batch and its items are created
 * together, so a refused item leaves no empty batch behind.
 *
 * @param {string} accessionId The accession.
 * @param {{ projectId: string, physicalItemIds?: string[], includeUnboxed?: boolean, operatorId?: string,
 *   resolutionDpi?: number, colourProfile?: string, bitDepth?: number, ocrEnabled?: boolean, ocrLanguage?: string }}
 *   input Which project and material, and the batch's capture settings.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ batch: object, items: object[] }>}
 * @throws {AppError} When the accession is not approved, the project is not linked to it, or nothing is left to plan.
 */
export async function planBatchFromAccession(accessionId, input, user) {
  const { projectId, physicalItemIds, includeUnboxed = true, ...batchData } = input;
  return sequelize.transaction(async (t) => {
    const a = await loadAccession(accessionId, t);
    if (!['approved', 'closed'].includes(a.status))
      throw badRequest('Material can be digitised once the accession is approved');
    const project = await models.DigitisationProject.findByPk(projectId, { transaction: t });
    if (!project || project.accessionId !== accessionId) throw notFound('Project for this accession');
    const { boxes, unboxed } = await materialStates(a, t);
    const fallbackRecord = await singleLinkedRecord(accessionId, t);
    const chosen = boxes.filter(
      (b) => b.state === 'not_started' && (!physicalItemIds || physicalItemIds.includes(b.physicalItemId)),
    );
    const loose = includeUnboxed ? unboxed.filter((u) => u.state === 'not_started') : [];
    if (!chosen.length && !loose.length)
      throw badRequest('Everything from this accession is already digitised or in a batch');
    const batch = await createBatch(projectId, batchData, t);
    const items = await addItems(
      batch.id,
      [
        ...chosen.map((b) => ({
          label: `${b.barcode} · ${b.title}`.slice(0, 500),
          physicalItemId: b.physicalItemId,
          recordId: b.recordId ?? fallbackRecord,
          accessionId,
        })),
        ...loose.map((u) => ({ label: u.description.slice(0, 500), recordId: u.recordId, accessionId })),
      ],
      user,
      t,
    );
    await audit(
      {
        action: 'digitisation.batch_planned_from_accession',
        resourceType: 'Accession',
        resourceId: accessionId,
        after: { batchId: batch.id, batchNumber: batch.batchNumber, boxes: chosen.length, unboxed: loose.length },
      },
      { transaction: t },
    );
    return { batch, items };
  });
}
