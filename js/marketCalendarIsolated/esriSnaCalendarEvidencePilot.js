"use strict";

const Core = require("./calendarSingleDocumentEvidencePilot.js");
const SourceEvidenceSet = require("../marketCalendarHistory/esriSnaCalendarSourceEvidenceSet.js");

const pilot = Core.createSingleDocumentEvidencePilot({
  sourceId: SourceEvidenceSet.SOURCE_ID,
  sourceEvidenceSet: SourceEvidenceSet,
  pilotVersion: "optionmap-esri-sna-calendar-evidence-pilot-v1",
  runIdPrefix: "esri-sna-calendar-acquisition",
  diagnosticPrefix: "esri_sna_calendar",
  allowedEncodings: ["utf-8", "windows-1252"]
});

module.exports = Object.freeze({ SOURCE_ID: pilot.SOURCE_ID, CORE_VERSION: pilot.CORE_VERSION,
  PILOT_VERSION: pilot.PILOT_VERSION, TRANSPORT_VERSION: pilot.TRANSPORT_VERSION,
  DIAGNOSTICS: pilot.DIAGNOSTICS,
  createEsriSnaCalendarEvidencePolicy: pilot.createEvidencePolicy,
  acceptedAcquisition: pilot.acceptedAcquisition, createEvidenceInput: pilot.createEvidenceInput,
  sourceResultFor: pilot.sourceResultFor, createPilotRuntime: pilot.createPilotRuntime });
