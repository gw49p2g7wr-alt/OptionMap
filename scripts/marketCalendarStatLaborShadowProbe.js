"use strict";
const crypto = require("node:crypto");
const Fetch = require("../js/marketCalendarShadow/readOnlyFetch.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const runtime = previousObservations => Shadow.create({ adapters: [Adapters.createStatLabor()],
    previousObservations, runId: crypto.randomUUID(),
    fetcher: (sourceId, url) => Fetch.acquire(sourceId, url) });
async function main() {
    const first = await runtime({}).run(), prior = first.sources[0], second = await runtime({
        [prior.sourceId]: { rawContentSetHash: prior.rawContentSetHash,
            semanticSetHash: prior.semanticSetHash } }).run(), current = second.sources[0],
        priorRevisions = prior.formalCanonicalSet.map(event => event.revisionKey),
        revisions = current.formalCanonicalSet.map(event => event.revisionKey), output = {
            sourceId: current.sourceId, fetchStatus: current.fetchStatus,
            fetches: current.fetches.map(value => ({ status: value.status, httpStatus: value.httpStatus,
                finalUrl: value.finalUrl, redirects: value.redirects, contentType: value.contentType,
                contentHash: value.contentHash })), encoding: current.encoding,
            parserStatus: current.parserStatus, canonicalizationStatus: current.canonicalizationStatus,
            eventCount: current.eventCount, eventTypes: current.eventTypes,
            referencePeriods: current.formalCanonicalSet.map(event => event.logical.referencePeriod),
            sample: current.formalCanonicalSet.find(event => event.logical.referencePeriod === "2026-08"),
            exclusionCounts: current.exclusions.reduce((counts, value) => ({ ...counts,
                [value.reason]: (counts[value.reason] || 0) + 1 }), {}),
            timezoneResolution: current.timezoneResolution, duplicates: current.duplicates,
            identityCollisions: current.identityCollisions,
            sameRevision: JSON.stringify(priorRevisions) === JSON.stringify(revisions),
            evidenceUpdated: prior.acquisitionEvidenceSetHash !== current.acquisitionEvidenceSetHash,
            rawChange: current.rawChange, semanticChange: current.semanticChange,
            changeClassification: current.changeClassification, diagnostics: current.diagnostics,
            formalEligible: current.formalEligible };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = output.formalEligible && output.sameRevision && output.evidenceUpdated &&
        output.semanticChange === "unchanged" ? 0 : 2;
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
