/**
 * HTTP routes for transfer submissions, mounted at /api/v1/transfers.
 *
 * A transfer is a department's proposal to send records to the Archives. Departmental liaisons ("transfer.submit")
 * prepare and submit transfers for their own unit only; records officers and archivists ("transfer.review") review
 * every transfer and decide line by line. When a department has no liaison, a records officer may prepare and submit
 * the transfer on its behalf; another reviewer then decides on it.
 *
 * - GET /inventory-template downloads a blank Excel or CSV inventory to fill in offline and import.
 * - GET / lists transfers visible to the caller, with filters and paging.
 * - POST / creates a draft transfer.
 * - GET /:id returns a transfer with its inventory, available actions, comments, revisions, documents and workflow
 *   history.
 * - PATCH /:id updates a draft or queried transfer.
 * - PUT /:id/items replaces the inventory; POST /:id/items/import loads it from a CSV or Excel file.
 * - POST /:id/transition performs a workflow action (submit, start review, raise a query, accept, partially accept,
 *   reject, resubmit or cancel).
 * - POST /:id/comments adds to the discussion with the department.
 * - GET /:id/revisions/:revision returns the snapshot taken at a submission.
 * - POST /:id/documents and GET /:id/documents/:docId upload and download supporting documents.
 * - POST /:id/create-accession turns an accepted transfer into a draft accession.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { TRANSFER_STATUSES } from '../../database/models/accessioning.js';
import { authenticate, requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { idParams, uuid, isoDate, optionalText } from '../../validators/common.js';
import { paginationSchema, pageParams, orderBy, paged } from '../../utils/pagination.js';
import { badRequest } from '../../utils/errors.js';
import { hasPerm } from '../../services/accessPolicy.service.js';
import { history } from '../../services/workflow.service.js';
import { getSetting } from '../../services/settings.service.js';
import { parseTabular } from '../../services/spreadsheet.service.js';
import { diskUpload } from '../../services/upload.service.js';
import * as svc from './transfers.service.js';
import { storeDocuments, listDocuments, streamDocument } from './documents.js';

const router = Router();
router.use(authenticate, requireAnyPermission('transfer.submit', 'transfer.review'));

const submissionBody = z.object({
  title: z.string().trim().min(3).max(500),
  originatingUnitId: uuid,
  contactName: z.string().trim().min(2).max(200),
  contactEmail: z.string().email().optional().nullable(),
  contactPhone: optionalText(60),
  proposedTransferDate: isoDate,
  transferAuthority: optionalText(1000),
  reason: optionalText(20000),
  recordsDateRange: optionalText(255),
  totalExtent: optionalText(255),
  confidentialityNotes: optionalText(20000),
});
const itemBody = z.object({
  sourceIdentifier: optionalText(120),
  title: z.string().trim().max(1000),
  dateExpression: optionalText(255),
  dateStart: z.string().max(20).optional().nullable(),
  dateEnd: z.string().max(20).optional().nullable(),
  format: optionalText(80),
  quantity: z.union([z.number(), z.string()]).optional().nullable(),
  extent: optionalText(255),
  boxNumber: optionalText(60),
  condition: optionalText(255),
  confidentiality: optionalText(255),
  notes: optionalText(2000),
});

// Columns of the downloadable inventory template, in order. Each header is one of COLUMN_ALIASES below, so a filled-in
// template imports without any column mapping.
const TEMPLATE_COLUMNS = [
  [
    'Identifier',
    18,
    false,
    'Your own file, volume or box reference. Must not repeat within the inventory.',
    'HIST/ADM/12',
  ],
  ['Title', 48, true, 'What the item is. Required on every line.', 'Staff meeting minutes'],
  ['Dates', 18, false, 'The dates as written on the item, in any form.', '1960–1965'],
  ['From', 14, false, 'Earliest date: YYYY, YYYY-MM-DD or DD/MM/YYYY.', '1960'],
  ['To', 14, false, 'Latest date, in the same forms. Not before From.', '1965'],
  ['Format', 18, false, 'Physical form.', 'Paper file'],
  ['Quantity', 10, false, 'Number of items, a positive whole number. Left empty, it counts as 1.', '2'],
  [
    'Extent',
    16,
    false,
    'How much material the line covers, as a measure (Quantity is the count). Other examples: 3 volumes, 120 sheets, 2 archive boxes.',
    '0.5 linear metres',
  ],
  [
    'Box',
    10,
    false,
    'The number written on the box the item is packed in, so the Archives can match the list to the boxes. Other examples: Box 3 of 12, B-07.',
    '3',
  ],
  ['Condition', 18, false, 'Physical condition.', 'Fragile'],
  ['Confidentiality', 20, false, 'Anything sensitive or confidential in the item.', 'Personnel details'],
  ['Notes', 36, false, 'Anything else the Archives should know.', 'Two folders bound together'],
];

/**
 * @openapi
 * /transfers/inventory-template:
 *   get: { tags: [Accessioning], summary: 'Blank inventory template to fill in offline and import (format=xlsx or csv)', responses: { 200: { description: The template file } } }
 */
