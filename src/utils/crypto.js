/**
 * Small cryptographic helpers shared across the backend: SHA-256 hashing, random token generation and constant-time
 * string comparison.
 *
 * @author Kwasi Adabo Boakye
 */

import crypto from 'node:crypto';

/**
 * Calculates the SHA-256 digest of a string or buffer.
 *
 * Used for file fixity values, for storing only hashes of one-time tokens, and for the audit trail hash chain.
 *
 * @param {string|Buffer} input Data to hash.
 * @returns {string} The digest as a lowercase hexadecimal string of 64 characters.
 */
export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

/**
 * Generates a cryptographically secure random token suitable for password-reset links, email verification, refresh
 * tokens and CSRF tokens.
 *
 * @param {number} [bytes=32] Number of random bytes; 32 bytes gives 256 bits of entropy.
 * @returns {string} The token encoded as URL-safe Base64 without padding.
 */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Compares two values in constant time to avoid leaking information through response timing.
 *
 * Both values are converted to strings first. Values of different length are reported as unequal without calling
 * the timing-safe comparison, which requires equal lengths.
 *
 * @param {*} a First value.
 * @param {*} b Second value.
 * @returns {boolean} True only when both values are identical.
 */
export const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
