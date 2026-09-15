"use strict";
const crypto = require("node:crypto");
const XLSX = require("xlsx");
const Fetch = require("../js/marketCalendarShadow/readOnlyFetch.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");

async function main() {
    const makeRuntime = previousObservations => Shadow.create({ adapters: Adapters.create({ XLSX }),
        previousObservations, runId: crypto.randomUUID(),
        fetcher: (sourceId, url) => Fetch.acquire(sourceId, url) });
    const first = await makeRuntime({}).run(), consecutive = process.argv.includes("--consecutive"),
        previous = Object.fromEntries(first.sources.map(source => [source.sourceId, {
            rawContentSetHash: source.rawContentSetHash, semanticSetHash: source.semanticSetHash }])),
        result = consecutive ? await makeRuntime(previous).run() : first;
    const output = process.argv.includes("--summary") ? { ...result,
        sources: result.sources.map(source => ({ ...source, formalCanonicalSet:
            source.formalCanonicalSet.map(event => event.revisionKey) })) } : result;
    const comparison = consecutive ? result.sources.map(source => { const prior = first.sources.find(item =>
        item.sourceId === source.sourceId), sameRevision = JSON.stringify(prior.formalCanonicalSet.map(event =>
            event.revisionKey)) === JSON.stringify(source.formalCanonicalSet.map(event => event.revisionKey));
        return { sourceId: source.sourceId, formalEligible: source.formalEligible, sameRevision,
            evidenceUpdated: prior.acquisitionEvidenceSetHash !== source.acquisitionEvidenceSetHash,
            rawChange: source.rawChange, semanticChange: source.semanticChange,
            changeClassification: source.changeClassification, eventCount: source.eventCount,
            eventTypes: source.eventTypes, diagnostics: source.diagnostics }; }) : null;
    process.stdout.write(`${JSON.stringify(consecutive ? { firstGeneratedAt: first.generatedAt,
        secondGeneratedAt: result.generatedAt, comparison } : output, null, 2)}\n`);
    process.exitCode = (comparison || result.sources).every(source => source.formalEligible &&
        (!consecutive || source.sameRevision && source.evidenceUpdated && source.semanticChange === "unchanged")) ? 0 : 2;
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
