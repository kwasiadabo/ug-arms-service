/**
 * Catalogue of the reports offered in the reports centre.
 *
 * Each report declares its group, title, required permission, whether it is sensitive, its columns and the query
 * that produces it. Queries apply the same access rules as the screens: descriptive content is limited to the
 * access levels the requesting user may read. All values passed into SQL are escaped or bound.
 *
 * @author Kwasi Adabo Boakye
 */

import { sequelize } from '../../database/models/index.js';
import { staffReadableLevels } from '../../services/accessPolicy.service.js';

/**
 * Runs a read-only SQL query with named replacements and returns the rows.
 *
 * @param {string} sql SQL text with :name placeholders.
 * @param {object} [replacements] Values for the placeholders.
 * @returns {Promise<object[]>}
 */
const q = (sql, replacements) => sequelize.query(sql, { type: 'SELECT', replacements });

/**
 * Converts a report's date filters into an inclusive UTC timestamp range; missing ends become a very early or very
 * late date.
 *
 * @param {{ from?: string, to?: string }} f Dates in YYYY-MM-DD form.
 * @returns {{ from: string, to: string }}
 */
const range = (f) => ({
  from: f.from ? `${f.from}T00:00:00Z` : '1900-01-01T00:00:00Z',
  to: f.to ? `${f.to}T23:59:59Z` : '2999-12-31T23:59:59Z',
});

/**
 * Builds an escaped SQL list of the access levels whose content the user may read, for use in an IN clause. A
 * placeholder value is used when the user may read none, so the clause matches nothing.
 *
 * @param {object} user Authenticated principal.
 * @returns {string}
 */
const levelsIn = (user) =>
  staffReadableLevels(user)
    .map((l) => sequelize.escape(l))
    .join(',') || "'__none__'";

