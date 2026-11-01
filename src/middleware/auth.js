/**
 * Authentication, authorisation and CSRF middleware.
 *
 * Sessions use short-lived JWT access tokens in HTTP-only cookies (or a Bearer header for API clients). On every
 * request the token is verified, and the user, their roles and their permissions are reloaded from the database
 * together with the session record. Suspending a user, changing their roles or revoking a session therefore takes
 * effect immediately rather than when the token expires.
 *
 * Permission checks are enforced here on the server, not only by hiding menu items, and every denial is written to
 * the audit trail. Accounts that must change a temporary password can reach only the endpoints needed to do so.
 *
 * @author Kwasi Adabo Boakye
 */

import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { models } from '../database/models/index.js';
import { unauthorized, forbidden, AppError } from '../utils/errors.js';
import { getContext } from '../utils/context.js';
import { audit } from '../services/audit.service.js';

export const ACCESS_COOKIE = 'ugarms_at';
export const REFRESH_COOKIE = 'ugarms_rt';
export const CSRF_COOKIE = 'ugarms_csrf';

/**
 * Loads a user with their live status and effective permissions.
 *
 * Role assignments that have passed their expiry date are ignored, and the permissions of the remaining roles are
 * merged into one set. The function runs on every authenticated request so that deactivation, suspension and role
 * changes take effect immediately.
 *
 * @param {string} userId Identifier of the user to load.
 * @returns {Promise<object|null>} The principal (identity, status, role codes and a Set of permission codes), or
 *   null if the user does not exist.
 */
export async function loadPrincipal(userId) {
  const user = await models.User.findByPk(userId, {
    include: [
      {
        model: models.Role,
        as: 'roles',
        through: { attributes: ['expiresAt'] },
        include: [{ model: models.Permission, as: 'permissions', through: { attributes: [] } }],
      },
    ],
  });
  if (!user) return null;
  const now = new Date();
  const roles = user.roles.filter((r) => !r.UserRole?.expiresAt || new Date(r.UserRole.expiresAt) > now);
  const permissions = new Set(roles.flatMap((r) => r.permissions.map((p) => p.code)));
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    userType: user.userType,
    organisationUnitId: user.organisationUnitId,
    tokenVersion: user.tokenVersion,
    accountExpiresAt: user.accountExpiresAt,
    mustChangePassword: user.mustChangePassword,
    roles: roles.map((r) => r.code),
    permissions,
  };
}

/**
 * Extracts the access token from the request, preferring an `Authorization: Bearer` header and falling back to the
 * access-token cookie.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {{ token: string|null, viaCookie?: boolean }} The token, and whether it came from a cookie (which makes
 *   the request subject to CSRF checks).
 */
function readToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return { token: header.slice(7), viaCookie: false };
  if (req.cookies?.[ACCESS_COOKIE]) return { token: req.cookies[ACCESS_COOKIE], viaCookie: true };
  return { token: null };
}

/**
 * Verifies the request's access token and returns the authenticated principal.
 *
 * The token signature, issuer and audience are checked, then the account must be active, unexpired and on the same
 * token version as when the token was issued (the version changes when all sessions are revoked). The referenced
 * session must also still exist, be unrevoked and be unexpired.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {Promise<object|null>} The principal, or null if the request carries no token.
 * @throws {AppError} 401 when the token is invalid or the account or session is no longer valid.
 */
async function resolve(req) {
  const { token, viaCookie } = readToken(req);
  if (!token) return null;
  let claims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: 'ug-arms',
      audience: 'ug-arms-api',
    });
  } catch {
    throw unauthorized('Session expired or invalid');
  }
  const principal = await loadPrincipal(claims.sub);
  if (!principal || principal.status !== 'active') throw unauthorized('Account is not active');
  if (principal.tokenVersion !== claims.tv) throw unauthorized('Session has been revoked');
  if (principal.accountExpiresAt && new Date(principal.accountExpiresAt) < new Date())
    throw unauthorized('Account has expired');
  const session = await models.UserSession.findOne({
    where: { id: claims.sid, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    attributes: ['id'],
  });
  if (!session) throw unauthorized('Session has been revoked');
  principal.sessionId = claims.sid;
  principal.viaCookie = viaCookie;
  return principal;
}

