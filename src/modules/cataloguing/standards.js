/**
 * Export of descriptions and authority records in archival exchange formats: EAD3-style finding aids, Dublin Core
 * (oai_dc) and EAC-CPF.
 *
 * The output uses the element names of these standards but is NOT validated against their schemas; see
 * docs/architecture.md before relying on it for exchange with other systems. Every export applies the requesting
 * user's access rights: restricted descriptions appear with identifying information only, and records the user may
 * not discover are left out. All text is XML-escaped.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { evaluateRecord } from '../../services/accessPolicy.service.js';
import { getSetting } from '../../services/settings.service.js';

/**
 * Escapes the five characters that have a special meaning in XML.
 *
 * @param {*} s Text to escape; null and undefined become an empty string.
 * @returns {string}
 */
const escapeXml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );

/**
 * Renders a simple XML element containing escaped text, or nothing when the value is empty.
 *
 * @param {string} name Element name.
 * @param {*} value Text content.
 * @param {string} [attrs=''] Pre-escaped attribute string, starting with a space.
 * @returns {string}
 */
const el = (name, value, attrs = '') => (value ? `<${name}${attrs}>${escapeXml(value)}</${name}>` : '');

/**
 * Renders an EAD element whose text is split into paragraphs (`<p>`) at blank lines, or nothing when the value is
 * empty.
 *
 * @param {string} name Element name, for example "scopecontent".
 * @param {*} value Multi-paragraph text.
 * @returns {string}
 */
