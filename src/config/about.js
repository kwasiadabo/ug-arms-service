/**
 * Product details shown to users and reported by the API: the release version, taken from package.json so there is
 * one place to change it, and who developed the system.
 *
 * @author Kwasi Adabo Boakye
 */

import { createRequire } from 'node:module';

export const APP_VERSION = createRequire(import.meta.url)('../../package.json').version;
export const DEVELOPED_BY = 'Variable-x Solutions in collaboration with Globe Inform';