// While a password change is required, only these endpoints are usable.
const PASSWORD_CHANGE_ALLOWED = [
  '/api/v1/auth/me',
  '/api/v1/auth/change-password',
  '/api/v1/auth/logout',
  '/api/v1/auth/sessions',
];

/**
 * Express middleware that requires a signed-in user.
 *
 * The resolved user is attached to `req.user` and to the request context so services can attribute their actions.
 * While a temporary password must be changed, only the profile, change-password, logout and session endpoints are
 * reachable; any other request is refused with PASSWORD_CHANGE_REQUIRED.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response (unused).
 * @param {import('express').NextFunction} next Continues to the next handler.
 * @throws {AppError} 401 when no valid session is present, 403 when a password change is required.
 */
export async function authenticate(req, res, next) {
  const user = await resolve(req);
  if (!user) throw unauthorized();
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some((p) => req.originalUrl.startsWith(p))) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing');
  }
  req.user = user;
  Object.assign(getContext(), { user });
  next();
}

/**
 * Express middleware for public routes that behave differently for signed-in users.
 *
 * If a valid session is present the user is attached exactly as in `authenticate`; a missing or invalid token is
 * treated as an anonymous visitor rather than an error, so public pages keep working when a cookie has expired.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response (unused).
 * @param {import('express').NextFunction} next Continues to the next handler.
 */
export async function optionalAuth(req, res, next) {
  try {
    const user = await resolve(req);
    if (user) {
      req.user = user;
      Object.assign(getContext(), { user });
    }
  } catch {
    /* treat invalid credentials on public routes as anonymous */
  }
  next();
}

/**
 * Creates middleware that allows the request only if the user holds every listed permission.
 *
 * A denial is recorded in the audit trail with the missing permissions and the route, then answered with 403
 * Forbidden.
 *
 * @param {...string} perms Permission codes that are all required, for example "records.publish".
 * @returns {import('express').RequestHandler} The middleware.
 */
export const requirePermission =
  (...perms) =>
  async (req, res, next) => {
    if (!req.user) throw unauthorized();
    const missing = perms.filter((p) => !req.user.permissions.has(p));
    if (missing.length) {
      await audit({
        action: 'authz.denied',
        outcome: 'denied',
        resourceType: 'route',
        resourceId: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`.slice(0, 64),
        metadata: { missing },
      });
      throw forbidden();
    }
    next();
  };

/**
 * Creates middleware that allows the request if the user holds at least one of the listed permissions.
 *
 * Used where several roles may reach the same endpoint, such as a list that liaisons and records officers both use.
 * A denial is audited and answered with 403 Forbidden.
 *
 * @param {...string} perms Permission codes, any one of which is sufficient.
 * @returns {import('express').RequestHandler} The middleware.
 */
export const requireAnyPermission =
  (...perms) =>
  async (req, res, next) => {
    if (!req.user) throw unauthorized();
    if (!perms.some((p) => req.user.permissions.has(p))) {
      await audit({
        action: 'authz.denied',
        outcome: 'denied',
        resourceType: 'route',
        resourceId: `${req.method} ${req.baseUrl}`.slice(0, 64),
        metadata: { anyOf: perms },
      });
      throw forbidden();
    }
    next();
  };

/**
 * Double-submit CSRF protection for state-changing requests authenticated by cookie.
 *
 * Safe methods (GET, HEAD, OPTIONS) and requests authenticated with an Authorization header are not affected. For
 * other requests that carry session cookies, the X-CSRF-Token header must match the CSRF cookie; a cross-site
 * attacker can make the browser send the cookies but cannot read them to set the header.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response (unused).
 * @param {import('express').NextFunction} next Continues to the next handler.
 * @throws {AppError} 403 when the token is missing or does not match.
 */
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const usesCookie =
    Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]) && !req.get('authorization');
  if (!usesCookie) return next();
  const header = req.get('x-csrf-token');
  if (!header || header !== req.cookies?.[CSRF_COOKIE]) throw forbidden('Missing or invalid CSRF token');
  next();
}
