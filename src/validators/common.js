/**
 * Reusable Zod schemas for values that appear across many endpoints: identifiers, email addresses, passwords, free
 * text, ISO dates, reasons and boolean query flags.
 *
 * Defining them once keeps validation rules identical everywhere; for example, the password rule used at
 * registration is the same as the one used when a password is changed or reset.
 *
 * @author Kwasi Adabo Boakye
 */

import { z } from 'zod';

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });
export const email = z.string().trim().toLowerCase().email().max(320);
export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

/**
 * Creates a schema for an optional free-text field.
 *
 * The value is trimmed and limited in length; an empty string is stored as null so that clearing a field in a form
 * removes the value instead of saving blank text.
 *
 * @param {number} [max=4000] Maximum number of characters.
 * @returns {import('zod').ZodType<string|null|undefined>}
 */
export const optionalText = (max = 4000) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));

/**
 * Creates a schema for a required single-line text field that must contain at least one non-space character.
 *
 * @param {number} [max=255] Maximum number of characters.
 * @returns {import('zod').ZodString}
 */
export const requiredText = (max = 255) => z.string().trim().min(1, 'Required').max(max);
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .optional()
  .nullable()
  .or(z.literal('').transform(() => null));
export const reason = z.object({ reason: z.string().trim().max(4000).optional() });
export const requiredReason = z.object({ reason: z.string().trim().min(3, 'A reason is required').max(4000) });
export const boolish = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
