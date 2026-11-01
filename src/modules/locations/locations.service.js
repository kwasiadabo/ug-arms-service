/**
 * Business rules for the physical storage hierarchy, physical items, movements, condition assessments and inventory
 * audits.
 *
 * Every placement checks the destination's capacity and material restrictions. A full location can only be used
 * through an authorised override with a reason, which is recorded with the movement. Every movement is recorded, so
 * the full custody history of each box is available. Items out on loan move through circulation, never through this
 * module.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, forbidden, conflict } from '../../utils/errors.js';
import { audit, diff } from '../../services/audit.service.js';
import { hasPerm, pathIds } from '../../services/accessPolicy.service.js';

/**
 * Calculates how full each location is: the total size units and the number of items currently in it, ignoring
 * disposed and withdrawn items.
 *
 * @param {string[]} locationIds Locations to measure.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<Record<string, { used: number, items: number }>>} Occupancy keyed by location ID; empty
 *   locations are absent.
 */
export async function occupancy(locationIds, transaction) {
  if (!locationIds.length) return {};
  const rows = await models.PhysicalItem.findAll({
    attributes: [
      'currentLocationId',
      [sequelize.fn('SUM', sequelize.col('sizeUnits')), 'used'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'items'],
    ],
    where: { currentLocationId: locationIds, status: { [Op.notIn]: ['disposed', 'withdrawn'] } },
    group: ['currentLocationId'],
    raw: true,
    transaction,
  });
  return Object.fromEntries(
    rows.map((r) => [r.currentLocationId, { used: Number(r.used || 0), items: Number(r.items) }]),
  );
}

/**
 * Creates a storage location under an optional parent and records its materialised path.
 *
 * A location type must rank below its parent's type (for example a shelf inside a room, never a room inside a
 * shelf), and codes must be unique. The repository is inherited from the parent when not given.
 *
 * @param {object} data Validated location details.
 * @returns {Promise<object>} The new location.
 * @throws {AppError} When the parent or type is unknown, the nesting is invalid, or the code is taken.
 */
export async function createLocation(data) {
  return sequelize.transaction(async (t) => {
    const parent = data.parentId ? await models.StorageLocation.findByPk(data.parentId, { transaction: t }) : null;
    if (data.parentId && !parent) throw notFound('Parent location');
    const [type, parentType] = await Promise.all([
      models.StorageLocationType.findByPk(data.typeId, { transaction: t }),
      parent ? models.StorageLocationType.findByPk(parent.typeId, { transaction: t }) : null,
    ]);
    if (!type) throw badRequest('Unknown location type');
    if (parentType && type.rank <= parentType.rank)
      throw badRequest(`A ${type.name} cannot be placed inside a ${parentType.name}`);
    if (await models.StorageLocation.findOne({ where: { code: data.code }, transaction: t }))
      throw conflict('Location code already exists');
    const loc = await models.StorageLocation.create(
      { ...data, repositoryId: data.repositoryId ?? parent?.repositoryId ?? null },
      { transaction: t },
    );
    loc.path = `${parent ? parent.path : '/'}${loc.id}/`;
    await loc.save({ transaction: t });
    await audit(
      {
        action: 'location.create',
        resourceType: 'StorageLocation',
        resourceId: loc.id,
        after: { code: loc.code, name: loc.name, parentId: loc.parentId },
      },
      { transaction: t },
    );
    return loc;
  });
}

/**
 * Updates a location. A location that still holds items cannot be deactivated. The change is audited with the
 * previous and new values.
 *
 * @param {string} id Identifier of the location.
 * @param {object} data Fields to change.
 * @returns {Promise<object>} The updated location.
 * @throws {AppError} 404 when not found, 409 when deactivating a location that holds items.
 */
export async function updateLocation(id, data) {
  return sequelize.transaction(async (t) => {
    const loc = await models.StorageLocation.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!loc) throw notFound('Location');
    if (
      data.isActive === false &&
      (await models.PhysicalItem.count({
        where: { currentLocationId: id, status: { [Op.notIn]: ['disposed', 'withdrawn'] } },
        transaction: t,
      }))
    ) {
      throw conflict('Relocate the items in this location before deactivating it');
    }
    const before = loc.get({ plain: true });
    await loc.update(data, { transaction: t });
    const d = diff(before, loc);
    await audit(
      { action: 'location.update', resourceType: 'StorageLocation', resourceId: id, before: d.before, after: d.after },
      { transaction: t },
    );
    return loc;
  });
}

