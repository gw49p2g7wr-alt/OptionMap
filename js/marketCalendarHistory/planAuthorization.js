(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") :
        root?.OptionMapMarketEventCanonicalizer;
    const plans = commonJs ? require("./planCanonicalizer.js") :
        root?.OptionMapMarketCalendarPlanCanonicalizer;
    const api = factory(canonicalizer, plans);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarPlanAuthorization = api;
})(typeof window !== "undefined" ? window : globalThis, function (canonicalizer, plans) {
    "use strict";
    const CONTRACT_VERSION = 1;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); };
    const revisionSemantic = value => ({ revisionKey: value.revisionKey, eventKey: value.eventKey,
        schemaVersion: value.schemaVersion, logical: value.logical, schedule: value.schedule,
        lifecycleStatus: value.lifecycleStatus, title: value.title, change: value.change,
        canonicalContentHash: value.canonicalContentHash, validFrom: value.validFrom,
        validTo: value.validTo, revisionOrigin: value.revisionOrigin });
    function semanticProjection(plan) { return { sourceId: plan.sourceId, acceptedAt: plan.acceptedAt,
        appendEntries: plan.appendEntries, updateEntries: plan.updateEntries,
        closeRevisions: plan.closeRevisions,
        appendRevisions: plan.appendRevisions.map(revisionSemantic) }; }
    function acquisitionProjection(plan) { return { sourceId: plan.sourceId, runId: plan.runId,
        acceptedAt: plan.acceptedAt, appendRuns: plan.appendRuns,
        appendEvidence: plan.appendEvidence, appendObservations: plan.appendObservations,
        updateCursors: plan.updateCursors }; }
    async function identities(plan) { const canonicalPlan = plans.canonicalizePlan(plan),
        semanticPlanHash = await canonicalizer.sha256(semanticProjection(canonicalPlan)),
        acquisitionEvidenceIdentityHash = await canonicalizer.sha256(acquisitionProjection(canonicalPlan)),
        storageMutationHash = await plans.planHash(canonicalPlan), authorizationIdentityHash =
            await canonicalizer.sha256({ contractVersion: CONTRACT_VERSION,
                sourceId: canonicalPlan.sourceId, acceptedAt: canonicalPlan.acceptedAt,
                runId: canonicalPlan.runId, semanticPlanHash, acquisitionEvidenceIdentityHash,
                storageMutationHash });
        return freeze({ semanticPlanHash, acquisitionEvidenceIdentityHash,
            storageMutationHash, authorizationIdentityHash }); }
    async function create(plan) { const canonicalPlan = plans.canonicalizePlan(plan), identity =
        await identities(canonicalPlan); return freeze({ contractVersion: CONTRACT_VERSION,
            sourceId: canonicalPlan.sourceId, acceptedAt: canonicalPlan.acceptedAt,
            runId: canonicalPlan.runId, canonicalPayload: plans.canonicalPayload(canonicalPlan),
            ...identity }); }
    async function verify(artifact, expected = {}) { const errors = [];
        if (artifact?.contractVersion !== CONTRACT_VERSION) errors.push("authorization_contract_version_invalid");
        let parsed = null;
        try { parsed = JSON.parse(artifact?.canonicalPayload); }
        catch (_error) { errors.push("canonical_payload_invalid"); }
        if (!parsed) return freeze({ ok: false, errors, plan: null, identities: null });
        const canonicalPlan = plans.canonicalizePlan(parsed), payload = plans.canonicalPayload(canonicalPlan);
        if (payload !== artifact.canonicalPayload) errors.push("canonical_payload_not_canonical");
        const identity = await identities(canonicalPlan);
        for (const field of ["sourceId", "acceptedAt", "runId"]) {
            if (artifact[field] !== canonicalPlan[field]) errors.push(`${field}_artifact_mismatch`);
            if (expected[field] !== undefined && expected[field] !== canonicalPlan[field])
                errors.push(`${field}_authorization_mismatch`); }
        for (const field of ["semanticPlanHash", "acquisitionEvidenceIdentityHash",
            "storageMutationHash", "authorizationIdentityHash"]) {
            if (artifact[field] !== identity[field]) errors.push(`${field}_artifact_mismatch`);
            if (expected[field] !== undefined && expected[field] !== identity[field])
                errors.push(`${field}_authorization_mismatch`); }
        return freeze({ ok: errors.length === 0, errors, plan: errors.length ? null : clone(canonicalPlan),
            identities: identity }); }
    return Object.freeze({ CONTRACT_VERSION, semanticProjection, acquisitionProjection,
        identities, create, verify });
});
