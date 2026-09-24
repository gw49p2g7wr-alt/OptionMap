"use strict";

const crypto = require("node:crypto");
const XLSX = require("xlsx");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");

const expected = Object.freeze({ "jp-boj-calendar": 3, "jp-stat-cpi": 30,
  "jp-stat-labor": 15, "jp-esri-machinery-orders-calendar": 4,
  "jp-esri-sna-calendar": 4, "us-fed-fomc-calendar": 24,
  "us-bls-calendar": 5, "us-bea-calendar": 8, "us-census-calendar": 13,
  "jp-jpx-derivatives-calendar": 24, "jp-jpx-market-holidays": 41,
  "us-nyse-market-holidays": 34 });

const adapterList = (() => { const values = [...Adapters.create({ XLSX }), Adapters.createStatCpi(),
  Adapters.createStatLabor(), Adapters.createEsriMachineryOrders(), Adapters.createEsriSna(),
  Adapters.createBea(), Adapters.createCensus(), Adapters.createJpxMarketHolidays(),
  Adapters.createNyseMarketHolidays()]; return new Map(values.map(value => [value.sourceId, value])); })();

function responseFor(document, requestedUrl, envelope) {
  return Object.freeze({ status: "success", reason: null, sourceId: envelope.sourceId,
    requestId: null, requestedUrl, finalUrl: document.finalUrl, fetchedAt: envelope.fetchedAt,
    httpStatus: document.httpStatus, redirects: document.redirects, contentType: document.mime,
    contentHash: document.contentSha256, bytes: document.parserInput });
}

async function main() {
  const service = Acquisition.createCalendarAcquisitionService({ maxRetries: 0 }), output = [];
  for (const sourceId of Object.keys(expected)) {
    const envelope = await service.acquire({ sourceId, operation: Policy.OPERATION });
    if (!envelope.success) { output.push({ sourceId, acquisition: "failure", reason: envelope.reason,
      diagnostics: envelope.diagnostics }); continue; }
    const fetcher = async (_sourceId, url) => { const document = envelope.documents.find(value =>
      value.originalOfficialUrl === url || value.finalUrl === url);
    return document ? responseFor(document, url, envelope) : Object.freeze({ status: "failure",
      reason: "document_not_in_validated_set", sourceId, requestedUrl: url }); };
    const shadow = await Shadow.create({ adapters: [adapterList.get(sourceId)], fetcher,
      runId: crypto.randomUUID() }).run(), result = shadow.sources[0];
    output.push({ sourceId, acquisition: "success", documentCount: envelope.documents.length,
      documents: envelope.documents.map(value => ({ role: value.role, finalUrl: value.finalUrl,
        httpStatus: value.httpStatus, redirectCount: value.redirects.length, mime: value.mime,
        byteCount: value.byteCount, contentSha256: value.contentSha256,
        encoding: value.encoding, workbook: value.workbook })), parserStatus: result.parserStatus,
      canonicalizationStatus: result.canonicalizationStatus, formalEligible: result.formalEligible,
      eventCount: result.eventCount, expectedEventCount: expected[sourceId],
      eventTypes: result.eventTypes, diagnostics: result.diagnostics });
  }
  const pass = output.length === 12 && output.every(value => value.acquisition === "success" &&
    value.formalEligible && value.eventCount === value.expectedEventCount);
  process.stdout.write(`${JSON.stringify({ phase: "A", readOnly: true, storageWrite: false,
    databaseOpen: 0, indexedDbTransactions: 0, productionProfileUsed: false, pass, sources: output }, null, 2)}\n`);
  process.exitCode = pass ? 0 : 2;
}

main().catch(error => { process.stderr.write("Phase A live acceptance failed\n"); process.exitCode = 1; });