const para = (name, value) =>
  value
    ? `<${name}>${String(value)
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeXml(p)}</p>`)
        .join('')}</${name}>`
    : '';
const EAD_LEVEL = {
  fonds: 'fonds',
  collection: 'collection',
  subfonds: 'subfonds',
  series: 'series',
  subseries: 'subseries',
  file: 'file',
  item: 'item',
};

/**
 * Renders the EAD descriptive identification (`<did>`) of a description: reference code, title, dates and, when the
 * full description may be shown, the extent.
 *
 * @param {object} r The description.
 * @param {boolean} full Whether the user may see the full description.
 * @returns {string}
 */
function did(r, full) {
  return `<did>${el('unitid', r.referenceCode)}${el('unittitle', r.title)}${r.dateExpression || r.dateStart ? `<unitdate${r.dateStart ? ` normal="${escapeXml(r.dateStart)}${r.dateEnd ? `/${escapeXml(r.dateEnd)}` : ''}"` : ''}>${escapeXml(r.dateExpression || `${r.dateStart}${r.dateEnd ? `–${r.dateEnd}` : ''}`)}</unitdate>` : ''}${full && r.extentAndMedium ? `<physdescstructured coverage="whole" physdescstructuredtype="otherphysdescstructuredtype" otherphysdescstructuredtype="extent"><quantity>1</quantity><unittype>${escapeXml(r.extentAndMedium)}</unittype></physdescstructured>` : ''}${full && r.creatorNote ? `<origination><corpname><part>${escapeXml(r.creatorNote)}</part></corpname></origination>` : ''}${full && r.languages?.length ? `<langmaterial>${r.languages.map((l) => `<language>${escapeXml(l)}</language>`).join('')}</langmaterial>` : ''}</did>`;
}

/**
 * Renders the EAD narrative elements of a description (history, custodial history, acquisition, scope and content,
 * appraisal, accruals, arrangement, conditions of access and use, physical characteristics, finding aids, related
 * material and preferred citation). When only identifying information may be shown, just the access conditions are
 * included.
 *
 * @param {object} r The description.
 * @param {boolean} full Whether the user may see the full description.
 * @returns {string}
 */
function body(r, full) {
  if (!full) return `${para('accessrestrict', r.accessConditions || 'Access to this description is restricted.')}`;
  return [
    para('bioghist', r.adminBiographicalHistory),
    para('custodhist', r.archivalHistory),
    para('acqinfo', r.immediateSource),
    para('scopecontent', r.scopeAndContent),
    para('appraisal', r.appraisalInfo),
    para('accruals', r.accruals),
    para('arrangement', r.arrangement),
    para('accessrestrict', r.accessConditions),
    para('userestrict', r.reproductionConditions),
    para('phystech', r.physicalCharacteristics),
    para('otherfindaid', r.findingAids),
    para('originalsloc', r.locationOfOriginals),
    para('altformavail', r.locationOfCopies),
    para('relatedmaterial', r.relatedMaterials),
    para('prefercite', r.preferredCitation),
  ].join('');
}

/**
 * Builds an EAD3-style finding aid for a description and all its descendants (up to 20,000), in hierarchy and
 * arrangement order.
 *
 * Each component is checked against the user's access: components the user may not discover are omitted together
 * with everything below them, and restricted components show identifying information only. Level names come from
 * the `EAD_LEVEL` allow-list, so only valid EAD level values reach the output.
 *
 * @param {object} root The top description of the finding aid.
 * @param {object|null} user Requesting user, or null for a public visitor.
 * @returns {Promise<string>} The XML document.
 */
export async function toEad(root, user) {
  const rows = await models.ArchivalRecord.findAll({
    where: { path: { [Op.like]: `${root.path}%` } },
    order: [
      ['depth', 'ASC'],
      ['sortOrder', 'ASC'],
      ['referenceCode', 'ASC'],
    ],
    limit: 20000,
  });
  const children = new Map();
  const visible = new Map();
  for (const r of rows) {
    const d = await evaluateRecord(user, r);
    if (!d.canDiscover) continue;
    visible.set(r.id, { r, full: d.mode === 'full' });
    if (r.id !== root.id) children.set(r.parentId, [...(children.get(r.parentId) || []), r.id]);
  }

  /**
   * Renders one EAD component (`<c>`) and, recursively, its visible children.
   *
   * @param {string} id Identifier of the description.
   * @returns {string}
   */
  const renderC = (id) => {
    const { r, full } = visible.get(id);
    const kids = (children.get(id) || []).filter((k) => visible.has(k));
    return `<c level="${EAD_LEVEL[r.level]}" id="ugarms-${r.id}">${did(r, full)}${body(r, full)}${kids.map(renderC).join('')}</c>`;
  };
  const rootV = visible.get(root.id);
  const institution = await getSetting('institution.name');
  const kids = (children.get(root.id) || []).filter((k) => visible.has(k));
  return `<?xml version="1.0" encoding="UTF-8"?>
<ead xmlns="http://ead3.archivists.org/schema/">
<control><recordid>${escapeXml(root.referenceCode)}</recordid><filedesc><titlestmt><titleproper>${escapeXml(root.title)}</titleproper></titlestmt><publicationstmt><publisher>${escapeXml(institution)}</publisher></publicationstmt></filedesc><maintenancestatus value="derived"/><maintenanceagency><agencyname>${escapeXml(institution)}</agencyname></maintenanceagency><maintenancehistory><maintenanceevent><eventtype value="derived"/><eventdatetime standarddatetime="${new Date().toISOString()}">${new Date().toISOString()}</eventdatetime><agenttype value="machine"/><agent>UG-ARMS</agent></maintenanceevent></maintenancehistory></control>
<archdesc level="${EAD_LEVEL[root.level] === 'collection' ? 'collection' : 'fonds'}">${did(rootV.r, rootV.full)}${body(rootV.r, rootV.full)}${kids.length ? `<dsc>${kids.map(renderC).join('')}</dsc>` : ''}</archdesc>
</ead>`;
}

/**
 * Builds a Dublin Core (oai_dc) record for a description. Creators, subjects, languages, the description and the
 * extent are included only when the user may see the full description.
 *
 * @param {object} r The description.
 * @param {boolean} full Whether the user may see the full description.
 * @returns {Promise<string>} The XML document.
 */
export async function toDublinCore(r, full) {
  const subjects = full
    ? await models.RecordSubject.findAll({
        where: { recordId: r.id },
        include: [
          { model: models.VocabularyTerm, as: 'term', attributes: ['label'] },
          { model: models.AuthorityRecord, as: 'authority', attributes: ['authorizedName'] },
        ],
      })
    : [];
  const creators = full
    ? await models.RecordCreator.findAll({
        where: { recordId: r.id },
        include: [{ model: models.AuthorityRecord, as: 'authority', attributes: ['authorizedName'] }],
      })
    : [];
  const institution = await getSetting('institution.name');
  return `<?xml version="1.0" encoding="UTF-8"?>
<oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/">
${el('dc:identifier', r.referenceCode)}
${el('dc:title', r.title)}
${creators.map((c) => el('dc:creator', c.authority?.authorizedName)).join('') || (full ? el('dc:creator', r.creatorNote) : '')}
${el('dc:date', r.dateExpression || [r.dateStart, r.dateEnd].filter(Boolean).join('/'))}
${full ? el('dc:description', r.scopeAndContent) : ''}
${subjects.map((s) => el('dc:subject', s.term?.label || s.authority?.authorizedName)).join('')}
${(full ? r.languages || [] : []).map((l) => el('dc:language', l)).join('')}
${el('dc:format', full ? r.extentAndMedium : '')}
${el('dc:rights', r.reproductionConditions)}
${el('dc:publisher', institution)}
${el('dc:type', 'Collection')}
</oai_dc:dc>`;
}

/**
 * Builds an EAC-CPF record for an authority record: control information, entity type, authorised and other names,
 * dates of existence, places, legal status, functions, mandates, history and general context.
 *
 * @param {object} a The authority record.
 * @returns {string} The XML document.
 */
export function toEacCpf(a) {
  const type = { person: 'person', family: 'family' }[a.entityType] || 'corporateBody';
  return `<?xml version="1.0" encoding="UTF-8"?>
<eac-cpf xmlns="urn:isbn:1-931666-33-4">
<control><recordId>${escapeXml(a.identifier || a.id)}</recordId><maintenanceStatus>${a.status === 'deprecated' ? 'deleted' : 'revised'}</maintenanceStatus><maintenanceAgency><agencyName>UG-ARMS</agencyName></maintenanceAgency><maintenanceHistory><maintenanceEvent><eventType>derived</eventType><eventDateTime standardDateTime="${new Date().toISOString()}"/><agentType>machine</agentType><agent>UG-ARMS</agent></maintenanceEvent></maintenanceHistory></control>
<cpfDescription><identity><entityType>${type}</entityType><nameEntry><part>${escapeXml(a.authorizedName)}</part><authorizedForm>local</authorizedForm></nameEntry>${(a.otherNames || []).map((n) => `<nameEntry><part>${escapeXml(n)}</part><alternativeForm>local</alternativeForm></nameEntry>`).join('')}</identity>
<description>${a.datesOfExistence ? `<existDates><dateRange><fromDate>${escapeXml(a.datesOfExistence)}</fromDate></dateRange></existDates>` : ''}${a.places ? `<places><place><placeEntry>${escapeXml(a.places)}</placeEntry></place></places>` : ''}${a.legalStatus ? `<legalStatus><term>${escapeXml(a.legalStatus)}</term></legalStatus>` : ''}${a.functions ? `<functions><function><descriptiveNote><p>${escapeXml(a.functions)}</p></descriptiveNote></function></functions>` : ''}${a.mandates ? `<mandates><mandate><descriptiveNote><p>${escapeXml(a.mandates)}</p></descriptiveNote></mandate></mandates>` : ''}${a.history ? `<biogHist><p>${escapeXml(a.history)}</p></biogHist>` : ''}</description>
</cpfDescription>
</eac-cpf>`;
}
