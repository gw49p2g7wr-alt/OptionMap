(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const api = factory(qriApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsDisplaySourceState = api;
})(typeof window !== "undefined" ? window : globalThis, function (qriApi) {
    "use strict";

    const SOURCE_STATE_VERSION = 1;
    const PENDING_STATUSES = new Set(["pending", "loading", "not_started",
        "not_confirmed", "unknown"]);

    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function validCanonical(canonical) {
        return qriApi?.validateCanonical?.(canonical,
            { allowUnresolvedContracts: true }) === true;
    }

    function publishedCounts(canonical) {
        const records = Array.isArray(canonical?.records) ? canonical.records : [];
        return { call: records.filter(record => record.optionType === "call" &&
            record.published === true).length,
        put: records.filter(record => record.optionType === "put" &&
            record.published === true).length };
    }

    function fullyAvailable(canonical) {
        const counts = publishedCounts(canonical);
        return validCanonical(canonical) && canonical.openInterestStatus === "available" &&
            counts.call > 0 && counts.put > 0;
    }

    function canonicalPositions(canonical) {
        return Array.isArray(canonical?.records) ? canonical.records.map(record => ({
            contract: record.contract, optionType: record.optionType, strike: record.strike,
            published: record.published, value: record.value
        })) : [];
    }

    function validLegacy(legacy) {
        return legacy?.available === true && legacy.valid !== false &&
            Array.isArray(legacy.positions) && legacy.positions.length > 0;
    }

    function analysisPolicy(sourceKind, calculationEligible) {
        if (sourceKind === "live") return { allowFormalAnalysis: true,
            allowLegacyAnalysis: false, calculationSourcePolicy: "existing_live_policy",
            reason: null };
        if (sourceKind === "legacy") return { allowFormalAnalysis: false,
            allowLegacyAnalysis: true, calculationSourcePolicy: "existing_legacy_policy",
            reason: "legacy_display_policy_preserved" };
        return { allowFormalAnalysis: false, allowLegacyAnalysis: false,
            calculationSourcePolicy: "none",
            reason: sourceKind === "saved" ? "saved_display_only" :
                calculationEligible === false ? "source_unavailable" : "no_display_source" };
    }

    function output(values, facts) {
        const canonical = values.canonical ? clone(values.canonical) : null;
        const positions = clone(values.positions || []);
        const calculationEligible = values.calculationEligible ?? "undetermined";
        const policy = analysisPolicy(values.sourceKind, calculationEligible);
        return deepFreeze({ sourceStateVersion: SOURCE_STATE_VERSION,
            available: values.available === true, sourceKind: values.sourceKind,
            state: values.state, reason: values.reason ?? null, canonical, positions,
            contract: values.contract ?? null,
            freshness: values.freshness ? clone(values.freshness) : null,
            displayEligible: values.displayEligible === true, calculationEligible,
            analysisPolicy: policy,
            metadata: { contract: values.contract ?? null,
                tradingDate: canonical?.tradingDate ?? null,
                pageUpdatedAt: canonical?.pageUpdatedAt ?? null,
                fetchedAt: values.fetchedAt ?? null,
                sourceDate: values.sourceDate ?? null,
                sourceDateKind: values.sourceDateKind ?? null,
                origin: values.origin ?? null },
            diagnostics: { ...facts,
                sourceSelectionReason: values.selectionReason,
                savedContractMatched: values.savedContractMatched ?? null,
                analysisSuppressed: !policy.allowFormalAnalysis && !policy.allowLegacyAnalysis,
                legacyConsidered: values.legacyConsidered === true,
                legacyRejectedReason: values.legacyRejectedReason ?? null }
        });
    }

    function buildQriOptionsDisplaySourceState(input = {}) {
        const mode = text(input.mode);
        const activeContract = text(input.activeContract);
        const selectedContract = text(input.selectedContract);
        const liveStatus = text(input.liveStatus) || "unknown";
        const live = input.liveState || null;
        const boot = input.bootShadowState || null;
        const legacy = input.legacyFallbackState || null;
        const expectedContract = mode === "specific" ? selectedContract : activeContract;
        const liveCanonical = live?.canonical || null;
        const liveAvailable = live?.available === true && live?.isCurrent !== false &&
            ["acquired", "available", "success"].includes(live?.sourceStatus) &&
            fullyAvailable(liveCanonical) && live.contract === liveCanonical.contract &&
            Boolean(expectedContract) && live.contract === expectedContract;
        const saved = boot?.candidate || null;
        const savedCanonical = boot?.canonical || saved?.canonical || null;
        const savedPresent = Boolean(saved || savedCanonical);
        const savedIntegrityVerified = boot?.diagnostics?.integrityVerified === true;
        const savedAvailable = boot?.status === "candidate" && saved?.origin === "cache" &&
            fullyAvailable(savedCanonical) && saved.contract === savedCanonical.contract &&
            boot.displayEligible === true && savedIntegrityVerified;
        const legacyAvailable = validLegacy(legacy);
        const facts = { requestedMode: mode, activeContract, selectedContract, liveStatus,
            liveAvailable, savedAvailable, legacyAvailable, savedIntegrityVerified,
            bootShadowStatus: boot?.status ?? null };

        if (mode === "specific") {
            if (liveAvailable) return output({ available: true, sourceKind: "live",
                state: "specific_live", canonical: liveCanonical,
                positions: live.positions || canonicalPositions(liveCanonical),
                contract: live.contract, freshness: live.freshness, displayEligible: true,
                calculationEligible: live.calculationEligible ?? "existing_policy",
                fetchedAt: live.fetchedAt, origin: "live",
                selectionReason: "matching_selected_live" }, facts);
            return output({ available: false, sourceKind: "unavailable",
                state: "specific_unavailable", reason: selectedContract
                    ? "selected_live_unavailable" : "selected_contract_missing",
                selectionReason: "specific_fallback_forbidden",
                legacyRejectedReason: legacyAvailable ? "specific_legacy_forbidden" : null }, facts);
        }

        if (mode !== "auto") return output({ available: false,
            sourceKind: "unavailable", state: "unavailable",
            reason: "mode_invalid", selectionReason: "unsupported_mode" }, facts);

        if (liveAvailable) return output({ available: true, sourceKind: "live",
            state: "live_available", canonical: liveCanonical,
            positions: live.positions || canonicalPositions(liveCanonical),
            contract: live.contract, freshness: live.freshness, displayEligible: true,
            calculationEligible: live.calculationEligible ?? "existing_policy",
            fetchedAt: live.fetchedAt, origin: "live",
            selectionReason: "matching_active_live" }, facts);

        if (boot?.status === "superseded" || boot?.reason === "replaced_by_live") {
            return output({ available: false, sourceKind: "unavailable",
                state: "unavailable", reason: "saved_superseded",
                selectionReason: "superseded_saved_reuse_forbidden",
                legacyRejectedReason: legacyAvailable ? "superseded_state_blocks_fallback" : null }, facts);
        }

        const unsafeSaved = savedPresent && (!savedIntegrityVerified ||
            ["invalid", "tampered"].includes(boot?.status) ||
            ["cache_invalid", "signature_invalid", "integrity_invalid", "tampered"]
                .includes(boot?.reason));
        if (unsafeSaved) return output({ available: false, sourceKind: "unavailable",
            state: "unavailable", reason: "saved_integrity_invalid",
            selectionReason: "unsafe_saved_blocks_legacy_fallback",
            legacyRejectedReason: legacyAvailable ? "saved_integrity_invalid" : null }, facts);

        if (savedAvailable && !activeContract) return output({ available: false,
            sourceKind: "unavailable", state: "unavailable",
            reason: "active_contract_unknown",
            selectionReason: "saved_contract_evaluation_deferred" }, facts);
        if (savedAvailable && saved.contract !== activeContract) {
            return output({ available: false, sourceKind: "unavailable",
                state: "contract_mismatch", reason: "saved_contract_mismatch",
                selectionReason: "saved_mismatch_blocks_legacy_fallback",
                savedContractMatched: false,
                legacyRejectedReason: legacyAvailable ? "legacy_contract_unverifiable" : null }, facts);
        }

        if (savedAvailable) {
            const pending = PENDING_STATUSES.has(liveStatus);
            return output({ available: true, sourceKind: "saved",
                state: pending ? "saved_pending" : "saved_fallback",
                canonical: savedCanonical, positions: canonicalPositions(savedCanonical),
                contract: saved.contract, freshness: boot.freshness, displayEligible: true,
                calculationEligible: "undetermined", fetchedAt: saved.fetchedAt,
                origin: "cache", selectionReason: pending
                    ? "live_pending_matching_saved" : "live_unavailable_matching_saved",
                savedContractMatched: true }, facts);
        }

        if (legacyAvailable) return output({ available: true, sourceKind: "legacy",
            state: "legacy_fallback", canonical: null, positions: legacy.positions,
            contract: null, freshness: legacy.freshness, displayEligible: true,
            calculationEligible: legacy.calculationEligible ?? "existing_legacy_policy",
            fetchedAt: legacy.fetchedAt, sourceDate: legacy.sourceDate,
            sourceDateKind: legacy.sourceDateKind, origin: "legacy",
            selectionReason: "saved_missing_or_unavailable_legacy_selected",
            legacyConsidered: true }, facts);

        return output({ available: false, sourceKind: "unavailable",
            state: "unavailable", reason: savedPresent ? "saved_unavailable" :
                "display_source_missing", selectionReason: "no_eligible_display_source",
            legacyConsidered: true,
            legacyRejectedReason: legacy ? "legacy_invalid" : "legacy_missing" }, facts);
    }

    return Object.freeze({ SOURCE_STATE_VERSION, buildQriOptionsDisplaySourceState,
        publishedCounts, fullyAvailable, canonicalPositions });
});
