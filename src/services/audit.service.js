/**
 * Append-only, tamper-evident audit trail.
 *
 * Every significant action (sign-ins, changes, approvals, access decisions, exports and preservation events) is
 * recorded with the actor, the time, the affected resource, the outcome, the request's correlation ID and, where
 * relevant, the values before and after the change. Passwords, tokens, hashes and storage keys are stripped before
 * anything is written.
 *
 * Each event stores the hash of the previous event and its own hash over its content, forming a chain. Changing or
 * deleting any past event breaks the chain, which `verifyChain` detects. The database also refuses updates and
 * deletes on the table through a trigger.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../database/models/index.js';
import { getContext } from '../utils/context.js';
import { sha256 } from '../utils/crypto.js';
import { logger } from '../config/logger.js';

const SECRET_KEYS = /password|token|secret|hash|storagekey/i;

// Strip secrets before anything reaches the audit log.

/**
 * Returns a copy of a value with secret fields removed, ready to be stored in the audit trail.
 *
 * Any property whose name contains "password", "token", "secret", "hash" or "storagekey" is dropped at every level.
 * Sequelize instances are converted to plain objects and dates to ISO strings.
 *
 * @param {*} value The value to clean.
 * @returns {*} The cleaned copy.
 */
export function scrub(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'object') {
    const plain = typeof value.get === 'function' ? value.get({ plain: true }) : value;
    const out = {};
    for (const [k, v] of Object.entries(plain)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? scrub(v) : v;
    }
    return out;
  }
  return value;
}

/**
 * Compares two versions of an object and returns only the fields that changed.
 *
 * Secret fields are removed first, and bookkeeping fields (updatedAt, version and the search text) are ignored, so
 * the audit trail shows meaningful changes only.
 *
 * @param {object|null} before State before the change.
 * @param {object|null} after State after the change.
 * @returns {{ before: object, after: object, fields: string[] }} The previous and new values of each changed field,
 *   and the list of changed field names.
 */
export function diff(before, after) {
  const b = scrub(before) || {};
  const a = scrub(after) || {};
  const changedBefore = {};
  const changedAfter = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (['updatedAt', 'version', 'searchText'].includes(key)) continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changedBefore[key] = b[key];
      changedAfter[key] = a[key];
    }
  }
  return { before: changedBefore, after: changedAfter, fields: Object.keys(changedAfter) };
}

/**
 * Serialises the fields of an audit event that are covered by its hash, in a fixed order.
 *
 * @param {object} e The audit event.
 * @returns {string} The canonical JSON string to hash.
 */
function hashPayload(e) {
  return JSON.stringify([
    e.eventId,
    e.occurredAt.toISOString(),
    e.actorType,
    e.actorUserId,
    e.action,
    e.resourceType,
    e.resourceId,
    e.outcome,
    e.correlationId,
    e.before,
    e.after,
    e.reason,
    e.metadata,
  ]);
}

/**
 * Appends an event to the audit trail.
 *
 * The actor defaults to the signed-in user of the current request; the IP address, user agent and correlation ID
 * are taken from the request context. Pass the caller's transaction so the event is committed together with the
 * change it records, or not at all. Writers are serialised with a database application lock, so concurrent requests
 * cannot both link to the same previous event and fork the chain.
 *
 * @param {{ action: string, resourceType?: string, resourceId?: string, outcome?: string, before?: object, after?:
 *   object, reason?: string, metadata?: object, sensitive?: boolean, actor?: object, actorType?: string, actorLabel?:
 *   string }} event What happened.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<object>} The stored audit event.
 * @throws {Error} If the event could not be written; the calling operation should then fail as well.
 */
export async function audit(event, { transaction } = {}) {
  const ctx = getContext();
  const actor = event.actor ?? ctx.user;

  /**
   * Writes one audit event inside the given transaction: takes the chain lock, reads the hash of the latest event,
   * and stores the new event with its own hash.
   *
   * @param {import('sequelize').Transaction} t Transaction to write in.
   * @returns {Promise<object>} The stored audit event.
   */
  const write = async (t) => {
    await sequelize.query(
      "EXEC sp_getapplock @Resource = 'audit_chain', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000",
      { transaction: t },
    );
    const last = await models.AuditEvent.findOne({ attributes: ['hash'], order: [['seq', 'DESC']], transaction: t });
    const row = {
      eventId: crypto.randomUUID(),
      occurredAt: new Date(),
      actorType: event.actorType ?? (actor ? 'user' : ctx.ip ? 'anonymous' : 'system'),
      actorUserId: actor?.id ?? null,
      actorLabel: actor?.email ?? event.actorLabel ?? null,
      action: event.action,
      resourceType: event.resourceType ?? null,
      resourceId: event.resourceId ? String(event.resourceId) : null,
      outcome: event.outcome ?? 'success',
      correlationId: ctx.correlationId ?? null,
      ipAddress: ctx.ip ?? null,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 500) : null,
      before: event.before ? scrub(event.before) : null,
      after: event.after ? scrub(event.after) : null,
      reason: event.reason ?? null,
      metadata: event.metadata ? scrub(event.metadata) : null,
      sensitive: Boolean(event.sensitive),
      prevHash: last?.hash ?? null,
    };
    row.hash = sha256((row.prevHash || '') + hashPayload(row));
    return models.AuditEvent.create(row, { transaction: t });
  };
  try {
    if (transaction) return await write(transaction);
    return await sequelize.transaction((t) => write(t));
  } catch (err) {
    logger.error({ err, action: event.action }, 'Failed to write audit event');
    throw err;
  }
}

/**
 * Recomputes the hash chain from the first event and reports whether it is intact.
 *
 * Events are read in batches of 1,000 in sequence order. For each event the stored previous hash must equal the
 * hash of the event before it, and the stored hash must equal a fresh hash of its content.
 *
 * @param {{ limit?: number }} [options] Maximum number of events to check.
 * @returns {Promise<{ valid: boolean, checked: number, brokenAtSeq?: number, truncated?: boolean }>} The result,
 *   with the sequence number of the first broken event when the chain is not intact.
 */
export async function verifyChain({ limit = 100000 } = {}) {
  let prev = null;
  let checked = 0;
  let lastSeq = 0;
  for (;;) {
    const rows = await models.AuditEvent.findAll({
      where: { seq: { [Op.gt]: lastSeq } },
      order: [['seq', 'ASC']],
      limit: 1000,
    });
    if (!rows.length) break;
    for (const r of rows) {
      const e = r.get({ plain: true });
      const expected = sha256((e.prevHash || '') + hashPayload({ ...e, occurredAt: new Date(e.occurredAt) }));
      if (e.prevHash !== prev || e.hash !== expected) return { valid: false, brokenAtSeq: e.seq, checked };
      prev = e.hash;
      checked += 1;
      lastSeq = e.seq;
      if (checked >= limit) return { valid: true, checked, truncated: true };
    }
  }
  return { valid: true, checked };
}
