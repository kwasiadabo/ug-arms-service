/**
 * Sequelize model definitions for the research services and reading room domain.
 *
 * Defines the tables for research requests and their items, reading rooms, closure days, appointment slots,
 * appointments, circulation transactions, reproduction requests, researchers' saved records, saved searches, search
 * logs and catalogue feedback. Circulation transactions record the condition of an item when it is issued and when
 * it is returned, so damage can be traced to a specific visit.
 *
 * The status lists exported from this module are the single source of the allowed workflow states; the workflow
 * service and validators import them rather than repeating the values.
 *
 * @author Kwasi Adabo Boakye
 */

import { pk, fk, str, req, text, bool, int, date, dateOnly, status, json, dec, uniqueWhenSet } from './_helpers.js';

export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'awaiting_researcher',
  'awaiting_approval',
  'approved',
  'rejected',
  'scheduled',
  'in_progress',
  'fulfilled',
  'closed',
  'cancelled',
];
export const CIRCULATION_STATUSES = [
  'requested',
  'approved',
  'issued',
  'returned',
  'overdue',
  'lost',
  'damaged',
  'closed',
];

/**
 * Defines the research services and reading room models on the given connection.
 *
 * @param {import('sequelize').Sequelize} sequelize Connection to define the models on.
 * @returns {Record<string, import('sequelize').ModelStatic>} The defined models keyed by name.
 */
