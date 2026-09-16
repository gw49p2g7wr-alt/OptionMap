(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") :
        root?.OptionMapMarketEventCanonicalizer;
    const api = factory(canonicalizer);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarPlanCanonicalizer = api;
})(typeof window !== "undefined" ? window : globalThis, function (canonicalizer) {
    "use strict";
    const ARRAY_KEYS = Object.freeze(["appendRuns", "appendEntries", "updateEntries", "closeRevisions",
        "appendRevisions", "appendEvidence", "appendObservations", "updateCursors"]);
    function normalize(value) {
        if (value instanceof Date) return value.toISOString();
        if (Array.isArray(value)) return value.map(item => item === undefined ? null : normalize(item));
        if (!value || typeof value !== "object") return value;
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] !== undefined) result[key] = normalize(value[key]);
        }
        return result;
    }
    const text = value => value == null ? "" : String(value);
    const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const compare = fields => (left, right) => {
        for (const field of fields) { const difference = lexical(text(left?.[field]), text(right?.[field]));
            if (difference) return difference; }
        return lexical(JSON.stringify(left), JSON.stringify(right));
    };
    const COMPARATORS = Object.freeze({
        appendRuns: compare(["sourceId", "runId", "acceptedAt"]),
        appendEntries: compare(["eventKey"]), updateEntries: compare(["eventKey"]),
        closeRevisions: compare(["revisionKey"]), appendRevisions: compare(["revisionKey"]),
        appendEvidence: compare(["eventKey", "revisionKey", "acquisitionEvidenceKey", "runId"]),
        appendObservations: compare(["eventKey", "state", "runId"]),
        updateCursors: compare(["sourceId", "runId", "acceptedAt"])
    });
    function canonicalizePlan(plan) {
        const result = normalize(plan || {});
        for (const key of ARRAY_KEYS) result[key] = [...(result[key] || [])].sort(COMPARATORS[key]);
        for (const run of result.appendRuns) if (Array.isArray(run.fetchedAt)) run.fetchedAt.sort();
        return result;
    }
    const canonicalPayload = plan => JSON.stringify(canonicalizePlan(plan));
    const planHash = plan => canonicalizer.sha256(canonicalizePlan(plan));
    return Object.freeze({ ARRAY_KEYS, canonicalizePlan, canonicalPayload, planHash });
});
