(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarHistoryContract = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const CONTRACT_VERSION = 1;
    const OBSERVATION_STATES = Object.freeze(["observed", "unobserved", "outside_coverage",
        "source_incomplete", "source_failed", "not_evaluated"]);
    const REVISION_ORIGINS = Object.freeze(["initial_observation", "authority_semantic_change",
        "parser_interpretation_change", "canonical_schema_migration", "manual_repair"]);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value));
    const hash = value => /^[0-9a-f]{64}$/.test(value || "");
    const nonempty = value => typeof value === "string" && value.length > 0;
    function validateAcceptedRun(value, { previousAcceptedAt = null } = {}) {
        const errors = [];
        if (!nonempty(value?.sourceId)) errors.push("source_id_invalid");
        if (!nonempty(value?.runId)) errors.push("run_id_invalid");
        if (!timestamp(value?.acceptedAt)) errors.push("accepted_at_invalid");
        if (value?.status !== "accepted") errors.push("run_not_accepted");
        if (!Array.isArray(value?.fetchedAt) || !value.fetchedAt.length ||
            value.fetchedAt.some(item => !timestamp(item))) errors.push("fetched_at_invalid");
        if (timestamp(value?.acceptedAt) && Array.isArray(value?.fetchedAt) &&
            value.fetchedAt.some(item => item > value.acceptedAt)) errors.push("accepted_before_fetch");
        if (previousAcceptedAt !== null && (!timestamp(previousAcceptedAt) ||
            timestamp(value?.acceptedAt) && value.acceptedAt <= previousAcceptedAt))
            errors.push("accepted_at_not_monotonic");
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function validateInterval(value) {
        const errors = [];
        if (!timestamp(value?.validFrom)) errors.push("valid_from_invalid");
        if (value?.validTo !== null && !timestamp(value?.validTo)) errors.push("valid_to_invalid");
        if (timestamp(value?.validFrom) && timestamp(value?.validTo) && value.validFrom >= value.validTo)
            errors.push("interval_not_positive");
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function validateObservation(value) {
        const errors = [];
        if (!nonempty(value?.eventKey)) errors.push("event_key_invalid");
        if (!nonempty(value?.sourceId)) errors.push("source_id_invalid");
        if (!nonempty(value?.runId)) errors.push("run_id_invalid");
        if (!timestamp(value?.acceptedAt)) errors.push("accepted_at_invalid");
        if (!OBSERVATION_STATES.includes(value?.state)) errors.push("observation_state_invalid");
        if (value?.state === "unobserved" && value?.coverageConfirmed !== true)
            errors.push("unobserved_without_coverage");
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function validateRevisionShape(value) {
        const interval = validateInterval(value), errors = [...interval.errors];
        if (!nonempty(value?.eventKey)) errors.push("event_key_invalid");
        if (!nonempty(value?.revisionKey)) errors.push("revision_key_invalid");
        if (!hash(value?.canonicalContentHash)) errors.push("canonical_hash_invalid");
        if (!REVISION_ORIGINS.includes(value?.revisionOrigin)) errors.push("revision_origin_invalid");
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function validateEvidenceShape(value) {
        const errors = [];
        for (const field of ["eventKey", "revisionKey", "sourceId", "runId", "acquisitionEvidenceKey"])
            if (!nonempty(value?.[field])) errors.push(`${field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}_invalid`);
        if (!hash(value?.acquisitionEvidenceHash)) errors.push("acquisition_hash_invalid");
        if (!timestamp(value?.fetchedAt)) errors.push("fetched_at_invalid");
        if (!timestamp(value?.acceptedAt)) errors.push("accepted_at_invalid");
        if (timestamp(value?.fetchedAt) && timestamp(value?.acceptedAt) && value.fetchedAt > value.acceptedAt)
            errors.push("accepted_before_fetch");
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    return Object.freeze({ CONTRACT_VERSION, OBSERVATION_STATES, REVISION_ORIGINS, timestamp, hash,
        validateAcceptedRun, validateInterval, validateObservation, validateRevisionShape,
        validateEvidenceShape });
});
