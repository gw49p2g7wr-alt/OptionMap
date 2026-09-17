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
    const CONTRACT_VERSION = 1, CONTRACT_VERSION_V2 = 2;
    const STORE_COUNT_FIELDS = Object.freeze(["marketCalendarSourceRuns", "marketCalendarEventEntries",
        "marketCalendarSemanticRevisions", "marketCalendarAcquisitionEvidence",
        "marketCalendarEventObservations", "marketCalendarSourceCursors"]);
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
    const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    const cursorFields = Object.freeze(["sourceId", "runId", "acceptedAt", "runKey"]);
    function canonicalizeProductionPrecondition(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const result = { productionSnapshotFingerprint: value.productionSnapshotFingerprint,
            storeCounts: {}, schemaFingerprint: value.schemaFingerprint,
            sourceCursor: value.sourceCursor === null ? null : value.sourceCursor === undefined ? undefined :
                Object.fromEntries(cursorFields.map(field => [field, value.sourceCursor[field]])) };
        for (const field of STORE_COUNT_FIELDS) result.storeCounts[field] = value.storeCounts?.[field];
        return result;
    }
    function validateProductionPrecondition(value) { const errors = [], canonical =
        canonicalizeProductionPrecondition(value), exactKeys = (actual, expected) => actual &&
            Object.keys(actual).sort().join("|") === [...expected].sort().join("|");
        if (!canonical || !exactKeys(value, ["productionSnapshotFingerprint", "storeCounts",
            "schemaFingerprint", "sourceCursor"])) return ["production_precondition_shape_invalid"];
        if (!hash(canonical.productionSnapshotFingerprint)) errors.push("production_snapshot_fingerprint_invalid");
        if (!hash(canonical.schemaFingerprint)) errors.push("schema_fingerprint_invalid");
        if (!exactKeys(value.storeCounts, STORE_COUNT_FIELDS)) errors.push("store_counts_shape_invalid");
        for (const field of STORE_COUNT_FIELDS) if (!Number.isSafeInteger(canonical.storeCounts[field]) ||
            canonical.storeCounts[field] < 0) errors.push(`${field}_count_invalid`);
        if (!("sourceCursor" in value)) errors.push("source_cursor_missing");
        else if (canonical.sourceCursor !== null) { if (!exactKeys(value.sourceCursor, cursorFields))
            errors.push("source_cursor_shape_invalid"); for (const field of cursorFields)
            if (typeof canonical.sourceCursor[field] !== "string" || !canonical.sourceCursor[field])
                errors.push(`source_cursor_${field}_invalid`); }
        return errors;
    }
    const productionPreconditionIdentity = async value => { const errors = validateProductionPrecondition(value);
        if (errors.length) throw new TypeError(errors[0]); return canonicalizer.sha256({
            contractVersion: CONTRACT_VERSION_V2, productionPrecondition: canonicalizeProductionPrecondition(value) }); };
    const productionSnapshotFingerprint = snapshot => canonicalizer.sha256(snapshot);
    const artifactDigest = artifact => canonicalizer.sha256(artifact);
    async function identitiesV2(plan, productionPrecondition) { const canonicalPlan = plans.canonicalizePlan(plan),
        base = await identities(canonicalPlan), productionPreconditionIdentityHash =
            await productionPreconditionIdentity(productionPrecondition), authorizationIdentityHash =
            await canonicalizer.sha256({ contractVersion: CONTRACT_VERSION_V2,
                sourceId: canonicalPlan.sourceId, acceptedAt: canonicalPlan.acceptedAt,
                runId: canonicalPlan.runId, semanticPlanHash: base.semanticPlanHash,
                acquisitionEvidenceIdentityHash: base.acquisitionEvidenceIdentityHash,
                storageMutationHash: base.storageMutationHash, productionPreconditionIdentityHash });
        return freeze({ semanticPlanHash: base.semanticPlanHash,
            acquisitionEvidenceIdentityHash: base.acquisitionEvidenceIdentityHash,
            storageMutationHash: base.storageMutationHash, productionPreconditionIdentityHash,
            authorizationIdentityHash }); }
    async function create(plan) { const canonicalPlan = plans.canonicalizePlan(plan), identity =
        await identities(canonicalPlan); return freeze({ contractVersion: CONTRACT_VERSION,
            sourceId: canonicalPlan.sourceId, acceptedAt: canonicalPlan.acceptedAt,
            runId: canonicalPlan.runId, canonicalPayload: plans.canonicalPayload(canonicalPlan),
            ...identity }); }
    async function createV2(plan, productionPrecondition) { const canonicalPlan = plans.canonicalizePlan(plan),
        canonicalPrecondition = canonicalizeProductionPrecondition(productionPrecondition);
        if (validateProductionPrecondition(productionPrecondition).length) throw new TypeError(
            validateProductionPrecondition(productionPrecondition)[0]);
        const identity = await identitiesV2(canonicalPlan, canonicalPrecondition);
        return freeze({ contractVersion: CONTRACT_VERSION_V2, sourceId: canonicalPlan.sourceId,
            acceptedAt: canonicalPlan.acceptedAt, runId: canonicalPlan.runId,
            canonicalPayload: plans.canonicalPayload(canonicalPlan),
            productionPrecondition: canonicalPrecondition, ...identity }); }
    async function verify(artifact, expected = {}) { const errors = [], version = artifact?.contractVersion;
        if (![CONTRACT_VERSION, CONTRACT_VERSION_V2].includes(version))
            errors.push("authorization_contract_version_invalid");
        let parsed = null;
        try { parsed = JSON.parse(artifact?.canonicalPayload); }
        catch (_error) { errors.push("canonical_payload_invalid"); }
        if (!parsed) return freeze({ ok: false, errors, plan: null, identities: null });
        const canonicalPlan = plans.canonicalizePlan(parsed), payload = plans.canonicalPayload(canonicalPlan);
        if (payload !== artifact.canonicalPayload) errors.push("canonical_payload_not_canonical");
        let identity = null, productionPrecondition = null;
        if (version === CONTRACT_VERSION_V2) { const preconditionErrors =
            validateProductionPrecondition(artifact.productionPrecondition);
            errors.push(...preconditionErrors); productionPrecondition =
                canonicalizeProductionPrecondition(artifact.productionPrecondition);
            if (!preconditionErrors.length) identity = await identitiesV2(canonicalPlan, productionPrecondition); }
        else if (version === CONTRACT_VERSION) identity = await identities(canonicalPlan);
        if (!identity) return freeze({ ok: false, errors, plan: null, identities: null,
            productionPrecondition: null });
        for (const field of ["sourceId", "acceptedAt", "runId"]) {
            if (artifact[field] !== canonicalPlan[field]) errors.push(`${field}_artifact_mismatch`);
            if (expected[field] !== undefined && expected[field] !== canonicalPlan[field])
                errors.push(`${field}_authorization_mismatch`); }
        const identityFields = ["semanticPlanHash", "acquisitionEvidenceIdentityHash", "storageMutationHash",
            ...(version === CONTRACT_VERSION_V2 ? ["productionPreconditionIdentityHash"] : []),
            "authorizationIdentityHash"];
        for (const field of identityFields) {
            if (artifact[field] !== identity[field]) errors.push(`${field}_artifact_mismatch`);
            if (expected[field] !== undefined && expected[field] !== identity[field])
                errors.push(`${field}_authorization_mismatch`); }
        if (expected.contractVersion !== undefined && expected.contractVersion !== version)
            errors.push("contract_version_authorization_mismatch");
        return freeze({ ok: errors.length === 0, errors, plan: errors.length ? null : clone(canonicalPlan),
            identities: identity, productionPrecondition: errors.length ? null : clone(productionPrecondition) }); }
    return Object.freeze({ CONTRACT_VERSION, CONTRACT_VERSION_V2, STORE_COUNT_FIELDS,
        semanticProjection, acquisitionProjection, canonicalizeProductionPrecondition,
        validateProductionPrecondition, productionPreconditionIdentity, identities, identitiesV2,
        productionSnapshotFingerprint, artifactDigest, create, createV2, verify });
});
