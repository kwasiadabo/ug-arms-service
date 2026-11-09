/**
 * Integration tests for authentication and authorisation: sign-in and HTTP-only cookies, generic failure messages,
 * lockout, CSRF protection, refresh-token rotation and reuse detection, forced password change, server-side
 * permission checks and audit records.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect } from 'vitest';
import { anon, loginAs, USERS, PASSWORD, app } from './helpers.js';
import request from 'supertest';
import { models, sequelize } from '../src/database/models/index.js';

describe('authentication', () => {
  it('logs in, returns permissions and sets HTTP-only cookies', async () => {
    const res = await anon().post('/api/v1/auth/login').send({ email: USERS.archivist, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.permissions).toContain('records.create');
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/ugarms_at=.*HttpOnly/);
    expect(cookies).toMatch(/ugarms_rt=.*HttpOnly/);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('does not reveal through registration whether an email already has an account', async () => {
    const before = await models.User.count({ where: { email: USERS.researcher } });
    const res = await anon()
      .post('/api/v1/auth/register')
      .send({ email: USERS.researcher, password: 'Another-pass-123', fullName: 'Someone Else' });
    expect(res.status).toBe(201);
    expect(res.body.data.message).toMatch(/Check your email/);
    expect(await models.User.count({ where: { email: USERS.researcher } })).toBe(before);
  });

  it('rejects unsigned (alg "none") access tokens', async () => {
    const user = await models.User.findOne({ where: { email: USERS.archivist } });
    /**
     * Encodes an object as a Base64url JSON segment of a JWT.
     *
     * @param {object} o Header or payload.
     * @returns {string}
     */
    const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user.id, tv: user.tokenVersion, iss: 'ug-arms', aud: 'ug-arms-api' })}.`;
    const res = await anon().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects bad credentials with a generic message', async () => {
    const res = await anon().post('/api/v1/auth/login').send({ email: USERS.archivist, password: 'wrong-password1' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('treats an account without a password as a normal sign-in failure', async () => {
    const user = await models.User.create({
      email: `nopass${Date.now()}@ugarms.local`,
      fullName: 'No Password (test)',
      status: 'active',
      userType: 'staff',
    });
    const res = await anon().post('/api/v1/auth/login').send({ email: user.email, password: 'whatever-password1' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('locks the account after repeated failures', async () => {
    const email = USERS.auditor;
    for (let i = 0; i < 5; i += 1) await anon().post('/api/v1/auth/login').send({ email, password: 'nope-nope-1' });
    const res = await anon().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/locked/i);
    await models.User.update({ lockedUntil: null, failedLoginCount: 0 }, { where: { email } });
  });

  it('requires CSRF header for cookie-authenticated writes', async () => {
    const c = await loginAs('archivist');
    const res = await c.agent.post('/api/v1/records').send({ level: 'fonds', localIdentifier: 'X', title: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/CSRF/);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/login').send({ email: USERS.records, password: PASSWORD });

    /**
     * Extracts one cookie from a response's Set-Cookie headers.
     *
     * @param {string} name Cookie name.
     * @param {object} res Supertest response.
     * @returns {string} The cookie as "name=value".
     */
    const cookie = (name, res) => res.headers['set-cookie'].find((c) => c.startsWith(`${name}=`)).split(';')[0];
    const oldRt = cookie('ugarms_rt', login);
    const csrf = cookie('ugarms_csrf', login).split('=')[1];
    const r1 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [oldRt, `ugarms_csrf=${csrf}`])
      .set('X-CSRF-Token', csrf);
    expect(r1.status).toBe(200);
    const newRt = cookie('ugarms_rt', r1);
    // Replaying the old token is treated as theft: the whole family is revoked.
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [oldRt, `ugarms_csrf=${csrf}`])
      .set('X-CSRF-Token', csrf);
    expect(replay.status).toBe(401);
    const r2 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [newRt, `ugarms_csrf=${csrf}`])
      .set('X-CSRF-Token', csrf);
    expect(r2.status).toBe(401);
  });

  it('refuses to refresh a session left unused for longer than the idle timeout', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/login').send({ email: USERS.auditor, password: PASSWORD });
    const userId = login.body.data.user.id;
    const csrf = login.headers['set-cookie']
      .find((c) => c.startsWith('ugarms_csrf='))
      .split(';')[0]
      .split('=')[1];
    // Default timeout 25 minutes + 15-minute access token: 45 minutes without a refresh is past the limit.
    await sequelize.query(
      'UPDATE [UserSessions] SET [createdAt] = :at WHERE [userId] = :userId AND [revokedAt] IS NULL',
      {
        replacements: { at: new Date(Date.now() - 45 * 60_000), userId },
      },
    );
    const res = await agent.post('/api/v1/auth/refresh').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/inactivity/);
    expect(await models.UserSession.count({ where: { userId, revokedReason: 'idle_timeout' } })).toBeGreaterThan(0);
    expect(await models.AuditEvent.count({ where: { action: 'auth.idle_timeout', resourceId: userId } })).toBe(1);
  });

  it('records an automatic sign-out after inactivity', async () => {
    const client = await loginAs('readingRoom');
    expect((await client.post('/api/v1/auth/logout').send({ reason: 'idle' })).status).toBe(204);
    expect(await models.UserSession.count({ where: { userId: client.user.id, revokedReason: 'idle_timeout' } })).toBe(
      1,
    );
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('publishes the idle timeout for the browser', async () => {
    const res = await anon().get('/api/v1/settings/public');
    expect(res.body.data['security.idleTimeoutMinutes']).toBe(25);
  });

  it('immediately blocks a deactivated user', async () => {
    const admin = await loginAs('admin');
    const created = await admin
      .post('/api/v1/users')
      .send({ email: 'temp.staff@ugarms.local', fullName: 'Temp Staff', roleIds: [], sendInvitation: false });
    expect(created.status).toBe(201);
    const { hashPassword } = await import('../src/modules/auth/auth.service.js');
    await models.User.update(
      { status: 'active', passwordHash: await hashPassword(PASSWORD) },
      { where: { id: created.body.data.id } },
    );
    const temp = await loginAs('temp.staff@ugarms.local');
    expect((await temp.get('/api/v1/auth/me')).status).toBe(200);
    const deact = await admin
      .post(`/api/v1/users/${created.body.data.id}/deactivate`)
      .send({ reason: 'Left the University' });
    expect(deact.status).toBe(200);
    expect((await temp.get('/api/v1/auth/me')).status).toBe(401);
    // Historical row is retained for audit attribution.
    expect(await models.User.findByPk(created.body.data.id)).not.toBeNull();
  });
});

describe('forced password change', () => {
  it('blocks everything except changing the password', async () => {
    const admin = await loginAs('admin');
    const created = await admin
      .post('/api/v1/users')
      .send({ email: 'must.change@ugarms.local', fullName: 'Must Change', roleIds: [], sendInvitation: false });
    const { hashPassword } = await import('../src/modules/auth/auth.service.js');
    await models.User.update(
      { status: 'active', mustChangePassword: true, passwordHash: await hashPassword(PASSWORD) },
      { where: { id: created.body.data.id } },
    );
    const u = await loginAs('must.change@ugarms.local');
    expect((await u.get('/api/v1/notifications')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await u.get('/api/v1/auth/me')).status).toBe(200);
    expect(
      (await u.post('/api/v1/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NewSecret2026x' }))
        .status,
    ).toBe(200);
    expect((await u.get('/api/v1/notifications')).status).toBe(200);
  });
});

describe('authorisation', () => {
  it('denies routes without the permission and audits the denial', async () => {
    const liaison = await loginAs('liaison');
    const res = await liaison.post('/api/v1/records').send({ level: 'fonds', localIdentifier: 'NOPE', title: 'Nope' });
    expect(res.status).toBe(403);
    const denied = await models.AuditEvent.findOne({ where: { action: 'authz.denied', actorLabel: USERS.liaison } });
    expect(denied).not.toBeNull();
  });

  it('system administrator cannot read restricted content by default', async () => {
    const admin = await loginAs('admin');
    expect(admin.user.permissions).not.toContain('records.read_restricted');
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    const row = await models.AuditEvent.findOne();
    await expect(models.AuditEvent.update({ action: 'tampered' }, { where: { seq: row.seq } })).rejects.toThrow(
      /append-only/,
    );
    await expect(models.AuditEvent.destroy({ where: { seq: row.seq } })).rejects.toThrow(/append-only/);
  });

  it('has a verifiable hash chain', async () => {
    const chief = await loginAs('chief');
    const res = await chief.get('/api/v1/audit/verify-chain');
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
  });
});
