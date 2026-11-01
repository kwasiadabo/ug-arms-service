/**
 * Error tracking. Unexpected errors are always logged, and can optionally be forwarded as a short JSON summary to
 * ERROR_WEBHOOK_URL (for example a relay to Sentry, Slack or Microsoft Teams).
 *
 * @author Kwasi Adabo Boakye
 */

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Records an unexpected error.
 *
 * The summary sent to the webhook contains only the application name, environment, time, error name, message
 * (shortened), the first lines of the stack trace, the request ID and the route. Request bodies, headers, cookies
 * and user data are never sent. A failure to deliver the webhook is logged but never thrown, so error reporting
 * cannot itself cause an error.
 *
 * @param {Error|*} err The error.
 * @param {{ source?: string, requestId?: string, route?: string }} [context={}] Where the error happened.
 * @returns {Promise<void>}
 */
export async function captureException(err, context = {}) {
  const summary = {
    app: env.APP_NAME,
    env: env.NODE_ENV,
    at: new Date().toISOString(),
    source: context.source || 'server',
    message: String(err?.message || err).slice(0, 500),
    name: err?.name,
    stack: String(err?.stack || '')
      .split('\n')
      .slice(0, 8)
      .join('\n'),
    requestId: context.requestId,
    route: context.route,
  };
  logger.error({ err, ...context }, 'Captured exception');
  if (!env.ERROR_WEBHOOK_URL) return;
  try {
    await fetch(env.ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Error webhook delivery failed');
  }
}
