/**
 * Integration tests for Journey A: the public portal finds open published descriptions, shows restricted ones with
 * identifying information only and hides everything else, including from facets and snippets.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loginAs, anon, publishedFonds, createCompleteFonds, uniq } from './helpers.js';
import { models } from '../src/database/models/index.js';
import { refreshEffectiveAccess } from '../src/services/accessPolicy.service.js';

let archivist, chief, word;
beforeAll(async () => {
  [archivist, chief] = await Promise.all([loginAs('archivist'), loginAs('chief')]);
  word = uniq('zebra').toLowerCase();
});

/**
 * Sets a description's access level to open and recalculates its effective access.
 *
 * @param {string} id Identifier of the description.
 * @returns {Promise<void>}
 */
async function makeOpen(id) {
  await models.ArchivalRecord.update({ accessLevel: 'open' }, { where: { id } });
  await refreshEffectiveAccess(id);
}

describe('public discovery respects access rules (Journey A)', () => {
  it('finds open published descriptions, masks restricted ones and hides the rest', async () => {
    const open = await publishedFonds(archivist, chief, {
      title: `Open ${word}`,
      scopeAndContent: `Secret-free scope about ${word}`,
    });
    await makeOpen(open.id);
    const restricted = await publishedFonds(archivist, chief, {
      title: `Restricted ${word}`,
      scopeAndContent: `Sensitive scope ${word} SHOULD-NOT-LEAK`,
      accessLevel: 'restricted',
    });
    const draft = await createCompleteFonds(archivist, { title: `Draft ${word}` });
    await makeOpen(draft.id);
    const conf = await publishedFonds(archivist, chief, { title: `Confidential-later ${word}` });
    await chief
      .put(`/api/v1/permissions/records/${conf.id}/level`)
      .send({ accessLevel: 'confidential', reason: 'Personal data' });

    const res = await anon().get(`/api/v1/public/search?q=${word}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.results.map((r) => r.id);
    expect(ids).toContain(open.id);
    expect(ids).toContain(restricted.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(conf.id);
    expect(JSON.stringify(res.body)).not.toMatch(/SHOULD-NOT-LEAK/);
    const r = res.body.data.results.find((x) => x.id === restricted.id);
    expect(r.mode).toBe('metadata_only');

    const facets = JSON.stringify(res.body.data.facets);
    expect(facets).not.toMatch(/Draft/);

    const detail = await anon().get(`/api/v1/public/records/${restricted.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.scopeAndContent).toBeUndefined();
    expect(detail.body.data.access.mode).toBe('metadata_only');
    expect((await anon().get(`/api/v1/public/records/${draft.id}`)).status).toBe(404);
    expect((await anon().get(`/api/v1/public/records/${conf.id}`)).status).toBe(404);
    const openDetail = await anon().get(`/api/v1/public/records/${open.id}`);
    expect(openDetail.body.data.archivistNote).toBeUndefined();
    expect(openDetail.body.data.citation.text).toContain(open.referenceCode);

    const suggest = await anon().get(`/api/v1/public/suggest?q=Draft ${word}`);
    expect(suggest.body.data.length).toBe(0);
  });

  it('children of an unpublished parent stay hidden even if published themselves', async () => {
    const parent = await createCompleteFonds(archivist);
    const child = await archivist.post('/api/v1/records').send({
      parentId: parent.id,
      level: 'item',
      localIdentifier: 'C',
      title: `Child ${word}`,
      dateExpression: '1950',
      accessLevel: 'open',
    });
    await models.ArchivalRecord.update({ status: 'published' }, { where: { id: child.body.data.id } });
    await refreshEffectiveAccess(parent.id);
    expect((await anon().get(`/api/v1/public/records/${child.body.data.id}`)).status).toBe(404);
  });

  it('supports phrase, exclusion and field queries', async () => {
    const a = await publishedFonds(archivist, chief, { title: `Vice Chancellor papers ${word}` });
    await makeOpen(a.id);
    const b = await publishedFonds(archivist, chief, { title: `Chancellor visit photographs ${word}` });
    await makeOpen(b.id);
    const phrase = await anon().get(`/api/v1/public/search?q=${encodeURIComponent(`"Vice Chancellor" ${word}`)}`);
    expect(phrase.body.data.results.map((r) => r.id)).toEqual([a.id]);
    const excl = await anon().get(`/api/v1/public/search?q=${encodeURIComponent(`Chancellor ${word} -Vice`)}`);
    expect(excl.body.data.results.map((r) => r.id)).toEqual([b.id]);
    const field = await anon().get(`/api/v1/public/search?q=${encodeURIComponent(`title:photographs ${word}`)}`);
    expect(field.body.data.results.map((r) => r.id)).toEqual([b.id]);
  });
});
