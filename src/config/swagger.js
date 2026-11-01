/**
 * OpenAPI 3 specification for the UG-ARMS API.
 *
 * The base document describes authentication (HTTP-only session cookie with a CSRF header, or a Bearer token for
 * service clients), the response envelope and the shared schemas. Detailed operations are read from `@openapi`
 * JSDoc annotations in the route files, and every other mounted route is added automatically, so the published
 * reference always covers the whole implemented API.
 *
 * @author Kwasi Adabo Boakye
 */

import swaggerJsdoc from 'swagger-jsdoc';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, DEVELOPED_BY } from './about.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'UG-ARMS API',
      version: APP_VERSION,
      description:
        'University of Ghana Digital Archives and Records Management System. All endpoints are under /api/v1. ' +
        'Authentication uses HTTP-only cookies (ugarms_at) with a double-submit CSRF header (X-CSRF-Token) for state-changing requests, ' +
        'or a Bearer token for service clients. Responses use the envelope { data, meta } or { error: { code, message, details } }. ' +
        `Developed by ${DEVELOPED_BY}.`,
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ugarms_at' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
            },
            requestId: { type: 'string' },
          },
        },
        PageMeta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  },
  apis: [path.join(here, '../modules/**/*.routes.js')],
});

const TAGS = {
  '/auth': 'Auth',
  '/users': 'Users',
  '/roles': 'Roles',
  '/organisation-units': 'Organisation',
  '/settings': 'Settings',
  '/notifications': 'Notifications',
  '/audit': 'Audit',
  '/jobs': 'Jobs',
  '/repositories': 'Collections',
  '/records': 'Archival records',
  '/permissions': 'Access',
  '/authority-records': 'Authority records',
  '/vocabularies': 'Vocabularies',
  '/transfers': 'Accessioning',
  '/accessions': 'Accessioning',
  '/locations': 'Storage',
  '/physical-items': 'Storage',
  '/digital-assets': 'Digital assets',
  '/files': 'Digital assets',
  '/preservation': 'Preservation',
  '/ocr': 'OCR',
  '/search': 'Search',
  '/public': 'Public portal',
  '/digitisation': 'Digitisation',
  '/research-requests': 'Research services',
  '/reading-rooms': 'Reading room',
  '/appointments': 'Reading room',
  '/circulation': 'Reading room',
  '/me': 'Research services',
  '/retention': 'Retention',
  '/legal-holds': 'Retention',
  '/appraisal': 'Appraisal',
  '/disposal': 'Disposal',
  '/dashboard': 'Dashboard',
  '/reports': 'Reports',
  '/imports': 'Imports',
  '/health': 'Health',
  '/client-errors': 'Health',
  '/ai': 'AI assistance',
};

/**
 * Adds every route registered on the mounted Express routers to an OpenAPI document.
 *
 * Operations that are already described by an `@openapi` annotation are kept unchanged. Any other route is added
 * with its path parameters, a tag derived from its mount point and the standard success, authentication,
 * permission, not-found and validation responses. Express `:param` segments are converted to OpenAPI `{param}`
 * syntax.
 *
 * @param {object} spec Base OpenAPI document produced from the annotations.
 * @param {Array<[string, import('express').Router]>} mounts Mount prefix and router pairs, as registered in the API
 *   router.
 * @returns {object} A new OpenAPI document; the input is not modified.
 */
export function withDiscoveredRoutes(spec, mounts) {
  const out = { ...spec, paths: { ...spec.paths } };
  for (const [prefix, router] of mounts) {
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        in: 'path',
        name: m[1],
        required: true,
        schema: { type: 'string' },
      }));
      for (const method of Object.keys(layer.route.methods)) {
        out.paths[path] ??= {};
        if (out.paths[path][method]) continue;
        out.paths[path][method] = {
          tags: [TAGS[prefix] || 'Other'],
          summary: `${method.toUpperCase()} ${path}`,
          description:
            'Discovered from the implemented routes. Request validation is enforced by Zod; see the route source for the schema.',
          parameters: params,
          responses: {
            200: { description: 'Success' },
            401: { description: 'Not signed in' },
            403: { description: 'Missing permission' },
            404: { description: 'Not found or not visible' },
            422: {
              description: 'Validation error',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
          },
        };
      }
    }
  }
  return out;
}