export default function defineResearch(sequelize) {
  const ResearchRequest = sequelize.define(
    'ResearchRequest',
    {
      id: pk(),
      requestNumber: str(60),
      requesterId: fk(),
      contactName: req(200),
      contactEmail: req(320),
      contactPhone: str(60),
      affiliation: str(255),
      requestType: status(['consultation', 'digital_copy', 'restricted_access', 'enquiry', 'reproduction']),
      purpose: text(),
      preferredDate: dateOnly(),
      deliveryPreference: str(255),
      restrictionsAcknowledged: bool(false),
      status: status(REQUEST_STATUSES, 'draft'),
      assignedToId: fk(),
      requiresSecondApproval: bool(false),
      decisionById: fk(),
      decisionAt: date(),
      publicDecisionNote: str(2000),
      internalDecisionNote: text(),
      conditions: str(2000),
      secondApproverId: fk(),
      secondApprovedAt: date(),
      feeAmount: dec(12, 2),
      feeCurrency: str(3),
      paymentStatus: status(['not_applicable', 'pending', 'paid', 'waived'], 'not_applicable'),
      submittedAt: date(),
      completedAt: date(),
    },
    { version: true, indexes: [uniqueWhenSet('requestNumber'), { fields: ['status'] }, { fields: ['requesterId'] }] },
  );

  const ResearchRequestItem = sequelize.define(
    'ResearchRequestItem',
    {
      id: pk(),
      requestId: fk(false),
      recordId: fk(false),
      assetId: fk(),
      physicalItemId: fk(),
      notes: str(1000),
      decision: status(['pending', 'approved', 'rejected'], 'pending'),
      decisionNote: str(1000),
    },
    { indexes: [{ fields: ['requestId'] }, { fields: ['recordId'] }] },
  );

  const ReadingRoom = sequelize.define('ReadingRoom', {
    id: pk(),
    repositoryId: fk(),
    name: req(200),
    location: str(500),
    capacity: int(10),
    openingHours: json('openingHours', {}),
    rules: text(),
    isActive: bool(true),
  });

  const ReadingRoomClosure = sequelize.define(
    'ReadingRoomClosure',
    {
      id: pk(),
      readingRoomId: fk(false),
      date: dateOnly({ allowNull: false }),
      reason: str(500),
    },
    { indexes: [{ unique: true, fields: ['readingRoomId', 'date'] }] },
  );

  const AppointmentSlot = sequelize.define(
    'AppointmentSlot',
    {
      id: pk(),
      readingRoomId: fk(false),
      startsAt: date({ allowNull: false }),
      endsAt: date({ allowNull: false }),
      capacity: int(4),
      isActive: bool(true),
    },
    { indexes: [{ unique: true, fields: ['readingRoomId', 'startsAt'] }] },
  );

  const ResearchAppointment = sequelize.define(
    'ResearchAppointment',
    {
      id: pk(),
      slotId: fk(false),
      requestId: fk(),
      researcherId: fk(),
      researcherName: req(200),
      researcherEmail: str(320),
      status: status(['booked', 'checked_in', 'completed', 'cancelled', 'no_show'], 'booked'),
      identityVerified: bool(false),
      identityMethod: str(120),
      checkedInAt: date(),
      checkedInById: fk(),
      cancelledAt: date(),
      cancellationReason: str(1000),
      reminderSentAt: date(),
      notes: str(2000),
    },
    { version: true, indexes: [{ fields: ['slotId'] }, { fields: ['requestId'] }, { fields: ['researcherId'] }] },
  );

  const CirculationTransaction = sequelize.define(
    'CirculationTransaction',
    {
      id: pk(),
      physicalItemId: fk(false),
      requestId: fk(),
      appointmentId: fk(),
      researcherId: fk(),
      researcherName: str(200),
      status: status(CIRCULATION_STATUSES, 'issued'),
      issuedById: fk(),
      issuedAt: date(),
      expectedReturnAt: date(),
      returnedAt: date(),
      receivedById: fk(),
      conditionBefore: str(40),
      conditionBeforeNotes: str(2000),
      conditionAfter: str(40),
      conditionAfterNotes: str(2000),
      incidentNotes: text(),
    },
    {
      version: true,
      indexes: [{ fields: ['physicalItemId', 'status'] }, { fields: ['requestId'] }, { fields: ['expectedReturnAt'] }],
    },
  );

  const ReproductionRequest = sequelize.define(
    'ReproductionRequest',
    {
      id: pk(),
      requestId: fk(false),
      recordId: fk(false),
      assetId: fk(),
      format: str(80),
      rightsCleared: bool(false),
      rightsNote: str(1000),
      status: status(['pending', 'approved', 'in_production', 'delivered', 'rejected'], 'pending'),
      deliveredAssetId: fk(),
      deliveredAt: date(),
    },
    { indexes: [{ fields: ['requestId'] }] },
  );

  // Researcher "saved records" lists and saved searches.
  const ResearchListItem = sequelize.define(
    'ResearchListItem',
    {
      id: pk(),
      userId: fk(false),
      recordId: fk(false),
      note: str(1000),
    },
    { indexes: [{ unique: true, fields: ['userId', 'recordId'] }] },
  );

  const SavedSearch = sequelize.define(
    'SavedSearch',
    {
      id: pk(),
      userId: fk(false),
      name: req(200),
      query: json('query', {}),
    },
    { indexes: [{ fields: ['userId'] }] },
  );

  const SearchLog = sequelize.define(
    'SearchLog',
    {
      id: pk(),
      userId: fk(),
      scope: status(['public', 'staff']),
      queryText: str(500),
      filters: json('filters', {}),
      resultCount: int(0),
      durationMs: int(),
    },
    { updatedAt: false, indexes: [{ fields: ['createdAt'] }] },
  );

  const CatalogueFeedback = sequelize.define(
    'CatalogueFeedback',
    {
      id: pk(),
      recordId: fk(false),
      userId: fk(),
      contactEmail: str(320),
      message: req(4000),
      status: status(['new', 'reviewed', 'actioned', 'dismissed'], 'new'),
      reviewedById: fk(),
    },
    { indexes: [{ fields: ['recordId'] }] },
  );

  return {
    ResearchRequest,
    ResearchRequestItem,
    ReadingRoom,
    ReadingRoomClosure,
    AppointmentSlot,
    ResearchAppointment,
    CirculationTransaction,
    ReproductionRequest,
    ResearchListItem,
    SavedSearch,
    SearchLog,
    CatalogueFeedback,
  };
}
