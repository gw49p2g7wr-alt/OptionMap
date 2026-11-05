"use strict";

const Core = require("./estatCalendarEvidencePilotCore.js");
const SourceEvidenceSet = require("../marketCalendarHistory/estatLaborCalendarSourceEvidenceSet.js");

const pilot = Core.createEstatCalendarEvidencePilot({ sourceId: SourceEvidenceSet.SOURCE_ID,
  sourceEvidenceSet: SourceEvidenceSet,
  pilotVersion: "optionmap-estat-labor-calendar-evidence-pilot-v1",
  runIdPrefix: "estat-labor-calendar-acquisition",
  diagnosticPrefix: "estat_labor_calendar" });

module.exports = Object.freeze({ SOURCE_ID: pilot.SOURCE_ID,
  ADAPTER_VERSION: pilot.ADAPTER_VERSION, CORE_VERSION: pilot.CORE_VERSION,
  PILOT_VERSION: pilot.PILOT_VERSION, TRANSPORT_VERSION: pilot.TRANSPORT_VERSION,
  DIAGNOSTICS: pilot.DIAGNOSTICS,
  createEstatLaborCalendarEvidencePolicy: pilot.createEvidencePolicy,
  normalizeAcquisition: pilot.normalizeAcquisition,
  acceptedAcquisition: pilot.acceptedAcquisition,
  createEvidenceInput: pilot.createEvidenceInput,
  sourceResultFor: pilot.sourceResultFor,
  createPilotRuntime: pilot.createPilotRuntime });
