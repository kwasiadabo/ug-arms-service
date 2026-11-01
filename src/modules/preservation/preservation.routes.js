/**
 * HTTP routes for digital preservation, mounted at /api/v1/preservation. Every route requires "preservation.read".
 *
 * - GET /summary returns the preservation dashboard figures: status, format risk, open alerts by severity, fixity
 *   results of the last 30 days, overdue checks and formats held.
 * - GET /alerts, GET /alerts/:id and POST /alerts/:id/status list, show and update alerts ("preservation.manage" to
 *   update).
 * - POST /alerts/:id/recover restores a file from a verified copy ("preservation.recover").
 * - POST /fixity queues fixity checks ("preservation.manage"); GET /fixity-checks and GET /events list checks and
 *   preservation events.
 * - GET /formats and PATCH /formats/:id manage the format registry ("preservation.manage" to change).
 * - GET /packages/:recordId downloads a BagIt-style preservation package for a description ("preservation.manage").
 * - GET /policies lists preservation policies.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, paged } from '../../utils/pagination.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { enqueue } from '../../services/queue.service.js';
import { audit } from '../../services/audit.service.js';
import { diskUpload, ingestTempFile } from '../../services/upload.service.js';
import { recoverAsset } from '../../services/preservation.service.js';
import { streamPackage } from './package.service.js';

const router = Router();
router.use(authenticate, requirePermission('preservation.read'));

/**
 * @openapi
 * /preservation/summary:
 *   get: { tags: [Preservation], summary: Preservation dashboard figures (fixity, alerts, formats at risk), responses: { 200: { description: Summary } } }
 */
router.get('/summary', async (req, res) => {
  const live = { status: { [Op.ne]: 'deleted' } };
  const [byStatus, byRisk, alerts, lastChecks, overdue, byFormat] = await Promise.all([
    models.DigitalAsset.count({ where: live, group: ['preservationStatus'] }),
    models.DigitalAsset.count({
      where: { ...live, role: ['preservation_master', 'original_upload', 'migrated_version'] },
      group: ['formatRisk'],
    }),
    models.PreservationAlert.count({ where: { status: ['open', 'investigating'] }, group: ['severity'] }),
    models.FixityCheck.count({
      where: { checkedAt: { [Op.gte]: new Date(Date.now() - 30 * 86400_000) } },
      group: ['status'],
    }),
    models.DigitalAsset.count({ where: { ...live, nextFixityAt: { [Op.lt]: new Date(Date.now() - 7 * 86400_000) } } }),
    models.DigitalAsset.count({ where: { ...live, role: { [Op.notIn]: ['thumbnail'] } }, group: ['mediaType'] }),
  ]);

  /**
   * Converts grouped count rows into an object keyed by the grouping value; rows without a value are counted as
   * "unknown".
   *
   * @param {Array<object>} rows Result of a grouped Sequelize count.
   * @param {string} key Name of the grouping column.
   * @returns {Record<string, number>}
   */
  const obj = (rows, key) => Object.fromEntries(rows.map((r) => [r[key] ?? 'unknown', r.count]));
  res.json({
    data: {
      preservationStatus: obj(byStatus, 'preservationStatus'),
      formatRisk: obj(byRisk, 'formatRisk'),
      openAlertsBySeverity: obj(alerts, 'severity'),
      fixityLast30Days: obj(lastChecks, 'status'),
      fixityOverdue: overdue,
      formats: obj(byFormat, 'mediaType'),
    },
  });
});

router.get(
  '/alerts',
  validate({
    query: paginationSchema.extend({ status: z.string().max(100).optional(), severity: z.string().max(60).optional() }),
  }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',');
    if (req.query.severity) where.severity = req.query.severity.split(',');
    paged(
      res,
      await models.PreservationAlert.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['createdAt', 'DESC']],
        include: [
          {
            model: models.DigitalAsset,
            as: 'asset',
            attributes: ['id', 'originalFilename', 'role', 'recordId', 'sha256', 'preservationStatus'],
          },
          { model: models.User, as: 'assignedTo', attributes: ['id', 'fullName'] },
        ],
      }),
      req.query,
    );
  },
);

router.get('/alerts/:id', validate({ params: idParams }), async (req, res) => {
  const alert = await models.PreservationAlert.findByPk(req.params.id, {
    include: [
      { model: models.DigitalAsset, as: 'asset', attributes: { exclude: ['storageKey'] } },
      { model: models.FixityCheck, as: 'fixityCheck' },
      { model: models.User, as: 'resolvedBy', attributes: ['id', 'fullName'] },
    ],
  });
  if (!alert) throw notFound('Alert');
  const [replicas, events] = await Promise.all([
    models.StorageReplica.findAll({ where: { assetId: alert.assetId }, attributes: { exclude: ['storageKey'] } }),
    models.PreservationEvent.findAll({ where: { assetId: alert.assetId }, order: [['eventAt', 'DESC']], limit: 30 }),
  ]);
  res.json({ data: { ...alert.get({ plain: true }), replicas, events } });
});

