/**
 * Model registry.
 *
 * Defines every model on the shared Sequelize connection, applies the associations between them and exports them as
 * `models`. Services import models from here so they all share the same definitions and connection pool.
 *
 * @author Kwasi Adabo Boakye
 */

import { sequelize } from '../../config/database.js';
import defineIdentity from './identity.js';
import defineArchival from './archival.js';
import defineAccessioning from './accessioning.js';
import definePhysical from './physical.js';
import defineDigital from './digital.js';
import defineDigitisation from './digitisation.js';
import defineResearch from './research.js';
import defineGovernance from './governance.js';
import { applyAssociations } from '../associations.js';

export const models = {
  ...defineIdentity(sequelize),
  ...defineArchival(sequelize),
  ...defineAccessioning(sequelize),
  ...definePhysical(sequelize),
  ...defineDigital(sequelize),
  ...defineDigitisation(sequelize),
  ...defineResearch(sequelize),
  ...defineGovernance(sequelize),
};

applyAssociations(models);

export { sequelize };
export default models;
