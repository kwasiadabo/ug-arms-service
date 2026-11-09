/**
 * Integration tests for Journeys B and C: departmental transfers (own-unit restriction, inventory validation,
 * submission, line-by-line decisions), accession approval and receipts, and physical storage with capacity checks.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs, uniq, createCompleteFonds } from './helpers.js';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { models } from '../src/database/models/index.js';
import { clearSettingsCache } from '../src/services/settings.service.js';

let liaison, records, chief, archivist, histUnit, physUnit;
beforeAll(async () => {
  [liaison, records, chief, archivist] = await Promise.all([
    loginAs('liaison'),
    loginAs('records'),
    loginAs('chief'),
    loginAs('archivist'),
  ]);
  histUnit = await models.OrganisationUnit.findOne({ where: { code: 'HIST' } });
  physUnit = await models.OrganisationUnit.findOne({ where: { code: 'PHYS' } });
});

/**
 * Creates a draft transfer for the Department of History.
 *
 * @param {object} [client=liaison] Logged-in client creating the transfer.
 * @returns {Promise<object>} The transfer.
 */
async function draftTransfer(client = liaison) {
  const res = await client.post('/api/v1/transfers').send({
    title: 'History department correspondence',
    originatingUnitId: histUnit.id,
    contactName: 'Kwame Addo',
    proposedTransferDate: '2026-11-15',
    transferAuthority: 'Head of Department memo 12/2026',
  });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('Journey B: departmental transfer', () => {
  it('liaison can only prepare transfers for their own unit', async () => {
    const res = await liaison.post('/api/v1/transfers').send({
      title: 'Not mine',
      originatingUnitId: physUnit.id,
      contactName: 'Someone Else',
      proposedTransferDate: '2026-11-15',
      transferAuthority: 'Memo',
    });
    expect(res.status).toBe(403);
  });

  it('validates the inventory and blocks submission until it is complete', async () => {
    const t = await draftTransfer();
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' })).status).toBe(422);
    const bad = await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'A', sourceIdentifier: 'X1', dateStart: '1999-13-45' },
        { title: 'B', sourceIdentifier: 'X1' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d) => d.message).join(' ')).toMatch(/Duplicate identifier/);
  });

  it('runs submit → query → resubmit → partial acceptance → accession, preserving revisions', async () => {
    const t = await draftTransfer();
    await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'Staff minutes 1960-1965', sourceIdentifier: 'H/1', dateStart: '1960', dateEnd: '1965', quantity: 2 },
        { title: 'Duplicate copies', sourceIdentifier: 'H/2' },
      ],
    });
    const sub = await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' });
    expect(sub.status).toBe(200);
    expect(sub.body.data.referenceNumber).toMatch(/^UGA\/TRF\/\d{4}\/\d{4}$/);
    // Liaison cannot review.
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' })).status).toBe(
      403,
    );
    expect((await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'raise_query' })).status).toBe(
      422,
    );
    expect(
      (
        await records
          .post(`/api/v1/transfers/${t.id}/transition`)
          .send({ action: 'raise_query', reason: 'Please give the date range for line 2' })
      ).status,
    ).toBe(200);
    await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'Staff minutes 1960-1965', sourceIdentifier: 'H/1', dateStart: '1960', dateEnd: '1965', quantity: 2 },
        { title: 'Duplicate copies', sourceIdentifier: 'H/2', dateExpression: '1970s' },
      ],
    });
    expect((await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'resubmit' })).status).toBe(200);
    await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' });
    const detail = await records.get(`/api/v1/transfers/${t.id}`);
    const [l1, l2] = detail.body.data.items;
    const noDecisions = await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'partially_accept' });
    expect(noDecisions.status).toBe(422);
    const partial = await records.post(`/api/v1/transfers/${t.id}/transition`).send({
      action: 'partially_accept',
      reason: 'Duplicates not retained',
      itemDecisions: [
        { itemId: l1.id, decision: 'accepted' },
        { itemId: l2.id, decision: 'rejected', note: 'Duplicates' },
      ],
    });
    expect(partial.status).toBe(200);
    const after = await liaison.get(`/api/v1/transfers/${t.id}`);
    expect(after.body.data.revisions.length).toBe(2);
    expect(after.body.data.comments.length).toBeGreaterThan(0);
    // Liaison cannot accession; records officer can, and repeat calls do not duplicate.
    expect((await liaison.post(`/api/v1/transfers/${t.id}/create-accession`).send({})).status).toBe(403);
    const acc1 = await records.post(`/api/v1/transfers/${t.id}/create-accession`).send({});
    expect(acc1.status).toBe(201);
    const acc2 = await records.post(`/api/v1/transfers/${t.id}/create-accession`).send({});
    expect(acc2.status).toBe(200);
    expect(acc2.body.data.id).toBe(acc1.body.data.id);
    const acc = await records.get(`/api/v1/accessions/${acc1.body.data.id}`);
    expect(acc.body.data.items.map((i) => i.description)).toEqual(['Staff minutes 1960-1965']);
  });

  it('previews supporting documents inline, sandboxed and audited separately from downloads', async () => {
    const t = await draftTransfer();
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 90, b: 70 } } })
      .png()
      .toBuffer();
    const up = await liaison.post(`/api/v1/transfers/${t.id}/documents`).attach('files', png, 'signed-list.png');
    expect(up.status).toBe(201);
    const doc = up.body.data[0];
    expect(doc.mediaType).toBe('image/png');

    const preview = await liaison.get(`/api/v1/transfers/${t.id}/documents/${doc.id}?preview=true`);
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toBe('image/png');
    expect(preview.headers['content-disposition']).toMatch(/^inline;/);
    expect(preview.headers['content-security-policy']).toMatch(/sandbox/);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');

    const dl = await liaison.get(`/api/v1/transfers/${t.id}/documents/${doc.id}`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    const actions = (
      await models.AuditEvent.findAll({
        where: { resourceId: t.id },
        attributes: ['action'],
        order: [['occurredAt', 'ASC']],
      })
    ).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['document.upload', 'document.preview', 'document.download']));

    // Reviewers can preview any transfer's documents.
    expect((await archivist.get(`/api/v1/transfers/${t.id}/documents/${doc.id}?preview=true`)).status).toBe(200);
  });

  it('offers inventory templates that import back without any column mapping', async () => {
    /**
     * Collects a binary response body as a Buffer.
     *
     * @param {object} res Node response stream.
     * @param {Function} cb Callback receiving the body.
     */
    const binary = (res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const xlsx = await liaison.get('/api/v1/transfers/inventory-template?format=xlsx').buffer(true).parse(binary);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-disposition']).toMatch(/transfer-inventory-template\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Inventory', 'How to fill this in']);
    const ws = wb.worksheets[0];
    ws.addRow(['H/10', 'Departmental board minutes', '1960–1965', '1960', '15/03/1965', 'Paper file', 2]);
    ws.addRow(['H/11', 'Correspondence with the Registrar', '', '1970', '', '', '', '', '4', 'Fragile']);
    const t = await draftTransfer();
    const imported = await liaison
      .post(`/api/v1/transfers/${t.id}/items/import?apply=true`)
      .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'filled-template.xlsx');
    expect(imported.status).toBe(200);
    expect(imported.body.data.unmappedColumns).toEqual([]);
    expect(Object.keys(imported.body.data.mapping)).toHaveLength(12);
    expect(imported.body.data.errors).toEqual([]);
    expect(imported.body.data.applied).toBe(true);
    const saved = (await liaison.get(`/api/v1/transfers/${t.id}`)).body.data.items;
    expect(saved.map((i) => [i.sourceIdentifier, i.dateEnd, i.quantity, i.boxNumber])).toEqual([
      ['H/10', '1965-03-15', 2, null],
      ['H/11', null, 1, '4'],
    ]);

    const csv = await records.get('/api/v1/transfers/inventory-template?format=csv');
    expect(csv.status).toBe(200);
    const parsed = await liaison
      .post(`/api/v1/transfers/${t.id}/items/import`)
      .attach('file', Buffer.from(`${csv.text}H/12,Annual reports\r\n`), 'filled-template.csv');
    expect(parsed.body.data.unmappedColumns).toEqual([]);
    expect(parsed.body.data.rows).toHaveLength(1);
  });

  it('lets a records officer submit on behalf of a department, leaving the decision to another reviewer', async () => {
    const t = await draftTransfer(records);
    expect(t.submittedOnBehalf).toBe(true);
    const own = await records.post('/api/v1/transfers').send({
      title: 'Registry files',
      originatingUnitId: records.user.organisationUnitId,
      contactName: 'Efua Asante',
      proposedTransferDate: '2026-11-15',
    });
    expect(own.body.data.submittedOnBehalf).toBe(false);

    await records.put(`/api/v1/transfers/${t.id}/items`).send({ items: [{ title: 'Departmental board minutes' }] });
    expect((await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' })).status).toBe(200);

    // The department's own liaison can follow it.
    const seen = await liaison.get(`/api/v1/transfers/${t.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.submittedOnBehalf).toBe(true);

    // The preparer is offered no review actions and cannot decide.
    const mine = await records.get(`/api/v1/transfers/${t.id}`);
    expect(mine.body.data.submittedBy.id).toBe(records.user.id);
    expect(mine.body.data.availableActions).not.toContain('start_review');
    expect(mine.body.data.availableActions).not.toContain('accept');
    expect(
      (await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'reject', reason: 'Not mine' }))
        .status,
    ).toBe(403);

    const theirs = await archivist.get(`/api/v1/transfers/${t.id}`);
    expect(theirs.body.data.availableActions).toContain('start_review');
    await archivist.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' });
    expect((await archivist.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'accept' })).status).toBe(200);
  });
});

describe('Journey C: accession approval', () => {
  it('flags missing information, enforces separation of duties and issues a receipt', async () => {
    const created = await archivist
      .post('/api/v1/accessions')
      .send({ title: 'Donated photographs', sourceType: 'donor', donorName: 'Estate of a former lecturer' });
    expect(created.status).toBe(201);
    expect(created.body.data.accessionNumber).toMatch(/^UGA\/ACC\//);
    const id = created.body.data.id;
    await archivist.put(`/api/v1/accessions/${id}/items`).send({
      items: [
        { description: 'Album of campus photographs', quantity: 1 },
        { description: 'Loose prints', quantity: 40 },
      ],
    });
    // Submitting is refused while required information is missing, and the refusal names each piece.
    const early = await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'submit' });
    expect(early.status).toBe(422);
    expect(early.body.error.details.map((x) => x.path)).toEqual(
      expect.arrayContaining(['transferAuthorityOrLegalBasis', 'physicalCondition', 'provenance', 'rightsStatement']),
    );
    expect(early.body.error.details.find((x) => x.path === 'rightsStatement').message).toMatch(/^Rights statement: /);
    const before = (await archivist.get(`/api/v1/accessions/${id}`)).body.data;
    expect(before.status).toBe('draft');
    expect(before.completenessRequired).toBe(true);
    await archivist.patch(`/api/v1/accessions/${id}`).send({
      accessionDate: '2026-11-05',
      legalBasis: 'Deed of gift',
      extent: '1 album; 40 loose prints',
      physicalCondition: 'Good; some foxing on loose prints',
      provenance: 'Kept by the donor since the 1960s',
      rightsStatement: 'Copyright assigned to the University',
      version: before.version,
    });
    const sub = await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'submit' });
    expect(sub.status).toBe(200);
    const d = await chief.get(`/api/v1/accessions/${id}`);
    expect(d.body.data.missing).toEqual([]);
    await chief.post(`/api/v1/accessions/${id}/transition`).send({ action: 'start_review' });
    // An accession that lost information after submission (for example, submitted before the rule) cannot be approved.
    await models.Accession.update({ rightsStatement: null }, { where: { id } });
    const gap = await chief.post(`/api/v1/accessions/${id}/transition`).send({ action: 'approve' });
    expect(gap.status).toBe(422);
    expect(gap.body.error.message).toMatch(/Query it back/);
    await models.Accession.update({ rightsStatement: 'Copyright assigned to the University' }, { where: { id } });
    expect((await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'approve' })).status).toBe(403);
    expect((await chief.get(`/api/v1/accessions/${id}/receipt`)).status).toBe(400);
    await chief.post(`/api/v1/accessions/${id}/quarantine`).send({ quarantine: true, reason: 'Mould suspected' });
    expect((await chief.post(`/api/v1/accessions/${id}/transition`).send({ action: 'approve' })).status).toBe(400);
    await chief
      .post(`/api/v1/accessions/${id}/quarantine`)
      .send({ quarantine: false, reason: 'Cleared by conservator' });
    const items = d.body.data.items;
    const ok = await chief.post(`/api/v1/accessions/${id}/transition`).send({
      action: 'approve',
      itemDecisions: [
        { itemId: items[0].id, decision: 'accepted' },
        { itemId: items[1].id, decision: 'rejected' },
      ],
    });
    expect(ok.status).toBe(200);
    const receipt = await chief.get(`/api/v1/accessions/${id}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
    const col = await archivist
      .post(`/api/v1/accessions/${id}/create-collection`)
      .send({ localIdentifier: uniq('PH'), level: 'collection' });
    expect(col.status).toBe(201);
    expect(col.body.data.status).toBe('draft');
  });
});

describe('accession completeness rule', () => {
  it('lets the officer return an accession to draft to complete it, but not take back a complete one under review', async () => {
    const created = await archivist.post('/api/v1/accessions').send({
      title: 'Donated maps',
      sourceType: 'donor',
      donorName: 'A donor',
      accessionDate: '2026-11-05',
      legalBasis: 'Deed of gift',
      extent: '3 maps',
      physicalCondition: 'Good',
      provenance: 'Kept by the donor',
      rightsStatement: 'University of Ghana',
    });
    const id = created.body.data.id;
    await archivist
      .put(`/api/v1/accessions/${id}/items`)
      .send({ items: [{ description: 'Survey maps', quantity: 3 }] });
    const go = (who, action, extra = {}) => who.post(`/api/v1/accessions/${id}/transition`).send({ action, ...extra });
    const actions = async (who) => (await who.get(`/api/v1/accessions/${id}`)).body.data.availableActions;

    // Before the review starts, the officer can take it back.
    expect((await go(archivist, 'submit')).status).toBe(200);
    expect(await actions(archivist)).toContain('recall');
    expect((await go(archivist, 'recall', { reason: 'Forgot the map scales' })).status).toBe(200);
    expect((await archivist.get(`/api/v1/accessions/${id}`)).body.data.status).toBe('draft');

    // Under review and complete: only the approver can send it back.
    await go(archivist, 'submit');
    await go(chief, 'start_review');
    expect(await actions(archivist)).not.toContain('recall');
    expect((await go(archivist, 'recall')).status).toBe(400);

    // Under review with information missing (submitted before the rule): the officer can take it back to complete it.
    await models.Accession.update({ provenance: null }, { where: { id } });
    expect(await actions(archivist)).toContain('recall');
    expect(await actions(chief)).toContain('query');
    expect((await go(archivist, 'recall')).status).toBe(200);
    const after = (await archivist.get(`/api/v1/accessions/${id}`)).body.data;
    expect(after.status).toBe('draft');
    expect(after.history.map((h) => h.action)).toEqual(expect.arrayContaining(['recall']));
    expect(
      await models.Notification.count({ where: { eventType: 'accession.recalled', entityId: id } }),
    ).toBeGreaterThan(0);
  });

  it('can be switched off, in which case submitting records what is missing for the approver', async () => {
    const created = await archivist
      .post('/api/v1/accessions')
      .send({ title: 'Loose letters', sourceType: 'donor', donorName: 'A donor' });
    const id = created.body.data.id;
    await archivist.put(`/api/v1/accessions/${id}/items`).send({ items: [{ description: 'Letters', quantity: 3 }] });
    await models.SystemSetting.create({
      key: 'workflow.requireCompleteAccessions',
      category: 'workflow',
      value: false,
    });
    clearSettingsCache();
    try {
      expect((await archivist.post(`/api/v1/accessions/${id}/transition`).send({ action: 'submit' })).status).toBe(200);
      const a = (await chief.get(`/api/v1/accessions/${id}`)).body.data;
      expect(a.completenessRequired).toBe(false);
      expect(a.missingInformation).toEqual(expect.arrayContaining(['provenance', 'rightsStatement']));
    } finally {
      await models.SystemSetting.destroy({ where: { key: 'workflow.requireCompleteAccessions' } });
      clearSettingsCache();
    }
  });
});

describe('registering boxes from an accession', () => {
  it('carries box numbers from the transfer and registers each box once, all or nothing', async () => {
    const t = await draftTransfer();
    await liaison.put(`/api/v1/transfers/${t.id}/items`).send({
      items: [
        { title: 'Board minutes 1960-1965', boxNumber: 'Box 1' },
        { title: 'Board minutes 1966-1970', boxNumber: 'box 1' },
        { title: 'Correspondence files', boxNumber: '2' },
        { title: 'Loose photograph' },
      ],
    });
    await liaison.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'submit' });
    await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'start_review' });
    await records.post(`/api/v1/transfers/${t.id}/transition`).send({ action: 'accept' });
    const accId = (await records.post(`/api/v1/transfers/${t.id}/create-accession`).send({})).body.data.id;
    const acc = (await records.get(`/api/v1/accessions/${accId}`)).body.data;
    expect(acc.items.map((i) => i.boxNumber)).toEqual(['Box 1', 'box 1', '2', null]);

    // Not before approval.
    expect((await records.get(`/api/v1/accessions/${accId}/boxes`)).body.data.canRegister).toBe(false);
    await records.patch(`/api/v1/accessions/${accId}`).send({
      physicalCondition: 'Good',
      provenance: 'Department of History',
      rightsStatement: 'University of Ghana',
      extent: '2 boxes',
    });
    expect((await records.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'submit' })).status).toBe(200);
    await chief.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'start_review' });
    expect((await chief.post(`/api/v1/accessions/${accId}/transition`).send({ action: 'approve' })).status).toBe(200);

    const plan = (await records.get(`/api/v1/accessions/${accId}/boxes`)).body.data;
    expect(plan.canRegister).toBe(true);
    expect(plan.boxes.map((b) => [b.boxNumber, b.items.length, b.registered])).toEqual([
      ['Box 1', 2, false],
      ['2', 1, false],
    ]);
    expect(plan.unboxedCount).toBe(1);
    expect(plan.boxes[0].suggestedTitle).toMatch(/Box 1 \(UGA\/TRF\//);

    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const shelf = await archivist.post('/api/v1/locations').send({
      code: uniq('SH'),
      name: 'Shelf for boxes',
      typeId: types.find((x) => x.code === 'shelf').id,
      capacity: 2,
    });
    const tiny = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'Full shelf', typeId: types.find((x) => x.code === 'shelf').id, capacity: 0 });
    const barcode = uniq('BX');

    // A duplicate barcode in one request, and a full shelf, are refused and nothing is saved.
    const dup = await records.post(`/api/v1/accessions/${accId}/boxes`).send({
      boxes: [
        { boxNumber: 'Box 1', barcode, locationId: shelf.body.data.id },
        { boxNumber: '2', barcode, locationId: shelf.body.data.id },
      ],
    });
    expect(dup.status).toBe(400);
    const full = await records.post(`/api/v1/accessions/${accId}/boxes`).send({
      boxes: [
        { boxNumber: 'Box 1', barcode, locationId: shelf.body.data.id },
        { boxNumber: '2', generateBarcode: true, locationId: tiny.body.data.id },
      ],
    });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/^Box 2:/);
    expect(await models.PhysicalItem.count({ where: { barcode } })).toBe(0);

    const ok = await records.post(`/api/v1/accessions/${accId}/boxes`).send({
      boxes: [
        { boxNumber: 'Box 1', barcode, locationId: shelf.body.data.id },
        { boxNumber: '2', generateBarcode: true, locationId: shelf.body.data.id },
      ],
    });
    expect(ok.status).toBe(201);
    const [b1, b2] = ok.body.data.map((x) => x.physicalItem);
    expect(b1.barcode).toBe(barcode);
    expect(b2.barcode).toMatch(/^UGA-BX-\d{6}$/);
    expect(b1.accessionId).toBe(accId);

    const after = (await records.get(`/api/v1/accessions/${accId}/boxes`)).body.data;
    expect(after.registeredCount).toBe(2);
    expect(after.boxes[0].physicalItem.barcode).toBe(barcode);
    const linked = await models.AccessionItem.findAll({ where: { accessionId: accId, physicalItemId: b1.id } });
    expect(linked).toHaveLength(2);
    const item = (await records.get(`/api/v1/physical-items/${b1.id}`)).body.data;
    expect(item.currentLocation.id).toBe(shelf.body.data.id);
    expect(item.movements.map((m) => m.movementType)).toEqual(['initial_placement']);

    const again = await records
      .post(`/api/v1/accessions/${accId}/boxes`)
      .send({ boxes: [{ boxNumber: 'Box 1', generateBarcode: true, locationId: shelf.body.data.id }] });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/^Box 1: .*already registered/);

    // Item details, including the description link, can be changed after registration; the barcode cannot.
    const fonds = await createCompleteFonds(archivist);
    const edited = await records
      .patch(`/api/v1/physical-items/${b1.id}`)
      .send({ title: 'History dept. Box 1 of 2', recordId: fonds.id, handlingNotes: 'Heavy' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.recordId).toBe(fonds.id);
    const relabel = await records.patch(`/api/v1/physical-items/${b1.id}`).send({ barcode: 'CHANGED' });
    expect(relabel.body.data.barcode).toBe(barcode);
  });
});

