/**
 * HTTP routes for institutional settings, mounted at /api/v1/settings.
 *
 * - GET /public returns the non-sensitive settings the portal needs (names, time zone, locale, registration and
 *   enquiry options, privacy notice), without an account.
 * - GET / lists every setting with its default, current value and description ("settings.manage").
 * - PUT /:key changes a setting ("settings.manage"). The value must have the same type as the default, and
 *   numbering formats must include {SEQ}. The change is audited as sensitive with an optional reason and applies
 *   within 30 seconds.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { badRequest } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { DEFAULT_SETTINGS, clearSettingsCache } from '../../services/settings.service.js';
import { DEFAULT_FORMATS } from '../../services/referenceCode.service.js';

const router = Router();

/**
 * @openapi
 * /settings/public:
 *   get: { tags: [Settings], security: [], summary: Non-sensitive settings needed by the public portal, responses: { 200: { description: Settings } } }
 */
router.get('/public', async (req, res) => {
  const keys = [
    'institution.name',
    'institution.shortName',
    'institution.tagline',
    'institution.timezone',
    'institution.locale',
    'institution.currency',
    'security.publicRegistration',
    'research.allowAnonymousEnquiries',
    'research.feesEnabled',
    'privacy.registrationNotice',
  ];
  const rows = await models.SystemSetting.findAll({ where: { key: keys } });
  const out = Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]?.value]));
  for (const r of rows) out[r.key] = r.value;
  res.json({ data: out });
});

router.use(authenticate, requirePermission('settings.manage'));

/**
 * @openapi
 * /settings:
 *   get: { tags: [Settings], summary: All configurable settings with defaults (settings.manage), responses: { 200: { description: Settings } } }
 */
router.get('/', async (req, res) => {
  const rows = await models.SystemSetting.findAll();
  const stored = new Map(rows.map((r) => [r.key, r]));
  const numbering = Object.fromEntries(
    Object.entries(DEFAULT_FORMATS).map(([k, v]) => [
      `numbering.${k}`,
      {
        category: 'numbering',
        value: v,
        description: `Reference format for ${k.replace(/_/g, ' ')}. Tokens: {YYYY}, {SEQ:n}.`,
      },
    ]),
  );
  const all = { ...DEFAULT_SETTINGS, ...numbering };
  const data = Object.entries(all).map(([key, def]) => {
    const row = stored.get(key);
    return {
      key,
      category: def.category,
      description: def.description,
      defaultValue: def.value,
      value: row ? row.value : def.value,
      isCustomised: Boolean(row),
      updatedAt: row?.updatedAt ?? null,
    };
  });
  res.json({ data });
});

router.put(
  '/:key',
  validate({
    params: z.object({ key: z.string().max(120) }),
    body: z.object({ value: z.any(), reason: z.string().max(1000).optional() }),
  }),
  async (req, res) => {
    const { key } = req.params;
    const isNumbering = key.startsWith('numbering.');
    const def =
      DEFAULT_SETTINGS[key] ??
      (isNumbering && DEFAULT_FORMATS[key.slice(10)]
        ? { category: 'numbering', value: DEFAULT_FORMATS[key.slice(10)] }
        : null);
    if (!def) throw badRequest('Unknown setting');
    if (typeof def.value !== typeof req.body.value && !(Array.isArray(def.value) && Array.isArray(req.body.value)))
      throw badRequest(`Setting ${key} expects a ${Array.isArray(def.value) ? 'list' : typeof def.value}`);
    if (isNumbering && !/\{SEQ(:\d+)?\}/.test(req.body.value))
      throw badRequest('A numbering format must include {SEQ} or {SEQ:n}');
    await sequelize.transaction(async (t) => {
      const existing = await models.SystemSetting.findOne({ where: { key }, transaction: t });
      const before = existing ? existing.value : def.value;
      if (existing) await existing.update({ value: req.body.value, updatedById: req.user.id }, { transaction: t });
      else
        await models.SystemSetting.create(
          {
            key,
            category: def.category,
            value: req.body.value,
            description: def.description,
            updatedById: req.user.id,
          },
          { transaction: t },
        );
      await audit(
        {
          action: 'settings.update',
          resourceType: 'SystemSetting',
          resourceId: key,
          before: { value: before },
          after: { value: req.body.value },
          reason: req.body.reason,
          sensitive: true,
        },
        { transaction: t },
      );
    });
    clearSettingsCache();
    res.json({ data: { key, value: req.body.value } });
  },
);

export default router;
