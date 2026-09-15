(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const planner = commonJs ? require("./transitionPlanner.js") : root?.OptionMapMarketCalendarTransitionPlanner;
    const integrity = commonJs ? require("./historyIntegrity.js") : root?.OptionMapMarketCalendarHistoryIntegrity;
    const api = factory(planner, integrity);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarInMemoryHistory = api;
})(typeof window !== "undefined" ? window : globalThis, function (planner, integrity) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const normalize = value => ({ entries: clone(value?.entries || []), revisions: clone(value?.revisions || []),
        evidence: clone(value?.evidence || []), observations: clone(value?.observations || []),
        runs: clone(value?.runs || []), cursors: clone(value?.cursors || []) });
    const replace = (list, key, value) => { const index = list.findIndex(item => item[key] === value[key]);
        if (index < 0) list.push(value); else list[index] = { ...list[index], ...value }; };
    async function applyPlan(snapshot, plan, options = {}) {
        const original = normalize(snapshot), next = normalize(snapshot);
        try {
            for (const update of plan.closeRevisions) { const revision = next.revisions.find(item =>
                item.revisionKey === update.revisionKey);
                if (!revision || revision.validTo !== update.expectedValidTo)
                    throw new Error("close_revision_precondition_failed");
                revision.validTo = update.validTo; }
            if (options.failAfter === "close") throw new Error("injected_failure_after_close");
            for (const revision of plan.appendRevisions) {
                if (next.revisions.some(item => item.revisionKey === revision.revisionKey))
                    throw new Error("revision_duplicate");
                next.revisions.push(clone(revision)); }
            for (const entry of plan.appendEntries) {
                if (next.entries.some(item => item.eventKey === entry.eventKey)) throw new Error("entry_duplicate");
                next.entries.push(clone(entry)); }
            for (const update of plan.updateEntries) { const entry = next.entries.find(item =>
                item.eventKey === update.eventKey);
                if (!entry || entry.activeRevisionKey !== update.expectedActiveRevisionKey)
                    throw new Error("entry_precondition_failed");
                Object.assign(entry, clone(update)); delete entry.expectedActiveRevisionKey; }
            if (options.failAfter === "revisions") throw new Error("injected_failure_after_revisions");
            for (const item of plan.appendEvidence) {
                if (!next.evidence.some(value => value.evidenceLinkKey === item.evidenceLinkKey))
                    next.evidence.push(clone(item)); }
            next.observations.push(...clone(plan.appendObservations));
            next.runs.push(...clone(plan.appendRuns));
            for (const cursor of plan.updateCursors) replace(next.cursors, "sourceId", clone(cursor));
            if (options.failAfter === "evidence") throw new Error("injected_failure_after_evidence");
            const audited = await integrity.audit(next);
            if (!audited.valid) throw new Error(`post_apply_integrity_failed:${audited.errors.join(",")}`);
            return { committed: true, outcome: "committed", snapshot: next, integrity: audited };
        } catch (error) { return { committed: false, outcome: "rolled_back", error: error.message,
            snapshot: original }; }
    }
    async function accept(snapshot, input, options = {}) {
        const planned = planner.planTransition({ snapshot: normalize(snapshot), ...input });
        if (!planned.ok || !planned.changed) return { committed: false, outcome: planned.outcome,
            errors: planned.errors || [], snapshot: normalize(snapshot) };
        return applyPlan(snapshot, planned.plan, options);
    }
    return Object.freeze({ normalize, applyPlan, accept });
});
