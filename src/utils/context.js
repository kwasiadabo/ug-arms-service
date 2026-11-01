/**
 * Per-request context storage built on Node's AsyncLocalStorage.
 *
 * The request-context middleware stores the correlation ID, client IP address and user agent, and the
 * authentication middleware adds the signed-in user. Services deep in the call stack, such as the audit and
 * workflow services, read this context to attribute their records without every function having to pass the request
 * object along.
 *
 * @author Kwasi Adabo Boakye
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

/**
 * Returns the context object of the request currently being processed.
 *
 * Outside a request (for example in a background job or a script) an empty object is returned, so callers can read
 * optional fields without checking for undefined.
 *
 * @returns {{ correlationId?: string, ip?: string, userAgent?: string, user?: object }} The mutable context for the
 *   current request.
 */
export const getContext = () => requestContext.getStore() || {};
