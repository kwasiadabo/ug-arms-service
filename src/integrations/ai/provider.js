/**
 * Adapter for an optional, institution-approved AI service.
 *
 * AI assistance is disabled by default (AI_PROVIDER "none"). When the "http" provider is configured, requests are
 * posted as JSON to AI_SERVICE_URL, which must answer with `{ suggestions: { field: value } }`. The contract is
 * deliberately small so that any approved model gateway can sit behind it. Deciding what content may be sent, and
 * checking the user's permissions and the record's access level, is the responsibility of the AI service module,
 * not of this adapter.
 *
 * @author Kwasi Adabo Boakye
 */

import { env } from '../../config/env.js';

/**
 * Sends a request to the configured AI service and returns its JSON response.
 *
 * The call is authenticated with AI_SERVICE_TOKEN when one is set and is abandoned after 60 seconds.
 *
 * @param {object} request The request body agreed with the AI service, for example the task and the permitted text.
 * @returns {Promise<{ suggestions?: Record<string, string> }>} The service response.
 * @throws {Error} With code AI_UNAVAILABLE when no provider is configured, or when the service answers with an
 *   error status.
 */
export async function complete(request) {
  if (env.AI_PROVIDER === 'none' || !env.AI_SERVICE_URL)
    throw Object.assign(new Error('No AI provider is configured'), { code: 'AI_UNAVAILABLE' });
  const res = await fetch(env.AI_SERVICE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.AI_SERVICE_TOKEN && { authorization: `Bearer ${env.AI_SERVICE_TOKEN}` }),
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`AI service returned ${res.status}`);
  return res.json();
}
