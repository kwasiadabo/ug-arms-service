/**
 * Application error type and factory functions for the standard HTTP error responses.
 *
 * Services throw these errors instead of writing responses themselves. The central error handler converts an
 * AppError into the JSON envelope `{ error: { code, message, details }, requestId }` with the matching HTTP status,
 * so error responses are consistent across the whole API.
 *
 * @author Kwasi Adabo Boakye
 */

/**
 * An error that carries an HTTP status, a stable machine-readable code and optional details for the client.
 *
 * @param {number} status HTTP status code to send, for example 404.
 * @param {string} code Stable error code the frontend can rely on, for example "NOT_FOUND".
 * @param {string} message Human-readable explanation shown to the user.
 * @param {*} [details] Optional structured information, such as field-level validation errors.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Creates a 400 Bad Request error for a request that is well-formed but not acceptable, for example an action that
 * is not allowed for the current data.
 *
 * @param {string} message Explanation shown to the user.
 * @param {*} [details] Optional structured details.
 * @returns {AppError}
 */
export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);

/**
 * Creates a 422 Unprocessable Entity error for input that fails business validation, with one entry per invalid
 * field.
 *
 * @param {Array<{path?: string, field?: string, message: string}>} details The individual validation problems.
 * @param {string} [message='Validation failed'] Summary message.
 * @returns {AppError}
 */
export const validationError = (details, message = 'Validation failed') =>
  new AppError(422, 'VALIDATION_ERROR', message, details);

/**
 * Creates a 401 Unauthorized error for a missing, expired or revoked session.
 *
 * @param {string} [message='Authentication required'] Explanation shown to the user.
 * @returns {AppError}
 */
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message);

/**
 * Creates a 403 Forbidden error for a signed-in user who lacks the permission or the clearance required for the
 * action.
 *
 * @param {string} [message] Explanation shown to the user.
 * @returns {AppError}
 */
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

/**
 * Creates a 404 Not Found error. The same error is also used when a record exists but the caller may not know it
 * exists, so restricted records cannot be discovered by probing identifiers.
 *
 * @param {string} [what='Resource'] Name of the thing that was not found, used in the message.
 * @returns {AppError}
 */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

/**
 * Creates a 409 Conflict error for a request that clashes with the current state, such as a duplicate value or an
 * item that is locked by a legal hold.
 *
 * @param {string} message Explanation shown to the user.
 * @param {*} [details] Optional structured details.
 * @returns {AppError}
 */
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);

/**
 * Creates a 409 error for a workflow action that is not allowed from the record's current state, for example
 * approving a record that is still a draft.
 *
 * @param {string} from The current workflow state.
 * @param {string} action The action that was attempted.
 * @returns {AppError}
 */
export const invalidTransition = (from, action) =>
  new AppError(409, 'INVALID_TRANSITION', `Action "${action}" is not allowed from state "${from}"`);

/**
 * Creates a 503 Service Unavailable error for a dependency that is not configured or not reachable, such as the
 * malware scanner or the AI service.
 *
 * @param {string} message Explanation shown to the user.
 * @returns {AppError}
 */
export const unavailable = (message) => new AppError(503, 'SERVICE_UNAVAILABLE', message);
