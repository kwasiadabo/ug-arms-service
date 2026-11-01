/**
 * Single source of truth for archival access decisions.
 *
 * Detail views, lists, search results, facet counts, exports, previews and file delivery all ask this module what
 * the current user may see, so a restricted record cannot leak through one route while being hidden on another.
 *
 * Access is inherited down the archival hierarchy: the effective level of a description is the strictest of the
 * repository level, its own level, the levels of all its ancestors and any active restrictions. A child can be made
 * stricter than its parent at any time, but can only be made looser through an approved, audited access exception.
 * The effective level and the public visibility ("full", "metadata_only" or "hidden") are pre-computed and stored
 * on each record, so lists and search can filter in SQL and restricted rows never leave the database.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../database/models/index.js';
import { ACCESS_LEVELS } from '../database/models/archival.js';
import { getSetting } from './settings.service.js';

/**
 * Returns the position of an access level in the order from most open to most restrictive.
 *
 * @param {string} level Access level, for example "restricted".
 * @returns {number} 0 for "open", increasing with restrictiveness; unknown levels rank as "open".
 */
export const accessRank = (level) => Math.max(0, ACCESS_LEVELS.indexOf(level));

/**
 * Returns the more restrictive of two access levels.
 *
 * @param {string} a First access level.
 * @param {string} b Second access level.
 * @returns {string} Whichever level ranks higher; `a` when they are equal.
 */
export const stricter = (a, b) => (accessRank(a) >= accessRank(b) ? a : b);

const RESTRICTION_LEVEL = {
  staff_only: 'staff_only',
  restricted: 'restricted',
  personal_data: 'restricted',
  embargoed: 'embargoed',
  confidential: 'confidential',
  closed: 'closed',
};
const FLAG_TYPES = [
  'onsite_only',
  'view_only',
  'no_download',
  'reproduction_by_permission',
  'copyright',
  'personal_data',
];
const ACTIVE_RESTRICTION = ['active', 'expired_pending_review'];

/**
 * Splits a materialised hierarchy path ("/rootId/parentId/id/") into its record identifiers, from the root down.
 *
 * @param {string} path Stored path of a record.
 * @returns {string[]} The identifiers along the path.
 */
export const pathIds = (path) => (path || '').split('/').filter(Boolean);

/**
 * Tells whether a user holds a permission.
 *
 * @param {object|null|undefined} user Authenticated principal, or nothing for an anonymous visitor.
 * @param {string} perm Permission code, for example "records.read".
 * @returns {boolean}
 */
export function hasPerm(user, perm) {
  return Boolean(user?.permissions?.has(perm));
}

/**
 * Lists the effective access levels whose content a staff user may read based on their permissions alone.
 *
 * Every staff user with "records.read" sees open and staff-only content; "records.read_restricted" adds restricted
 * and embargoed content; "records.read_confidential" adds confidential and closed content. Time-limited grants
 * given to researchers are handled separately.
 *
 * @param {object|null|undefined} user Authenticated principal.
 * @returns {string[]} The readable access levels, or an empty list for non-staff users.
 */
export function staffReadableLevels(user) {
  if (!hasPerm(user, 'records.read')) return [];
  const levels = ['open', 'staff_only'];
  if (hasPerm(user, 'records.read_restricted')) levels.push('restricted', 'embargoed');
  if (hasPerm(user, 'records.read_confidential')) levels.push('confidential', 'closed');
  return levels;
}

/**
 * Reads which restricted access levels are publicly discoverable, meaning the public may see that the record exists
 * (identifying metadata only, never its content).
 *
 * @returns {Promise<string[]>} The configured levels; by default "restricted" and "embargoed".
 */
async function publicDiscoverableLevels() {
  return (await getSetting('access.publicDiscoverableRestrictedLevels')) ?? ['restricted', 'embargoed'];
}