router.post(
  '/alerts/:id/status',
  requirePermission('preservation.manage'),
  validate({
    params: idParams,
    body: z.object({
      status: z.enum(['investigating', 'resolved', 'closed']),
      note: z.string().trim().min(3).max(4000),
      assignedToId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    const alert = await models.PreservationAlert.findByPk(req.params.id);
    if (!alert) throw notFound('Alert');
    if (req.body.status === 'closed' && !['recovered', 'resolved'].includes(alert.status))
      throw badRequest('An alert can only be closed after recovery or resolution has been verified');
    if (req.body.status === 'resolved' && ['fixity_failure', 'missing_file'].includes(alert.alertType)) {
      const asset = await models.DigitalAsset.findByPk(alert.assetId);
      if (!['ok', 'recovered'].includes(asset.preservationStatus))
        throw badRequest('Integrity failures are resolved by recovery followed by a passing fixity check');
    }
    await sequelize.transaction(async (t) => {
      await alert.update(
        {
          status: req.body.status,
          assignedToId: req.body.assignedToId ?? alert.assignedToId,
          resolution: req.body.note,
          ...(req.body.status !== 'investigating' && { resolvedById: req.user.id, resolvedAt: new Date() }),
        },
        { transaction: t },
      );
      await audit(
        {
          action: `preservation.alert_${req.body.status}`,
          resourceType: 'PreservationAlert',
          resourceId: alert.id,
          reason: req.body.note,
        },
        { transaction: t },
      );
    });
    res.json({ data: alert });
  },
);

/**
 * @openapi
 * /preservation/alerts/{id}/recover:
 *   post: { tags: [Preservation], summary: Restore from a verified replica (replicaId) or a replacement file (multipart "file") whose SHA-256 matches the recorded value, then re-verify, responses: { 200: { description: Recovered } } }
 */
router.post(
  '/alerts/:id/recover',
  requirePermission('preservation.recover'),
  validate({ params: idParams }),
  diskUpload().single('file'),
  async (req, res) => {
    const body = z.object({ replicaId: uuid.optional(), note: z.string().trim().min(5).max(4000) }).parse(req.body);
    let uploaded = {};
    if (req.file) {
      const r = await ingestTempFile(req.file, { area: 'recovery-staging' });
      uploaded = { uploadedKey: r.storageKey, uploadedSha256: r.sha256 };
    }
    res.json({
      data: await recoverAsset(req.params.id, { replicaId: body.replicaId, note: body.note, ...uploaded }, req.user),
    });
  },
);

router.post(
  '/fixity',
  requirePermission('preservation.manage'),
  validate({ body: z.object({ assetIds: z.array(uuid).min(1).max(1000) }) }),
  async (req, res) => {
    const jobs = [];
    for (const assetId of req.body.assetIds)
      jobs.push(
        await enqueue(
          'fixity',
          'preservation.fixity',
          { assetId, triggeredBy: 'manual' },
          { entityType: 'DigitalAsset', entityId: assetId, requestedById: req.user.id },
        ),
      );
    await audit({
      action: 'preservation.fixity_requested',
      resourceType: 'DigitalAsset',
      metadata: { count: jobs.length },
    });
    res.status(202).json({ data: { jobIds: jobs } });
  },
);

router.get(
  '/fixity-checks',
  validate({ query: paginationSchema.extend({ status: z.string().max(60).optional(), assetId: uuid.optional() }) }),
  async (req, res) => {
    const where = {};
    if (req.query.status) where.status = req.query.status.split(',');
    if (req.query.assetId) where.assetId = req.query.assetId;
    paged(
      res,
      await models.FixityCheck.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: [['createdAt', 'DESC']],
        include: [{ model: models.DigitalAsset, as: 'asset', attributes: ['id', 'originalFilename', 'role'] }],
      }),
      req.query,
    );
  },
);

router.get(
  '/events',
  validate({
    query: paginationSchema.extend({
      eventType: z.string().max(60).optional(),
      outcome: z.string().max(20).optional(),
      assetId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    for (const k of ['eventType', 'outcome', 'assetId']) if (req.query[k]) where[k] = req.query[k];
    paged(
      res,
      await models.PreservationEvent.findAndCountAll({ where, ...pageParams(req.query), order: [['eventAt', 'DESC']] }),
      req.query,
    );
  },
);

router.get('/formats', async (req, res) =>
  res.json({
    data: await models.FormatRegistry.findAll({
      order: [
        ['category', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
  }),
);

router.patch(
  '/formats/:id',
  requirePermission('preservation.manage'),
  validate({
    params: idParams,
    body: z.object({
      riskLevel: z.enum(['low', 'medium', 'high']).optional(),
      isAcceptedForIngest: z.boolean().optional(),
      isPreservationFormat: z.boolean().optional(),
      ocrEligible: z.boolean().optional(),
      preservationAction: optionalText(1000),
    }),
  }),
  async (req, res) => {
    const f = await models.FormatRegistry.findByPk(req.params.id);
    if (!f) throw notFound('Format');
    const before = f.get({ plain: true });
    await f.update(req.body);
    await audit({
      action: 'preservation.format_updated',
      resourceType: 'FormatRegistry',
      resourceId: f.id,
      before: { riskLevel: before.riskLevel, isAcceptedForIngest: before.isAcceptedForIngest },
      after: req.body,
    });
    if (req.body.riskLevel)
      await models.DigitalAsset.update({ formatRisk: req.body.riskLevel }, { where: { mediaType: f.mediaType } });
    res.json({ data: f });
  },
);

/**
 * @openapi
 * /preservation/packages/{recordId}:
 *   get: { tags: [Preservation], summary: Download a BagIt-style preservation package (files, manifest-sha256, PREMIS events, description), responses: { 200: { description: ZIP } } }
 */
router.get(
  '/packages/:recordId',
  requirePermission('preservation.manage'),
  validate({ params: z.object({ recordId: uuid }) }),
  async (req, res) => {
    await streamPackage(req.params.recordId, req.user, res);
  },
);

router.get('/policies', async (req, res) => res.json({ data: await models.PreservationPolicy.findAll() }));

export default router;
