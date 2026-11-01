/**
 * HTTP routes for controlled vocabularies and their terms (for example subjects, genres and record types), mounted
 * at /api/v1/vocabularies.
 *
 * Any signed-in user may read them (GET / and GET /:code/terms). Creating vocabularies and terms, editing terms and
 * removing terms require "vocabulary.manage"; a term already used by a description cannot be deleted and must be
 * deactivated instead, so existing descriptions keep their meaning. Every change is audited.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid } from '../../validators/common.js';
import { notFound, conflict, forbidden } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * /vocabularies:
 *   get: { tags: [Vocabularies], summary: Controlled vocabularies with active terms, responses: { 200: { description: Vocabularies } } }
 */
router.get('/', async (req, res) => {
  const rows = await models.ControlledVocabulary.findAll({
    include: [
      {
        model: models.VocabularyTerm,
        as: 'terms',
        required: false,
        where: req.query.includeInactive === 'true' ? {} : { isActive: true },
      },
    ],
    order: [
      ['name', 'ASC'],
      [{ model: models.VocabularyTerm, as: 'terms' }, 'sortOrder', 'ASC'],
      [{ model: models.VocabularyTerm, as: 'terms' }, 'label', 'ASC'],
    ],
  });
  res.json({ data: rows });
});

router.get(
  '/:code/terms',
  validate({ params: z.object({ code: z.string().max(60) }), query: z.object({ q: z.string().max(100).optional() }) }),
  async (req, res) => {
    const vocab = await models.ControlledVocabulary.findOne({ where: { code: req.params.code } });
    if (!vocab) throw notFound('Vocabulary');
    const where = { vocabularyId: vocab.id, isActive: true };
    if (req.query.q) where.label = { [Op.like]: `%${req.query.q}%` };
    res.json({
      data: await models.VocabularyTerm.findAll({
        where,
        order: [
          ['sortOrder', 'ASC'],
          ['label', 'ASC'],
        ],
        limit: 500,
      }),
    });
  },
);

router.post(
  '/',
  requirePermission('vocabulary.manage'),
  validate({
    body: z.object({
      code: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/),
      name: z.string().min(2).max(200),
      description: z.string().max(1000).optional(),
      isHierarchical: z.boolean().default(false),
    }),
  }),
  async (req, res) => {
    if (await models.ControlledVocabulary.findOne({ where: { code: req.body.code } }))
      throw conflict('Vocabulary code already exists');
    const v = await models.ControlledVocabulary.create(req.body);
    await audit({
      action: 'vocabulary.create',
      resourceType: 'ControlledVocabulary',
      resourceId: v.id,
      after: req.body,
    });
    res.status(201).json({ data: v });
  },
);

const termBody = z.object({
  label: z.string().trim().min(1).max(255),
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,80}$/)
    .optional(),
  parentId: uuid.nullable().optional(),
  scopeNote: z.string().max(1000).optional().nullable(),
  altLabels: z.array(z.string().max(255)).max(20).optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  '/:id/terms',
  requirePermission('vocabulary.manage'),
  validate({ params: idParams, body: termBody }),
  async (req, res) => {
    const vocab = await models.ControlledVocabulary.findByPk(req.params.id);
    if (!vocab) throw notFound('Vocabulary');
    const code =
      req.body.code ||
      req.body.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80);
    if (await models.VocabularyTerm.findOne({ where: { vocabularyId: vocab.id, code } }))
      throw conflict('A term with this code already exists');
    const term = await models.VocabularyTerm.create({ ...req.body, code, vocabularyId: vocab.id });
    await audit({
      action: 'vocabulary.term_created',
      resourceType: 'VocabularyTerm',
      resourceId: term.id,
      after: { vocabulary: vocab.code, label: term.label },
    });
    res.status(201).json({ data: term });
  },
);

router.patch(
  '/terms/:id',
  requirePermission('vocabulary.manage'),
  validate({ params: idParams, body: termBody.partial().omit({ code: true }) }),
  async (req, res) => {
    const term = await models.VocabularyTerm.findByPk(req.params.id);
    if (!term) throw notFound('Term');
    const before = term.get({ plain: true });
    await sequelize.transaction(async (t) => {
      await term.update(req.body, { transaction: t });
      await audit(
        {
          action: 'vocabulary.term_updated',
          resourceType: 'VocabularyTerm',
          resourceId: term.id,
          before: { label: before.label, isActive: before.isActive },
          after: { label: term.label, isActive: term.isActive },
        },
        { transaction: t },
      );
    });
    res.json({ data: term });
  },
);

// Terms in use are deactivated rather than deleted so existing descriptions keep their meaning.
router.delete(
  '/terms/:id',
  requirePermission('vocabulary.manage'),
  validate({ params: idParams }),
  async (req, res) => {
    const term = await models.VocabularyTerm.findByPk(req.params.id);
    if (!term) throw notFound('Term');
    if (await models.RecordSubject.count({ where: { termId: term.id } }))
      throw forbidden('This term is in use. Deactivate it instead.');
    await term.destroy();
    await audit({
      action: 'vocabulary.term_deleted',
      resourceType: 'VocabularyTerm',
      resourceId: term.id,
      before: { label: term.label },
    });
    res.status(204).end();
  },
);

export default router;
