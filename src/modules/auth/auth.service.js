/**
 * Authentication and account lifecycle.
 *
 * Passwords are hashed with Argon2id. Sign-in failures are recorded, lock the account temporarily after repeated
 * attempts and take about the same time whether or not the account exists, so attackers cannot discover which email
 * addresses are registered. Sessions use short-lived access tokens and rotating refresh tokens: each refresh token
 * can be used once, and presenting an already-used token revokes the whole session family, which stops a stolen
 * token from being reused.
 *
 * One-time links for email verification, account activation and password reset are random, stored only as hashes,
 * expire and can be used once.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../../config/env.js';
import { models, sequelize } from '../../database/models/index.js';
import { sha256, randomToken } from '../../utils/crypto.js';
import { unauthorized, badRequest, forbidden } from '../../utils/errors.js';
import { audit } from '../../services/audit.service.js';
import { getSetting } from '../../services/settings.service.js';
import { notifyEmailOnly } from '../../services/notification.service.js';
import { loadPrincipal } from '../../middleware/auth.js';

/**
 * Hashes a password with Argon2id (19 MiB of memory, two iterations, one thread).
 *
 * @param {string} pw The plain-text password.
 * @returns {Promise<string>} The encoded hash, including its parameters and salt.
 */
export const hashPassword = (pw) =>
  argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

/**
 * Checks a password against a stored hash. Accounts without a password (for example not yet activated) never match.
 *
 * @param {string|null} hash Stored hash.
 * @param {string} pw Password entered by the user.
 * @returns {Promise<boolean>}
 */
export const verifyPassword = async (hash, pw) => (hash ? argon2.verify(hash, pw) : false);

// A dummy hash keeps response timing similar for unknown accounts.
const DUMMY_HASH = await hashPassword(randomToken(16));

/**
 * Signs a short-lived access token for a session.
 *
 * The token carries the user ID, the user's token version (so all tokens can be revoked at once) and the session
 * ID, and is valid only for this API.
 *
 * @param {{ id: string, tokenVersion: number }} user The user.
 * @param {string} sessionId Identifier of the session.
 * @returns {string} The signed JWT.
 */
export function issueAccessToken(user, sessionId) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion, sid: sessionId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    issuer: 'ug-arms',
    audience: 'ug-arms-api',
  });
}

/**
 * Creates a session with a new refresh token and access token.
 *
 * Only a hash of the refresh token is stored. Sessions created by refreshing share the family ID of the original
 * sign-in, so a whole sign-in can be revoked together.
 *
 * @param {object} user The user.
 * @param {{ ip?: string, userAgent?: string }} meta Client details.
 * @param {string} [familyId] Session family; a new one for a fresh sign-in.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<{ session: object, refreshToken: string, accessToken: string }>}
 */
async function createSession(user, meta, familyId = crypto.randomUUID(), transaction) {
  const refreshToken = randomToken(48);
  const session = await models.UserSession.create(
    {
      userId: user.id,
      familyId,
      refreshTokenHash: sha256(refreshToken),
      userAgent: meta.userAgent?.slice(0, 500),
      ipAddress: meta.ip,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
      lastUsedAt: new Date(),
    },
    { transaction },
  );
  return { session, refreshToken, accessToken: issueAccessToken(user, session.id) };
}

/**
 * Signs a user in with email and password.
 *
 * Every failure is recorded and audited and returns the same generic message, except for a locked account. After
 * the configured number of failed attempts the account is locked for the configured number of minutes. Suspended,
 * deactivated, pending and expired accounts cannot sign in. On success the failure counter is reset and a new
 * session is created.
 *
 * @param {{ email: string, password: string }} credentials Sign-in details.
 * @param {{ ip?: string, userAgent?: string }} meta Client details.
 * @returns {Promise<{ session: object, refreshToken: string, accessToken: string, principal: object }>}
 * @throws {AppError} 401 for any failure.
 */
