/**
 * HTTP routes for the role-aware dashboard, mounted at /api/v1/dashboard. Requires "dashboard.view".
 *
 * - GET / returns metrics and chart series computed from live data for a date range (the last 365 days by default).
 *   Each section is included only if the caller holds the permission for that area, and catalogue figures respect
 *   the caller's clearance. No figure is stored or estimated.
 * - GET /work returns the caller's pending work queues.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { hasPerm, staffReadableLevels } from '../../services/accessPolicy.service.js';
import { pendingWork } from './tasks.service.js';

const router = Router();
router.use(authenticate, requirePermission('dashboard.view'));

/**
 * Runs a read-only SQL query with named replacements and returns the rows.
 *
 * @param {string} sql SQL text with :name placeholders.
 * @param {object} [replacements] Values for the placeholders.
 * @returns {Promise<object[]>}
 */
const q = (sql, replacements) => sequelize.query(sql, { type: 'SELECT', replacements });

/**
 * @openapi
 * /dashboard:
 *   get:
 *     tags: [Dashboard]
 *     summary: Role-aware metrics and chart series computed from live data. Sections the caller lacks permission for are omitted.
 *     parameters: [{ in: query, name: from, schema: { type: string, format: date } }, { in: query, name: to, schema: { type: string, format: date } }]
 *     responses: { 200: { description: Dashboard } }
 */
