/**
 * Seeder: reference data needed before the system can be used.
 *
 * Creates the storage location types, the format registry (which drives server-side upload validation; risk levels
 * are initial suggestions for review), the controlled vocabularies, the digitisation quality profiles, the default
 * preservation policy and the default repository. All values are starting points to be reviewed against University
 * policy, not official policy. The seeder is idempotent.
 *
 * @author Kwasi Adabo Boakye
 */

import { models } from '../models/index.js';

const LOCATION_TYPES = [
  ['repository', 'Repository', 1],
  ['building', 'Building', 2],
  ['floor', 'Floor', 3],
  ['room', 'Room', 4],
  ['storage_area', 'Storage area', 5],
  ['aisle', 'Aisle', 6],
  ['bay', 'Bay', 7],
  ['shelf', 'Shelf', 8],
  ['box', 'Box', 9],
  ['folder', 'Folder', 10],
];

// Format registry drives server-side upload validation. Risk levels are initial suggestions for review.
const FORMATS = [
  ['application/pdf', ['pdf'], 'PDF document', 'document', 'medium', false, true, true],
  ['image/tiff', ['tif', 'tiff'], 'TIFF image', 'image', 'low', true, true, false],
  ['image/jpeg', ['jpg', 'jpeg'], 'JPEG image', 'image', 'medium', false, true, true],
  ['image/png', ['png'], 'PNG image', 'image', 'low', true, true, true],
  ['image/jp2', ['jp2'], 'JPEG 2000 image', 'image', 'medium', true, true, false],
  ['audio/mpeg', ['mp3'], 'MP3 audio', 'audio', 'medium', false, false, true],
  ['audio/wav', ['wav'], 'WAV audio', 'audio', 'low', true, false, true],
  ['audio/x-flac', ['flac'], 'FLAC audio', 'audio', 'low', true, false, true],
  ['video/mp4', ['mp4', 'm4v'], 'MPEG-4 video', 'video', 'medium', false, false, true],
  ['video/quicktime', ['mov'], 'QuickTime video', 'video', 'high', false, false, false],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ['docx'],
    'Word document',
    'document',
    'medium',
    false,
    false,
    false,
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ['xlsx'],
    'Excel workbook',
    'spreadsheet',
    'medium',
    false,
    false,
    false,
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ['pptx'],
    'PowerPoint presentation',
    'presentation',
    'medium',
    false,
    false,
    false,
  ],
  ['text/plain', ['txt'], 'Plain text', 'text', 'low', true, false, true],
  ['text/csv', ['csv'], 'CSV', 'text', 'low', true, false, true],
  ['application/xml', ['xml'], 'XML', 'text', 'low', true, false, false],
  ['application/json', ['json'], 'JSON', 'text', 'low', true, false, false],
  ['application/zip', ['zip'], 'ZIP package', 'archive', 'medium', false, false, false],
  ['message/rfc822', ['eml'], 'Email message (EML)', 'email', 'medium', false, false, false],
  ['application/mbox', ['mbox'], 'Mailbox (MBOX)', 'email', 'medium', false, false, false],
];

const VOCABULARIES = {
  collection_types: [
    'Institutional records',
    'Personal papers',
    'Photographs',
    'Audiovisual',
    'Theses and dissertations',
    'Maps and plans',
    'Oral histories',
    'Special collections',
    'Memorabilia',
  ],
  document_types: [
    'Minutes',
    'Correspondence',
    'Report',
    'Photograph',
    'Map',
    'Architectural drawing',
    'Poster',
    'Audio recording',
    'Video recording',
    'Manuscript',
    'Diary',
    'Thesis',
    'Publication',
    'Register',
    'Certificate',
  ],
  languages: ['English', 'Twi', 'Ga', 'Ewe', 'Dagbani', 'Hausa', 'French', 'Arabic'],
  subjects: [
    'University governance',
    'Student life',
    'Academic programmes',
    'Research',
    'Convocation and congregation',
    'Campus development',
    'Ghanaian history',
    'African studies',
    'Science and technology',
    'Health sciences',
    'Agriculture',
    'Arts and culture',
    'Politics and nationalism',
  ],
  record_classifications: [
    'Governance',
    'Administration',
    'Finance',
    'Personnel',
    'Students',
    'Estates',
    'Academic affairs',
    'Research',
    'Legal',
  ],
  conditions: ['Good', 'Fair', 'Poor', 'Critical'],
  functions: [
    'Teaching',
    'Research',
    'Governance',
    'Student administration',
    'Estate management',
    'Community engagement',
  ],
};

