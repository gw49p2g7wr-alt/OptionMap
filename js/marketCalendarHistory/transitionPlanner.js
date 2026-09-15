(function (root, factory) {
    const contract = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./historyContract.js") : root?.OptionMapMarketCalendarHistoryContract;
    const api = factory(contract);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarTransitionPlanner = api;
})(typeof window !== "undefined" ? window : globalThis, function (contract) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const frozen = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(frozen); return Object.freeze(value); };
    const emptySnapshot = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
    function originFor(active, event, parserChanged) {
        if (!active) return "initial_observation";
        if (parserChanged) return "parser_interpretation_change";
        return "authority_semantic_change";
    }
    function evidenceFor(event, run) {
        return { eventKey: event.eventKey, revisionKey: event.revisionKey, sourceId: run.sourceId,
            runId: run.runId, acceptedAt: run.acceptedAt, acquisitionEvidenceKey: event.acquisitionEvidenceKey,
            acquisitionEvidenceHash: event.acquisitionEvidenceHash, fetchedAt: event.acquisitionEvidence.fetchedAt,
            acquisitionEvidence: clone(event.acquisitionEvidence) };
    }
    function planTransition({ snapshot = emptySnapshot(), run, canonicalSet = [], coverage = null,
        parserChanged = false } = {}) {
        const cursor = (snapshot.cursors || []).find(item => item.sourceId === run?.sourceId),
            validation = contract.validateAcceptedRun(run, { previousAcceptedAt: cursor?.acceptedAt || null });
        if (!validation.valid) return frozen({ ok: false, outcome: "run_rejected", errors: validation.errors });
        const priorRun = (snapshot.runs || []).find(item => item.sourceId === run.sourceId && item.runId === run.runId);
        if (priorRun) return priorRun.acceptedAt === run.acceptedAt &&
            priorRun.semanticSetHash === run.semanticSetHash
            ? frozen({ ok: true, changed: false, outcome: "already_committed", plan: null })
            : frozen({ ok: false, outcome: "duplicate_run_conflict", errors: ["duplicate_run_conflict"] });
        if (!canonicalSet.length) return frozen({ ok: false, outcome: "empty_formal_set",
            errors: ["empty_formal_set"] });
        const entryByKey = new Map((snapshot.entries || []).map(item => [item.eventKey, item]));
        const revisionByKey = new Map((snapshot.revisions || []).map(item => [item.revisionKey, item]));
        const candidateKeys = new Set(), revisionKeys = new Set(), errors = [];
        for (const event of canonicalSet) {
            if (candidateKeys.has(event.eventKey)) errors.push("candidate_event_key_duplicate");
            if (revisionKeys.has(event.revisionKey)) errors.push("candidate_revision_duplicate");
            candidateKeys.add(event.eventKey); revisionKeys.add(event.revisionKey);
            const entry = entryByKey.get(event.eventKey);
            if (entry && entry.sourceId !== run.sourceId) errors.push("cross_source_identity_collision");
        }
        if (errors.length) return frozen({ ok: false, outcome: "integrity_rejected", errors });
        const plan = { sourceId: run.sourceId, runId: run.runId, acceptedAt: run.acceptedAt,
            appendRuns: [{ ...clone(run), contractVersion: contract.CONTRACT_VERSION }],
            appendEntries: [], updateEntries: [], closeRevisions: [], appendRevisions: [],
            appendEvidence: [], appendObservations: [], updateCursors: [{ sourceId: run.sourceId,
                acceptedAt: run.acceptedAt, runId: run.runId }] };
        for (const event of canonicalSet) {
            const entry = entryByKey.get(event.eventKey), active = entry?.activeRevisionKey
                ? revisionByKey.get(entry.activeRevisionKey) : null;
            if (entry?.activeRevisionKey && !active) errors.push("active_revision_missing");
            const unchanged = active?.revisionKey === event.revisionKey &&
                active?.canonicalContentHash === event.canonicalContentHash;
            if (active && !unchanged) plan.closeRevisions.push({ revisionKey: active.revisionKey,
                expectedValidTo: null, validTo: run.acceptedAt });
            if (!unchanged) {
                const revision = { ...clone(event), validFrom: run.acceptedAt, validTo: null,
                    revisionOrigin: originFor(active, event, parserChanged) };
                plan.appendRevisions.push(revision);
                if (!entry) plan.appendEntries.push({ eventKey: event.eventKey, sourceId: run.sourceId,
                    activeRevisionKey: event.revisionKey, firstKnownAt: run.acceptedAt,
                    lastObservedAt: run.acceptedAt });
                else plan.updateEntries.push({ eventKey: event.eventKey,
                    expectedActiveRevisionKey: active?.revisionKey || null,
                    activeRevisionKey: event.revisionKey, lastObservedAt: run.acceptedAt });
            } else plan.updateEntries.push({ eventKey: event.eventKey,
                expectedActiveRevisionKey: active.revisionKey, activeRevisionKey: active.revisionKey,
                lastObservedAt: run.acceptedAt });
            plan.appendEvidence.push(evidenceFor(event, run));
            plan.appendObservations.push({ eventKey: event.eventKey, sourceId: run.sourceId,
                runId: run.runId, acceptedAt: run.acceptedAt, state: "observed", coverageConfirmed: true });
        }
        for (const entry of snapshot.entries || []) {
            if (entry.sourceId !== run.sourceId || candidateKeys.has(entry.eventKey)) continue;
            const confirmed = coverage?.confirmed === true && Array.isArray(coverage.eventKeys) &&
                coverage.eventKeys.includes(entry.eventKey);
            plan.appendObservations.push({ eventKey: entry.eventKey, sourceId: run.sourceId,
                runId: run.runId, acceptedAt: run.acceptedAt,
                state: confirmed ? "unobserved" : "not_evaluated", coverageConfirmed: confirmed });
        }
        if (errors.length) return frozen({ ok: false, outcome: "integrity_rejected", errors });
        return frozen({ ok: true, changed: true, outcome: "planned", plan });
    }
    return Object.freeze({ emptySnapshot, planTransition });
});
