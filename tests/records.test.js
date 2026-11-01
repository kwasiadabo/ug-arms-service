/**
 * Integration tests for archival descriptions: hierarchy rules and reference codes, the description workflow with
 * separation of duties, and inheritance of access down the hierarchy.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs, createCompleteFonds, uniq } from './helpers.js';

let archivist, chief, records;
beforeAll(async () => {
  [archivist, chief, records] = await Promise.all([loginAs('archivist'), loginAs('chief'), loginAs('records')]);
});

describe('hierarchy and reference codes', () => {
  it('derives child reference codes and builds breadcrumbs', async () => {
    const fonds = await createCompleteFonds(archivist);
    const series = await archivist
      .post('/api/v1/records')
      .send({ parentId: fonds.id, level: 'series', localIdentifier: 'S1', title: 'Council minutes' });
    expect(series.status).toBe(201);
    expect(series.body.data.referenceCode).toBe(`${fonds.referenceCode}/S1`);
    const file = await archivist
      .post('/api/v1/records')
      .send({ parentId: series.body.data.id, level: 'file', localIdentifier: '001', title: 'Minutes 1950' });
    const detail = await archivist.get(`/api/v1/records/${file.body.data.id}`);
    expect(detail.body.data.breadcrumbs.map((b) => b.id)).toEqual([fonds.id, series.body.data.id]);
  });

  it('rejects invalid level placement, duplicates and cycles', async () => {
    const fonds = await createCompleteFonds(archivist);
    const item = await archivist
      .post('/api/v1/records')
      .send({ parentId: fonds.id, level: 'item', localIdentifier: 'I1', title: 'Item' });
    expect(
      (
        await archivist
          .post('/api/v1/records')
          .send({ parentId: item.body.data.id, level: 'series', localIdentifier: 'S', title: 'Bad' })
      ).status,
    ).toBe(400);
    expect(
      (await archivist.post('/api/v1/records').send({ level: 'series', localIdentifier: 'S', title: 'Orphan series' }))
        .status,
    ).toBe(400);
    expect(
      (
        await archivist
          .post('/api/v1/records')
          .send({ level: 'fonds', referenceCode: fonds.referenceCode, title: 'Dup' })
      ).status,
    ).toBe(409);
    const series = await archivist
      .post('/api/v1/records')
      .send({ parentId: fonds.id, level: 'series', localIdentifier: 'S9', title: 'S' });
    const sub = await archivist
      .post('/api/v1/records')
      .send({ parentId: series.body.data.id, level: 'subseries', localIdentifier: 'SS', title: 'SS' });
    const cycle = await archivist
      .post(`/api/v1/records/${series.body.data.id}/move`)
      .send({ parentId: sub.body.data.id });
    expect(cycle.status).toBe(400);
  });

  it('moves a subtree and keeps paths consistent', async () => {
    const a = await createCompleteFonds(archivist);
    const b = await createCompleteFonds(archivist);
    const s = await archivist
      .post('/api/v1/records')
      .send({ parentId: a.id, level: 'series', localIdentifier: 'MV', title: 'Moving series' });
    const f = await archivist
      .post('/api/v1/records')
      .send({ parentId: s.body.data.id, level: 'file', localIdentifier: 'F', title: 'Child file' });
    expect(
      (
        await archivist
          .post(`/api/v1/records/${s.body.data.id}/move`)
          .send({ parentId: b.id, reason: 'Re-arrangement' })
      ).status,
    ).toBe(200);
    const child = await archivist.get(`/api/v1/records/${f.body.data.id}`);
    expect(child.body.data.rootId).toBe(b.id);
    expect(child.body.data.breadcrumbs[0].id).toBe(b.id);
  });
});

describe('description workflow', () => {
  it('enforces required fields, separation of duties and approvals before publication', async () => {
    const incomplete = await archivist
      .post('/api/v1/records')
      .send({ level: 'fonds', localIdentifier: uniq('INC'), title: 'Incomplete' });
    const blocked = await archivist
      .post(`/api/v1/records/${incomplete.body.data.id}/transition`)
      .send({ action: 'submit_for_review' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.map((d) => d.path)).toContain('scopeAndContent');

    const fonds = await createCompleteFonds(chief);
    expect((await chief.post(`/api/v1/records/${fonds.id}/transition`).send({ action: 'publish' })).status).toBe(409);
    expect(
      (await chief.post(`/api/v1/records/${fonds.id}/transition`).send({ action: 'submit_for_review' })).status,
    ).toBe(200);
    const self = await chief.post(`/api/v1/records/${fonds.id}/transition`).send({ action: 'approve' });
    expect(self.status).toBe(403);

    const f2 = await createCompleteFonds(archivist);
    await archivist.post(`/api/v1/records/${f2.id}/transition`).send({ action: 'submit_for_review' });
    expect((await archivist.post(`/api/v1/records/${f2.id}/transition`).send({ action: 'approve' })).status).toBe(403); // lacks records.approve
    expect((await chief.post(`/api/v1/records/${f2.id}/transition`).send({ action: 'approve' })).status).toBe(200);
    const pub = await chief.post(`/api/v1/records/${f2.id}/transition`).send({ action: 'publish' });
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('published');
    // Archivist cannot edit an approved/published description.
    const detail = await archivist.get(`/api/v1/records/${f2.id}`);
    expect(
      (await archivist.patch(`/api/v1/records/${f2.id}`).send({ title: 'Changed', version: detail.body.data.version }))
        .status,
    ).toBe(403);
    const withdrawNoReason = await chief.post(`/api/v1/records/${f2.id}/transition`).send({ action: 'withdraw' });
    expect(withdrawNoReason.status).toBe(422);
    const hist = await chief.get(`/api/v1/records/${f2.id}/history`);
    expect(hist.body.data.map((h) => h.action)).toEqual(['submit_for_review', 'approve', 'publish']);
  });

  it('uses optimistic concurrency and keeps versions that can be compared and restored', async () => {
    const fonds = await createCompleteFonds(archivist, { title: 'Original title' });
    const d = await archivist.get(`/api/v1/records/${fonds.id}`);
    const u1 = await archivist
      .patch(`/api/v1/records/${fonds.id}`)
      .send({ title: 'Second title', version: d.body.data.version });
    expect(u1.status).toBe(200);
    const stale = await archivist
      .patch(`/api/v1/records/${fonds.id}`)
      .send({ title: 'Stale', version: d.body.data.version });
    expect(stale.status).toBe(409);
    const versions = await archivist.get(`/api/v1/records/${fonds.id}/versions`);
    expect(versions.body.data.length).toBe(2);
    const cmp = await archivist.get(`/api/v1/records/${fonds.id}/versions/compare?from=1&to=2`);
    expect(cmp.body.data.changes).toContainEqual({ field: 'title', from: 'Original title', to: 'Second title' });
    const restored = await chief
      .post(`/api/v1/records/${fonds.id}/versions/1/restore`)
      .send({ reason: 'Revert accidental change' });
    expect(restored.status).toBe(200);
    expect(restored.body.data.title).toBe('Original title');
  });
});

describe('access inheritance', () => {
  it('a child can never be more open than a restricted parent', async () => {
    const fonds = await createCompleteFonds(chief, { accessLevel: 'restricted' });
    const child = await chief.post('/api/v1/records').send({
      parentId: fonds.id,
      level: 'series',
      localIdentifier: 'OPEN',
      title: 'Tries to be open',
      accessLevel: 'open',
    });
    const detail = await chief.get(`/api/v1/records/${child.body.data.id}`);
    expect(detail.body.data.effectiveAccessLevel).toBe('restricted');
  });

  it('loosening access requires a different approver', async () => {
    const fonds = await createCompleteFonds(chief, { accessLevel: 'restricted' });
    const req1 = await chief
      .put(`/api/v1/permissions/records/${fonds.id}/level`)
      .send({ accessLevel: 'open', reason: 'Review complete' });
    expect(req1.status).toBe(200);
    expect(req1.body.data.pendingApproval).toBe(true);
    const own = await chief
      .post(`/api/v1/permissions/requests/${req1.body.data.request.id}/decision`)
      .send({ decision: 'approve', reason: 'self' });
    expect(own.status).toBe(403);
    // Tightening is immediate.
    const fonds2 = await createCompleteFonds(archivist);
    const tighten = await chief
      .put(`/api/v1/permissions/records/${fonds2.id}/level`)
      .send({ accessLevel: 'confidential', reason: 'Personal data identified' });
    expect(tighten.body.data.pendingApproval).toBe(false);
    // Archivist without read_confidential sees only metadata now.
    const masked = await archivist.get(`/api/v1/records/${fonds2.id}`);
    expect(masked.body.data.access.mode).toBe('metadata_only');
    expect(masked.body.data.scopeAndContent).toBeUndefined();
  });

  it('restrictions on a parent cascade to descendants and appear in effective level', async () => {
    const fonds = await createCompleteFonds(chief);
    const s = await chief
      .post('/api/v1/records')
      .send({ parentId: fonds.id, level: 'series', localIdentifier: 'R', title: 'S', accessLevel: 'open' });
    const r = await chief
      .post(`/api/v1/permissions/records/${fonds.id}/restrictions`)
      .send({ restrictionType: 'embargoed', expiresAt: '2099-01-01', legalBasis: 'Donor agreement' });
    expect(r.status).toBe(201);
    const child = await chief.get(`/api/v1/records/${s.body.data.id}`);
    expect(child.body.data.effectiveAccessLevel).toBe('embargoed');
  });

  it('records officers without restricted clearance cannot see restricted content', async () => {
    const fonds = await createCompleteFonds(chief, { accessLevel: 'restricted' });
    const res = await records.get(`/api/v1/records/${fonds.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access.mode).toBe('metadata_only');
  });
});