export async function login({ email, password }, meta) {
  const normalised = email.trim().toLowerCase();
  const user = await models.User.scope('withSecrets').findOne({ where: { email: normalised } });
  const maxAttempts = await getSetting('security.lockoutMaxAttempts');
  const lockMinutes = await getSetting('security.lockoutMinutes');

  /**
   * Records a failed sign-in attempt, audits it and throws the error returned to the client.
   *
   * @param {string} reason Internal reason, for example "bad_password" or "locked"; recorded but not shown.
   * @param {string|null} [userId=null] The account concerned, if it exists.
   * @returns {Promise<never>}
   * @throws {AppError} Always.
   */
  const fail = async (reason, userId = null) => {
    await models.LoginAttempt.create({
      email: normalised,
      userId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent?.slice(0, 500),
      success: false,
      reason,
    });
    await audit({
      action: 'auth.login',
      outcome: 'failure',
      resourceType: 'User',
      resourceId: userId,
      actorLabel: normalised,
      reason,
    });
    throw unauthorized(
      reason === 'locked'
        ? 'Account temporarily locked after repeated failed sign-in attempts. Try again later.'
        : 'Invalid email or password',
    );
  };

  if (!user) {
    await verifyPassword(DUMMY_HASH, password).catch(() => false);
    return fail('unknown_account');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) return fail('locked', user.id);
  const ok = await verifyPassword(user.passwordHash, password).catch(() => false);
  if (!ok) {
    const count = user.failedLoginCount + 1;
    const lockedUntil = count >= maxAttempts ? new Date(Date.now() + lockMinutes * 60_000) : null;
    await user.update({ failedLoginCount: lockedUntil ? 0 : count, lockedUntil });
    if (lockedUntil)
      await audit({
        action: 'auth.account_locked',
        resourceType: 'User',
        resourceId: user.id,
        actorLabel: normalised,
        outcome: 'success',
      });
    return fail('bad_password', user.id);
  }
  if (user.status !== 'active') return fail(`status_${user.status}`, user.id);
  if (user.accountExpiresAt && user.accountExpiresAt < new Date()) return fail('expired', user.id);

  const result = await sequelize.transaction(async (t) => {
    await user.update({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }, { transaction: t });
    const s = await createSession(user, meta, undefined, t);
    await models.LoginAttempt.create(
      {
        email: normalised,
        userId: user.id,
        ipAddress: meta.ip,
        userAgent: meta.userAgent?.slice(0, 500),
        success: true,
      },
      { transaction: t },
    );
    await audit(
      {
        action: 'auth.login',
        resourceType: 'User',
        resourceId: user.id,
        actor: user,
        metadata: { sessionId: s.session.id },
      },
      { transaction: t },
    );
    return s;
  });
  return { ...result, principal: await loadPrincipal(user.id) };
}

/**
 * Exchanges a refresh token for a new pair of tokens (rotation).
 *
 * The old session is marked as replaced. If a token that has already been rotated is presented again, it is treated
 * as stolen: every session in its family is revoked and the event is audited. The new session keeps the original
 * absolute expiry, so a session cannot be extended forever by refreshing.
 *
 * @param {string} refreshToken Refresh token from the cookie.
 * @param {{ ip?: string, userAgent?: string }} meta Client details.
 * @returns {Promise<{ session: object, refreshToken: string, accessToken: string }>}
 * @throws {AppError} 401 when the token is missing, unknown, revoked or expired, or the account is not active.
 */