// Each report declares its permission, sensitivity and columns. Queries apply the same access rules as
// the application: descriptive content is limited to access levels the requesting user may read.
export const REPORTS = {
  collections_by_category: {
    group: 'Collection management',
    title: 'Collections by category',
    perm: 'reports.view',
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'collections', label: 'Collections' },
      { key: 'descriptions', label: 'Descriptions (all levels)' },
    ],
    run: () =>
      q(
        `SELECT COALESCE(root.collectionType, 'Unspecified') AS category, COUNT(DISTINCT root.id) AS collections, COUNT(r.id) AS descriptions FROM ArchivalRecords root LEFT JOIN ArchivalRecords r ON r.rootId = root.id WHERE root.parentId IS NULL GROUP BY COALESCE(root.collectionType, 'Unspecified') ORDER BY collections DESC`,
      ),
  },
  collections_by_department: {
    group: 'Collection management',
    title: 'Descriptions by originating department',
    perm: 'reports.view',
    columns: [
      { key: 'department', label: 'Department' },
      { key: 'descriptions', label: 'Descriptions' },
      { key: 'published', label: 'Published' },
    ],
    run: () =>
      q(
        `SELECT COALESCE(ou.name, 'Not recorded') AS department, COUNT(*) AS descriptions, SUM(CASE WHEN r.status = 'published' THEN 1 ELSE 0 END) AS published FROM ArchivalRecords r LEFT JOIN OrganisationUnits ou ON ou.id = r.originatingUnitId GROUP BY COALESCE(ou.name, 'Not recorded') ORDER BY descriptions DESC`,
      ),
  },
  unpublished_descriptions: {
    group: 'Collection management',
    title: 'Unpublished descriptions and review queue',
    perm: 'reports.view',
    columns: [
      { key: 'referenceCode', label: 'Reference' },
      { key: 'title', label: 'Title' },
      { key: 'level', label: 'Level' },
      { key: 'status', label: 'Status' },
      { key: 'updatedAt', label: 'Last updated' },
    ],
    run: (f, user) =>
      q(
        `SELECT referenceCode, title, level, status, updatedAt FROM ArchivalRecords WHERE status IN ('draft','in_review','approved') AND effectiveAccessLevel IN (${levelsIn(user)}) ORDER BY status, updatedAt`,
      ),
  },
  collection_growth: {
    group: 'Collection management',
    title: 'Collection growth by month',
    perm: 'reports.view',
    columns: [
      { key: 'month', label: 'Month' },
      { key: 'created', label: 'Descriptions created' },
      { key: 'published', label: 'Published' },
    ],
    run: (f) =>
      q(
        `SELECT FORMAT(createdAt, 'yyyy-MM') AS month, COUNT(*) AS created, SUM(CASE WHEN publishedAt IS NOT NULL THEN 1 ELSE 0 END) AS published FROM ArchivalRecords WHERE createdAt BETWEEN :from AND :to GROUP BY FORMAT(createdAt, 'yyyy-MM') ORDER BY month`,
        range(f),
      ),
  },
  accessions_by_year: {
    group: 'Accessioning',
    title: 'Accessions by year and status',
    perm: 'reports.view',
    columns: [
      { key: 'year', label: 'Year' },
      { key: 'status', label: 'Status' },
      { key: 'accessions', label: 'Accessions' },
    ],
    run: () =>
      q(
        `SELECT YEAR(COALESCE(accessionDate, CAST(createdAt AS DATE))) AS year, status, COUNT(*) AS accessions FROM Accessions GROUP BY YEAR(COALESCE(accessionDate, CAST(createdAt AS DATE))), status ORDER BY year DESC, status`,
      ),
  },
  transfer_sources: {
    group: 'Accessioning',
    title: 'Transfer sources',
    perm: 'reports.view',
    columns: [
      { key: 'unit', label: 'Originating unit' },
      { key: 'submissions', label: 'Submissions' },
      { key: 'accepted', label: 'Accepted' },
      { key: 'openQueries', label: 'Open queries' },
    ],
    run: (f) =>
      q(
        `SELECT ou.name AS unit, COUNT(*) AS submissions, SUM(CASE WHEN t.status IN ('accepted','partially_accepted') THEN 1 ELSE 0 END) AS accepted, SUM(CASE WHEN t.status = 'query_raised' THEN 1 ELSE 0 END) AS openQueries FROM TransferSubmissions t JOIN OrganisationUnits ou ON ou.id = t.originatingUnitId WHERE t.createdAt BETWEEN :from AND :to GROUP BY ou.name ORDER BY submissions DESC`,
        range(f),
      ),
  },
  digitisation_progress: {
    group: 'Digitisation',
    title: 'Digitisation progress by batch',
    perm: 'reports.view',
    columns: [
      { key: 'batchNumber', label: 'Batch' },
      { key: 'project', label: 'Project' },
      { key: 'status', label: 'Status' },
      { key: 'operator', label: 'Operator' },
      { key: 'items', label: 'Items' },
      { key: 'passed', label: 'QA passed' },
      { key: 'failed', label: 'QA failed / rework' },
    ],
    run: () =>
      q(
        `SELECT b.batchNumber, p.title AS project, b.status, u.fullName AS operator, COUNT(i.id) AS items, SUM(CASE WHEN i.status = 'qa_passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN i.status IN ('qa_failed','rework') THEN 1 ELSE 0 END) AS failed FROM DigitisationBatches b JOIN DigitisationProjects p ON p.id = b.projectId LEFT JOIN Users u ON u.id = b.operatorId LEFT JOIN DigitisationItems i ON i.batchId = b.id GROUP BY b.batchNumber, p.title, b.status, u.fullName ORDER BY b.batchNumber DESC`,
      ),
  },
  qa_rework_rates: {
    group: 'Digitisation',
    title: 'QA outcomes by reviewer',
    perm: 'reports.view',
    columns: [
      { key: 'reviewer', label: 'Reviewer' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'reviews', label: 'Reviews' },
    ],
    run: (f) =>
      q(
        `SELECT u.fullName AS reviewer, r.outcome, COUNT(*) AS reviews FROM QualityAssuranceReviews r JOIN Users u ON u.id = r.reviewerId WHERE r.createdAt BETWEEN :from AND :to GROUP BY u.fullName, r.outcome ORDER BY reviewer`,
        range(f),
      ),
  },
  ocr_completion: {
    group: 'Digitisation',
    title: 'OCR jobs by status',
    perm: 'reports.view',
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'jobs', label: 'Jobs' },
      { key: 'meanConfidence', label: 'Mean confidence' },
    ],
    run: (f) =>
      q(
        `SELECT status, COUNT(*) AS jobs, AVG(CAST(meanConfidence AS FLOAT)) AS meanConfidence FROM OCRJobs WHERE createdAt BETWEEN :from AND :to GROUP BY status`,
        range(f),
      ),
  },
  fixity_results: {
    group: 'Preservation',
    title: 'Fixity check results',
    perm: 'preservation.read',
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'status', label: 'Result' },
      { key: 'checks', label: 'Checks' },
    ],
    run: (f) =>
      q(
        `SELECT CAST(checkedAt AS DATE) AS day, status, COUNT(*) AS checks FROM FixityChecks WHERE checkedAt BETWEEN :from AND :to GROUP BY CAST(checkedAt AS DATE), status ORDER BY day DESC`,
        range(f),
      ),
  },
  at_risk_assets: {
    group: 'Preservation',
    title: 'Corrupt, missing and at-risk assets',
    perm: 'preservation.read',
    columns: [
      { key: 'assetId', label: 'Asset ID' },
      { key: 'originalFilename', label: 'File' },
      { key: 'mediaType', label: 'Format' },
      { key: 'preservationStatus', label: 'Status' },
      { key: 'formatRisk', label: 'Format risk' },
      { key: 'lastFixityAt', label: 'Last fixity' },
    ],
    run: () =>
      q(
        `SELECT id AS assetId, originalFilename, mediaType, preservationStatus, formatRisk, lastFixityAt FROM DigitalAssets WHERE status <> 'deleted' AND (preservationStatus IN ('fixity_failed','missing','at_risk') OR formatRisk = 'high') ORDER BY preservationStatus`,
      ),
  },
  research_requests: {
    group: 'Research services',
    title: 'Research requests by type and status',
    perm: 'reports.view',
    columns: [
      { key: 'requestType', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'requests', label: 'Requests' },
      { key: 'avgDaysToDecision', label: 'Average days to decision' },
    ],
    run: (f) =>
      q(
        `SELECT requestType, status, COUNT(*) AS requests, AVG(CAST(DATEDIFF(hour, submittedAt, decisionAt) AS FLOAT)) / 24 AS avgDaysToDecision FROM ResearchRequests WHERE createdAt BETWEEN :from AND :to GROUP BY requestType, status ORDER BY requestType, status`,
        range(f),
      ),
  },
  reading_room_attendance: {
    group: 'Research services',
    title: 'Reading-room attendance',
    perm: 'reports.view',
    columns: [
      { key: 'day', label: 'Day' },
      { key: 'room', label: 'Reading room' },
      { key: 'booked', label: 'Booked' },
      { key: 'attended', label: 'Attended' },
      { key: 'noShows', label: 'No-shows' },
    ],
    run: (f) =>
      q(
        `SELECT CAST(s.startsAt AS DATE) AS day, rr.name AS room, COUNT(a.id) AS booked, SUM(CASE WHEN a.status IN ('checked_in','completed') THEN 1 ELSE 0 END) AS attended, SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) AS noShows FROM ResearchAppointments a JOIN AppointmentSlots s ON s.id = a.slotId JOIN ReadingRooms rr ON rr.id = s.readingRoomId WHERE s.startsAt BETWEEN :from AND :to GROUP BY CAST(s.startsAt AS DATE), rr.name ORDER BY day DESC`,
        range(f),
      ),
  },
  popular_collections: {
    group: 'Research services',
    title: 'Most requested collections',
    perm: 'reports.view',
    columns: [
      { key: 'referenceCode', label: 'Reference' },
      { key: 'title', label: 'Collection' },
      { key: 'requests', label: 'Requests' },
    ],
    run: (f) =>
      q(
        `SELECT TOP 50 root.referenceCode, root.title, COUNT(DISTINCT i.requestId) AS requests FROM ResearchRequestItems i JOIN ArchivalRecords r ON r.id = i.recordId JOIN ArchivalRecords root ON root.id = r.rootId JOIN ResearchRequests rq ON rq.id = i.requestId WHERE rq.createdAt BETWEEN :from AND :to GROUP BY root.referenceCode, root.title ORDER BY requests DESC`,
        range(f),
      ),
  },
  overdue_items: {
    group: 'Research services',
    title: 'Outstanding and overdue physical items',
    perm: 'reports.view',
    columns: [
      { key: 'barcode', label: 'Barcode' },
      { key: 'title', label: 'Item' },
      { key: 'researcherName', label: 'Researcher' },
      { key: 'issuedAt', label: 'Issued' },
      { key: 'expectedReturnAt', label: 'Due' },
      { key: 'status', label: 'Status' },
    ],
    run: () =>
      q(
        `SELECT p.barcode, p.title, c.researcherName, c.issuedAt, c.expectedReturnAt, c.status FROM CirculationTransactions c JOIN PhysicalItems p ON p.id = c.physicalItemId WHERE c.status IN ('issued','overdue') ORDER BY c.expectedReturnAt`,
      ),
  },
  access_changes: {
    group: 'Governance',
    title: 'Access and restriction changes',
    perm: 'audit.read',
    sensitive: true,
    columns: [
      { key: 'occurredAt', label: 'When' },
      { key: 'actorLabel', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'resourceType', label: 'Resource' },
      { key: 'resourceId', label: 'Resource ID' },
      { key: 'reason', label: 'Reason' },
    ],
    run: (f) =>
      q(
        `SELECT occurredAt, actorLabel, action, resourceType, resourceId, reason FROM AuditEvents WHERE action LIKE 'access.%' AND occurredAt BETWEEN :from AND :to ORDER BY seq DESC`,
        range(f),
      ),
  },
  disposal_register: {
    group: 'Governance',
    title: 'Disposal register',
    perm: 'audit.read',
    sensitive: true,
    columns: [
      { key: 'certificateNumber', label: 'Certificate' },
      { key: 'caseNumber', label: 'Case' },
      { key: 'action', label: 'Action' },
      { key: 'issuedAt', label: 'Issued' },
      { key: 'sha256', label: 'Certificate SHA-256' },
    ],
    run: () =>
      q(
        `SELECT c.certificateNumber, d.caseNumber, d.action, c.issuedAt, c.sha256 FROM DisposalCertificates c JOIN DisposalCases d ON d.id = c.disposalCaseId ORDER BY c.issuedAt DESC`,
      ),
  },
  user_activity: {
    group: 'Governance',
    title: 'User activity summary',
    perm: 'audit.read',
    sensitive: true,
    columns: [
      { key: 'actorLabel', label: 'User' },
      { key: 'events', label: 'Events' },
      { key: 'denied', label: 'Denied' },
      { key: 'failedLogins', label: 'Failed logins' },
      { key: 'lastSeen', label: 'Last activity' },
    ],
    run: (f) =>
      q(
        `SELECT actorLabel, COUNT(*) AS events, SUM(CASE WHEN outcome = 'denied' THEN 1 ELSE 0 END) AS denied, SUM(CASE WHEN action = 'auth.login' AND outcome = 'failure' THEN 1 ELSE 0 END) AS failedLogins, MAX(occurredAt) AS lastSeen FROM AuditEvents WHERE occurredAt BETWEEN :from AND :to AND actorLabel IS NOT NULL GROUP BY actorLabel ORDER BY events DESC`,
        range(f),
      ),
  },
  metadata_changes: {
    group: 'Governance',
    title: 'Metadata changes',
    perm: 'audit.read',
    columns: [
      { key: 'occurredAt', label: 'When' },
      { key: 'actorLabel', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'resourceId', label: 'Description ID' },
    ],
    run: (f) =>
      q(
        `SELECT occurredAt, actorLabel, action, resourceId FROM AuditEvents WHERE resourceType = 'ArchivalRecord' AND occurredAt BETWEEN :from AND :to ORDER BY seq DESC`,
        range(f),
      ),
  },
  permission_exceptions: {
    group: 'Governance',
    title: 'Access exceptions and denied requests',
    perm: 'audit.read',
    sensitive: true,
    columns: [
      { key: 'occurredAt', label: 'When' },
      { key: 'actorLabel', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'resourceId', label: 'Resource' },
      { key: 'outcome', label: 'Outcome' },
    ],
    run: (f) =>
      q(
        `SELECT occurredAt, actorLabel, action, resourceId, outcome FROM AuditEvents WHERE (outcome = 'denied' OR action LIKE 'access.exception%') AND occurredAt BETWEEN :from AND :to ORDER BY seq DESC`,
        range(f),
      ),
  },
};