const QUALITY_PROFILES = [
  ['Textual documents', 'textual', 300, 'Greyscale or colour', 8, 'TIFF', 'PDF'],
  ['Photographs and prints', 'photograph', 600, 'Colour', 16, 'TIFF', 'JPEG'],
  ['Maps and drawings', 'map', 400, 'Colour', 8, 'TIFF', 'JPEG'],
  ['Bound volumes', 'volume', 400, 'Colour', 8, 'TIFF', 'PDF'],
];

/**
 * Creates any reference data that does not yet exist; existing entries, including ones an administrator has edited,
 * are left unchanged.
 *
 * @returns {Promise<void>}
 */
export async function up() {
  for (const [code, name, rank] of LOCATION_TYPES)
    await models.StorageLocationType.findOrCreate({ where: { code }, defaults: { code, name, rank } });
  for (const [
    mediaType,
    extensions,
    name,
    category,
    riskLevel,
    isPreservationFormat,
    ocrEligible,
    previewable,
  ] of FORMATS) {
    await models.FormatRegistry.findOrCreate({
      where: { mediaType },
      defaults: {
        mediaType,
        extensions,
        name,
        category,
        riskLevel,
        isPreservationFormat,
        ocrEligible,
        previewable,
        isAcceptedForIngest: true,
      },
    });
  }
  for (const [code, labels] of Object.entries(VOCABULARIES)) {
    const [vocab] = await models.ControlledVocabulary.findOrCreate({
      where: { code },
      defaults: { code, name: code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), isSystem: true },
    });
    for (const [i, label] of labels.entries()) {
      const termCode = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      await models.VocabularyTerm.findOrCreate({
        where: { vocabularyId: vocab.id, code: termCode },
        defaults: { vocabularyId: vocab.id, code: termCode, label, sortOrder: i },
      });
    }
  }
  for (const [
    name,
    materialType,
    minResolutionDpi,
    colourMode,
    bitDepth,
    masterFormat,
    accessFormat,
  ] of QUALITY_PROFILES) {
    await models.QualityProfile.findOrCreate({
      where: { name },
      defaults: { name, materialType, minResolutionDpi, colourMode, bitDepth, masterFormat, accessFormat },
    });
  }
  await models.PreservationPolicy.findOrCreate({
    where: { name: 'Default preservation policy' },
    defaults: {
      name: 'Default preservation policy',
      description: 'Initial default. To be reviewed against the University’s approved preservation policy.',
      fixityIntervalDays: 90,
      isDefault: true,
      appliesToCategories: [],
    },
  });
  await models.Repository.findOrCreate({
    where: { code: 'UGA' },
    defaults: {
      code: 'UGA',
      name: 'University of Ghana Archives',
      authorizedFormOfName: 'University of Ghana, Legon — Archives (name to be confirmed)',
      address: 'University of Ghana, Legon, Accra, Ghana',
      accessLevel: 'open',
      description: 'Default repository created by the seeder. Edit details to match the official service.',
    },
  });
}

/**
 * Reverses this seeder. Intentionally does nothing: seeded reference data and accounts may already be referenced by
 * real records and audit events, so they are never deleted automatically. Use `npm run db:reset` to rebuild a
 * development database from scratch.
 *
 * @returns {Promise<void>}
 */
export async function down() {}
