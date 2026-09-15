(function (root, factory) {
    const canonicalizer = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/marketEventCanonicalizer.js") : root?.OptionMapMarketEventCanonicalizer;
    const sourceContract = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/sourceContract.js") : root?.OptionMapMarketEventSourceContract;
    const schedule = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/marketEventSchedule.js") : root?.OptionMapMarketEventSchedule;
    const api = factory(canonicalizer, sourceContract, schedule);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarShadowAcquisition = api;
})(typeof window !== "undefined" ? window : globalThis, function (canonicalizer, sourceContract, schedule) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function create({ adapters, fetcher, previousObservations = {}, runId = null } = {}) {
        async function run() { const sourceResults = [];
            for (const adapter of adapters || []) { const acquired = await adapter.acquire({ fetcher, runId }),
                diagnostics = [...(acquired.diagnostics || [])], exclusions = clone(acquired.exclusions || []),
                canonical = [], eventTypes = {};
                let parserStatus = diagnostics.length ? acquired.records?.length ? "partial" : "failure" : "success";
                for (const record of acquired.records || []) { const validation = sourceContract.validateSourceRecord(record);
                    if (!validation.valid) { diagnostics.push(...validation.errors.map(error => `contract:${error}`)); continue; }
                    const result = await canonicalizer.canonicalize(record);
                    if (!result.ok) { diagnostics.push(`canonical:${result.reason}`); continue; }
                    try { schedule.calendarDateFor(result.event.schedule, "Asia/Tokyo"); }
                    catch (error) { diagnostics.push(`timezone:${error.message}`); continue; }
                    canonical.push(result.event); eventTypes[result.event.logical.eventType] =
                        (eventTypes[result.event.logical.eventType] || 0) + 1; }
                const eventKeys = new Map(), revisions = new Set(); let duplicates = 0, identityCollisions = 0;
                for (const event of canonical) { if (revisions.has(event.revisionKey)) duplicates += 1;
                    revisions.add(event.revisionKey); const prior = eventKeys.get(event.eventKey);
                    if (prior && prior !== event.revisionKey) identityCollisions += 1;
                    eventKeys.set(event.eventKey, event.revisionKey); }
                if (duplicates) diagnostics.push(`duplicate:${duplicates}`);
                if (identityCollisions) diagnostics.push(`identity_collision:${identityCollisions}`);
                const successfulFetches = (acquired.fetches || []).filter(item => item.status === "success"),
                    contentHashes = successfulFetches.map(item => item.contentHash),
                    rawContentSetHash = contentHashes.length ? await canonicalizer.sha256(contentHashes) : null,
                    semanticSetHash = canonical.length ? await canonicalizer.sha256(canonical.map(event =>
                        event.revisionKey).sort()) : null,
                    acquisitionEvidenceSetHash = canonical.length ? await canonicalizer.sha256(canonical.map(event =>
                        event.acquisitionEvidenceKey).sort()) : null,
                    previous = previousObservations[adapter.sourceId] || null,
                    rawChange = !previous ? "unknown" : previous.rawContentSetHash === rawContentSetHash
                        ? "unchanged" : "changed",
                    semanticChange = !previous ? "unknown" : previous.semanticSetHash === semanticSetHash
                        ? "unchanged" : "changed",
                    changeClassification = !previous ? "unknown" : semanticChange === "changed"
                        ? "parsed_semantic_changed" : rawChange === "changed"
                            ? "raw_changed_parsed_semantic_unchanged" : "raw_unchanged";
                const formalEligible = parserStatus === "success" && diagnostics.length === 0 &&
                    canonical.length === acquired.records.length && canonical.length > 0;
                sourceResults.push(freeze({ sourceId: adapter.sourceId,
                    fetchStatus: (acquired.fetches || []).every(item => item.status === "success") ? "success" : "failure",
                    fetches: clone(acquired.fetches || []).map(item => ({ status: item.status, reason: item.reason,
                        requestId: item.requestId || null,
                        requestedUrl: item.requestedUrl, finalUrl: item.finalUrl, httpStatus: item.httpStatus,
                        redirects: item.redirects, contentType: item.contentType, contentHash: item.contentHash,
                        fetchedAt: item.fetchedAt })), contentHashes, rawContentSetHash, semanticSetHash,
                    acquisitionEvidenceSetHash, rawChange, semanticChange, changeClassification, parserStatus,
                    canonicalizationStatus: canonical.length === (acquired.records || []).length && canonical.length
                        ? "success" : canonical.length ? "partial" : "failure", eventCount: canonical.length,
                    eventTypes, duplicates, identityCollisions, timezoneResolution: diagnostics.some(value =>
                        value.startsWith("timezone:")) ? "failure" : canonical.length ? "success" : "not_evaluated",
                    encoding: clone(acquired.encoding || null), exclusions, diagnostics, formalEligible,
                    formalCanonicalSet: formalEligible ? canonical : [] })); }
            return freeze({ shadow: true, readOnly: true, storageWrite: false, uiConnected: false,
                timeTravelConnected: false, schedulerConnected: false, notificationConnected: false,
                overallV2Connected: false, generatedAt: new Date().toISOString(), sources: sourceResults }); }
        return Object.freeze({ run });
    }
    return Object.freeze({ create });
});
