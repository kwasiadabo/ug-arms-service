/**
 * Bulk import of archival descriptions, authority records and physical items from CSV or Excel files.
 *
 * An import goes through upload, column mapping, validation (a dry run that writes nothing to the catalogue), the
 * import itself and sign-off by a second person. Every source row is reconciled: each ends up imported, skipped,
 * invalid or failed, and the totals must balance. Imports are idempotent, so a row whose source key was imported
 * before, by any job, is skipped and linked to the existing entry instead of being duplicated. Corrected rejected
 * rows can therefore be imported again safely.
 *
 * @author Kwasi Adabo Boakye
 */

import { stringify } from 'csv-stringify/sync';
import { models, sequelize } from '../../database/models/index.js';
import { badRequest, notFound, conflict } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { transition, assertSeparationOfDuties } from '../../services/workflow.service.js';
import { storage, buildKey, readToBuffer } from '../../services/storage/index.js';
import { parseTabular, normaliseDate, csvSafeRow } from '../../services/spreadsheet.service.js';
import { notifyUsers } from '../../services/notification.service.js';
import { enqueue } from '../../services/queue.service.js';
import { sha256 } from '../../utils/crypto.js';
import { loadPrincipal } from '../../middleware/auth.js';
import { createRecord, setSubjects } from '../records/records.service.js';
import { normaliseName } from '../cataloguing/authority.routes.js';
import { TEMPLATES, suggestMapping } from './templates.js';

/**
 * Returns the identifier scheme under which an import type records the source keys of imported rows.
 *
 * @param {string} type Import type, for example "archival_records".
 * @returns {string} The scheme, for example "import:archival_records".
 */
const identifierScheme = (type) => `import:${type}`;

/**
 * Stores an uploaded spreadsheet and creates an import job with a suggested column mapping.
 *
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file The uploaded file (held in memory).
 * @param {string} importType Kind of data in the file.
 * @param {object} user Authenticated principal.
 * @returns {Promise<{ job: object, sample: object[] }>} The job and the first ten rows for preview.
 * @throws {AppError} 400 when the file cannot be read or has no data rows.
 */
export async function createJob(file, importType, user) {
  const { headers, rows } = await parseTabular(file.buffer, file.originalname, { maxRows: 50000 });
  if (!rows.length) throw badRequest('The file has no data rows');
  const key = buildKey('imports', file.originalname);
  await storage.put(key, file.buffer, { contentType: file.mimetype });
  const job = await models.ImportJob.create({
    importType,
    status: 'uploaded',
    sourceFilename: file.originalname.slice(0, 500),
    storageKey: key,
    sha256: sha256(file.buffer),
    headers,
    mapping: suggestMapping(importType, headers),
    totalRows: rows.length,
    createdById: user.id,
  });
  await audit({
    action: 'import.uploaded',
    resourceType: 'ImportJob',
    resourceId: job.id,
    metadata: { importType, filename: file.originalname, rows: rows.length, sha256: job.sha256 },
  });
  return { job, sample: rows.slice(0, 10) };
}

/**
 * Reads the stored spreadsheet of an import job again.
 *
 * @param {object} job The import job.
 * @returns {Promise<object[]>} The data rows.
 */
async function loadRows(job) {
  const buf = await readToBuffer(job.storageKey);
  return (await parseTabular(buf, job.sourceFilename, { maxRows: 50000 })).rows;
}

/**
 * Converts a spreadsheet row to target fields using the column mapping. Text values are trimmed; unmapped columns
 * are ignored.
 *
 * @param {object} raw Row keyed by column heading.
 * @param {Record<string, string>} mapping Column heading to target field.
 * @returns {object}
 */
function mapRow(raw, mapping) {
  const out = {};
  for (const [col, field] of Object.entries(mapping))
    if (field) out[field] = typeof raw[col] === 'string' ? raw[col].trim() : raw[col];
  return out;
}

/**
 * Validates every row that has not yet been imported, without writing anything to the catalogue.
 *
 * Checks include required fields, allowed values, dates, numbers, controlled vocabulary terms and duplicate keys
 * within the file. For descriptions it also checks date order, reference codes already in use, parents that exist
 * in the file or the catalogue, and that only fonds or collections are top-level. For physical items it checks that
 * locations and descriptions exist. Errors make a row invalid; warnings do not. A row number is its line in the
 * spreadsheet, the first data row being 2.
 *
 * @param {string} id Identifier of the import job.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The numbers of valid and invalid rows and the current status counts.
 * @throws {AppError} When required fields are not mapped or the file cannot be read; the job is then marked failed.
 */