export async function refresh(refreshToken, meta) {
  if (!refreshToken) throw unauthorized();
  const existing = await models.UserSession.findOne({ where: { refreshTokenHash: sha256(refreshToken) } });
  if (!existing) throw unauthorized('Session not found');
  if (existing.revokedAt || existing.replacedById) {
    if (existing.replacedById) {
      await models.UserSession.update(
        { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' },
        { where: { familyId: existing.familyId, revokedAt: null } },
      );
      await audit({
        action: 'auth.refresh_token_reuse',
        outcome: 'denied',
        resourceType: 'User',
        resourceId: existing.userId,
        actorType: 'anonymous',
      });
    }
    throw unauthorized('Session has been revoked');
  }
  if (existing.expiresAt < new Date()) throw unauthorized('Session expired');
  // The browser signs out after the idle timeout. This catches a browser that was closed or asleep instead: a
  // session not refreshed for longer than the idle timeout plus one access-token lifetime has not been in use.
  const idleMinutes = Number(await getSetting('security.idleTimeoutMinutes'));
  if (
    idleMinutes > 0 &&
    existing.createdAt < new Date(Date.now() - (idleMinutes + env.ACCESS_TOKEN_TTL_MIN) * 60_000)
  ) {
    await models.UserSession.update(
      { revokedAt: new Date(), revokedReason: 'idle_timeout' },
      { where: { familyId: existing.familyId, revokedAt: null } },
    );
    await audit({
      action: 'auth.idle_timeout',
      resourceType: 'User',
      resourceId: existing.userId,
      actorType: 'anonymous',
    });
    throw unauthorized('You were signed out after a period of inactivity');
  }
  const user = await models.User.findByPk(existing.userId);
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');

  return sequelize.transaction(async (t) => {
    const next = await createSession(user, meta, existing.familyId, t);
    // Keep the absolute expiry of the original family to prevent indefinite sliding sessions.
    await next.session.update({ expiresAt: existing.expiresAt }, { transaction: t });
    await existing.update(
      { replacedById: next.session.id, revokedAt: new Date(), revokedReason: 'rotated' },
      { transaction: t },
    );
    return next;
  });
}

/**
 * Signs out by revoking the session family identified by the session ID or, failing that, the refresh token.
 * Unknown sessions are ignored.
 *
 * @param {string} [sessionId] Identifier of the current session.
 * @param {string} [refreshToken] Refresh token from the cookie.
 * @param {boolean} [idle=false] Whether the browser signed out automatically after the idle timeout.
 * @returns {Promise<void>}
 */
export async function logout(sessionId, refreshToken, idle = false) {
  const where = sessionId ? { id: sessionId } : refreshToken ? { refreshTokenHash: sha256(refreshToken) } : null;
  if (!where) return;
  const s = await models.UserSession.findOne({ where });
  if (s) {
    await models.UserSession.update(
      { revokedAt: new Date(), revokedReason: idle ? 'idle_timeout' : 'logout' },
      { where: { familyId: s.familyId, revokedAt: null } },
    );
    await audit({ action: idle ? 'auth.idle_timeout' : 'auth.logout', resourceType: 'User', resourceId: s.userId });
  }
}

/**
 * Revokes every session of a user and increases their token version, so access tokens already issued also stop
 * working immediately.
 *
 * @param {string} userId Identifier of the user.
 * @param {string} reason Reason recorded on the sessions, for example "password_reset".
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<void>}
 */
export async function revokeAllSessions(userId, reason, transaction) {
  await models.UserSession.update(
    { revokedAt: new Date(), revokedReason: reason },
    { where: { userId, revokedAt: null }, transaction },
  );
  await models.User.increment('tokenVersion', { where: { id: userId }, transaction });
}

/**
 * Creates a one-time token for an email link. Earlier unused tokens for the same purpose are cancelled, so only the
 * latest link works.
 *
 * @param {string} userId Identifier of the user.
 * @param {string} purpose "verify_email", "activate_account" or "reset_password".
 * @param {number} hours Validity in hours.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<string>} The token to put in the link; only its hash is stored.
 */
async function createActionToken(userId, purpose, hours, transaction) {
  const token = randomToken(32);
  await models.ActionToken.update({ usedAt: new Date() }, { where: { userId, purpose, usedAt: null }, transaction });
  await models.ActionToken.create(
    { userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3600_000) },
    { transaction },
  );
  return token;
}

/**
 * Validates a one-time token and marks it as used. The row is locked so the same link cannot be used twice at the
 * same moment.
 *
 * @param {string} token Token from the link.
 * @param {string} purpose Expected purpose.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<object>} The token row, which identifies the user.
 * @throws {AppError} 400 when the token is unknown, used, expired or for another purpose.
 */
