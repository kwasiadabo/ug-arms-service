/**
 * Shared helpers for paginated, sortable list endpoints.
 *
 * List routes validate their query string with `paginationSchema`, translate it into Sequelize options with
 * `pageParams` and `orderBy`, and respond with `paged`, so every list in the API accepts the same parameters and
 * returns the same `{ data, meta }` shape.
 *
 * @author Kwasi Adabo Boakye
 */

import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(300).optional(),
});

/**
 * Converts a page number and page size into the limit and offset used by Sequelize.
 *
 * @param {{ page: number, pageSize: number }} params Validated pagination parameters; pages start at 1.
 * @returns {{ limit: number, offset: number }}
 */
export function pageParams({ page, pageSize }) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * Builds a Sequelize `order` clause from user input, accepting only columns from an allow-list.
 *
 * Restricting sorting to known columns prevents clients from sorting by sensitive or unindexed fields and from
 * injecting arbitrary column names.
 *
 * @param {string} [sort] Column requested by the client.
 * @param {'asc'|'desc'} order Requested direction.
 * @param {string[]} allowed Columns the endpoint allows sorting by.
 * @param {string} [fallback='createdAt'] Column used when the requested one is not allowed.
 * @returns {Array<[string, 'ASC'|'DESC']>} The order clause.
 */
export function orderBy(sort, order, allowed, fallback = 'createdAt') {
  const col = allowed.includes(sort) ? sort : fallback;
  return [[col, order === 'asc' ? 'ASC' : 'DESC']];
}

/**
 * Sends a page of results in the standard list envelope `{ data, meta: { page, pageSize, total, totalPages } }`.
 *
 * @param {import('express').Response} res Express response.
 * @param {{ rows: object[], count: number }} result Result of a Sequelize `findAndCountAll`.
 * @param {{ page: number, pageSize: number }} params Pagination parameters used for the query.
 * @returns {import('express').Response}
 */
export function paged(res, { rows, count }, { page, pageSize }) {
  return res.json({ data: rows, meta: { page, pageSize, total: count, totalPages: Math.ceil(count / pageSize) } });
}
