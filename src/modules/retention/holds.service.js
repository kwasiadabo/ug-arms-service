/**
 * Lookup of the legal holds that apply to a record, digital file or physical item. Used by appraisal and disposal
 * so that held material can never be disposed of.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models } from '../../database/models/index.js';
import { pathIds } from '../../services/accessPolicy.service.js';

/**
 * Finds the active legal holds that cover the given material.
 *
 * A record is covered by a hold placed on it directly or on an ancestor with "include descendants". A digital file
 * or physical item is covered by a hold on itself or on its record.
 *
 * @param {{ recordId?: string, assetId?: string, physicalItemId?: string }} target The material to check.
 * @param {import('sequelize').Transaction} [transaction]
 * @returns {Promise<Array<{ itemId: string, holdId: string, reference: string, title: string }>>} The covering
 *   holds; empty when there are none.
 */
export async function holdsFor({ recordId, assetId, physicalItemId }, transaction) {
  const or = [];
  if (recordId) {
    const rec = await models.ArchivalRecord.findByPk(recordId, { attributes: ['id', 'path'], transaction });
    const ancestors = rec ? pathIds(rec.path) : [recordId];
    or.push({ recordId }, { recordId: ancestors.filter((id) => id !== recordId), includeDescendants: true });
  }
  if (assetId) {
    const asset = await models.DigitalAsset.findByPk(assetId, { attributes: ['recordId'], transaction });
    or.push({ assetId });
    if (asset?.recordId)
      or.push(...(await holdsFor({ recordId: asset.recordId }, transaction)).map((h) => ({ id: h.itemId })));
  }
  if (physicalItemId) {
    const item = await models.PhysicalItem.findByPk(physicalItemId, { attributes: ['recordId'], transaction });
    or.push({ physicalItemId });
    if (item?.recordId)
      or.push(...(await holdsFor({ recordId: item.recordId }, transaction)).map((h) => ({ id: h.itemId })));
  }
  if (!or.length) return [];
  const rows = await models.LegalHoldItem.findAll({
    where: { [Op.or]: or },
    include: [
      { model: models.LegalHold, as: 'hold', where: { status: 'active' }, attributes: ['id', 'reference', 'title'] },
    ],
    transaction,
  });
  return rows.map((r) => ({ itemId: r.id, holdId: r.hold.id, reference: r.hold.reference, title: r.hold.title }));
}
