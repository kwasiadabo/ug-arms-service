/**
 * Sequelize model definitions for the physical storage domain.
 *
 * Defines the tables for storage location types, the location hierarchy (repository, building, room, shelf, box and
 * so on), physical items, item movements, condition assessments, inventory audits and audit lines. Each location
 * records its capacity and a materialised path, so occupancy checks and "everything inside this room" queries do
 * not need recursive SQL.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, text, bool, int, date, status, json, dec } from './_helpers.js';

export const PHYSICAL_STATUSES = [
  'available',
  'reserved',
  'issued',
  'in_transit',
  'in_conservation',
  // Out of storage for scanning in a digitisation batch; returns to its shelf when the batch ends.
  'in_digitisation',
  'missing',
  'withdrawn',
  'disposed',
];

/**
 * Defines the physical storage models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function definePhysical(sequelize) {
  const StorageLocationType = sequelize.define(
    'StorageLocationType',
    {
      id: pk(),
      code: req(40),
      name: req(120),
      rank: int(0),
    },
    { indexes: [{ unique: true, fields: ['code'] }] },
  );

  const StorageLocation = sequelize.define(
    'StorageLocation',
    {
      id: pk(),
      repositoryId: fk(),
      typeId: fk(false),
      parentId: fk(),
      path: str(2000),
      code: req(80),
      name: req(255),
      capacity: dec(12, 2),
      capacityUnit: status(['items', 'boxes', 'linear_metres', 'cubic_metres'], 'boxes'),
      materialRestrictions: json('materialRestrictions', []),
      environmentRef: str(255),
      isRestricted: bool(false),
      restrictionNote: str(1000),
      isActive: bool(true),
      barcode: str(120),
    },
    { version: true, indexes: [{ unique: true, fields: ['code'] }, { fields: ['parentId'] }] },
  );

  const PhysicalItem = sequelize.define(
    'PhysicalItem',
    {
      id: pk(),
      barcode: req(120),
      itemType: status(
        ['box', 'folder', 'volume', 'item', 'map', 'drawing', 'photograph', 'audiovisual_carrier', 'artefact', 'other'],
        'box',
      ),
      title: req(1000),
      recordId: fk(),
      accessionId: fk(),
      currentLocationId: fk(),
      homeLocationId: fk(),
      status: status(PHYSICAL_STATUSES, 'available'),
      materialType: str(80),
      sizeUnits: dec(10, 2, { defaultValue: 1 }),
      conditionRating: status(['good', 'fair', 'poor', 'critical', 'unknown'], 'unknown'),
      isFragile: bool(false),
      handlingNotes: str(2000),
      notes: text(),
      createdById: fk(),
    },
    {
      version: true,
      indexes: [
        { unique: true, fields: ['barcode'] },
        { fields: ['recordId'] },
        { fields: ['currentLocationId'] },
        { fields: ['status'] },
      ],
    },
  );

  const PhysicalItemMovement = sequelize.define(
    'PhysicalItemMovement',
    {
      id: pk(),
      itemId: fk(false),
      fromLocationId: fk(),
      toLocationId: fk(),
      movementType: status([
        'initial_placement',
        'temporary',
        'permanent',
        'issue',
        'return',
        'conservation',
        'audit_correction',
        'disposal',
        'digitisation',
      ]),
      reason: req(1000),
      movedById: fk(false),
      approvedById: fk(),
      movedAt: date({ allowNull: false }),
      expectedReturnAt: date(),
      capacityOverride: bool(false),
      overrideReason: str(1000),
      circulationId: fk(),
    },
    { updatedAt: false, indexes: [{ fields: ['itemId', 'movedAt'] }] },
  );

  const ConditionAssessment = sequelize.define(
    'ConditionAssessment',
    {
      id: pk(),
      itemId: fk(false),
      context: status(['accession', 'issue', 'return', 'audit', 'conservation', 'digitisation', 'routine']),
      rating: status(['good', 'fair', 'poor', 'critical']),
      notes: str(4000),
      recommendedAction: str(1000),
      assessedById: fk(false),
      circulationId: fk(),
    },
    { updatedAt: false, indexes: [{ fields: ['itemId'] }] },
  );

  const InventoryAudit = sequelize.define(
    'InventoryAudit',
    {
      id: pk(),
      locationId: fk(false),
      status: status(['open', 'completed', 'cancelled'], 'open'),
      startedById: fk(false),
      completedById: fk(),
      completedAt: date(),
      summary: json('summary', {}),
      notes: str(2000),
    },
    { indexes: [{ fields: ['locationId'] }] },
  );

  const InventoryAuditLine = sequelize.define(
    'InventoryAuditLine',
    {
      id: pk(),
      auditId: fk(false),
      itemId: fk(),
      scannedBarcode: str(120),
      outcome: status(['found', 'missing', 'unexpected', 'misplaced']),
      note: str(1000),
    },
    { indexes: [{ fields: ['auditId'] }] },
  );

  return {
    StorageLocationType,
    StorageLocation,
    PhysicalItem,
    PhysicalItemMovement,
    ConditionAssessment,
    InventoryAudit,
    InventoryAuditLine,
  };
}