/**
 * Checks that an item may be placed in a location.
 *
 * The location must be active and must accept the item's material type. If the placement would exceed its capacity,
 * it is refused unless an override is requested by someone holding "physical.override_capacity" with a reason.
 *
 * @param {object} location Destination location.
 * @param {object} item The physical item; its size counts once even if it is already there.
 * @param {{ override?: boolean, overrideReason?: string, user: object, transaction?:
 *   import('sequelize').Transaction }} options Override request, acting user and transaction.
 * @returns {Promise<{ overridden: boolean, used?: number, capacity?: number }>} Whether a capacity override was
 *   used.
 * @throws {AppError} When the placement is not allowed.
 */
export async function assertPlacement(location, item, { override, overrideReason, user, transaction }) {
  if (!location.isActive) throw badRequest(`Location ${location.code} is inactive`);
  const restrictions = location.materialRestrictions || [];
  if (restrictions.length && item.materialType && !restrictions.includes(item.materialType)) {
    throw badRequest(`Location ${location.code} accepts only: ${restrictions.join(', ')}`);
  }
  if (location.capacity !== null && location.capacity !== undefined) {
    const used = (await occupancy([location.id], transaction))[location.id]?.used ?? 0;
    const already = item.currentLocationId === location.id ? Number(item.sizeUnits || 1) : 0;
    const after = used - already + Number(item.sizeUnits || 1);
    if (after > Number(location.capacity)) {
      if (!override)
        throw conflict(
          `Location ${location.code} is at capacity (${used}/${location.capacity}). An authorised override with a reason is required.`,
          { used, capacity: Number(location.capacity) },
        );
      if (!hasPerm(user, 'physical.override_capacity'))
        throw forbidden('You are not authorised to override location capacity');
      if (!overrideReason) throw badRequest('Give a reason for the capacity override');
      return { overridden: true, used, capacity: Number(location.capacity) };
    }
  }
  return { overridden: false };
}

/**
 * Registers a physical item with a unique barcode and, if a location is given, records its initial placement after
 * the capacity check.
 *
 * @param {object} data Validated item details, optionally with `locationId`, `override` and `overrideReason`.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The new item.
 * @throws {AppError} When the barcode is taken, the location does not exist, or the placement is not allowed.
 */
export async function createItem(data, user) {
  return sequelize.transaction(async (t) => {
    if (await models.PhysicalItem.findOne({ where: { barcode: data.barcode }, transaction: t }))
      throw conflict('Barcode already in use');
    const { locationId, override, overrideReason, ...rest } = data;
    const item = await models.PhysicalItem.create(
      { ...rest, status: 'available', createdById: user.id },
      { transaction: t },
    );
    if (locationId) {
      const loc = await models.StorageLocation.findByPk(locationId, { transaction: t });
      if (!loc) throw notFound('Location');
      const check = await assertPlacement(loc, item, { override, overrideReason, user, transaction: t });
      await item.update({ currentLocationId: loc.id, homeLocationId: loc.id }, { transaction: t });
      await models.PhysicalItemMovement.create(
        {
          itemId: item.id,
          toLocationId: loc.id,
          movementType: 'initial_placement',
          reason: 'Initial placement',
          movedById: user.id,
          movedAt: new Date(),
          capacityOverride: check.overridden,
          overrideReason: check.overridden ? overrideReason : null,
        },
        { transaction: t },
      );
    }
    await audit(
      {
        action: 'physical_item.create',
        resourceType: 'PhysicalItem',
        resourceId: item.id,
        after: { barcode: item.barcode, title: item.title, locationId },
      },
      { transaction: t },
    );
    return item;
  });
}

/**
 * Moves an item to another location and records the movement.
 *
 * Issued, disposed and withdrawn items cannot be moved here, and restricted locations need "locations.manage". A
 * permanent move also changes the item's home location; a move to conservation marks it as in conservation, and
 * moving a missing or conserved item makes it available again. A capacity override and its reason are recorded with
 * the movement and in the audit trail.
 *
 * @param {string} itemId Identifier of the item.
 * @param {{ toLocationId: string, movementType: string, reason?: string, expectedReturnAt?: string, override?:
 *   boolean, overrideReason?: string, approvedById?: string }} input Movement details.
 * @param {object} user Authenticated principal.
 * @param {import('sequelize').Transaction} [transaction] Existing transaction, used by bulk moves.
 * @returns {Promise<object>} The moved item.
 * @throws {AppError} When the item or location is not found or the move is not allowed.
 */