router.get(
  '/',
  validate({
    query: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
  }),
  async (req, res) => {
    const u = req.user;
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date(Date.now() - 365 * 86400_000);
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59Z`) : new Date();
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const out = {
      generatedAt: new Date().toISOString(),
      range: { from, to },
      metrics: {},
      charts: {},
      work: await pendingWork(u),
    };

    if (hasPerm(u, 'records.read')) {
      const [descriptions, collections, thisMonth, byAccess, inRange] = await Promise.all([
        models.ArchivalRecord.count(),
        models.ArchivalRecord.count({ where: { parentId: null } }),
        models.ArchivalRecord.count({ where: { createdAt: { [Op.gte]: monthStart } } }),
        models.ArchivalRecord.count({ group: ['effectiveAccessLevel'] }),
        models.ArchivalRecord.count({ where: { createdAt: { [Op.between]: [from, to] } } }),
      ]);
      Object.assign(out.metrics, {
        descriptions,
        collections,
        recordsThisMonth: thisMonth,
        recordsInRange: inRange,
        openAccess: byAccess.find((b) => b.effectiveAccessLevel === 'open')?.count ?? 0,
        restricted: byAccess.filter((b) => b.effectiveAccessLevel !== 'open').reduce((n, b) => n + b.count, 0),
      });
      out.charts.accessLevels = byAccess.map((b) => ({ name: b.effectiveAccessLevel, value: b.count }));
      out.charts.recordsByStatus = (await models.ArchivalRecord.count({ group: ['status'] })).map((r) => ({
        name: r.status,
        value: r.count,
      }));
      out.charts.collectionsByType = await q(
        `SELECT COALESCE(collectionType, 'Unspecified') AS name, COUNT(*) AS value FROM ArchivalRecords WHERE parentId IS NULL GROUP BY COALESCE(collectionType, 'Unspecified') ORDER BY value DESC`,
      );
      out.charts.recordsByDepartment = await q(
        `SELECT TOP 12 ou.name AS name, COUNT(*) AS value FROM ArchivalRecords r JOIN OrganisationUnits ou ON ou.id = r.originatingUnitId GROUP BY ou.name ORDER BY value DESC`,
      );
      const levels = staffReadableLevels(u);
      out.recent = await models.ArchivalRecord.findAll({
        where: { effectiveAccessLevel: levels },
        attributes: ['id', 'referenceCode', 'title', 'status', 'level', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        limit: 8,
      });
    }
    if (hasPerm(u, 'accession.read')) {
      const [pending, inRange] = await Promise.all([
        models.Accession.count({ where: { status: ['submitted', 'under_review', 'queried'] } }),
        models.Accession.count({ where: { createdAt: { [Op.between]: [from, to] } } }),
      ]);
      Object.assign(out.metrics, { accessionsAwaitingReview: pending, accessionsInRange: inRange });
      out.charts.acquisitionsByYear = await q(
        `SELECT YEAR(COALESCE(accessionDate, CAST(createdAt AS DATE))) AS name, COUNT(*) AS value FROM Accessions WHERE status IN ('approved','closed') GROUP BY YEAR(COALESCE(accessionDate, CAST(createdAt AS DATE))) ORDER BY name`,
      );
    }
    if (hasPerm(u, 'assets.read')) {
      const live = { status: { [Op.ne]: 'deleted' }, role: { [Op.notIn]: ['thumbnail', 'access_derivative'] } };
      const [digital, ocrReview, exceptions, bytes] = await Promise.all([
        models.DigitalAsset.count({ where: live }),
        models.DigitalAsset.count({ where: { ocrStatus: 'succeeded' } }),
        models.PreservationAlert.count({ where: { status: ['open', 'investigating'] } }),
        q(`SELECT COALESCE(SUM(CAST(sizeBytes AS BIGINT)), 0) AS total FROM DigitalAssets WHERE status <> 'deleted'`),
      ]);
      Object.assign(out.metrics, {
        digitalAssets: digital,
        ocrAwaitingReview: ocrReview,
        preservationExceptions: exceptions,
        storageBytes: Number(bytes[0].total),
      });
      out.charts.formats = await q(
        `SELECT TOP 10 COALESCE(mediaType, 'unknown') AS name, COUNT(*) AS value FROM DigitalAssets WHERE status <> 'deleted' AND role NOT IN ('thumbnail','access_derivative') GROUP BY mediaType ORDER BY value DESC`,
      );
      out.charts.preservationStatus = (
        await models.DigitalAsset.count({ where: live, group: ['preservationStatus'] })
      ).map((r) => ({ name: r.preservationStatus, value: r.count }));
      out.charts.fixityLast30Days = (
        await models.FixityCheck.count({
          where: { checkedAt: { [Op.gte]: new Date(Date.now() - 30 * 86400_000) } },
          group: ['status'],
        })
      ).map((r) => ({ name: r.status, value: r.count }));
    }
    if (hasPerm(u, 'digitisation.manage') || hasPerm(u, 'digitisation.capture') || hasPerm(u, 'digitisation.qa')) {
      out.metrics.digitisationBatchesInProgress = await models.DigitisationBatch.count({
        where: { status: ['in_progress', 'processing', 'quality_review', 'rework_required'] },
      });
      out.charts.digitisationProgress = (await models.DigitisationBatch.count({ group: ['status'] })).map((r) => ({
        name: r.status,
        value: r.count,
      }));
    }
    if (hasPerm(u, 'research.manage') || hasPerm(u, 'appointments.manage')) {
      const today = new Date().toISOString().slice(0, 10);
      const [awaiting, todayAppts, outstanding] = await Promise.all([
        models.ResearchRequest.count({
          where: { status: ['submitted', 'under_review', 'awaiting_approval', 'awaiting_researcher'] },
        }),
        models.ResearchAppointment.count({
          where: { status: ['booked', 'checked_in'] },
          include: [
            {
              model: models.AppointmentSlot,
              as: 'slot',
              where: { startsAt: { [Op.between]: [new Date(`${today}T00:00:00Z`), new Date(`${today}T23:59:59Z`)] } },
            },
          ],
        }),
        models.CirculationTransaction.count({ where: { status: ['issued', 'overdue'] } }),
      ]);
      Object.assign(out.metrics, {
        researchRequestsAwaitingAction: awaiting,
        appointmentsToday: todayAppts,
        outstandingPhysicalItems: outstanding,
      });
      out.charts.researchRequestsByStatus = (
        await models.ResearchRequest.count({ where: { createdAt: { [Op.between]: [from, to] } }, group: ['status'] })
      ).map((r) => ({ name: r.status, value: r.count }));
    }
    if (hasPerm(u, 'physical.read')) {
      out.charts.storageUtilisation = await q(
        `SELECT TOP 10 l.code AS name, l.capacity AS capacity, COALESCE(SUM(p.sizeUnits), 0) AS used FROM StorageLocations l LEFT JOIN PhysicalItems p ON p.currentLocationId = l.id AND p.status NOT IN ('disposed','withdrawn') WHERE l.capacity IS NOT NULL AND l.isActive = 1 GROUP BY l.code, l.capacity ORDER BY COALESCE(SUM(p.sizeUnits), 0) * 1.0 / NULLIF(l.capacity, 0) DESC`,
      );
      out.metrics.physicalItems = await models.PhysicalItem.count({
        where: { status: { [Op.notIn]: ['disposed', 'withdrawn'] } },
      });
    }
    if (hasPerm(u, 'transfer.submit') && !hasPerm(u, 'transfer.review')) {
      out.metrics.myUnitTransfers = await models.TransferSubmission.count({
        where: { originatingUnitId: u.organisationUnitId },
      });
    }
    if (hasPerm(u, 'audit.read')) {
      out.activity = await models.AuditEvent.findAll({
        attributes: ['seq', 'occurredAt', 'actorLabel', 'action', 'resourceType', 'outcome'],
        order: [['seq', 'DESC']],
        limit: 10,
      });
    }
    res.json({ data: out });
  },
);

router.get('/work', async (req, res) => res.json({ data: await pendingWork(req.user) }));

export default router;
