/**
 * Shared helpers for the backend integration tests: an in-memory application instance, the seeded demonstration
 * accounts, logged-in test clients and fixtures for common records.
 *
 * @author Kwasi Adabo Boakye
 */

import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerHandlers } from '../src/jobs/handlers.js';

registerHandlers();
export const app = createApp();
export const PASSWORD = 'ChangeMe!2026';

export const USERS = {
  admin: 'admin@ugarms.local',
  chief: 'chief.archivist@ugarms.local',
  archivist: 'archivist@ugarms.local',
  records: 'records.officer@ugarms.local',
  digitisation: 'digitisation@ugarms.local',
  readingRoom: 'readingroom@ugarms.local',
  liaison: 'liaison.history@ugarms.local',
  auditor: 'auditor@ugarms.local',
  researcher: 'researcher@ugarms.local',
};

/**
 * Signs in as a seeded account and returns a test client whose write requests send the CSRF header automatically,
 * as the real frontend does.
 *
 * @param {string} who Key of `USERS` (for example "chief") or an email address.
 * @returns {Promise<{ agent: object, user: object, csrf: string, get: Function, post: Function, patch: Function,
 *   put: Function, delete: Function }>}
 * @throws {Error} When sign-in fails.
 */
export async function loginAs(who) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email: USERS[who] || who, password: PASSWORD });
  if (res.status !== 200) throw new Error(`Login failed for ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.headers['set-cookie']
    .find((c) => c.startsWith('ugarms_csrf='))
    .split(';')[0]
    .split('=')[1];

  /**
   * Creates a request function for an HTTP method that adds the CSRF header.
   *
   * @param {string} method Supertest method name, for example "post".
   * @returns {(url: string) => object}
   */
  const wrap = (method) => (url) => agent[method](url).set('X-CSRF-Token', csrf);
  return {
    agent,
    user: res.body.data.user,
    csrf,
    get: (url) => agent.get(url),
    post: wrap('post'),
    patch: wrap('patch'),
    put: wrap('put'),
    delete: wrap('delete'),
  };
}

/**
 * Returns a test client with no session, for testing public and anonymous access.
 *
 * @returns {object}
 */
export const anon = () => request(app);

let counter = 0;

/**
 * Generates a unique value for codes and identifiers, so tests do not collide with each other or with earlier runs.
 *
 * @param {string} [p='T'] Prefix.
 * @returns {string}
 */
export const uniq = (p = 'T') => `${p}${Date.now().toString(36)}${(counter += 1)}`;

/**
 * Creates a fonds with every field required for review and publication.
 *
 * @param {object} client Logged-in test client allowed to create descriptions.
 * @param {object} [overrides={}] Field values to change.
 * @returns {Promise<object>} The created description.
 * @throws {Error} When creation fails.
 */
export async function createCompleteFonds(client, overrides = {}) {
  const res = await client.post('/api/v1/records').send({
    level: 'fonds',
    localIdentifier: uniq('F'),
    title: 'Test fonds',
    dateExpression: '1948-1960',
    dateStart: '1948-01-01',
    dateEnd: '1960-12-31',
    extentAndMedium: '12 boxes',
    creatorNote: 'University College of the Gold Coast',
    scopeAndContent: 'Minutes and correspondence.',
    adminBiographicalHistory: 'Founded 1948.',
    accessConditions: 'Open for research.',
    reproductionConditions: 'Copies on request.',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`createCompleteFonds failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/**
 * Polls a condition until it returns a truthy value, for waiting on background work such as ingest.
 *
 * @param {() => Promise<*>} fn The condition.
 * @param {{ timeout?: number, interval?: number }} [options] Maximum wait and polling interval in milliseconds.
 * @returns {Promise<*>} The first truthy value.
 * @throws {Error} When the timeout is reached.
 */
export async function waitFor(fn, { timeout = 30000, interval = 200 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Creates a complete fonds and takes it through review, approval and publication, with the archivist submitting and
 * the chief archivist deciding.
 *
 * @param {object} archivist Logged-in archivist client.
 * @param {object} chief Logged-in chief archivist client.
 * @param {object} [overrides={}] Field values to change.
 * @returns {Promise<object>} The created description.
 */
export async function publishedFonds(archivist, chief, overrides = {}) {
  const f = await createCompleteFonds(archivist, overrides);
  await archivist.post(`/api/v1/records/${f.id}/transition`).send({ action: 'submit_for_review' });
  await chief.post(`/api/v1/records/${f.id}/transition`).send({ action: 'approve' });
  const p = await chief.post(`/api/v1/records/${f.id}/transition`).send({ action: 'publish' });
  if (p.status !== 200) throw new Error(`publish failed ${JSON.stringify(p.body)}`);
  return f;
}
