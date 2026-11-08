"use strict";

const Core = require("./calendarSingleDocumentEvidencePilot.js");
const SourceEvidenceSet = require("../marketCalendarHistory/jpxHolidaysCalendarSourceEvidenceSet.js");

const pilot = Core.createSingleDocumentEvidencePilot({
  sourceId: SourceEvidenceSet.SOURCE_ID,
  sourceEvidenceSet: SourceEvidenceSet,
  pilotVersion: "optionmap-jpx-holidays-calendar-evidence-pilot-v1",
  runIdPrefix: "jpx-holidays-calendar-acquisition",
  diagnosticPrefix: "jpx_holidays_calendar",
  allowedEncodings: ["utf-8", "windows-1252"]
});

module.exports = Object.freeze({ SOURCE_ID: pilot.SOURCE_ID, CORE_VERSION: pilot.CORE_VERSION,
  PILOT_VERSION: pilot.PILOT_VERSION, TRANSPORT_VERSION: pilot.TRANSPORT_VERSION,
  DIAGNOSTICS: pilot.DIAGNOSTICS,
  createJpxHolidaysCalendarEvidencePolicy: pilot.createEvidencePolicy,
  acceptedAcquisition: pilot.acceptedAcquisition, createEvidenceInput: pilot.createEvidenceInput,
  sourceResultFor: pilot.sourceResultFor, createPilotRuntime: pilot.createPilotRuntime });
