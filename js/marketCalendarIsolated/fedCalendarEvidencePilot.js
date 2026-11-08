"use strict";

const Core = require("./calendarSingleDocumentEvidencePilot.js");
const SourceEvidenceSet = require("../marketCalendarHistory/fedCalendarSourceEvidenceSet.js");

const LIVE_CONTEXT = "live_original_acquisition";
const pilot = Core.createSingleDocumentEvidencePilot({
  sourceId: SourceEvidenceSet.SOURCE_ID,
  sourceEvidenceSet: SourceEvidenceSet,
  pilotVersion: "optionmap-fed-calendar-evidence-pilot-v1",
  runIdPrefix: "fed-calendar-acquisition",
  diagnosticPrefix: "fed_calendar",
  allowedEncodings: ["utf-8", "windows-1252"]
});

function requireLiveContext(value) {
  if (value !== LIVE_CONTEXT) throw new Error("fed_calendar_historical_route_not_approved");
}
function createEvidenceInput(acquisition, acquisitionContext) {
  requireLiveContext(acquisitionContext);
  return pilot.createEvidenceInput(acquisition, acquisitionContext);
}
function createPilotRuntime(configuration) {
  const runtime = pilot.createPilotRuntime(configuration);
  return Object.freeze({ ...runtime,
    async acquireAndCommit(input) {
      requireLiveContext(input?.acquisitionContext);
      return runtime.acquireAndCommit(input);
    } });
}

module.exports = Object.freeze({ SOURCE_ID: pilot.SOURCE_ID,
  CORE_VERSION: pilot.CORE_VERSION, PILOT_VERSION: pilot.PILOT_VERSION,
  TRANSPORT_VERSION: pilot.TRANSPORT_VERSION, DIAGNOSTICS: pilot.DIAGNOSTICS,
  LIVE_CONTEXT, createFedCalendarEvidencePolicy: pilot.createEvidencePolicy,
  acceptedAcquisition: pilot.acceptedAcquisition, createEvidenceInput,
  sourceResultFor: pilot.sourceResultFor, createPilotRuntime });
