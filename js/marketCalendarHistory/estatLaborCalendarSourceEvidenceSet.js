"use strict";

const Core = require("./calendarEvidenceSetCore.js");
const Estat = require("../marketCalendarIsolated/estatRoute.js");

const SOURCE_ID = "jp-stat-labor";
const source = Estat.shadowRegistry.getSource(SOURCE_ID), route = Estat.ROUTES[SOURCE_ID];
const contract = Core.createExactDocumentSetContract({ sourceId: SOURCE_ID,
  parserId: source.parserId, parserVersion: Estat.PARSER_VERSION,
  runIdPattern: /^estat-labor-calendar-acquisition\|sha256:[0-9a-f]{64}$/,
  documents: [{ role: route.role, initialUrl: route.url, sourceUrls: [route.url],
    maxBytes: route.maxBytes, mediaTypes: route.allowedMime, encodings: ["utf-8"] }] });

module.exports = Object.freeze({ SOURCE_ID, CONTRACT_VERSION: Core.CONTRACT_VERSION,
  PARSER_ID: source.parserId, PARSER_VERSION: Estat.PARSER_VERSION,
  FIELDS: Core.FIELDS, DOCUMENT_FIELDS: Core.DOCUMENT_FIELDS,
  validateSourceEvidenceSet: contract.validateSourceEvidenceSet,
  createSourceEvidenceSet: contract.createSourceEvidenceSet,
  resolveRunEvidence: contract.resolveRunEvidence,
  resolveRevisionEvidence: contract.resolveRevisionEvidence });
