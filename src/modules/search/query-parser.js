/**
 * Parsing of search queries and safe highlighting of matches.
 *
 * Supported syntax: "exact phrase", -excluded, field:value (title:, ref:, creator:, subject:, place:, date:) and
 * alternatives separated by OR.
 *
 * @author Kwasi Adabo Boakye
 */

const FIELD_ALIASES = {
  title: 'title',
  ref: 'referenceCode',
  reference: 'referenceCode',
  creator: 'creator',
  subject: 'subject',
  place: 'geographicCoverage',
  date: 'dateExpression',
};

/**
 * Splits a query into groups of clauses: the groups are alternatives (OR) and the clauses within a group must all
 * match.
 *
 * Wildcard characters are escaped so they are matched literally in SQL LIKE patterns, and the query is limited to
 * 300 characters. Unknown field names are treated as a search across all fields.
 *
 * @param {string} [input=''] The query typed by the user.
 * @returns {Array<Array<{ negate: boolean, field: string|null, value: string, phrase: boolean, raw: string }>>}
 */
export function parseQuery(input = '') {
  const groups = String(input)
    .slice(0, 300)
    .split(/\s+OR\s+/)
    .map((part) => {
      const clauses = [];
      const re = /(-)?(?:(\w+):)?(?:"([^"]+)"|(\S+))/g;
      let m;
      while ((m = re.exec(part))) {
        const [, neg, field, phrase, word] = m;
        const value = (phrase ?? word ?? '').replace(/[%_[\]]/g, (c) => `[${c}]`).trim();
        if (!value || value === 'AND') continue;
        clauses.push({
          negate: Boolean(neg),
          field: field ? (FIELD_ALIASES[field.toLowerCase()] ?? null) : null,
          value,
          phrase: Boolean(phrase),
          raw: phrase ?? word,
        });
      }
      return clauses;
    })
    .filter((g) => g.length);
  return groups;
}

/**
 * Lists the distinct terms to highlight: the positive clauses in lower case, ignoring single characters.
 *
 * @param {Array<Array<object>>} groups Parsed query.
 * @returns {string[]}
 */
export function highlightTerms(groups) {
  return [
    ...new Set(
      groups
        .flat()
        .filter((c) => !c.negate)
        .map((c) => c.raw.toLowerCase()),
    ),
  ].filter((t) => t.length > 1);
}

/**
 * Cuts a short passage around the first match in a text and splits it into highlighted and plain segments.
 *
 * Returning segments instead of HTML lets the frontend render highlights without inserting markup, so archival text
 * can never inject HTML.
 *
 * @param {string|null} text The text to search.
 * @param {string[]} terms Terms to highlight.
 * @param {number} [radius=120] Characters to keep before the match (twice as many after).
 * @returns {Array<{ text: string, hit: boolean }>|null} The segments, or null when nothing matches.
 */
export function snippet(text, terms, radius = 120) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius * 2);
  const slice = text.slice(start, end);
  const segments = [];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  let last = 0;
  for (const m of slice.matchAll(pattern)) {
    if (m.index > last) segments.push({ text: slice.slice(last, m.index), hit: false });
    segments.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < slice.length) segments.push({ text: slice.slice(last), hit: false });
  if (start > 0) segments.unshift({ text: '… ', hit: false });
  if (end < text.length) segments.push({ text: ' …', hit: false });
  return segments;
}
