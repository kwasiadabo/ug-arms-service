/**
 * Data minimisation for personal information, following the principles of Ghana's Data Protection Act, 2012 (Act
 * 843), subject to the University's approved policy.
 *
 * @author Kwasi Adabo Boakye
 */

import { Op } from 'sequelize';
import { models, sequelize } from '../../database/models/index.js';
import { getSetting } from '../../services/settings.service.js';
import { audit } from '../../services/audit.service.js';

const ANON = {
  contactName: 'Anonymised researcher',
  contactEmail: 'anonymised@invalid.example',
  contactPhone: null,
  affiliation: null,
  purpose: '[Removed under the personal-data retention policy]',
};

/**
 * Scheduled job that removes personal data that is no longer needed.
 *
 * After the configured number of months, finished research requests keep their decisions and links to records
 * (needed for archival accountability) but lose the researcher's contact details and stated purpose. The same
 * details are removed from the related appointments and loans, and each anonymisation is audited. Login attempts
 * and search logs older than the configured number of days are deleted. Audit events are never removed. A setting
 * of 0 disables the corresponding step.
 *
 * @returns {Promise<{ anonymised: number, pruned: number }>} Number of requests anonymised and log rows deleted.
 */
export async function applyPrivacyRetention() {
  const months = await getSetting('privacy.researchRequestRetentionMonths');
  const logDays = await getSetting('privacy.operationalLogRetentionDays');
  let anonymised = 0;
  if (months > 0) {
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const due = await models.ResearchRequest.findAll({
      where: {
        status: ['closed', 'cancelled', 'rejected', 'fulfilled'],
        updatedAt: { [Op.lt]: cutoff },
        contactEmail: { [Op.ne]: ANON.contactEmail },
      },
      attributes: ['id'],
      limit: 1000,
    });
    for (const r of due) {
      await sequelize.transaction(async (t) => {
        await models.ResearchRequest.update(ANON, { where: { id: r.id }, transaction: t });
        await models.ResearchAppointment.update(
          { researcherName: ANON.contactName, researcherEmail: null },
          { where: { requestId: r.id }, transaction: t },
        );
        await models.CirculationTransaction.update(
          { researcherName: ANON.contactName },
          { where: { requestId: r.id }, transaction: t },
        );
        await audit(
          {
            action: 'privacy.research_request_anonymised',
            resourceType: 'ResearchRequest',
            resourceId: r.id,
            actorType: 'system',
            metadata: { retentionMonths: months },
          },
          { transaction: t },
        );
      });
      anonymised += 1;
    }
  }
  let pruned = 0;
  if (logDays > 0) {
    const cutoff = new Date(Date.now() - logDays * 86400_000);
    pruned += await models.LoginAttempt.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
    pruned += await models.SearchLog.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
  }
  return { anonymised, pruned };
}
