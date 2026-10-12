"use strict";

// Main-side factory capability, never selected by renderer/check request fields.
// Production activation remains a separate gate; historical defaults stay exact12.
const Registry = require("../marketCalendar/sourceRegistry.js");
const NORMAL13 = Object.freeze({ version: 2, sourceIds: Object.freeze([
  ...Registry.HISTORICAL_SOURCE_ORDER, "jp-mof-jgb-auction-calendar"
]) });
function resolve(contract) {
  if (contract === undefined) return Registry.getAcquisitionEnabledSourceIds();
  if (contract !== NORMAL13) throw TypeError("normal_acquisition_contract_invalid");
  return Registry.selectRegisteredEnabledSourceIds(Object.keys(Registry.SOURCES), contract.sourceIds);
}
module.exports = Object.freeze({ NORMAL13, resolve });