describe('physical storage', () => {
  it('enforces capacity with an authorised, audited override and records every movement', async () => {
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const room = types.find((t) => t.code === 'room');
    const shelf = types.find((t) => t.code === 'shelf');
    const r = await archivist.post('/api/v1/locations').send({ code: uniq('RM'), name: 'Strongroom', typeId: room.id });
    const tmpShelf = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'S', typeId: shelf.id, parentId: r.body.data.id });
    expect(
      (
        await archivist
          .post('/api/v1/locations')
          .send({ code: uniq('BAD'), name: 'Room in shelf', typeId: room.id, parentId: tmpShelf.body.data.id })
      ).status,
    ).toBe(400);
    const s = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'Shelf A', typeId: shelf.id, parentId: r.body.data.id, capacity: 1 });
    const s2 = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('SH'), name: 'Shelf B', typeId: shelf.id, parentId: r.body.data.id });
    const b1 = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BX'), title: 'Box 1', locationId: s.body.data.id });
    expect(b1.status).toBe(201);
    const full = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('BX'), title: 'Box 2', locationId: s.body.data.id });
    expect(full.status).toBe(409);
    const noPerm = await archivist.post('/api/v1/physical-items').send({
      barcode: uniq('BX'),
      title: 'Box 2',
      locationId: s.body.data.id,
      override: true,
      overrideReason: 'Temporary',
    });
    expect(noPerm.status).toBe(403);
    const over = await chief.post('/api/v1/physical-items').send({
      barcode: uniq('BX'),
      title: 'Box 2',
      locationId: s.body.data.id,
      override: true,
      overrideReason: 'Temporary while shelving is installed',
    });
    expect(over.status).toBe(201);
    const mv = await archivist
      .post(`/api/v1/physical-items/${b1.body.data.id}/move`)
      .send({ toLocationId: s2.body.data.id, movementType: 'permanent', reason: 'Re-shelving' });
    expect(mv.status).toBe(200);
    const item = await archivist.get(`/api/v1/physical-items/${b1.body.data.id}`);
    expect(item.body.data.movements.map((m) => m.movementType)).toEqual(['permanent', 'initial_placement']);
    expect(item.body.data.homeLocation.id).toBe(s2.body.data.id);
    const labels = await archivist.post('/api/v1/locations/labels').send({ itemIds: [b1.body.data.id] });
    expect(labels.status).toBe(200);
  });

  it('reconciles an inventory audit', async () => {
    const types = (await archivist.get('/api/v1/locations/types')).body.data;
    const loc = await archivist
      .post('/api/v1/locations')
      .send({ code: uniq('AU'), name: 'Audit room', typeId: types.find((t) => t.code === 'room').id });
    const a = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('A'), title: 'Present', locationId: loc.body.data.id });
    const b = await archivist
      .post('/api/v1/physical-items')
      .send({ barcode: uniq('A'), title: 'Absent', locationId: loc.body.data.id });
    const audit = await archivist.post(`/api/v1/locations/${loc.body.data.id}/audits`).send({});
    await archivist.post(`/api/v1/locations/audits/${audit.body.data.id}/scan`).send({ barcode: a.body.data.barcode });
    await archivist.post(`/api/v1/locations/audits/${audit.body.data.id}/scan`).send({ barcode: 'NOT-A-REAL-CODE' });
    const done = await archivist
      .post(`/api/v1/locations/audits/${audit.body.data.id}/complete`)
      .send({ markMissing: true });
    expect(done.body.data.summary).toMatchObject({ expected: 2, found: 1, unexpected: 1, missing: 1 });
    expect((await archivist.get(`/api/v1/physical-items/${b.body.data.id}`)).body.data.status).toBe('missing');
  });
});
