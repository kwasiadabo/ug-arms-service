/**
 * Integration tests for operations: the dashboard, reports and exports, Journey I (bulk import with validation,
 * reconciliation and idempotent retries), and settings including numbering formats.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs, createCompleteFonds, uniq, waitFor } from './helpers.js';
import { models } from '../src/database/models/index.js';

let archivist, chief, auditor, liaison, readingRoom, admin;
beforeAll(async () => {
  [archivist, chief, auditor, liaison, readingRoom, admin] = await Promise.all([
    loginAs('archivist'),
    loginAs('chief'),
    loginAs('auditor'),
    loginAs('liaison'),
    loginAs('readingRoom'),
    loginAs('admin'),
  ]);
});

describe('dashboard', () => {
  it('returns live, role-appropriate metrics', async () => {
    const chiefDash = await chief.get('/api/v1/dashboard');
    expect(chiefDash.status).toBe(200);
    expect(chiefDash.body.data.metrics.descriptions).toBe(await models.ArchivalRecord.count());
    expect(chiefDash.body.data.work.map((w) => w.key)).toContain('records_review');
    const rr = await readingRoom.get('/api/v1/dashboard');
    expect(rr.body.data.metrics.digitalAssets).toBeUndefined();
    expect(rr.body.data.metrics).toHaveProperty('appointmentsToday');
    const l = await liaison.get('/api/v1/dashboard');
    expect(l.body.data.metrics.descriptions).toBeUndefined();
  });
});

describe('reports and exports', () => {
  it('enforces report permissions and logs exports', async () => {
    const list = await archivist.get('/api/v1/reports');
    expect(list.body.data.map((r) => r.key)).not.toContain('access_changes');
    expect((await archivist.get('/api/v1/reports/access_changes')).status).toBe(403);
    const csv = await archivist.post('/api/v1/reports/collections_by_department/export').send({ format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const xlsx = await auditor.post('/api/v1/reports/access_changes/export').send({ format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    const job = await models.ExportJob.findOne({
      where: { reportType: 'access_changes' },
      order: [['createdAt', 'DESC']],
    });
    expect(job.isSensitive).toBe(true);
    expect(
      await models.AuditEvent.findOne({ where: { action: 'report.export', resourceId: job.id, sensitive: true } }),
    ).not.toBeNull();
    const pdf = await chief.post('/api/v1/reports/accessions_by_year/export').send({ format: 'pdf' });
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('exports EAD and Dublin Core without leaking restricted children', async () => {
    const fonds = await createCompleteFonds(chief);
    await chief
      .post('/api/v1/records')
      .send({ parentId: fonds.id, level: 'series', localIdentifier: 'OK', title: 'Visible series' });
    const secret = await chief.post('/api/v1/records').send({
      parentId: fonds.id,
      level: 'series',
      localIdentifier: 'NO',
      title: 'Restricted series',
      scopeAndContent: 'CONFIDENTIAL-CONTENT',
      accessLevel: 'confidential',
    });
    expect(secret.status).toBe(201);
    const ead = await archivist.get(`/api/v1/records/${fonds.id}/export/ead`);
    expect(ead.status).toBe(200);
    expect(ead.text).toContain('<ead');
    expect(ead.text).toContain('Visible series');
    expect(ead.text).not.toContain('CONFIDENTIAL-CONTENT');
    const dc = await archivist.get(`/api/v1/records/${fonds.id}/export/dc`);
    expect(dc.text).toContain('<dc:title>');
  });
});

describe('Journey I: bulk import with validation and idempotent retries', () => {
  it('maps, dry-runs, imports, reports rejected rows and does not duplicate on retry', async () => {
    const parentRef = uniq('LEG');
    const csv = [
      'Legacy ID,Reference,Parent,Level,Title,Date From,Date To,Subjects',
      `L1,${parentRef},,fonds,Registrar legacy register,1950,1970,University governance`,
      `L2,${parentRef}/1,${parentRef},series,Council papers,1950,1960,Student life`,
      `L3,${parentRef}/2,${parentRef},series,Bad dates,1990,1980,`,
      `L4,${parentRef}/3,${parentRef},series,Unknown subject,1950,1951,Underwater basket weaving`,
    ].join('\n');
    const up = await archivist
      .post('/api/v1/imports')
      .field('importType', 'archival_records')
      .attach('files', Buffer.from(''), 'x.csv')
      .catch(() => null);
    const created = await archivist
      .post('/api/v1/imports')
      .field('importType', 'archival_records')
      .attach('file', Buffer.from(csv), 'legacy.csv');
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.mapping).toMatchObject({
      'Legacy ID': 'sourceId',
      Reference: 'referenceCode',
      Parent: 'parentReference',
      Level: 'level',
      Title: 'title',
    });
    const v = await archivist.post(`/api/v1/imports/${id}/validate`).send({});
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ valid: 2, invalid: 2 });
    expect(await models.ArchivalRecord.count({ where: { referenceCode: parentRef } })).toBe(0);
    const run = await archivist.post(`/api/v1/imports/${id}/run`).send({});
    expect(run.status).toBe(202);
    await waitFor(async () =>
      ['completed', 'completed_with_errors'].includes((await models.ImportJob.findByPk(id)).status),
    );
    const recon = (await archivist.get(`/api/v1/imports/${id}`)).body.data.reconciliation;
    expect(recon).toMatchObject({ imported: 2, invalid: 2, balanced: true });
    const rejected = await archivist.get(`/api/v1/imports/${id}/rejected.csv`);
    expect(rejected.text).toMatch(/End date is before start date/);
    expect(rejected.text).toMatch(/Not in the controlled vocabulary/);

    // Re-uploading the same file is idempotent: already-imported rows are skipped, not duplicated.
    const again = await archivist
      .post('/api/v1/imports')
      .field('importType', 'archival_records')
      .attach('file', Buffer.from(csv), 'legacy.csv');
    await archivist.post(`/api/v1/imports/${again.body.data.id}/validate`).send({});
    await archivist.post(`/api/v1/imports/${again.body.data.id}/run`).send({});
    await waitFor(async () =>
      ['completed', 'completed_with_errors'].includes((await models.ImportJob.findByPk(again.body.data.id)).status),
    );
    expect(await models.ArchivalRecord.count({ where: { referenceCode: parentRef } })).toBe(1);
    expect((await archivist.get(`/api/v1/imports/${again.body.data.id}`)).body.data.reconciliation.skipped).toBe(2);
    // Sign-off must come from someone else.
    expect((await archivist.post(`/api/v1/imports/${id}/approve`).send({})).status).toBe(403);
    expect((await chief.post(`/api/v1/imports/${id}/approve`).send({ note: 'Reconciled' })).status).toBe(200);
    void up;
  });
});

describe('settings and numbering', () => {
  it('applies a configured numbering rule and audits the change', async () => {
    const set = await admin
      .put('/api/v1/settings/numbering.accession')
      .send({ value: 'UG/ACQ/{YYYY}/{SEQ:6}', reason: 'Align with registry format' });
    expect(set.status).toBe(200);
    const acc = await archivist.post('/api/v1/accessions').send({ title: 'Numbering check' });
    expect(acc.body.data.accessionNumber).toMatch(/^UG\/ACQ\/\d{4}\/\d{6}$/);
    expect((await admin.put('/api/v1/settings/numbering.accession').send({ value: 'NO-SEQUENCE' })).status).toBe(400);
    // Restore the default so other test files are unaffected by execution order.
    await models.SystemSetting.destroy({ where: { key: 'numbering.accession' } });
    (await import('../src/services/settings.service.js')).clearSettingsCache();
  });
});
