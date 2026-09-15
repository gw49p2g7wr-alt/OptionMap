"use strict";
const crypto = require("node:crypto");
const Fetch = require("../js/marketCalendarShadow/readOnlyFetch.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const adapters = () => [Adapters.createEsriMachineryOrders(), Adapters.createEsriSna()];
const runtime = previousObservations => Shadow.create({ adapters: adapters(), previousObservations,
    runId: crypto.randomUUID(), fetcher: (sourceId, url) => Fetch.acquire(sourceId, url) });
async function main() {
    const first = await runtime({}).run(), previous = Object.fromEntries(first.sources.map(source =>
        [source.sourceId, { rawContentSetHash: source.rawContentSetHash,
            semanticSetHash: source.semanticSetHash }])), second = await runtime(previous).run(), sources =
        second.sources.map((source, index) => ({ sourceId: source.sourceId,
            fetchStatus: source.fetchStatus, fetches: source.fetches, parserStatus: source.parserStatus,
            canonicalizationStatus: source.canonicalizationStatus, eventCount: source.eventCount,
            eventTypes: source.eventTypes, events: source.formalCanonicalSet.map(event => ({
                eventKey: event.eventKey, referencePeriod: event.logical.referencePeriod,
                edition: event.logical.edition, sourceLocal: event.schedule.sourceLocal })),
            timezoneResolution: source.timezoneResolution, duplicates: source.duplicates,
            identityCollisions: source.identityCollisions, sameRevision: JSON.stringify(
                first.sources[index].formalCanonicalSet.map(event => event.revisionKey)) === JSON.stringify(
                    source.formalCanonicalSet.map(event => event.revisionKey)), evidenceUpdated:
                first.sources[index].acquisitionEvidenceSetHash !== source.acquisitionEvidenceSetHash,
            rawChange: source.rawChange, semanticChange: source.semanticChange,
            changeClassification: source.changeClassification, diagnostics: source.diagnostics,
            formalEligible: source.formalEligible }));
    process.stdout.write(`${JSON.stringify({ sources }, null, 2)}\n`);
    process.exitCode = sources.every(source => source.formalEligible && source.sameRevision &&
        source.evidenceUpdated && source.semanticChange === "unchanged") ? 0 : 2;
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
