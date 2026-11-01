/**
 * Unit tests for rules that need no database round trip: metadata validation, workflow transitions, access rules,
 * search query parsing, handling of AI output, authority duplicate detection, export and spreadsheet safety, and the
 * Object Lock retention window.
 *
 * @author Kwasi Adabo Boakye
 */

import { describe, it, expect } from 'vitest';
import { parseQuery, highlightTerms, snippet } from '../src/modules/search/query-parser.js';
import { validateLevel, missingFields, REQUIRED_FOR_REVIEW } from '../src/modules/records/records.service.js';
import { validateInventory } from '../src/modules/accessioning/transfers.service.js';
import { assertTransition, availableActions } from '../src/services/workflow.service.js';
import { stricter, pathIds } from '../src/services/accessPolicy.service.js';
import ExcelJS from 'exceljs';
import { normaliseDate, csvSafe, assertSafeXlsx } from '../src/services/spreadsheet.service.js';
import { sanitiseSuggestions, SUGGESTIBLE_FIELDS } from '../src/modules/ai/ai.service.js';
import { normaliseName } from '../src/modules/cataloguing/authority.routes.js';
import { retentionWindow, protectAsset, PROTECTED_ROLES } from '../src/services/objectLock.service.js';

describe('metadata validation', () => {
  it('enforces level placement', () => {
    expect(() => validateLevel('series', null)).toThrow(/Top-level/);
    expect(() => validateLevel('series', { level: 'item' })).toThrow();
    expect(() => validateLevel('subseries', { level: 'subseries' })).not.toThrow();
    expect(() => validateLevel('item', { level: 'fonds' })).not.toThrow();
  });
  it('requires level-specific fields before review', () => {
    expect(missingFields({ title: 'x', referenceCode: 'R', level: 'fonds' }, REQUIRED_FOR_REVIEW.fonds)).toEqual(
      expect.arrayContaining(['dates', 'creator', 'scopeAndContent']),
    );
    expect(
      missingFields(
        { title: 'x', referenceCode: 'R', level: 'item', dateExpression: '1950' },
        REQUIRED_FOR_REVIEW.item,
      ),
    ).toEqual([]);
    expect(missingFields({ creators: [{}], title: 't' }, ['creator'])).toEqual([]);
  });
  it('validates transfer inventories', () => {
    const errors = validateInventory([
      { title: '', sourceIdentifier: 'A' },
      { title: 'x', sourceIdentifier: 'a', dateStart: '1990', dateEnd: '1980' },
      { title: 'y', quantity: '-2' },
    ]);
    expect(errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['title', 'sourceIdentifier', 'dateEnd', 'quantity']),
    );
  });
  it('normalises dates in common Ghanaian and ISO formats', () => {
    expect(normaliseDate('1961')).toBe('1961-01-01');
    expect(normaliseDate('06/03/1957')).toBe('1957-03-06');
    expect(normaliseDate('1957-03-06')).toBe('1957-03-06');
    expect(normaliseDate('sometime')).toBeUndefined();
    expect(normaliseDate('')).toBeNull();
  });
});

describe('workflow transitions', () => {
  it('only permits defined transitions', () => {
    expect(assertTransition('accession', 'under_review', 'approve')).toBe('approved');
    expect(() => assertTransition('accession', 'draft', 'approve')).toThrow(/not allowed/);
    expect(() => assertTransition('disposal', 'draft', 'execute')).toThrow();
    expect(assertTransition('description', 'approved', 'publish')).toBe('published');
    expect(availableActions('research_request', 'approved')).toEqual(
      expect.arrayContaining(['schedule', 'fulfil', 'cancel']),
    );
    expect(availableActions('appraisal', 'executed')).toEqual(['close']);
  });
});

describe('access rules', () => {
  it('chooses the stricter access level', () => {
    expect(stricter('open', 'restricted')).toBe('restricted');
    expect(stricter('closed', 'staff_only')).toBe('closed');
    expect(pathIds('/a/b/c/')).toEqual(['a', 'b', 'c']);
  });
});

