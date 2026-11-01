/**
 * HTTP routes for the signed-in user's notifications, mounted at /api/v1/notifications. Users only ever see their
 * own notifications.
 *
 * - GET / lists notifications, optionally only unread ones, with the unread count.
 * - POST /:id/read and POST /read-all mark notifications as read.
 * - GET /preferences and PUT /preferences read and set, per event type, whether to be notified in the application
 *   and by email.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models } from '../../database/models/index.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../../validators/common.js';
import { paginationSchema, pageParams } from '../../utils/pagination.js';
import { EVENT_TYPES } from '../../services/notification.service.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /notifications:
 *   get: { tags: [Notifications], summary: Current user's notifications, responses: { 200: { description: Paged notifications } } }
 */
router.get(
  '/',
  validate({ query: paginationSchema.extend({ unread: z.enum(['true', 'false']).optional() }) }),
  async (req, res) => {
    const where = { userId: req.user.id };
    if (req.query.unread === 'true') where.readAt = null;
    const result = await models.Notification.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      ...pageParams(req.query),
    });
    const unread = await models.Notification.count({ where: { userId: req.user.id, readAt: null } });
    res.json({
      data: result.rows,
      meta: { page: req.query.page, pageSize: req.query.pageSize, total: result.count, unread },
    });
  },
);

router.post('/:id/read', validate({ params: idParams }), async (req, res) => {
  await models.Notification.update(
    { readAt: new Date() },
    { where: { id: req.params.id, userId: req.user.id, readAt: null } },
  );
  res.json({ data: { ok: true } });
});

router.post('/read-all', async (req, res) => {
  await models.Notification.update({ readAt: new Date() }, { where: { userId: req.user.id, readAt: null } });
  res.json({ data: { ok: true } });
});

router.get('/preferences', async (req, res) => {
  const rows = await models.NotificationPreference.findAll({ where: { userId: req.user.id } });
  const byType = new Map(rows.map((r) => [r.eventType, r]));
  res.json({
    data: EVENT_TYPES.map((eventType) => ({
      eventType,
      inApp: byType.get(eventType)?.inApp ?? true,
      email: byType.get(eventType)?.email ?? true,
    })),
  });
});

router.put(
  '/preferences',
  validate({
    body: z.object({
      preferences: z
        .array(z.object({ eventType: z.enum(EVENT_TYPES), inApp: z.boolean(), email: z.boolean() }))
        .max(100),
    }),
  }),
  async (req, res) => {
    for (const p of req.body.preferences) {
      const [row] = await models.NotificationPreference.findOrCreate({
        where: { userId: req.user.id, eventType: p.eventType },
        defaults: p,
      });
      await row.update({ inApp: p.inApp, email: p.email });
    }
    res.json({ data: { ok: true } });
  },
);

export default router;