async function consumeActionToken(token, purpose, transaction) {
  const row = await models.ActionToken.findOne({
    where: { tokenHash: sha256(token), purpose, usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (!row) throw badRequest('This link is invalid or has expired');
  await row.update({ usedAt: new Date() }, { transaction });
  return row;
}

/**
 * Registers a researcher account, if self-registration is enabled.
 *
 * The account starts as pending with the researcher role and becomes active when the email address is verified. A
 * verification email is sent.
 *
 * If the address already has an account, nothing is created: the account holder is emailed instead, and the caller
 * receives the same response as for a new registration. This prevents the form from being used to discover which
 * email addresses are registered.
 *
 * @param {{ email: string, fullName: string, password: string, affiliation?: string, phone?: string }} data
 *   Validated registration details.
 * @returns {Promise<object|null>} The new user, or null when the address was already registered.
 * @throws {AppError} 403 when registration is disabled.
 */
export async function register(data) {
  if (!(await getSetting('security.publicRegistration'))) throw forbidden('Self-registration is disabled');
  const email = data.email.trim().toLowerCase();
  if (await models.User.findOne({ where: { email } })) {
    // Same response and similar timing as a new registration, so the form cannot reveal which addresses have accounts.
    await hashPassword(data.password);
    await notifyEmailOnly(email, {
      subject: 'Your UG Archives account',
      body: 'Someone tried to create a UG Archives account with this email address, which already has an account. If it was you, sign in or use "Forgot password". Otherwise you can ignore this email.',
      actionUrl: `${env.PUBLIC_APP_URL}/login`,
      actionLabel: 'Sign in',
    });
    await audit({
      action: 'user.register_duplicate',
      outcome: 'denied',
      resourceType: 'User',
      actorType: 'anonymous',
      actorLabel: email,
    });
    return null;
  }
  const user = await sequelize.transaction(async (t) => {
    const u = await models.User.create(
      {
        email,
        fullName: data.fullName,
        passwordHash: await hashPassword(data.password),
        status: 'pending',
        userType: 'researcher',
        affiliation: data.affiliation,
        phone: data.phone,
      },
      { transaction: t },
    );
    const role = await models.Role.findOne({ where: { code: 'researcher' }, transaction: t });
    if (role) await models.UserRole.create({ userId: u.id, roleId: role.id }, { transaction: t });
    await audit(
      {
        action: 'user.register',
        resourceType: 'User',
        resourceId: u.id,
        actorLabel: email,
        actorType: 'anonymous',
        after: { email, fullName: data.fullName },
      },
      { transaction: t },
    );
    return u;
  });
  await sendVerification(user);
  return user;
}

/**
 * Emails a link, valid for 48 hours, that confirms the user's email address.
 *
 * @param {{ id: string, email: string, fullName: string }} user The user.
 * @returns {Promise<void>}
 */
export async function sendVerification(user) {
  const token = await createActionToken(user.id, 'verify_email', 48);
  await notifyEmailOnly(user.email, {
    subject: 'Verify your UG Archives account',
    body: `Hello ${user.fullName},\n\nPlease confirm your email address to activate your researcher account.`,
    actionUrl: `${env.PUBLIC_APP_URL}/verify-email?token=${token}`,
    actionLabel: 'Verify email',
  });
}

/**
 * Confirms a user's email address from a verification link and activates a pending account.
 *
 * @param {string} token Token from the link.
 * @returns {Promise<object>} The user.
 * @throws {AppError} 400 when the link is invalid or expired.
 */
export async function verifyEmail(token) {
  return sequelize.transaction(async (t) => {
    const row = await consumeActionToken(token, 'verify_email', t);
    const user = await models.User.findByPk(row.userId, { transaction: t });
    await user.update(
      { emailVerifiedAt: new Date(), status: user.status === 'pending' ? 'active' : user.status },
      { transaction: t },
    );
    await audit(
      { action: 'user.email_verified', resourceType: 'User', resourceId: user.id, actor: user },
      { transaction: t },
    );
    return user;
  });
}

/**
 * Emails a link, valid for 72 hours, with which a user created by an administrator sets their own password.
 * Administrators never choose or see users' passwords.
 *
 * @param {{ id: string, email: string, fullName: string }} user The user.
 * @returns {Promise<string>} The activation token.
 */
export async function sendActivation(user) {
  const token = await createActionToken(user.id, 'activate_account', 72);
  await notifyEmailOnly(user.email, {
    subject: 'Activate your UG Archives account',
    body: `Hello ${user.fullName},\n\nAn account has been created for you. Set your password to activate it. This link expires in 72 hours.`,
    actionUrl: `${env.PUBLIC_APP_URL}/activate?token=${token}`,
    actionLabel: 'Set password',
  });
  return token;
}

/**
 * Sets the password of an account created by an administrator and activates it. Suspended and deactivated accounts
 * cannot be activated.
 *
 * @param {string} token Token from the activation link.
 * @param {string} password The new password, already validated.
 * @returns {Promise<object>} The activated user.
 * @throws {AppError} 400 when the link is invalid, 403 when the account may not be activated.
 */
export async function activateAccount(token, password) {
  return sequelize.transaction(async (t) => {
    const row = await consumeActionToken(token, 'activate_account', t);
    const user = await models.User.findByPk(row.userId, { transaction: t });
    if (user.status === 'deactivated' || user.status === 'suspended')
      throw forbidden('Account is not available for activation');
    await user.update(
      {
        passwordHash: await hashPassword(password),
        status: 'active',
        emailVerifiedAt: new Date(),
        mustChangePassword: false,
      },
      { transaction: t },
    );
    await audit(
      { action: 'user.activated', resourceType: 'User', resourceId: user.id, actor: user },
      { transaction: t },
    );
    return user;
  });
}

/**
 * Starts a password reset by emailing a link valid for one hour.
 *
 * The response is the same whether or not an active account exists for the address, so the endpoint cannot be used
 * to discover registered email addresses.
 *
 * @param {string} email Email address entered by the user.
 * @returns {Promise<void>}
 */
export async function forgotPassword(email) {
  const user = await models.User.findOne({ where: { email: email.trim().toLowerCase(), status: 'active' } });
  // Always respond the same way to avoid account enumeration.
  if (!user) return;
  const token = await createActionToken(user.id, 'reset_password', 1);
  await notifyEmailOnly(user.email, {
    subject: 'Reset your UG Archives password',
    body: 'A password reset was requested for your account. The link expires in 1 hour. If you did not request this, you can ignore this email.',
    actionUrl: `${env.PUBLIC_APP_URL}/reset-password?token=${token}`,
    actionLabel: 'Reset password',
  });
  await audit({
    action: 'auth.password_reset_requested',
    resourceType: 'User',
    resourceId: user.id,
    actorType: 'anonymous',
  });
}

/**
 * Sets a new password from a reset link. The lockout is cleared, a required password change is removed and every
 * existing session is revoked.
 *
 * @param {string} token Token from the link.
 * @param {string} password The new password, already validated.
 * @returns {Promise<void>}
 * @throws {AppError} 400 when the link is invalid or expired.
 */
export async function resetPassword(token, password) {
  return sequelize.transaction(async (t) => {
    const row = await consumeActionToken(token, 'reset_password', t);
    const user = await models.User.findByPk(row.userId, { transaction: t });
    await user.update(
      { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null, mustChangePassword: false },
      { transaction: t },
    );
    await revokeAllSessions(user.id, 'password_reset', t);
    await audit(
      { action: 'auth.password_reset', resourceType: 'User', resourceId: user.id, actor: user },
      { transaction: t },
    );
  });
}

/**
 * Changes the password of a signed-in user after checking the current one.
 *
 * The temporary-password flag is cleared and every other session of the user is signed out; the current session
 * stays signed in.
 *
 * @param {string} userId Identifier of the user.
 * @param {string} currentPassword The current password.
 * @param {string} newPassword The new password, already validated.
 * @param {string} keepSessionId Session that stays signed in.
 * @returns {Promise<void>}
 * @throws {AppError} 400 when the current password is wrong.
 */
export async function changePassword(userId, currentPassword, newPassword, keepSessionId) {
  const user = await models.User.scope('withSecrets').findByPk(userId);
  if (!(await verifyPassword(user.passwordHash, currentPassword))) throw badRequest('Current password is incorrect');
  await sequelize.transaction(async (t) => {
    await user.update({ passwordHash: await hashPassword(newPassword), mustChangePassword: false }, { transaction: t });
    await models.UserSession.update(
      { revokedAt: new Date(), revokedReason: 'password_changed' },
      { where: { userId, revokedAt: null, id: { [Op.ne]: keepSessionId } }, transaction: t },
    );
    await audit({ action: 'auth.password_changed', resourceType: 'User', resourceId: userId }, { transaction: t });
  });
}