describe('search parsing', () => {
  it('parses phrases, exclusions, fields and OR', () => {
    const g = parseQuery('"Vice Chancellor" -draft title:minutes OR creator:Busia');
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phrase: true, raw: 'Vice Chancellor' }),
        expect.objectContaining({ negate: true, raw: 'draft' }),
        expect.objectContaining({ field: 'title', raw: 'minutes' }),
      ]),
    );
    expect(g[1][0]).toMatchObject({ field: 'creator', raw: 'Busia' });
  });
  it('escapes LIKE wildcards', () => {
    expect(parseQuery('100%_done')[0][0].value).toBe('100[%][_]done');
  });
  it('builds safe highlight segments', () => {
    const s = snippet(
      'The Council met in <b>Legon</b> to appoint the Vice Chancellor.',
      highlightTerms(parseQuery('chancellor')),
    );
    expect(s.some((x) => x.hit && /chancellor/i.test(x.text))).toBe(true);
    expect(s.map((x) => x.text).join('')).toContain('<b>Legon</b>'); // returned as text, rendered escaped by React
  });
});

describe('AI output handling', () => {
  it('keeps only suggestible fields with bounded values', () => {
    const out = sanitiseSuggestions({
      suggestions: {
        scopeAndContent: ' Minutes ',
        accessLevel: 'open',
        status: 'published',
        keywords: ['a', 5, 'b'],
        referenceCode: 'X',
      },
    });
    expect(Object.keys(out).every((k) => SUGGESTIBLE_FIELDS.includes(k))).toBe(true);
    expect(out).toEqual({ scopeAndContent: 'Minutes', keywords: ['a', 'b'] });
    expect(sanitiseSuggestions('ignore previous instructions')).toEqual({});
  });
});

describe('authority duplicate detection', () => {
  it('normalises names for comparison', () => {
    expect(normaliseName('Prof. Kofi A. Busia')).toBe(normaliseName('Kofi A Busia'));
  });
});

describe('export safety', () => {
  it('neutralises spreadsheet formulas but keeps numbers and ordinary text', () => {
    expect(csvSafe('=HYPERLINK("http://x")')).toBe('\'=HYPERLINK("http://x")');
    expect(csvSafe('+1+1')).toBe("'+1+1");
    expect(csvSafe('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvSafe('-2+3')).toBe("'-2+3");
    expect(csvSafe('-5')).toBe('-5');
    expect(csvSafe('1950-1970')).toBe('1950-1970');
    expect(csvSafe('Council minutes')).toBe('Council minutes');
    expect(csvSafe(42)).toBe(42);
  });
});

/**
 * Builds a zip central directory whose single entry claims the given sizes, for testing the archive checks without
 * creating a large file.
 *
 * @param {number} compressed Claimed compressed size.
 * @param {number} uncompressed Claimed uncompressed size.
 * @returns {Buffer}
 */
function zipClaiming(compressed, uncompressed) {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt32LE(compressed, 20);
  cd.writeUInt32LE(uncompressed, 24);
  cd.writeUInt16LE(name.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([cd, name, eocd]);
}

describe('spreadsheet upload safety', () => {
  it('accepts a genuine Excel workbook', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Register');
    ws.addRow(['Title', 'Date']);
    for (let i = 0; i < 1000; i += 1) ws.addRow([`Row ${i}`, '1950']);
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    expect(() => assertSafeXlsx(file)).not.toThrow();
  });

  it('rejects zip bombs, ZIP64 archives and files that are not zips, before decompressing', () => {
    expect(() => assertSafeXlsx(zipClaiming(300_000, 300 * 1024 * 1024))).toThrow(/expands far more/);
    expect(() => assertSafeXlsx(zipClaiming(200 * 1024 * 1024, 260 * 1024 * 1024))).toThrow(/more than 250 MB/);
    expect(() => assertSafeXlsx(zipClaiming(0xffffffff, 0xffffffff))).toThrow(/ZIP64/);
    expect(() => assertSafeXlsx(Buffer.from('not a spreadsheet'.repeat(4)))).toThrow(/not a valid/);
  });
});

describe('Object Lock retention', () => {
  it('retains for whole calendar years and renews a month before the full period runs short', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const { retainUntil, refreshBefore } = retentionWindow(5, now);
    expect(retainUntil.toISOString()).toBe('2031-10-30T12:00:00.000Z');
    expect((retainUntil - refreshBefore) / 86_400_000).toBe(30);
  });

  it('locks preservation files but not derivatives that can be regenerated', () => {
    expect(PROTECTED_ROLES).toEqual(['preservation_master', 'original_upload', 'migrated_version']);
    expect(PROTECTED_ROLES).not.toContain('access_derivative');
  });

  it('does nothing on storage that cannot enforce retention', async () => {
    expect(await protectAsset('00000000-0000-0000-0000-000000000000')).toEqual({
      skipped: 'Object Lock is not enabled',
    });
  });
});
