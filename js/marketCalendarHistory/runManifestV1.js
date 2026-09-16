(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const contract = commonJs ? require("./historyContract.js") : root?.OptionMapMarketCalendarHistoryContract;
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") :
        root?.OptionMapMarketEventCanonicalizer;
    const api = factory(contract, canonicalizer);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarRunManifestV1 = api;
})(typeof window !== "undefined" ? window : globalThis, function (contract, canonicalizer) {
    "use strict";
    const CONTRACT_VERSION = 1, STATES = Object.freeze(["observed", "unobserved", "not_evaluated"]);
    const nonempty = value => typeof value === "string" && value.length > 0;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const frozen = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(frozen); return Object.freeze(value); };
    const compareItems = (left, right) => left.eventKey.localeCompare(right.eventKey) ||
        left.state.localeCompare(right.state) || (left.revisionKey || "").localeCompare(right.revisionKey || "");
    const canonicalItems = items => (items || []).map(item => ({ eventKey: item.eventKey,
        revisionKey: item.revisionKey == null ? null : item.revisionKey, state: item.state }))
        .sort(compareItems);
    const semanticBody = value => ({ contractVersion: value.contractVersion, runKey: value.runKey,
        sourceId: value.sourceId, runId: value.runId, acceptedAt: value.acceptedAt,
        semanticSetHash: value.semanticSetHash, coverage: clone(value.coverage),
        items: canonicalItems(value.items), itemCount: value.itemCount });
    const semanticSetHash = items => canonicalizer.sha256(canonicalItems(items)
        .filter(item => item.state === "observed").map(item => item.revisionKey).sort());
    const manifestHash = value => canonicalizer.sha256(semanticBody(value));
    async function create({ run, coverage, items } = {}) {
        const normalized = canonicalItems(items), value = { contractVersion: CONTRACT_VERSION,
            runKey: run?.runKey || `${run?.sourceId}|${run?.runId}`, sourceId: run?.sourceId,
            runId: run?.runId, acceptedAt: run?.acceptedAt, semanticSetHash: run?.semanticSetHash,
            coverage: clone(coverage), items: normalized, itemCount: normalized.length };
        value.manifestHash = await manifestHash(value);
        const validation = await validate(value, { run });
        return validation.valid ? frozen({ ok: true, manifest: value, errors: [] }) :
            frozen({ ok: false, manifest: null, errors: validation.errors });
    }
    async function validate(value, { run = null } = {}) {
        const errors = [];
        if (!value || typeof value !== "object") return frozen({ valid: false,
            errors: ["manifest_missing"] });
        if (value.contractVersion !== CONTRACT_VERSION) errors.push("contract_version_invalid");
        for (const field of ["runKey", "sourceId", "runId"])
            if (!nonempty(value[field])) errors.push(`${field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}_invalid`);
        if (!contract.timestamp(value.acceptedAt)) errors.push("accepted_at_invalid");
        if (!contract.hash(value.semanticSetHash)) errors.push("semantic_set_hash_invalid");
        if (!value.coverage || !["complete", "partial", "failed"].includes(value.coverage.status) ||
            value.coverage.scopeVersion !== 1) errors.push("coverage_invalid");
        if (!Array.isArray(value.items)) errors.push("items_invalid");
        const items = Array.isArray(value.items) ? value.items : [], seen = new Set();
        for (const item of items) {
            if (!nonempty(item?.eventKey)) errors.push("item_event_key_invalid");
            if (!STATES.includes(item?.state)) errors.push("item_state_invalid");
            if (item?.state === "observed" && !nonempty(item?.revisionKey)) errors.push("observed_revision_missing");
            if (item?.state !== "observed" && item?.revisionKey !== null) errors.push("non_observed_revision_present");
            if (seen.has(item?.eventKey)) errors.push("duplicate_item");
            seen.add(item?.eventKey);
        }
        if (JSON.stringify(items) !== JSON.stringify(canonicalItems(items))) errors.push("items_not_canonical");
        if (value.itemCount !== items.length) errors.push("item_count_mismatch");
        if (!contract.hash(value.manifestHash)) errors.push("manifest_hash_invalid");
        else if (await manifestHash(value) !== value.manifestHash) errors.push("manifest_hash_mismatch");
        if (contract.hash(value.semanticSetHash) && await semanticSetHash(items) !== value.semanticSetHash)
            errors.push("semantic_set_hash_mismatch");
        if (run) {
            const accepted = contract.validateAcceptedRun(run);
            if (!accepted.valid) errors.push("source_run_invalid");
            if (value.runKey !== (run.runKey || `${run.sourceId}|${run.runId}`)) errors.push("run_key_mismatch");
            if (value.sourceId !== run.sourceId) errors.push("source_id_mismatch");
            if (value.runId !== run.runId) errors.push("run_id_mismatch");
            if (value.acceptedAt !== run.acceptedAt) errors.push("accepted_at_mismatch");
            if (value.semanticSetHash !== run.semanticSetHash) errors.push("source_run_semantic_set_hash_mismatch");
        }
        return frozen({ valid: errors.length === 0, errors });
    }
    return Object.freeze({ CONTRACT_VERSION, STATES, compareItems, canonicalItems, semanticBody,
        semanticSetHash, manifestHash, create, validate });
});
