"use strict";

const Core = require("./calendarEvidenceSetCore.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");

const SOURCE_ID = "us-bea-calendar";
const source = Registry.getSource(SOURCE_ID), routes = Network.getPolicy(SOURCE_ID).documents;
const contract = Core.createExactDocumentSetContract({ sourceId: SOURCE_ID,
  parserId: source.parserId, parserVersion: source.parserVersion,
  runIdPattern: /^bea-calendar-acquisition\|sha256:[0-9a-f]{64}$/,
  documents: [{ role: routes[0].role, initialUrl: routes[0].url,
    sourceUrls: [routes[0].url], maxBytes: routes[0].maxBytes,
    mediaTypes: routes[0].allowedMime, encodings: ["utf-8"] },
  { role: routes[1].role, initialUrl: routes[1].url,
    sourceUrls: [routes[1].url], maxBytes: routes[1].maxBytes,
    mediaTypes: routes[1].allowedMime, encodings: ["utf-8", "windows-1252"] }] });

module.exports = Object.freeze({ SOURCE_ID, CONTRACT_VERSION: Core.CONTRACT_VERSION,
  PARSER_ID: source.parserId, PARSER_VERSION: source.parserVersion,
  FIELDS: Core.FIELDS, DOCUMENT_FIELDS: Core.DOCUMENT_FIELDS,
  validateSourceEvidenceSet: contract.validateSourceEvidenceSet,
  createSourceEvidenceSet: contract.createSourceEvidenceSet,
  resolveRunEvidence: contract.resolveRunEvidence,
  resolveRevisionEvidence: contract.resolveRevisionEvidence });
