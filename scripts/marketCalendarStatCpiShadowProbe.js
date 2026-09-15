"use strict";
const crypto = require("node:crypto");
const Fetch = require("../js/marketCalendarShadow/readOnlyFetch.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");

const runtime = previousObservations => Shadow.create({ adapters: [Adapters.createStatCpi()],
    previousObservations, runId: crypto.randomUUID(),
    fetcher: (sourceId, url) => Fetch.acquire(sourceId, url) });
async function main() {
    const first = await runtime({}).run(), prior = first.sources[0], second = await runtime({
        [prior.sourceId]: { rawContentSetHash: prior.rawContentSetHash,
            semanticSetHash: prior.semanticSetHash } }).run(), current = second.sources[0],
        sameRevision = JSON.stringify(prior.formalCanonicalSet.map(event => event.revisionKey)) ===
            JSON.stringify(current.formalCanonicalSet.map(event => event.revisionKey)), output = {
                sourceId: current.sourceId, fetchStatus: current.fetchStatus, fetches: current.fetches,
                encoding: current.encoding, parserStatus: current.parserStatus,
                canonicalizationStatus: current.canonicalizationStatus, eventCount: current.eventCount,
                eventTypes: current.eventTypes, events: current.formalCanonicalSet.map(event => ({
                    eventKey: event.eventKey, revisionKey: event.revisionKey,
                    acquisitionEvidenceKey: event.acquisitionEvidenceKey,
                    sourceLocal: event.schedule.sourceLocal })), exclusions: current.exclusions,
                timezoneResolution: current.timezoneResolution, duplicates: current.duplicates,
                identityCollisions: current.identityCollisions, sameRevision,
                evidenceUpdated: prior.acquisitionEvidenceSetHash !== current.acquisitionEvidenceSetHash,
                rawChange: current.rawChange, semanticChange: current.semanticChange,
                changeClassification: current.changeClassification, diagnostics: current.diagnostics,
                formalEligible: current.formalEligible };
    const rendered = process.argv.includes("--summary") ? { sourceId: output.sourceId,
        fetchStatus: output.fetchStatus, fetches: output.fetches.map(value => ({ status: value.status,
            httpStatus: value.httpStatus, finalUrl: value.finalUrl, redirects: value.redirects,
            contentType: value.contentType, contentHash: value.contentHash })), encoding: output.encoding,
        parserStatus: output.parserStatus, canonicalizationStatus: output.canonicalizationStatus,
        eventCount: output.eventCount, eventTypes: output.eventTypes,
        identitySamples: output.events.filter(event => event.eventKey.includes("|2026-08|")),
        exclusionCounts: output.exclusions.reduce((counts, value) => ({ ...counts,
            [value.reason]: (counts[value.reason] || 0) + 1 }), {}),
        timezoneResolution: output.timezoneResolution, duplicates: output.duplicates,
        identityCollisions: output.identityCollisions, sameRevision: output.sameRevision,
        evidenceUpdated: output.evidenceUpdated, rawChange: output.rawChange,
        semanticChange: output.semanticChange, changeClassification: output.changeClassification,
        diagnostics: output.diagnostics, formalEligible: output.formalEligible } : output;
    process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
    process.exitCode = output.formalEligible && output.sameRevision && output.evidenceUpdated &&
        output.semanticChange === "unchanged" ? 0 : 2;
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