export async function validateJob(id, user) {
  const job = await models.ImportJob.findByPk(id);
  if (!job) throw notFound('Import');
  await sequelize.transaction((t) => transition('import', job, 'validate', { actor: user, transaction: t }));
  try {
    const template = TEMPLATES[job.importType];
    const missingRequired = Object.entries(template.fields)
      .filter(([, f]) => f.required)
      .map(([k]) => k)
      .filter((k) => !Object.values(job.mapping).includes(k));
    if (missingRequired.length) throw badRequest(`Map these required fields: ${missingRequired.join(', ')}`);
    const rows = await loadRows(job);
    const existing = new Map(
      (await models.ImportRowResult.findAll({ where: { jobId: id }, attributes: ['id', 'rowNumber', 'status'] })).map(
        (r) => [r.rowNumber, r],
      ),
    );
    const vocab = await models.ControlledVocabulary.findOne({
      where: { code: 'subjects' },
      include: [{ model: models.VocabularyTerm, as: 'terms', where: { isActive: true }, required: false }],
    });
    const subjectLabels = new Map((vocab?.terms || []).map((t) => [t.label.toLowerCase(), t.id]));
    const inFileRefs = new Set(rows.map((r) => mapRow(r, job.mapping).referenceCode).filter(Boolean));
    const seenKeys = new Map();
    const seenRefs = new Map();
    let valid = 0;
    let invalid = 0;
    for (const [i, raw] of rows.entries()) {
      const rowNumber = i + 2;
      const prior = existing.get(rowNumber);
      if (prior && ['imported', 'skipped'].includes(prior.status)) continue;
      const data = mapRow(raw, job.mapping);
      const errors = [];
      const warnings = [];
      for (const [name, f] of Object.entries(template.fields)) {
        const v = data[name];
        if (f.required && (v === undefined || v === null || v === ''))
          errors.push({ field: name, message: `${f.label} is required` });
        if (v && f.enum && !f.enum.includes(String(v).toLowerCase()))
          errors.push({ field: name, message: `"${v}" is not one of: ${f.enum.join(', ')}` });
        if (v && f.type === 'date' && normaliseDate(v) === undefined)
          errors.push({ field: name, message: `"${v}" is not a valid date (use YYYY, YYYY-MM-DD or DD/MM/YYYY)` });
        if (v && f.type === 'number' && Number.isNaN(Number(v)))
          errors.push({ field: name, message: `"${v}" is not a number` });
        if (v && f.vocabulary) {
          const unknown = String(v)
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s && !subjectLabels.has(s.toLowerCase()));
          if (unknown.length)
            errors.push({ field: name, message: `Not in the controlled vocabulary: ${unknown.join(', ')}` });
        }
      }
      const key = data[template.keyField];
      if (key) {
        if (seenKeys.has(key))
          errors.push({ field: template.keyField, message: `Duplicate key in file (also row ${seenKeys.get(key)})` });
        else seenKeys.set(key, rowNumber);
      }
      if (job.importType === 'archival_records') {
        const s = normaliseDate(data.dateStart);
        const e = normaliseDate(data.dateEnd);
        if (s && e && s > e) errors.push({ field: 'dateEnd', message: 'End date is before start date' });
        if (data.referenceCode) {
          if (seenRefs.has(data.referenceCode))
            errors.push({
              field: 'referenceCode',
              message: `Duplicate reference code in file (row ${seenRefs.get(data.referenceCode)})`,
            });
          seenRefs.set(data.referenceCode, rowNumber);
          const clash = await models.ArchivalRecord.findOne({
            where: { referenceCode: data.referenceCode },
            attributes: ['id'],
          });
          const ident = key
            ? await models.RecordIdentifier.findOne({
                where: { scheme: identifierScheme(job.importType), value: String(key) },
              })
            : null;
          if (clash && (!ident || ident.recordId !== clash.id))
            errors.push({ field: 'referenceCode', message: 'Reference code already exists in the catalogue' });
        }
        if (!data.referenceCode && !data.localIdentifier)
          errors.push({ field: 'referenceCode', message: 'Provide a reference code or a local identifier' });
        if (
          data.parentReference &&
          !inFileRefs.has(data.parentReference) &&
          !(await models.ArchivalRecord.findOne({ where: { referenceCode: data.parentReference }, attributes: ['id'] }))
        ) {
          errors.push({
            field: 'parentReference',
            message: `Parent ${data.parentReference} not found in the file or the catalogue`,
          });
        }
        if (!data.parentReference && data.level && !['fonds', 'collection'].includes(String(data.level).toLowerCase()))
          errors.push({ field: 'parentReference', message: 'Only fonds or collections can be top-level' });
        if (!data.dateExpression && !data.dateStart)
          warnings.push({ field: 'dateExpression', message: 'No date recorded' });
      }
      if (job.importType === 'physical_items') {
        if (
          data.locationCode &&
          !(await models.StorageLocation.findOne({ where: { code: data.locationCode }, attributes: ['id'] }))
        )
          errors.push({ field: 'locationCode', message: `Location ${data.locationCode} not found` });
        if (
          data.recordReference &&
          !(await models.ArchivalRecord.findOne({ where: { referenceCode: data.recordReference }, attributes: ['id'] }))
        )
          errors.push({ field: 'recordReference', message: `Description ${data.recordReference} not found` });
      }
      const status = errors.length ? 'invalid' : 'valid';
      if (status === 'valid') valid += 1;
      else invalid += 1;
      const payload = {
        jobId: id,
        rowNumber,
        sourceKey: key ? String(key).slice(0, 255) : null,
        status,
        errors,
        warnings,
        raw,
      };
      if (prior)
        await models.ImportRowResult.update(
          { ...payload, errors: JSON.stringify(errors), warnings: JSON.stringify(warnings), raw: JSON.stringify(raw) },
          { where: { id: prior.id } },
        );
      else await models.ImportRowResult.create(payload);
    }
    const counts = await rowCounts(id);
    await sequelize.transaction(async (t) => {
      await job.update({ validRows: counts.valid, invalidRows: counts.invalid, lastError: null }, { transaction: t });
      await transition('import', job, 'validated', { actor: user, transaction: t, metadata: counts });
    });
    return { valid, invalid, ...counts };
  } catch (err) {
    await sequelize.transaction(async (t) => {
      await job.update({ lastError: err.message.slice(0, 4000) }, { transaction: t });
      await transition('import', job, 'fail', { actor: user, transaction: t, reason: err.message });
    });
    throw err;
  }
}