router.get(
  '/inventory-template',
  validate({ query: z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }) }),
  async (req, res) => {
    const headers = TEMPLATE_COLUMNS.map(([h]) => h);
    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="transfer-inventory-template.csv"');
      // The byte-order mark makes Excel open the file as UTF-8.
      res.send(`\uFEFF${headers.join(',')}\r\n`);
      return;
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'UG-ARMS';
    // The import reads the first sheet only, so the guidance sheet comes second.
    const ws = wb.addWorksheet('Inventory', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = TEMPLATE_COLUMNS.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A5C' } };
    ws.getCell('B1').note = 'Required';
    // Dates are kept as typed (text), so Excel does not turn 1960 or 15/03/1962 into a different date.
    for (const col of ['C', 'D', 'E']) ws.getColumn(col).numFmt = '@';
    ws.dataValidations.add('G2:G5001', {
      type: 'whole',
      operator: 'greaterThanOrEqual',
      formulae: [1],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Quantity',
      error: 'Enter a positive whole number, or leave it empty for 1.',
    });
    const guide = wb.addWorksheet('How to fill this in');
    guide.columns = [
      { header: 'Column', width: 18 },
      { header: 'Required', width: 10 },
      { header: 'What to enter', width: 70 },
      { header: 'Example', width: 28 },
    ];
    guide.getRow(1).font = { bold: true };
    for (const [header, , required, help, example] of TEMPLATE_COLUMNS)
      guide.addRow([header, required ? 'Yes' : 'No', help, example]);
    guide.addRow([]);
    guide.addRow(['', '', 'One line per file, volume or box. Keep the column headings as they are.']);
    guide.addRow(['', '', 'Save as .xlsx or .csv, then choose Import on the transfer and check the preview.']);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="transfer-inventory-template.xlsx"');
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  },
);

/**
 * @openapi
 * /transfers:
 *   get: { tags: [Accessioning], summary: Transfer submissions (liaisons see their own unit only), responses: { 200: { description: Paged } } }
 *   post: { tags: [Accessioning], summary: Create a draft transfer submission, responses: { 201: { description: Created } } }
 */
router.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(TRANSFER_STATUSES).optional(),
      originatingUnitId: uuid.optional(),
    }),
  }),
  async (req, res) => {
    const where = {};
    if (!hasPerm(req.user, 'transfer.review'))
      where.originatingUnitId = req.user.organisationUnitId ?? '00000000-0000-0000-0000-000000000000';
    else if (req.query.originatingUnitId) where.originatingUnitId = req.query.originatingUnitId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.q)
      where[Op.or] = [
        { title: { [Op.like]: `%${req.query.q}%` } },
        { referenceNumber: { [Op.like]: `%${req.query.q}%` } },
      ];
    paged(
      res,
      await models.TransferSubmission.findAndCountAll({
        where,
        ...pageParams(req.query),
        order: orderBy(req.query.sort, req.query.order, [
          'createdAt',
          'submittedAt',
          'status',
          'referenceNumber',
          'title',
        ]),
        include: [
          { model: models.OrganisationUnit, as: 'originatingUnit', attributes: ['id', 'name', 'code'] },
          { model: models.User, as: 'submittedBy', attributes: ['id', 'fullName'] },
        ],
      }),
      req.query,
    );
  },
);