export async function moveItem(
  itemId,
  { toLocationId, movementType, reason, expectedReturnAt, override, overrideReason, approvedById },
  user,
  transaction,
) {
  /**
   * Performs the movement inside the given transaction.
   *
   * @param {import('sequelize').Transaction} t Transaction to use.
   * @returns {Promise<object>}
   */
  const run = async (t) => {
    const item = await models.PhysicalItem.findByPk(itemId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!item) throw notFound('Physical item');
    if (['issued', 'disposed', 'withdrawn'].includes(item.status))
      throw conflict(`An item that is ${item.status} cannot be moved here`);
    const to = await models.StorageLocation.findByPk(toLocationId, { transaction: t });
    if (!to) throw notFound('Destination location');
    if (to.id === item.currentLocationId) throw badRequest('The item is already in that location');
    if (to.isRestricted && !hasPerm(user, 'locations.manage')) throw forbidden(`${to.code} is a restricted location`);
    const check = await assertPlacement(to, item, { override, overrideReason, user, transaction: t });
    const from = item.currentLocationId;
    await models.PhysicalItemMovement.create(
      {
        itemId,
        fromLocationId: from,
        toLocationId: to.id,
        movementType,
        reason,
        movedById: user.id,
        approvedById: approvedById ?? null,
        movedAt: new Date(),
        expectedReturnAt: movementType === 'temporary' ? expectedReturnAt : null,
        capacityOverride: check.overridden,
        overrideReason: check.overridden ? overrideReason : null,
      },
      { transaction: t },
    );
    const patch = { currentLocationId: to.id };
    if (movementType === 'permanent') patch.homeLocationId = to.id;
    if (movementType === 'conservation') patch.status = 'in_conservation';
    else if (item.status === 'in_conservation' || item.status === 'missing') patch.status = 'available';
    await item.update(patch, { transaction: t });
    await audit(
      {
        action: 'physical_item.move',
        resourceType: 'PhysicalItem',
        resourceId: itemId,
        before: { locationId: from },
        after: { locationId: to.id, movementType },
        reason: check.overridden ? `${reason} [capacity override: ${overrideReason}]` : reason,
      },
      { transaction: t },
    );
    return item;
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * Moves several items to the same location in one transaction: if any move fails, none is applied.
 *
 * @param {string[]} itemIds Items to move.
 * @param {object} payload Movement details, as for `moveItem`.
 * @param {object} user Authenticated principal.
 * @returns {Promise<number>} Number of items moved.
 */
export async function bulkMove(itemIds, payload, user) {
  return sequelize.transaction(async (t) => {
    const results = [];
    for (const id of itemIds) results.push(await moveItem(id, payload, user, t));
    return results.length;
  });
}

/**
 * Marks an item as missing, recording its previous status and the reason.
 *
 * @param {string} itemId Identifier of the item.
 * @param {string} reason What is known about the loss.
 * @returns {Promise<object>} The updated item.
 */
export async function reportMissing(itemId, reason) {
  return sequelize.transaction(async (t) => {
    const item = await models.PhysicalItem.findByPk(itemId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!item) throw notFound('Physical item');
    const before = item.status;
    await item.update({ status: 'missing' }, { transaction: t });
    await audit(
      {
        action: 'physical_item.reported_missing',
        resourceType: 'PhysicalItem',
        resourceId: itemId,
        before: { status: before },
        after: { status: 'missing' },
        reason,
      },
      { transaction: t },
    );
    return item;
  });
}

/**
 * Records a condition assessment for an item and updates its current condition rating.
 *
 * @param {string} itemId Identifier of the item.
 * @param {{ rating: string, context?: string, notes?: string }} data The assessment.
 * @param {object} user Assessor.
 * @returns {Promise<object>} The assessment.
 */
export async function assessCondition(itemId, data, user) {
  return sequelize.transaction(async (t) => {
    const item = await models.PhysicalItem.findByPk(itemId, { transaction: t });
    if (!item) throw notFound('Physical item');
    const a = await models.ConditionAssessment.create({ ...data, itemId, assessedById: user.id }, { transaction: t });
    await item.update({ conditionRating: data.rating }, { transaction: t });
    await audit(
      {
        action: 'physical_item.condition_assessed',
        resourceType: 'PhysicalItem',
        resourceId: itemId,
        after: { rating: data.rating, context: data.context },
      },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Starts an inventory audit of a location and everything below it. Only one audit can be open per location.
 *
 * @param {string} locationId Identifier of the location.
 * @param {object} user Authenticated principal.
 * @param {string} [notes] Notes about the audit.
 * @returns {Promise<object>} The audit.
 * @throws {AppError} When the location does not exist or an audit is already open.
 */
export async function startAudit(locationId, user, notes) {
  const loc = await models.StorageLocation.findByPk(locationId);
  if (!loc) throw notFound('Location');
  if (await models.InventoryAudit.findOne({ where: { locationId, status: 'open' } }))
    throw conflict('An audit is already open for this location');
  const a = await models.InventoryAudit.create({ locationId, startedById: user.id, notes });
  await audit({
    action: 'inventory_audit.start',
    resourceType: 'StorageLocation',
    resourceId: locationId,
    after: { auditId: a.id },
  });
  return a;
}

/**
 * Lists a location and all locations below it, using the materialised path.
 *
 * @param {{ path: string }} loc The top location.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<Array<{ id: string }>>}
 */
async function locationsUnder(loc, transaction) {
  return models.StorageLocation.findAll({
    where: { path: { [Op.like]: `${loc.path}%` } },
    attributes: ['id'],
    transaction,
  });
}

/**
 * Records a barcode scanned during an open inventory audit as found (recorded within the audited area), misplaced
 * (recorded elsewhere) or unexpected (unknown barcode).
 *
 * @param {string} auditId Identifier of the audit.
 * @param {string} barcode Scanned barcode.
 * @returns {Promise<{ line: object, item: object|null }>}
 * @throws {AppError} 404 when the audit is not open.
 */
export async function recordScan(auditId, barcode) {
  const a = await models.InventoryAudit.findByPk(auditId, {
    include: [{ model: models.StorageLocation, as: 'location' }],
  });
  if (!a || a.status !== 'open') throw notFound('Open audit');
  const item = await models.PhysicalItem.findOne({ where: { barcode } });
  const under = new Set((await locationsUnder(a.location)).map((l) => l.id));
  const outcome = !item ? 'unexpected' : under.has(item.currentLocationId) ? 'found' : 'misplaced';
  const line = await models.InventoryAuditLine.create({
    auditId,
    itemId: item?.id ?? null,
    scannedBarcode: barcode,
    outcome,
    note: outcome === 'misplaced' ? 'Recorded at another location' : null,
  });
  return { line, item: item ? { id: item.id, title: item.title, status: item.status } : null };
}

/**
 * Completes an inventory audit. Every item expected in the audited area that was not scanned is recorded as missing
 * and, if requested, marked missing. A summary of expected, found, misplaced, unexpected and missing items is
 * stored.
 *
 * @param {string} auditId Identifier of the audit.
 * @param {{ markMissing?: boolean }} input Whether to mark unscanned items as missing.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The completed audit.
 * @throws {AppError} 404 when the audit is not open.
 */
export async function completeAudit(auditId, { markMissing }, user) {
  return sequelize.transaction(async (t) => {
    const a = await models.InventoryAudit.findByPk(auditId, {
      include: [{ model: models.StorageLocation, as: 'location' }],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!a || a.status !== 'open') throw notFound('Open audit');
    const under = (await locationsUnder(a.location, t)).map((l) => l.id);
    const expected = await models.PhysicalItem.findAll({
      where: {
        currentLocationId: under,
        status: { [Op.in]: ['available', 'reserved', 'in_transit', 'in_conservation'] },
      },
      attributes: ['id', 'barcode'],
      transaction: t,
    });
    const lines = await models.InventoryAuditLine.findAll({ where: { auditId }, transaction: t });
    const scanned = new Set(lines.filter((l) => l.itemId).map((l) => l.itemId));
    const missing = expected.filter((e) => !scanned.has(e.id));
    for (const m of missing) {
      await models.InventoryAuditLine.create(
        { auditId, itemId: m.id, scannedBarcode: m.barcode, outcome: 'missing' },
        { transaction: t },
      );
      if (markMissing) await models.PhysicalItem.update({ status: 'missing' }, { where: { id: m.id }, transaction: t });
    }
    const summary = {
      expected: expected.length,
      found: lines.filter((l) => l.outcome === 'found').length,
      misplaced: lines.filter((l) => l.outcome === 'misplaced').length,
      unexpected: lines.filter((l) => l.outcome === 'unexpected').length,
      missing: missing.length,
      markedMissing: Boolean(markMissing),
    };
    await a.update(
      { status: 'completed', completedById: user.id, completedAt: new Date(), summary },
      { transaction: t },
    );
    await audit(
      { action: 'inventory_audit.complete', resourceType: 'StorageLocation', resourceId: a.locationId, after: summary },
      { transaction: t },
    );
    return a;
  });
}

/**
 * Lists the ancestors of a location from the top down, for breadcrumb navigation.
 *
 * @param {{ id: string, path: string }} loc The location.
 * @returns {Promise<Array<{ id: string, code: string, name: string }>>}
 */
export async function locationBreadcrumbs(loc) {
  const ids = pathIds(loc.path).filter((id) => id !== loc.id);
  if (!ids.length) return [];
  const rows = await models.StorageLocation.findAll({ where: { id: ids }, attributes: ['id', 'code', 'name'] });
  const m = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => m.get(id)).filter(Boolean);
}