/**
 * Recomputes the effective access level, effective restriction flags and public visibility of a record and all its
 * descendants.
 *
 * For each record in the subtree, the path from the root is walked once, applying the repository default, each
 * node's own level, active restrictions and approved exceptions. An exception resets inheritance at its node but is
 * never looser than that node's own settings. A record is publicly visible only if it and every ancestor are
 * published. Only rows whose values actually change are updated.
 *
 * Call this inside the same transaction as any change to a record's status, access level, restrictions, exceptions
 * or position in the hierarchy.
 *
 * @param {string} recordId Record whose subtree must be refreshed.
 * @param {import('sequelize').Transaction} [transaction] Transaction of the change that triggered the refresh.
 * @returns {Promise<Array<{ id: string, level: string, publicVisibility: string, flags: string[] }>|undefined>} The
 *   records whose values changed, or undefined if the record does not exist.
 */
export async function refreshEffectiveAccess(recordId, transaction) {
  const record = await models.ArchivalRecord.findByPk(recordId, {
    transaction,
    attributes: ['id', 'path', 'repositoryId'],
  });
  if (!record) return;
  const ancestorIds = pathIds(record.path).filter((id) => id !== record.id);
  const nodes = await models.ArchivalRecord.findAll({
    where: { [Op.or]: [{ id: [...ancestorIds, record.id] }, { path: { [Op.like]: `${record.path}%` } }] },
    attributes: [
      'id',
      'parentId',
      'path',
      'status',
      'accessLevel',
      'repositoryId',
      'effectiveAccessLevel',
      'effectiveFlags',
      'publicVisibility',
    ],
    transaction,
  });
  const ids = nodes.map((n) => n.id);
  const [restrictions, exceptions, repo] = await Promise.all([
    models.AccessRestriction.findAll({
      where: { targetType: 'record', targetId: ids, status: ACTIVE_RESTRICTION },
      transaction,
    }),
    models.AccessException.findAll({ where: { recordId: ids, status: 'active' }, transaction }),
    models.Repository.findByPk(record.repositoryId, { transaction, attributes: ['accessLevel'] }),
  ]);
  const byTarget = new Map();
  for (const r of restrictions) byTarget.set(r.targetId, [...(byTarget.get(r.targetId) || []), r]);
  const exceptionFor = new Map(exceptions.map((e) => [e.recordId, e]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const discoverable = await publicDiscoverableLevels();

  // Walk from the root for each node in the subtree (subtrees are small relative to cost of a DB round trip).
  const subtree = nodes.filter((n) => n.path.startsWith(record.path));
  const changed = [];
  for (const node of subtree) {
    let level = repo?.accessLevel || 'open';
    let flags = new Set();
    let allPublished = true;
    for (const id of pathIds(node.path)) {
      const n = byId.get(id);
      if (!n) continue;
      if (n.status !== 'published') allPublished = false;
      let own = n.accessLevel;
      const nodeFlags = new Set();
      for (const r of byTarget.get(id) || []) {
        if (RESTRICTION_LEVEL[r.restrictionType]) own = stricter(own, RESTRICTION_LEVEL[r.restrictionType]);
        if (FLAG_TYPES.includes(r.restrictionType)) nodeFlags.add(r.restrictionType);
      }
      const exc = exceptionFor.get(id);
      // An approved exception resets inheritance at this node; it can never be looser than the node's own settings.
      level = exc ? stricter(exc.grantedAccessLevel, own) : stricter(level, own);
      flags = exc ? nodeFlags : new Set([...flags, ...nodeFlags]);
    }
    const publicVisibility = !allPublished
      ? 'hidden'
      : level === 'open'
        ? 'full'
        : discoverable.includes(level)
          ? 'metadata_only'
          : 'hidden';
    const flagList = [...flags].sort();
    if (
      node.effectiveAccessLevel !== level ||
      node.publicVisibility !== publicVisibility ||
      JSON.stringify(node.effectiveFlags) !== JSON.stringify(flagList)
    ) {
      changed.push({ id: node.id, level, publicVisibility, flags: flagList });
    }
  }
  for (const c of changed) {
    await models.ArchivalRecord.update(
      { effectiveAccessLevel: c.level, publicVisibility: c.publicVisibility, effectiveFlags: JSON.stringify(c.flags) },
      { where: { id: c.id }, transaction, silent: true, hooks: false },
    );
  }
  return changed;
}

/**
 * Loads a user's access grants that are neither revoked nor expired, such as time-limited access given after an
 * approved research request.
 *
 * @param {object|null|undefined} user Authenticated principal.
 * @returns {Promise<object[]>} The active grants; empty for anonymous visitors.
 */
export async function activeGrants(user) {
  if (!user) return [];
  return models.AccessGrant.findAll({
    where: { userId: user.id, revokedAt: null, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] },
  });
}

/**
 * Finds the grant, if any, that covers a record, either directly or through a grant on an ancestor that includes
 * descendants.
 *
 * @param {object[]} grants The user's active grants.
 * @param {{ id: string, path: string }} record The record being accessed.
 * @returns {object|undefined} The covering grant.
 */
function grantCovers(grants, record) {
  const ids = pathIds(record.path);
  return grants.find(
    (g) =>
      g.targetType === 'record' && (g.targetId === record.id || (g.includeDescendants && ids.includes(g.targetId))),
  );
}

/**
 * Decides what a user may do with a record.
 *
 * Rules are checked in this order:
 * - Staff whose clearance covers the effective level see everything, and may download if they hold
 *   "records.download" and no restriction flag forbids it.
 * - Other staff see that the record exists but not its content.
 * - Departmental liaisons see their own unit's records up to staff-only.
 * - A researcher with an active grant on the record or an ancestor sees the content of approved or published
 *   records.
 * - Everyone else sees what the record's public visibility allows: everything, identifying metadata only, or
 *   nothing.
 *
 * @param {object|null|undefined} user Authenticated principal, or nothing for an anonymous visitor.
 * @param {object} record Record with its effective access fields.
 * @param {{ grants?: object[] }} [options] Pre-loaded grants, to avoid a query per record in lists.
 * @returns {Promise<{ canDiscover: boolean, canViewContent: boolean, mode: 'full'|'metadata_only'|'none',
 *   canDownload: boolean, reason?: string, staff?: boolean, grant?: string }>}
 */
export async function evaluateRecord(user, record, { grants } = {}) {
  const level = record.effectiveAccessLevel;
  const flags = record.effectiveFlags || [];
  const noDownload = flags.includes('no_download') || flags.includes('view_only') || flags.includes('onsite_only');

  if (staffReadableLevels(user).includes(level)) {
    return {
      canDiscover: true,
      canViewContent: true,
      mode: 'full',
      canDownload: hasPerm(user, 'records.download') && !noDownload,
      staff: true,
    };
  }
  // Staff without clearance still see that the record exists, but not its content.
  if (hasPerm(user, 'records.read')) {
    return {
      canDiscover: true,
      canViewContent: false,
      mode: 'metadata_only',
      canDownload: false,
      staff: true,
      reason: 'insufficient_clearance',
    };
  }
  // Departmental liaisons: their own unit's non-sensitive records.
  if (
    hasPerm(user, 'transfer.submit') &&
    user.organisationUnitId &&
    record.originatingUnitId === user.organisationUnitId &&
    accessRank(level) <= accessRank('staff_only')
  ) {
    return { canDiscover: true, canViewContent: true, mode: 'full', canDownload: false };
  }
  const g = grantCovers(grants ?? (await activeGrants(user)), record);
  if (g && ['published', 'approved'].includes(record.status)) {
    return {
      canDiscover: true,
      canViewContent: true,
      mode: 'full',
      canDownload: g.permissionLevel === 'download' && !flags.includes('view_only'),
      grant: g.id,
    };
  }
  if (record.publicVisibility === 'full')
    return { canDiscover: true, canViewContent: true, mode: 'full', canDownload: !noDownload };
  if (record.publicVisibility === 'metadata_only')
    return {
      canDiscover: true,
      canViewContent: false,
      mode: 'metadata_only',
      canDownload: false,
      reason: 'restricted',
    };
  return { canDiscover: false, canViewContent: false, mode: 'none', canDownload: false, reason: 'not_found' };
}

/**
 * Builds the SQL filter for record lists and search, so that records a user may not discover are excluded by the
 * database query itself rather than after loading.
 *
 * Staff with "records.read" may discover every record (their content is then masked per row). Others see publicly
 * discoverable records, plus their own unit's records for liaisons, plus records covered by their grants (at most
 * 200 grants are expanded into the filter).
 *
 * @param {object|null|undefined} user Authenticated principal.
 * @param {{ grants?: object[] }} [options] Pre-loaded grants.
 * @returns {Promise<object>} A Sequelize `where` clause.
 */
export async function recordVisibilityWhere(user, { grants } = {}) {
  if (hasPerm(user, 'records.read')) return {}; // staff discover all; content is masked per row
  const ors = [{ publicVisibility: ['full', 'metadata_only'] }];
  if (user && hasPerm(user, 'transfer.submit') && user.organisationUnitId) {
    ors.push({ originatingUnitId: user.organisationUnitId, effectiveAccessLevel: ['open', 'staff_only'] });
  }
  for (const g of (grants ?? (await activeGrants(user))).filter((x) => x.targetType === 'record').slice(0, 200)) {
    ors.push({ id: g.targetId });
    if (g.includeDescendants) ors.push({ path: { [Op.like]: `%/${g.targetId}/%` } });
  }
  return { [Op.or]: ors };
}

/** Fields that may be shown when only metadata (not content) is permitted. */
export const METADATA_ONLY_FIELDS = [
  'id',
  'parentId',
  'rootId',
  'repositoryId',
  'level',
  'referenceCode',
  'title',
  'dateExpression',
  'dateStart',
  'dateEnd',
  'extentAndMedium',
  'accessConditions',
  'reproductionConditions',
  'preferredCitation',
  'languages',
  'status',
  'effectiveAccessLevel',
  'publicVisibility',
  'path',
  'depth',
];

/**
 * Shapes a record for the response according to an access decision.
 *
 * Internal fields (archivist notes, internal notes, staff identifiers and appraisal information) are removed unless
 * this is a staff view, and the search text column is always removed. When only metadata is permitted, the result
 * is reduced to the identifying fields in `METADATA_ONLY_FIELDS` plus the repository, parent and breadcrumb trail.
 * The decision is attached as `access` so the client can show the right messages.
 *
 * @param {object} record Sequelize instance or plain object.
 * @param {object} decision Result of `evaluateRecord`.
 * @param {{ staffView?: boolean }} [options] Whether the caller is using the staff interface.
 * @returns {object} A plain object that is safe to send to this user.
 */
export function presentRecord(record, decision, { staffView = false } = {}) {
  const data = typeof record.get === 'function' ? record.get({ plain: true }) : { ...record };
  delete data.searchText;
  if (!staffView) {
    for (const f of [
      'archivistNote',
      'internalNotes',
      'createdById',
      'updatedById',
      'submittedForReviewById',
      'approvedById',
      'publishedById',
      'responsibleArchivistId',
      'aiProcessingAllowed',
      'appraisalInfo',
    ])
      delete data[f];
  }
  if (decision.mode === 'metadata_only') {
    const masked = {};
    for (const f of METADATA_ONLY_FIELDS) if (f in data) masked[f] = data[f];
    for (const rel of ['repository', 'parent', 'breadcrumbs']) if (data[rel]) masked[rel] = data[rel];
    return { ...masked, access: decision };
  }
  return { ...data, access: decision };
}

/**
 * Calculates the effective access level of a digital file. A file is never more open than the record it belongs to;
 * a file without a record is treated as staff-only.
 *
 * @param {{ accessLevel: string }} asset The digital asset; "inherit" means it follows its record.
 * @param {object|null} record The record the asset belongs to.
 * @returns {string} The effective access level.
 */
export function assetLevel(asset, record) {
  const own = asset.accessLevel === 'inherit' ? 'open' : asset.accessLevel;
  return stricter(own, record ? record.effectiveAccessLevel : 'staff_only');
}

/**
 * Decides whether a user may view (preview or stream) or download a digital file.
 *
 * Deleted and quarantined files are never delivered. Staff whose clearance covers the file's level may view it.
 * Otherwise the file must be available and have passed the malware scan, and then:
 * - a grant on this exact file (for example a delivered reproduction) allows viewing, and downloading if the grant
 *   says so;
 * - a grant covering the record allows viewing, and downloading if the record and file allow it;
 * - the public may view only published access copies of open records, never preservation masters, and may download
 *   only when no restriction flag forbids it.
 *
 * @param {object|null|undefined} user Authenticated principal.
 * @param {object} asset The digital asset.
 * @param {object|null} record The record the asset belongs to.
 * @param {{ grants?: object[] }} [opts] Pre-loaded grants.
 * @returns {Promise<{ canView: boolean, canDownload: boolean, reason?: string, staff?: boolean, grant?: string }>}
 */
export async function evaluateAsset(user, asset, record, opts = {}) {
  /**
   * Builds a refusal decision for a file.
   *
   * @param {string} reason Machine-readable reason, for example "quarantined" or "not_published".
   * @returns {{ canView: false, canDownload: false, reason: string }}
   */
  const deny = (reason) => ({ canView: false, canDownload: false, reason });
  if (asset.status === 'deleted') return deny('deleted');
  if (asset.malwareStatus === 'infected' || asset.status === 'quarantined') return deny('quarantined');
  const staffLevels = staffReadableLevels(user);
  const level = assetLevel(asset, record);
  if (hasPerm(user, 'assets.read') && staffLevels.includes(level)) {
    return { canView: true, canDownload: hasPerm(user, 'assets.download'), staff: true };
  }
  if (!record) return deny('not_found');
  if (asset.status !== 'available' || asset.malwareStatus !== 'clean') return deny('not_available');
  // A researcher-specific grant on this exact file (e.g. a delivered reproduction).
  const grants = opts.grants ?? (await activeGrants(user));
  const assetGrant = grants.find((g) => g.targetType === 'asset' && g.targetId === asset.id);
  if (assetGrant)
    return { canView: true, canDownload: assetGrant.permissionLevel === 'download', grant: assetGrant.id };
  const recDecision = await evaluateRecord(user, record, { grants });
  if (!recDecision.canViewContent) return deny('restricted');
  const flags = record.effectiveFlags || [];
  if (recDecision.grant) {
    return { canView: true, canDownload: recDecision.canDownload && asset.downloadAllowed, grant: recDecision.grant };
  }
  if (!asset.isPublished || level !== 'open' || asset.role === 'preservation_master') return deny('not_published');
  const noDl = flags.includes('no_download') || flags.includes('view_only') || flags.includes('onsite_only');
  return { canView: true, canDownload: asset.downloadAllowed && !noDl };
}

/**
 * Loads a record by identifier together with the current user's access decision for it.
 *
 * @param {object|null|undefined} user Authenticated principal.
 * @param {string} id Record identifier.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<{ record: object|null, decision: object }>} The record, or null with mode "none" if it does not
 *   exist.
 */
export async function getRecordWithAccess(user, id, { transaction } = {}) {
  const record = await models.ArchivalRecord.findByPk(id, { transaction });
  if (!record) return { record: null, decision: { mode: 'none' } };
  const decision = await evaluateRecord(user, record);
  return { record, decision };
}
