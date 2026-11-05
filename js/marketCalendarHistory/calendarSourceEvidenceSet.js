"use strict";

// R2-D2-R7 binds the fixed four-page BLS Calendar acquisition to the shared
// immutable Source Evidence Vault.  This contract stores references only;
// raw response bytes remain vault-owned and never enter Calendar IndexedDB.
const Route = require("../marketCalendarIsolated/blsFixedRoute.js");
const Core = require("./calendarEvidenceSetCore.js");

const CONTRACT_VERSION = Core.CONTRACT_VERSION;
const PARSER_ID = Route.shadowRegistry.getSource(Route.SOURCE_ID).parserId;
const contract = Core.createExactDocumentSetContract({ sourceId: Route.SOURCE_ID,
  parserId: PARSER_ID, parserVersion: Route.PARSER_VERSION,
  runIdPattern: /^bls-calendar-acquisition\|sha256:[0-9a-f]{64}$/,
  documents: Route.ROLES.map(route => ({ role: route.role, initialUrl: route.url,
    sourceUrls: [route.url], maxBytes: Route.MAX_BYTES, mediaTypes: ["text/html"],
    encodings: ["utf-8"] })) });

module.exports = Object.freeze({ CONTRACT_VERSION, PARSER_ID, FIELDS: Core.FIELDS,
  DOCUMENT_FIELDS: Core.DOCUMENT_FIELDS,
  validateSourceEvidenceSet: contract.validateSourceEvidenceSet,
  createSourceEvidenceSet: contract.createSourceEvidenceSet,
  resolveRunEvidence: contract.resolveRunEvidence,
  resolveRevisionEvidence: contract.resolveRevisionEvidence });