router.post('/', requirePermission('transfer.submit'), validate({ body: submissionBody }), async (req, res) => {
  res.status(201).json({ data: await svc.createSubmission(req.body, req.user) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const s = await svc.loadVisible(req.params.id, req.user);
  const [items, revisions, comments, documents, hist, unit, submittedBy, separationOfDuties] = await Promise.all([
    models.TransferInventoryItem.findAll({ where: { submissionId: s.id }, order: [['lineNumber', 'ASC']] }),
    models.TransferSubmissionRevision.findAll({
      where: { submissionId: s.id },
      attributes: ['id', 'revision', 'createdAt'],
      order: [['revision', 'ASC']],
    }),
    models.Comment.findAll({
      where: {
        entityType: 'TransferSubmission',
        entityId: s.id,
        ...(hasPerm(req.user, 'transfer.review') ? {} : { visibility: 'shared' }),
      },
      include: [{ model: models.User, as: 'author', attributes: ['id', 'fullName'] }],
      order: [['createdAt', 'ASC']],
    }),
    listDocuments('transfer_submission', s.id),
    history('TransferSubmission', s.id),
    models.OrganisationUnit.findByPk(s.originatingUnitId, { attributes: ['id', 'name', 'code'] }),
    s.submittedById ? models.User.findByPk(s.submittedById, { attributes: ['id', 'fullName'] }) : null,
    getSetting('workflow.separationOfDuties'),
  ]);
  res.json({
    data: {
      ...s.get({ plain: true }),
      originatingUnit: unit,
      submittedBy,
      items,
      revisions,
      comments,
      documents,
      history: hist,
      availableActions: svc.actionsFor(s, req.user, Boolean(separationOfDuties)),
      validation: svc.validateSubmission(s, items),
    },
  });
});

router.patch('/:id', validate({ params: idParams, body: submissionBody.partial() }), async (req, res) => {
  res.json({ data: await svc.updateSubmission(req.params.id, req.body, req.user) });
});

router.put(
  '/:id/items',
  validate({ params: idParams, body: z.object({ items: z.array(itemBody).max(5000) }) }),
  async (req, res) => {
    res.json({ data: { lines: await svc.replaceItems(req.params.id, req.body.items, req.user) } });
  },
);

const COLUMN_ALIASES = {
  sourceIdentifier: ['sourceidentifier', 'identifier', 'ref', 'reference', 'file no', 'file number'],
  title: ['title', 'description', 'file title'],
  dateExpression: ['dates', 'date', 'dateexpression'],
  dateStart: ['datestart', 'start date', 'from'],
  dateEnd: ['dateend', 'end date', 'to'],
  format: ['format', 'type', 'medium'],
  quantity: ['quantity', 'qty', 'count'],
  extent: ['extent', 'size'],
  boxNumber: ['box', 'boxnumber', 'box no'],
  condition: ['condition'],
  confidentiality: ['confidentiality', 'sensitivity'],
  notes: ['notes', 'remarks', 'comments'],
};
/**
 * @openapi
 * /transfers/{id}/items/import:
 *   post: { tags: [Accessioning], summary: Parse a CSV/XLSX inventory; returns rows and validation errors. Pass apply=true to replace the inventory., responses: { 200: { description: Parsed } } }
 */
router.post(
  '/:id/items/import',
  validate({ params: idParams }),
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file'),
  async (req, res) => {
    if (!req.file) throw badRequest('Upload a CSV or Excel file in the "file" field');
    await svc.loadVisible(req.params.id, req.user);
    const { headers, rows } = await parseTabular(req.file.buffer, req.file.originalname, { maxRows: 5000 });
    const map = {};
    for (const h of headers) {
      const key = h.toLowerCase().replace(/[_-]+/g, ' ').trim();
      const field = Object.entries(COLUMN_ALIASES).find(
        ([, aliases]) => aliases.includes(key) || aliases.includes(key.replace(/ /g, '')),
      );
      if (field) map[h] = field[0];
    }
    const items = rows.map((r) =>
      Object.fromEntries(
        Object.entries(r)
          .filter(([h]) => map[h])
          .map(([h, v]) => [map[h], v === '' ? null : v]),
      ),
    );
    const errors = svc.validateInventory(items);
    let applied = false;
    if (req.query.apply === 'true' && !errors.length) {
      await svc.replaceItems(req.params.id, items, req.user);
      applied = true;
    }
    res.json({
      data: { headers, mapping: map, unmappedColumns: headers.filter((h) => !map[h]), rows: items, errors, applied },
    });
  },
);

/**
 * @openapi
 * /transfers/{id}/transition:
 *   post: { tags: [Accessioning], summary: Workflow action (submit, start_review, raise_query, resubmit, accept, partially_accept, reject, cancel), responses: { 200: { description: OK } } }
 */
router.post(
  '/:id/transition',
  validate({
    params: idParams,
    body: z.object({
      action: z.enum([
        'submit',
        'start_review',
        'raise_query',
        'resubmit',
        'accept',
        'partially_accept',
        'reject',
        'cancel',
      ]),
      reason: z.string().trim().max(4000).optional(),
      itemDecisions: z
        .array(
          z.object({ itemId: uuid, decision: z.enum(['accepted', 'rejected']), note: z.string().max(1000).optional() }),
        )
        .max(5000)
        .optional(),
    }),
  }),
  async (req, res) => {
    const s = await svc.transitionSubmission(req.params.id, req.body, req.user);
    res.json({ data: { id: s.id, status: s.status, referenceNumber: s.referenceNumber } });
  },
);

router.post(
  '/:id/comments',
  validate({
    params: idParams,
    body: z.object({
      body: z.string().trim().min(1).max(4000),
      visibility: z.enum(['internal', 'shared']).default('shared'),
    }),
  }),
  async (req, res) => {
    const s = await svc.loadVisible(req.params.id, req.user);
    const visibility = hasPerm(req.user, 'transfer.review') ? req.body.visibility : 'shared';
    const c = await models.Comment.create({
      entityType: 'TransferSubmission',
      entityId: s.id,
      authorId: req.user.id,
      body: req.body.body,
      visibility,
    });
    res.status(201).json({ data: c });
  },
);

router.get(
  '/:id/revisions/:revision',
  validate({ params: z.object({ id: uuid, revision: z.coerce.number().int().min(1) }) }),
  async (req, res) => {
    await svc.loadVisible(req.params.id, req.user);
    const r = await models.TransferSubmissionRevision.findOne({
      where: { submissionId: req.params.id, revision: req.params.revision },
    });
    if (!r) throw badRequest('Revision not found');
    res.json({ data: r });
  },
);

router.post('/:id/documents', validate({ params: idParams }), diskUpload(100).array('files', 20), async (req, res) => {
  const s = await svc.loadVisible(req.params.id, req.user);
  if (!req.files?.length) throw badRequest('Attach at least one file in the "files" field');
  res.status(201).json({
    data: await storeDocuments('transfer_submission', s.id, req.files, req.body.documentType || 'supporting', req.user),
  });
});

router.get('/:id/documents/:docId', validate({ params: z.object({ id: uuid, docId: uuid }) }), async (req, res) => {
  await svc.loadVisible(req.params.id, req.user);
  await streamDocument('transfer_submission', req.params.id, req.params.docId, res, {
    preview: req.query.preview === 'true',
  });
});

router.post(
  '/:id/create-accession',
  requirePermission('accession.create'),
  validate({ params: idParams }),
  async (req, res) => {
    const { accession, created } = await svc.createAccessionFromSubmission(req.params.id, req.user);
    res.status(created ? 201 : 200).json({ data: accession, meta: { created } });
  },
);

export default router;
