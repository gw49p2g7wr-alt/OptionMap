(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const source = common ? require("./sourceContract.js") : root?.OptionMapJpxDerivativesOpenInterestSourceContract;
    const identity = common ? require("./identity.js") : root?.OptionMapJpxDerivativesOpenInterestIdentity;
    const api = factory(source, identity); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestHistoryContract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (source, identity) {
    "use strict";
    const clone = source.clone;
    const stores = Object.freeze({ runs: "jpxDerivativeOpenInterestSourceRuns",
        days: "jpxDerivativeOpenInterestSourceDays", revisions: "jpxDerivativeOpenInterestCanonicalRevisions",
        evidence: "jpxDerivativeOpenInterestEvidence", observations: "jpxDerivativeOpenInterestObservations",
        cursors: "jpxDerivativeOpenInterestSourceCursors" });
    function snapshotEmpty() { return { runs: [], days: [], revisions: [], evidence: [], observations: [], cursors: [] }; }
    function validateSnapshot(snapshot) {
        const errors = []; for (const field of Object.keys(stores)) if (!Array.isArray(snapshot?.[field])) errors.push(`${field}_invalid`);
        if (errors.length) return errors;
        const revisionKeys = new Set(snapshot.revisions.map(item => item.revisionKey));
        for (const day of snapshot.days) {
            const active = snapshot.revisions.filter(item => item.logicalKey === day.logicalKey && item.closedAt === null);
            if (active.length !== 1 || active[0].revisionKey !== day.activeRevisionKey) errors.push(`active_revision_invalid:${day.logicalKey}`);
        }
        for (const observation of snapshot.observations) if (!revisionKeys.has(observation.revisionKey)) errors.push(`orphan_observation:${observation.observationKey}`);
        return errors;
    }
    async function makePlan(snapshot, candidate, { runId, acceptedAt }) {
        const identities = await identity.derive(candidate.canonical, candidate.evidence);
        const errors = validateSnapshot(snapshot); if (errors.length) throw new Error(errors[0]);
        if (!runId || !acceptedAt || Number.isNaN(new Date(acceptedAt).getTime())) throw new TypeError("run_identity_invalid");
        const existingDay = snapshot.days.find(item => item.logicalKey === identities.logicalKey) || null;
        const active = existingDay ? snapshot.revisions.find(item => item.revisionKey === existingDay.activeRevisionKey) : null;
        const outcome = !existingDay ? "initial" : active?.semanticIdentity === identities.semanticIdentity ?
            "semantic_unchanged" : "semantic_revision";
        const evidenceKey = `${identities.revisionKey}|${acceptedAt}|${identities.acquisitionEvidenceIdentity}`;
        const observationKey = `${source.SOURCE_ID}|${runId}|${identities.logicalKey}`;
        const plan = { contractVersion: "jpx-open-interest-storage-plan-v1", sourceId: source.SOURCE_ID,
            runId, acceptedAt, outcome, identities: clone(identities), expectedActiveRevisionKey: active?.revisionKey || null,
            appendDay: outcome === "initial" ? { logicalKey: identities.logicalKey,
                sourceId: source.SOURCE_ID, sourceDate: candidate.canonical.sourceDate,
                activeRevisionKey: identities.revisionKey, firstObservedAt: acceptedAt, lastObservedAt: acceptedAt } : null,
            updateDay: outcome !== "initial" ? { logicalKey: identities.logicalKey,
                expectedActiveRevisionKey: active.revisionKey,
                activeRevisionKey: outcome === "semantic_revision" ? identities.revisionKey : active.revisionKey,
                lastObservedAt: acceptedAt } : null,
            closeRevision: outcome === "semantic_revision" ? { revisionKey: active.revisionKey,
                expectedClosedAt: null, closedAt: acceptedAt } : null,
            appendRevision: outcome === "semantic_unchanged" ? null : { revisionKey: identities.revisionKey,
                logicalKey: identities.logicalKey, sourceId: source.SOURCE_ID, sourceDate: candidate.canonical.sourceDate,
                semanticIdentity: identities.semanticIdentity, acceptedAt, closedAt: null,
                canonical: clone(candidate.canonical) },
            appendEvidence: { evidenceKey, runId, revisionKey: outcome === "semantic_unchanged" ?
                active.revisionKey : identities.revisionKey, acquisitionEvidenceIdentity:
                identities.acquisitionEvidenceIdentity, acceptedAt, evidence: clone(candidate.evidence) },
            appendObservation: { observationKey, runId, logicalKey: identities.logicalKey,
                revisionKey: outcome === "semantic_unchanged" ? active.revisionKey : identities.revisionKey,
                evidenceKey, state: outcome, acceptedAt },
            appendRun: { runId, sourceId: source.SOURCE_ID, acceptedAt, sourceDate: candidate.canonical.sourceDate,
                outcome, semanticIdentity: identities.semanticIdentity,
                acquisitionEvidenceIdentity: identities.acquisitionEvidenceIdentity },
            updateCursor: { sourceId: source.SOURCE_ID, sourceDate: candidate.canonical.sourceDate,
                logicalKey: identities.logicalKey, activeRevisionKey: outcome === "semantic_unchanged" ?
                    active.revisionKey : identities.revisionKey, runId, acceptedAt } };
        plan.storageMutationIdentity = await identity.storageMutationIdentity(plan); return plan;
    }
    function simulate(snapshot, plan) { const next = clone(snapshot), find = (field, key, value) =>
        next[field].find(item => item[key] === value);
        if (plan.appendDay) next.days.push(clone(plan.appendDay));
        if (plan.updateDay) { const day = find("days", "logicalKey", plan.updateDay.logicalKey);
            if (!day || day.activeRevisionKey !== plan.updateDay.expectedActiveRevisionKey) throw new Error("day_precondition_failed");
            day.activeRevisionKey = plan.updateDay.activeRevisionKey; day.lastObservedAt = plan.updateDay.lastObservedAt; }
        if (plan.closeRevision) { const revision = find("revisions", "revisionKey", plan.closeRevision.revisionKey);
            if (!revision || revision.closedAt !== plan.closeRevision.expectedClosedAt) throw new Error("revision_precondition_failed");
            revision.closedAt = plan.closeRevision.closedAt; }
        if (plan.appendRevision) next.revisions.push(clone(plan.appendRevision));
        next.evidence.push(clone(plan.appendEvidence)); next.observations.push(clone(plan.appendObservation));
        next.runs.push(clone(plan.appendRun));
        const cursor = find("cursors", "sourceId", source.SOURCE_ID);
        if (cursor) Object.assign(cursor, clone(plan.updateCursor)); else next.cursors.push(clone(plan.updateCursor));
        const errors = validateSnapshot(next); if (errors.length) throw new Error(errors[0]); return next;
    }
    return Object.freeze({ stores, snapshotEmpty, validateSnapshot, makePlan, simulate });
});