/**
 * Counts the rows of an import job by status.
 *
 * @param {string} jobId Identifier of the import job.
 * @returns {Promise<{ valid: number, invalid: number, imported: number, skipped: number, failed: number }>}
 */
async function rowCounts(jobId) {
  const rows = await models.ImportRowResult.count({ where: { jobId }, group: ['status'] });
  const by = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    valid: by.valid || 0,
    invalid: by.invalid || 0,
    imported: by.imported || 0,
    skipped: by.skipped || 0,
    failed: by.failed || 0,
  };
}

/**
 * Starts importing the valid rows of a job in the background.
 *
 * @param {string} id Identifier of the import job.
 * @param {object} user Authenticated principal.
 * @returns {Promise<object>} The job.
 * @throws {AppError} 400 when there are no valid rows.
 */
export async function startRun(id, user) {
  const job = await models.ImportJob.findByPk(id);
  if (!job) throw notFound('Import');
  if (!(await models.ImportRowResult.count({ where: { jobId: id, status: 'valid' } })))
    throw badRequest('There are no valid rows to import. Validate the file first.');
  await sequelize.transaction((t) => transition('import', job, 'run', { actor: user, transaction: t }));
  await enqueue(
    'imports',
    'import.run',
    { importJobId: id },
    { entityType: 'ImportJob', entityId: id, requestedById: user.id },
  );
  return job;
}

/**
 * Background job: imports the valid rows of a running import.
 *
 * Rows whose source key was imported before are skipped and linked to the existing entry. Rows whose parent
 * description appears later in the same file are retried in further passes (up to 20), so the order of rows in the
 * file does not matter; rows whose parent can never be created are marked failed. An error in one row marks only
 * that row as failed. When finished, the job is completed (with or without errors), audited, and the person who
 * started it is notified in the application.
 *
 * @param {string} id Identifier of the import job.
 * @returns {Promise<object>} The final status counts, or `{ skipped: true }` when the job is not running.
 */
