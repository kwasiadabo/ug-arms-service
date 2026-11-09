/**
 * Registering the boxes of an approved accession as physical items.
 *
 * Accepted accession items are grouped by the department's box number (carried over from the transfer inventory).
 * Each group can be registered as one physical item in a single step: it receives a barcode (scanned, typed or
 * generated), a home location after the usual capacity check, an initial-placement movement and a link to the
 * accession, and every accession item in the box is linked to it. Registering several boxes is all or nothing.
 *
 * @author Kwasi Adabo Boakye
 */

import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, conflict, AppError } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { generateReference } from '../../services/referenceCode.service.js';
import { createItem } from '../locations/locations.service.js';

const REGISTRABLE = ['approved', 'closed'];

/**
 * Normalises a box number for grouping: trimmed and case-insensitive, so "Box 3" and "box 3 " are one box.
 *
 * @param {string} v Box number as written.
 * @returns {string}
 */
const boxKey = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase();

/**
 * Loads an accession with its items, for planning or registering boxes.
 *
 * @param {string} id Accession identifier.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object>}
 * @throws {AppError} 404 when the accession does not exist.
 */
async function loadAccession(id, transaction) {
  const a = await models.Accession.findByPk(id, {
    include: [
      { model: models.AccessionItem, as: 'items' },
      { model: models.TransferSubmission, as: 'transferSubmission', attributes: ['id', 'referenceNumber'] },
    ],
    order: [[{ model: models.AccessionItem, as: 'items' }, 'lineNumber', 'ASC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!a) throw notFound('Accession');
  return a;
}

/**
 * Groups an accession's accepted items into boxes.
 *
 * @param {object} a The accession with its items.
 * @returns {{ boxes: object[], unboxed: object[] }} One entry per box number, in order of first appearance, and the
 *   accepted items that have no box number.
 */
function groupBoxes(a) {
  const boxes = new Map();
  const unboxed = [];
  for (const it of a.items.filter((i) => i.status === 'accepted')) {
    const key = boxKey(it.boxNumber);
    if (!key) {
      unboxed.push(it);
      continue;
    }
    if (!boxes.has(key)) boxes.set(key, { key, boxNumber: String(it.boxNumber).trim(), items: [] });
    boxes.get(key).items.push(it);
  }
  return { boxes: [...boxes.values()], unboxed };
}

/**
 * Names a box for titles and messages: "Box 3" for a bare number, the department's own wording otherwise.
 *
 * @param {string} boxNumber The department's box number.
 * @returns {string}
 */
const boxLabel = (boxNumber) => (/^box\b/i.test(boxNumber) ? boxNumber : `Box ${boxNumber}`);

/**
 * Suggests a title for a box's physical item, naming the accession, the box and the transfer it came with, so the
 * label can be matched to the department's list.
 *
 * @param {object} a The accession.
 * @param {string} boxNumber The department's box number.
 * @returns {string}
 */
const suggestedTitle = (a, boxNumber) => {
  const from = a.transferSubmission?.referenceNumber || a.accessionNumber;
  return `${a.title}, ${boxLabel(boxNumber)} (${from})`.slice(0, 1000);
};

/**
 * Lists the boxes of an accession with their items and, for those already registered, the physical item.
 *
 * @param {string} id Accession identifier.
 * @returns {Promise<{ canRegister: boolean, reason?: string, boxes: object[], unboxedCount: number,
 *   registeredCount: number }>}
 */
export async function boxPlan(id) {
  const a = await loadAccession(id);
  const { boxes, unboxed } = groupBoxes(a);
  const ids = [...new Set(boxes.flatMap((b) => b.items.map((i) => i.physicalItemId)).filter(Boolean))];
  const physical = ids.length
    ? await models.PhysicalItem.findAll({
        where: { id: ids },
        attributes: ['id', 'barcode', 'title', 'status'],
        include: [{ model: models.StorageLocation, as: 'currentLocation', attributes: ['id', 'code', 'name'] }],
      })
    : [];
  const byId = new Map(physical.map((p) => [p.id, p]));
  const out = boxes.map((b) => {
    const registered = b.items.every((i) => i.physicalItemId);
    return {
      boxNumber: b.boxNumber,
      suggestedTitle: suggestedTitle(a, b.boxNumber),
      items: b.items.map((i) => ({
        id: i.id,
        lineNumber: i.lineNumber,
        description: i.description,
        quantity: i.quantity,
      })),
      registered,
      physicalItem: registered ? byId.get(b.items[0].physicalItemId) || null : null,
    };
  });
  return {
    canRegister: REGISTRABLE.includes(a.status),
    reason: REGISTRABLE.includes(a.status) ? undefined : 'Boxes can be registered once the accession is approved',
    boxes: out,
    unboxedCount: unboxed.length,
    registeredCount: out.filter((b) => b.registered).length,
  };
}

/**
 * Picks a generated barcode that is not already in use.
 *
 * @param {import('sequelize').Transaction} t Current transaction.
 * @returns {Promise<string>}
 * @throws {AppError} 409 when no free barcode was found, which means the numbering rule clashes with existing labels.
 */
async function freeBarcode(t) {
  for (let i = 0; i < 25; i += 1) {
    const code = await generateReference('physical_item', t);
    if (!(await models.PhysicalItem.findOne({ where: { barcode: code }, attributes: ['id'], transaction: t })))
      return code;
  }
  throw conflict('Could not generate a free barcode; check the physical item numbering rule in Settings');
}

/**
 * Registers boxes of an approved accession as physical items, all or nothing.
 *
 * Each box gets its barcode (or a generated one), title, type and initial location, through the same checks as
 * registering a single item (unique barcode, capacity and authorised override). Its accession items are then linked
 * to the new physical item. Errors name the box they concern.
 *
 * @param {string} id Accession identifier.
 * @param {Array<{ boxNumber: string, barcode?: string, generateBarcode?: boolean, title?: string, itemType?: string,
 *   locationId: string, override?: boolean, overrideReason?: string }>} boxes The boxes to register.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object[]>} The new physical items, with the box number each one holds.
 * @throws {AppError} When the accession is not approved, a box is unknown or already registered, a barcode repeats,
 *   or a placement is refused.
 */
export async function registerBoxes(id, boxes, user) {
  const seen = new Set();
  for (const b of boxes) {
    if (!b.generateBarcode) {
      const code = String(b.barcode ?? '').trim();
      if (!code) throw badRequest(`${boxLabel(b.boxNumber)}: scan or type a barcode, or choose Generate`);
      if (seen.has(code.toLowerCase())) throw badRequest(`${boxLabel(b.boxNumber)}: barcode ${code} is used twice`);
      seen.add(code.toLowerCase());
    }
  }
  return sequelize.transaction(async (t) => {
    const a = await loadAccession(id, t);
    if (!REGISTRABLE.includes(a.status)) throw badRequest('Boxes can be registered once the accession is approved');
    const groups = new Map(groupBoxes(a).boxes.map((g) => [g.key, g]));
    const created = [];
    for (const b of boxes) {
      const group = groups.get(boxKey(b.boxNumber));
      try {
        if (!group) throw notFound('Box');
        if (group.items.every((i) => i.physicalItemId)) throw conflict('This box is already registered');
        const item = await createItem(
          {
            barcode: b.generateBarcode ? await freeBarcode(t) : String(b.barcode).trim(),
            itemType: b.itemType || 'box',
            title: (b.title || '').trim() || suggestedTitle(a, group.boxNumber),
            accessionId: a.id,
            locationId: b.locationId,
            override: b.override,
            overrideReason: b.overrideReason,
          },
          user,
          t,
        );
        await models.AccessionItem.update(
          { physicalItemId: item.id },
          { where: { id: group.items.map((i) => i.id) }, transaction: t },
        );
        created.push({ boxNumber: group.boxNumber, physicalItem: item });
      } catch (err) {
        if (err instanceof AppError) err.message = `${boxLabel(b.boxNumber)}: ${err.message}`;
        throw err;
      }
    }
    await audit(
      {
        action: 'accession.boxes_registered',
        resourceType: 'Accession',
        resourceId: a.id,
        after: { boxes: created.map((c) => ({ boxNumber: c.boxNumber, barcode: c.physicalItem.barcode })) },
      },
      { transaction: t },
    );
    return created;
  });
}
