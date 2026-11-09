/**
 * HTTP routes for authentication and account self-service, mounted at /api/v1/auth.
 *
 * - POST /login, /refresh and /logout manage the session cookies.
 * - GET /me returns the signed-in user with their roles and permissions.
 * - POST /register, /verify-email and /activate create and activate accounts.
 * - POST /forgot-password and /reset-password handle forgotten passwords.
 * - POST /change-password changes the password of the signed-in user.
 * - GET /sessions and DELETE /sessions/:id list and sign out the user's own sessions.
 *
 * Sessions use three cookies: an HTTP-only access token, an HTTP-only refresh token restricted to the /api/v1/auth
 * path, and a readable CSRF token that the frontend echoes in the X-CSRF-Token header. Tokens are never exposed to
 * JavaScript or stored in browser storage. Sign-in is rate-limited by failed attempts only, so many staff behind
 * one campus network address can still sign in, and individual accounts are additionally protected by temporary
 * lockout. Registration and token endpoints are rate-limited per request.
 *
 * @author Kwasi Adabo Boakye
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE } from '../../middleware/auth.js';
import { email, password, idParams } from '../../validators/common.js';
import { randomToken } from '../../utils/crypto.js';
import { models } from '../../database/models/index.js';
import { audit } from '../../services/audit.service.js';
import { notFound } from '../../utils/errors.js';
import * as auth from './auth.service.js';

const router = Router();

const authLimit = env.NODE_ENV === 'test' ? 1000 : env.AUTH_RATE_LIMIT_MAX;
// Account-creation and token endpoints count every request per IP.
const strictLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: authLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});
// Sign-in counts failed attempts only, so many staff behind one campus NAT can still sign in;
// per-account lockout additionally protects individual accounts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: authLimit,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

/**
 * Returns the options shared by all session cookies: HTTP-only, SameSite=Lax, Secure when configured, and the
 * configured cookie domain.
 *
 * @returns {import('express').CookieOptions}
 */
const baseCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: '/',
});

/**
 * Sets the access-token, refresh-token and CSRF cookies after sign-in or refresh. The refresh cookie is sent only
 * to the auth endpoints, and a new random CSRF token is issued each time.
 *
 * @param {import('express').Response} res Response to set the cookies on.
 * @param {{ accessToken: string, refreshToken: string }} tokens The new tokens.
 */
function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie(), maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
  res.cookie(CSRF_COOKIE, randomToken(24), {
    ...baseCookie(),
    httpOnly: false,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
}

/**
 * Removes all session cookies, for example on sign-out or when a refresh fails.
 *
 * @param {import('express').Response} res Response to clear the cookies on.
 */
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { ...baseCookie(), httpOnly: false });
}

/**
 * Converts the authenticated principal into the user object returned to the frontend: identity, user type,
 * organisation unit, role codes, sorted permission codes and whether a password change is required.
 *
 * @param {object} p The principal from `loadPrincipal`.
 * @returns {object}
 */
export const presentPrincipal = (p) => ({
  id: p.id,
  email: p.email,
  fullName: p.fullName,
  userType: p.userType,
  organisationUnitId: p.organisationUnitId,
  roles: p.roles,
  permissions: [...p.permissions].sort(),
  mustChangePassword: p.mustChangePassword,
});

/**
 * Collects the client details recorded with sessions and login attempts.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {{ ip: string, userAgent: string|undefined }}
 */
const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in and receive HTTP-only session cookies
 *     requestBody: { required: true, content: { application/json: { schema: { type: object, required: [email, password], properties: { email: { type: string }, password: { type: string } } } } } }
 *     responses: { 200: { description: Signed in }, 401: { description: Invalid credentials or locked } }
 */
router.post(
  '/login',
  loginLimiter,
  validate({ body: z.object({ email, password: z.string().min(1).max(200) }) }),
  async (req, res) => {
    const result = await auth.login(req.body, meta(req));
    setAuthCookies(res, result);
    res.json({
      data: { user: presentPrincipal(result.principal), accessTokenExpiresInSeconds: env.ACCESS_TOKEN_TTL_MIN * 60 },
    });
  },
);