export async function runJob(id) {
  const job = await models.ImportJob.findByPk(id);
  if (!job || job.status !== 'running') return { skipped: true };
  const user = await loadPrincipal(job.createdById);
  const scheme = identifierScheme(job.importType);
  let pending = await models.ImportRowResult.findAll({
    where: { jobId: id, status: 'valid' },
    order: [['rowNumber', 'ASC']],
  });
  const subjectsVocab = await models.ControlledVocabulary.findOne({
    where: { code: 'subjects' },
    include: [{ model: models.VocabularyTerm, as: 'terms', required: false }],
  });
  const subjectIds = new Map((subjectsVocab?.terms || []).map((t) => [t.label.toLowerCase(), t.id]));
  // Multiple passes let children wait until their parent (also in this file) has been created.
  for (let pass = 0; pass < 20 && pending.length; pass += 1) {
    const deferred = [];
    for (const row of pending) {
      const data = mapRow(row.raw, job.mapping);
      try {
        if (job.importType === 'archival_records') {
          const existing = await models.RecordIdentifier.findOne({ where: { scheme, value: String(data.sourceId) } });
          if (existing) {
            await row.update({
              status: 'skipped',
              entityId: existing.recordId,
              warnings: [...row.warnings, { message: 'Already imported earlier; not duplicated' }],
            });
            continue;
          }
          let parent = null;
          if (data.parentReference) {
            parent = await models.ArchivalRecord.findOne({ where: { referenceCode: data.parentReference } });
            if (!parent) {
              deferred.push(row);
              continue;
            }
          }
          const rec = await createRecord(
            {
              parentId: parent?.id ?? null,
              level: String(data.level).toLowerCase(),
              title: data.title,
              referenceCode: data.referenceCode || undefined,
              localIdentifier: data.localIdentifier,
              dateExpression: data.dateExpression,
              dateStart: normaliseDate(data.dateStart) ?? null,
              dateEnd: normaliseDate(data.dateEnd) ?? null,
              extentAndMedium: data.extentAndMedium,
              creatorNote: data.creatorNote,
              scopeAndContent: data.scopeAndContent,
              adminBiographicalHistory: data.adminBiographicalHistory,
              accessConditions: data.accessConditions,
              reproductionConditions: data.reproductionConditions,
              archivistNote: data.archivistNote,
              accessLevel: data.accessLevel ? String(data.accessLevel).toLowerCase() : undefined,
              languages: data.languages
                ? String(data.languages)
                    .split(';')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [],
            },
            user,
          );
          await models.RecordIdentifier.create({ recordId: rec.id, scheme, value: String(data.sourceId) });
          if (data.subjects)
            await setSubjects(
              rec.id,
              String(data.subjects)
                .split(';')
                .map((s) => s.trim())
                .filter(Boolean)
                .map((s) => ({ termId: subjectIds.get(s.toLowerCase()), subjectType: 'subject' })),
              user,
            );
          await row.update({ status: 'imported', entityId: rec.id });
        } else if (job.importType === 'authority_records') {
          const existing = await models.AuthorityRecord.findOne({
            where: { identifier: `${scheme}:${data.sourceId}` },
          });
          if (existing) {
            await row.update({ status: 'skipped', entityId: existing.id });
            continue;
          }
          const a = await models.AuthorityRecord.create({
            entityType: data.entityType.toLowerCase(),
            authorizedName: data.authorizedName,
            normalisedName: normaliseName(data.authorizedName),
            otherNames: data.otherNames
              ? String(data.otherNames)
                  .split(';')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [],
            datesOfExistence: data.datesOfExistence,
            history: data.history,
            identifier: `${scheme}:${data.sourceId}`,
            verificationStatus: 'unverified',
            createdById: user.id,
            updatedById: user.id,
          });
          await row.update({ status: 'imported', entityId: a.id });
        } else if (job.importType === 'physical_items') {
          const existing = await models.PhysicalItem.findOne({ where: { barcode: data.barcode } });
          if (existing) {
            await row.update({ status: 'skipped', entityId: existing.id });
            continue;
          }
          const loc = data.locationCode
            ? await models.StorageLocation.findOne({ where: { code: data.locationCode } })
            : null;
          const rec = data.recordReference
            ? await models.ArchivalRecord.findOne({ where: { referenceCode: data.recordReference } })
            : null;
          const item = await models.PhysicalItem.create({
            barcode: data.barcode,
            title: data.title,
            itemType: data.itemType ? data.itemType.toLowerCase() : 'box',
            recordId: rec?.id,
            currentLocationId: loc?.id,
            homeLocationId: loc?.id,
            sizeUnits: data.sizeUnits ? Number(data.sizeUnits) : 1,
            createdById: user.id,
          });
          if (loc)
            await models.PhysicalItemMovement.create({
              itemId: item.id,
              toLocationId: loc.id,
              movementType: 'initial_placement',
              reason: `Imported (job ${id})`,
              movedById: user.id,
              movedAt: new Date(),
            });
          await row.update({ status: 'imported', entityId: item.id });
        }
      } catch (err) {
        await row.update({ status: 'failed', errors: [...row.errors, { message: err.message.slice(0, 500) }] });
      }
    }
    if (deferred.length === pending.length) {
      for (const row of deferred)
        await row.update({
          status: 'failed',
          errors: [...row.errors, { field: 'parentReference', message: 'Parent could not be created first' }],
        });
      break;
    }
    pending = deferred;
  }
  const c = await rowCounts(id);
  const action = c.failed || c.invalid ? 'complete_with_errors' : 'complete';
  await sequelize.transaction(async (t) => {
    await job.update(
      {
        importedRows: c.imported,
        skippedRows: c.skipped,
        failedRows: c.failed,
        invalidRows: c.invalid,
        completedAt: new Date(),
      },
      { transaction: t },
    );
    await transition('import', job, action, { actor: null, transaction: t, metadata: c });
  });
  await audit({
    action: 'import.completed',
    resourceType: 'ImportJob',
    resourceId: id,
    metadata: c,
    actorType: 'system',
  });
  await notifyUsers([job.createdById], {
    eventType: 'import.completed',
    title: `Import finished: ${job.sourceFilename}`,
    body: `Imported ${c.imported}, skipped ${c.skipped}, failed ${c.failed}, invalid ${c.invalid}.`,
    link: `/admin/imports/${id}`,
    email: false,
  });
  return c;
}

