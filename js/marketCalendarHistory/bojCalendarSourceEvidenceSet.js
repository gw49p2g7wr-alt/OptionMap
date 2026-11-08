"use strict";

const Core = require("./calendarEvidenceSetCore.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");

const SOURCE_ID = "jp-boj-calendar";
const source = Registry.getSource(SOURCE_ID), routes = Network.BOJ_COVERAGE_V3.documents;
const contract = Core.createExactDocumentSetContract({ sourceId: SOURCE_ID,
  parserId: source.parserId, parserVersion: source.parserVersion,
  runIdPattern: /^boj-calendar-acquisition\|sha256:[0-9a-f]{64}$/,
  documents: routes.map(route => ({ role: route.role, initialUrl: route.url,
    sourceUrls: [route.url], maxBytes: route.maxBytes, mediaTypes: route.allowedMime,
    encodings: route.kind === "xlsx" ? [null] : ["utf-8", "windows-1252"] })) });

module.exports = Object.freeze({ SOURCE_ID, CONTRACT_VERSION: Core.CONTRACT_VERSION,
  PARSER_ID: source.parserId, PARSER_VERSION: source.parserVersion,
  FIELDS: Core.FIELDS, DOCUMENT_FIELDS: Core.DOCUMENT_FIELDS,
  validateSourceEvidenceSet: contract.validateSourceEvidenceSet,
  createSourceEvidenceSet: contract.createSourceEvidenceSet,
  resolveRunEvidence: contract.resolveRunEvidence,
  resolveRevisionEvidence: contract.resolveRevisionEvidence });