/**
 * @openapi
 * /auth/refresh:
 *   post: { tags: [Auth], summary: Rotate the refresh token and issue a new access token, responses: { 200: { description: Refreshed }, 401: { description: Session invalid } } }
 */
router.post('/refresh', async (req, res) => {
  try {
    const result = await auth.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
    setAuthCookies(res, result);
    res.json({ data: { ok: true } });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
});

/** @openapi
 * /auth/logout:
 *   post: { tags: [Auth], summary: 'Revoke the current session; body {"reason":"idle"} records an automatic sign-out after inactivity', responses: { 204: { description: Signed out } } }
 */
router.post('/logout', async (req, res) => {
  await auth.logout(null, req.cookies?.[REFRESH_COOKIE], req.body?.reason === 'idle');
  clearAuthCookies(res);
  res.status(204).end();
});

/** @openapi
 * /auth/me:
 *   get: { tags: [Auth], summary: Current user with roles and permissions, responses: { 200: { description: Current user } } }
 */
router.get('/me', authenticate, (req, res) => res.json({ data: presentPrincipal(req.user) }));

/** @openapi
 * /auth/register:
 *   post: { tags: [Auth], summary: Self-register a researcher account (email verification required), responses: { 201: { description: Registered } } }
 */
router.post(
  '/register',
  strictLimiter,
  validate({
    body: z.object({
      email,
      password,
      fullName: z.string().trim().min(2).max(200),
      affiliation: z.string().trim().max(255).optional(),
      phone: z.string().trim().max(40).optional(),
    }),
  }),
  async (req, res) => {
    await auth.register(req.body);
    res.status(201).json({ data: { message: 'Account created. Check your email to verify your address.' } });
  },
);

router.post(
  '/verify-email',
  strictLimiter,
  validate({ body: z.object({ token: z.string().min(10).max(200) }) }),
  async (req, res) => {
    await auth.verifyEmail(req.body.token);
    res.json({ data: { message: 'Email verified. You can now sign in.' } });
  },
);

router.post(
  '/activate',
  strictLimiter,
  validate({ body: z.object({ token: z.string().min(10).max(200), password }) }),
  async (req, res) => {
    await auth.activateAccount(req.body.token, req.body.password);
    res.json({ data: { message: 'Account activated. You can now sign in.' } });
  },
);

router.post('/forgot-password', strictLimiter, validate({ body: z.object({ email }) }), async (req, res) => {
  await auth.forgotPassword(req.body.email);
  res.json({ data: { message: 'If an active account exists for that address, a reset link has been sent.' } });
});

router.post(
  '/reset-password',
  strictLimiter,
  validate({ body: z.object({ token: z.string().min(10).max(200), password }) }),
  async (req, res) => {
    await auth.resetPassword(req.body.token, req.body.password);
    res.json({ data: { message: 'Password updated. Sign in with your new password.' } });
  },
);

router.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: password }) }),
  async (req, res) => {
    await auth.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword, req.user.sessionId);
    res.json({ data: { message: 'Password changed. Other sessions were signed out.' } });
  },
);

router.get('/sessions', authenticate, async (req, res) => {
  const sessions = await models.UserSession.findAll({
    where: { userId: req.user.id, revokedAt: null },
    order: [['lastUsedAt', 'DESC']],
    attributes: ['id', 'userAgent', 'ipAddress', 'createdAt', 'lastUsedAt', 'expiresAt'],
  });
  res.json({ data: sessions.map((s) => ({ ...s.get({ plain: true }), current: s.id === req.user.sessionId })) });
});

router.delete('/sessions/:id', authenticate, validate({ params: idParams }), async (req, res) => {
  const s = await models.UserSession.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!s) throw notFound('Session');
  await s.update({ revokedAt: new Date(), revokedReason: 'user_revoked' });
  await audit({ action: 'auth.session_revoked', resourceType: 'UserSession', resourceId: s.id });
  res.status(204).end();
});

export default router;