/**
 * Reconciles an import: the number of rows in the file against the rows in each status.
 *
 * @param {string} id Identifier of the import job.
 * @returns {Promise<object>} The counts, the number of rows attempted and whether the totals balance.
 * @throws {AppError} 404 when the job does not exist.
 */
export async function reconciliation(id) {
  const job = await models.ImportJob.findByPk(id);
  if (!job) throw notFound('Import');
  const c = await rowCounts(id);
  return {
    totalRows: job.totalRows,
    attempted: c.imported + c.skipped + c.failed,
    ...c,
    balanced: job.totalRows === c.valid + c.invalid + c.imported + c.skipped + c.failed,
  };
}

/**
 * Produces a CSV of the rejected (invalid or failed) rows with their errors and original values, ready to be
 * corrected and imported again. The file starts with a byte-order mark so Excel reads it as UTF-8.
 *
 * @param {string} id Identifier of the import job.
 * @returns {Promise<string>} The CSV text.
 */
export async function rejectedCsv(id) {
  const rows = await models.ImportRowResult.findAll({
    where: { jobId: id, status: ['invalid', 'failed'] },
    order: [['rowNumber', 'ASC']],
  });
  const out = rows.map((r) =>
    csvSafeRow({
      row: r.rowNumber,
      status: r.status,
      errors: r.errors.map((e) => `${e.field ? `${e.field}: ` : ''}${e.message}`).join(' | '),
      ...r.raw,
    }),
  );
  return `\uFEFF${stringify(out, { header: true })}`;
}

/**
 * Records sign-off of a finished import's reconciliation by a person other than the one who ran it. The
 * reconciliation figures are stored in the audit trail.
 *
 * @param {string} id Identifier of the import job.
 * @param {object} user Authenticated principal.
 * @param {string} [note] Comment recorded with the sign-off.
 * @returns {Promise<object>} The job.
 * @throws {AppError} When the import is not finished, already signed off, or the signer ran the import.
 */
export async function approveCompletion(id, user, note) {
  const job = await models.ImportJob.findByPk(id);
  if (!job) throw notFound('Import');
  if (!['completed', 'completed_with_errors'].includes(job.status))
    throw badRequest('Only finished imports can be signed off');
  if (job.approvedById) throw conflict('Already signed off');
  await assertSeparationOfDuties(user.id, [job.createdById], 'Another person must sign off the import reconciliation');
  await job.update({ approvedById: user.id, approvedAt: new Date() });
  await audit({
    action: 'import.approved',
    resourceType: 'ImportJob',
    resourceId: id,
    reason: note,
    metadata: await reconciliation(id),
  });
  return job;
}
