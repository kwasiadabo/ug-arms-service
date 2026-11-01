/**
 * Institutional settings with built-in defaults.
 *
 * `DEFAULT_SETTINGS` lists every setting with its category, default value and description. The defaults are
 * reasonable starting points, NOT confirmed University of Ghana policy, and administrators must review them (see
 * docs/administrator-manual.md). Values changed by administrators are stored in the database and take effect within
 * 30 seconds through a small in-memory cache.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../database/models/index.js';

export const DEFAULT_SETTINGS = {
  'institution.name': {
    category: 'institution',
    value: 'University of Ghana, Legon — Archives',
    description: 'Display name of the archives service (to be confirmed by the University).',
  },
  'institution.shortName': {
    category: 'institution',
    value: 'UG Archives',
    description: 'Short name used in the header and emails.',
  },
  'institution.tagline': {
    category: 'institution',
    value: 'Records Management',
    description: 'Line shown beneath the short name.',
  },
  'institution.timezone': {
    category: 'institution',
    value: 'Africa/Accra',
    description: 'IANA time zone for displaying dates and times (Ghana uses GMT, UTC+0, without daylight saving).',
  },
  'institution.locale': {
    category: 'institution',
    value: 'en-GH',
    description: 'Locale for dates and numbers (en-GH: day-month-year).',
  },
  'institution.currency': {
    category: 'institution',
    value: 'GHS',
    description: 'Currency for any approved fees (Ghana cedi).',
  },
  'institution.repositoryCode': {
    category: 'institution',
    value: 'UGA',
    description: 'Prefix used in reference codes.',
  },
  'security.lockoutMaxAttempts': {
    category: 'security',
    value: 5,
    description: 'Failed logins before temporary lockout.',
  },
  'security.lockoutMinutes': { category: 'security', value: 15, description: 'Lockout duration in minutes.' },
  'security.publicRegistration': {
    category: 'security',
    value: true,
    description: 'Allow researchers to self-register.',
  },
  'workflow.separationOfDuties': {
    category: 'workflow',
    value: true,
    description: 'Prevent the creator or submitter of an item approving it.',
  },
  'workflow.twoPersonAccessChanges': {
    category: 'workflow',
    value: true,
    description: 'Require a second approver when a record becomes less restrictive.',
  },
  'workflow.disposalApprovals': {
    category: 'workflow',
    value: 2,
    description: 'Number of distinct approvals required before disposal.',
  },
  'workflow.taskEscalationHours': {
    category: 'workflow',
    value: 72,
    description: 'Hours before an open task is escalated.',
  },
  'embargo.autoLiftOnExpiry': {
    category: 'access',
    value: false,
    description: 'If false, expired embargoes are flagged for review rather than lifted automatically.',
  },
  'access.publicDiscoverableRestrictedLevels': {
    category: 'access',
    value: ['restricted', 'embargoed'],
    description:
      'Access levels whose existence (identifying metadata only, never content) is listed publicly once published.',
  },
  'research.allowAnonymousEnquiries': {
    category: 'research',
    value: true,
    description: 'Allow enquiries from visitors without accounts.',
  },
  'research.feesEnabled': {
    category: 'research',
    value: false,
    description: 'Enable fees. Requires an approved fee policy.',
  },
  'research.defaultLoanHours': {
    category: 'research',
    value: 4,
    description: 'Expected return window for supervised issues.',
  },
  'preservation.fixityIntervalDays': {
    category: 'preservation',
    value: 90,
    description: 'Default days between fixity checks.',
  },
  'preservation.objectLockYears': {
    category: 'preservation',
    value: 5,
    description:
      'Years of write-once (governance) retention on preservation files, renewed nightly while the file is kept. Lowering it never shortens retention already applied (1 to 100).',
  },
  'ocr.languages': { category: 'ocr', value: ['eng'], description: 'Tesseract language packs available for OCR.' },
  'ocr.lowConfidenceThreshold': {
    category: 'ocr',
    value: 75,
    description: 'Pages below this mean confidence are flagged for review.',
  },
  'privacy.researchRequestRetentionMonths': {
    category: 'privacy',
    value: 0,
    description:
      'Months after closure before researcher contact details and purpose are anonymised. 0 keeps them until a retention policy is approved.',
  },
  'privacy.registrationNotice': {
    category: 'privacy',
    value:
      'We collect only what is needed to manage your account, research requests and reading-room visits. Requests and the decisions on them are recorded.',
    description:
      'Privacy notice shown when researchers register. Replace with wording approved by the University (see docs/legal-and-governance.md).',
  },
  'privacy.operationalLogRetentionDays': {
    category: 'privacy',
    value: 365,
    description: 'Days to keep login attempts and search logs (audit events are never removed).',
  },
  'operations.rpoHours': {
    category: 'operations',
    value: 24,
    description: 'Recovery point objective agreed with the University (target, in hours).',
  },
  'operations.rtoHours': {
    category: 'operations',
    value: 72,
    description: 'Recovery time objective agreed with the University (target, in hours).',
  },
  'uploads.maxSizeMb': { category: 'uploads', value: 2048, description: 'Maximum single upload size.' },
  'ai.enabled': {
    category: 'ai',
    value: false,
    description:
      'Optional AI suggestions. Never applied automatically. Requires AI_ENABLED=true and an approved provider.',
  },
  'ai.allowedAccessLevels': {
    category: 'ai',
    value: ['open', 'staff_only'],
    description:
      'Effective access levels AI may process. Adding restricted levels requires an explicitly authorised, compliant configuration.',
  },
};

const cache = new Map();
const TTL = 30_000;

/**
 * Returns the current value of a setting: the stored value if an administrator has set one, otherwise the default.
 *
 * Values are cached for 30 seconds. If the settings table cannot be read (for example while migrations are
 * running), the default is returned.
 *
 * @param {string} key Setting key, for example "workflow.separationOfDuties".
 * @returns {Promise<*>} The value, or undefined for an unknown key.
 */
export async function getSetting(key) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL) return hit.value;
  let value = DEFAULT_SETTINGS[key]?.value;
  try {
    const row = await models.SystemSetting.findOne({ where: { key } });
    if (row) value = row.value;
  } catch {
    /* settings table unavailable (e.g. during migrations) – fall back to defaults */
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * Empties the settings cache so a changed setting takes effect immediately in this process. Called after an
 * administrator saves a setting.
 */
export function clearSettingsCache() {
  cache.clear();
}
