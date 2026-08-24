(function (root, factory) {
    const ivApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv;
    const api = factory(ivApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriIvGraphSourceState = api;
})(typeof window !== "undefined" ? window : globalThis, function (ivApi) {
    "use strict";

    const SOURCE_STATE_VERSION = 1;
    const LIVE_STATUSES = new Set(["success", "available"]);
    const PENDING_STATUSES = new Set(["pending", "loading", "not_started",
        "not_confirmed", "unknown"]);
    const FAILED_STATUSES = new Set(["failed", "unavailable", "error"]);

    function clone(value) {
        if (value === undefined) return undefined;
        return typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function validCanonical(canonical) {
        return !!canonical && ivApi?.validateCanonical?.(canonical) === true;
    }

    function runtimeAvailable(runtime, expectedContract) {
        if (runtime?.available !== true || runtime.sourceStatus !== "acquired" ||
            !validCanonical(runtime.canonical) ||
            runtime.contract !== runtime.canonical.contract) return false;
        return !expectedContract || runtime.contract === expectedContract;
    }

    function availableCounts(canonical) {
        const records = Array.isArray(canonical?.records) ? canonical.records : [];
        const count = optionType => records.filter(record => record.optionType === optionType &&
            record.iv?.status === "available").length;
        return { call: count("call"), put: count("put"),
            total: count("call") + count("put") };
    }

    function rangePolicy(sourceKind) {
        return sourceKind === "live" ? {
            defaultRange: "plus_minus_3000",
            allowLivePriceNavigation: true,
            allowSavedPriceNavigation: false,
            requireCurrentPriceForRadius: true
        } : sourceKind === "saved" ? {
            defaultRange: "all",
            allowLivePriceNavigation: true,
            allowSavedPriceNavigation: false,
            requireCurrentPriceForRadius: true
        } : {
            defaultRange: "all",
            allowLivePriceNavigation: false,
            allowSavedPriceNavigation: false,
            requireCurrentPriceForRadius: true
        };
    }

    function output(values, facts) {
        const canonical = values.canonical ? clone(values.canonical) : null;
        return deepFreeze({
            sourceStateVersion: SOURCE_STATE_VERSION,
            available: values.available === true,
            sourceKind: values.sourceKind,
            state: values.state,
            reason: values.reason ?? null,
            canonical,
            contract: values.contract ?? null,
            channel: values.channel ?? null,
            freshness: values.freshness ? clone(values.freshness) : null,
            displayEligible: values.displayEligible === true,
            calculationEligible: values.calculationEligible ?? "undetermined",
            liveStatus: facts.liveStatus,
            metadata: {
                tradingDate: canonical?.tradingDate ?? null,
                pageUpdatedAt: canonical?.pageUpdatedAt ?? null,
                fetchedAt: values.fetchedAt ?? null,
                candidateOrigin: values.candidateOrigin ?? null
            },
            rangePolicy: rangePolicy(values.sourceKind),
            diagnostics: { ...facts, sourceSelectionReason: values.selectionReason,
                contractMatched: values.contractMatched ?? null,
                availablePointCounts: canonical ? availableCounts(canonical) : null }
        });
    }

    function buildQriIvGraphSourceState(input = {}) {
        const mode = text(input.selectionMode);
        const selectedContract = text(input.selectedContract);
        const activeContract = text(input.activeContract);
        const liveStatus = text(input.liveStatus) || "unknown";
        const active = input.activeRuntime || null;
        const selected = input.selectedRuntime || null;
        const boot = input.bootShadowState || null;
        const saved = boot?.candidate || null;
        const savedCanonical = saved?.canonical || boot?.canonical || null;
        const savedAvailable = !!saved && saved.origin === "cache" &&
            validCanonical(savedCanonical) && saved.contract === savedCanonical.contract;
        const facts = {
            requestedMode: mode,
            requestedContract: mode === "specific" ? selectedContract : activeContract,
            liveStatus,
            liveAvailable: mode === "specific"
                ? runtimeAvailable(selected, selectedContract)
                : runtimeAvailable(active, activeContract),
            savedAvailable,
            savedDisplayEligible: boot?.displayEligible === true,
            savedShadowStatus: boot?.status ?? null,
            integrityVerified: boot?.diagnostics?.integrityVerified === true,
            activeRuntimeStatus: active?.sourceStatus ?? null,
            selectedRuntimeStatus: selected?.sourceStatus ?? null
        };

        if (mode === "specific") {
            if (selectedContract && runtimeAvailable(selected, selectedContract)) {
                return output({ available: true, sourceKind: "live", state: "selected_live",
                    canonical: selected.canonical, contract: selected.contract,
                    channel: "selected", freshness: selected.freshness,
                    displayEligible: true,
                    calculationEligible: selected.calculationEligible ?? "undetermined",
                    fetchedAt: selected.fetchedAt, candidateOrigin: "live",
                    selectionReason: "matching_selected_live", contractMatched: true }, facts);
            }
            return output({ available: false, sourceKind: "unavailable",
                state: "selected_unavailable",
                reason: selectedContract ? "selected_live_unavailable" : "selected_contract_missing",
                selectionReason: "specific_saved_fallback_forbidden",
                contractMatched: selectedContract && selected?.contract
                    ? selectedContract === selected.contract : null }, facts);
        }

        if (mode !== "auto") {
            return output({ available: false, sourceKind: "unavailable",
                state: "unavailable", reason: "selection_mode_invalid",
                selectionReason: "unsupported_selection_mode" }, facts);
        }

        if (runtimeAvailable(active, activeContract)) {
            return output({ available: true, sourceKind: "live", state: "live_available",
                canonical: active.canonical, contract: active.contract, channel: "active",
                freshness: active.freshness, displayEligible: true,
                calculationEligible: active.calculationEligible ?? "undetermined",
                fetchedAt: active.fetchedAt, candidateOrigin: "live",
                selectionReason: "matching_active_live", contractMatched: true }, facts);
        }

        if (boot?.status === "superseded" || boot?.reason === "replaced_by_live") {
            return output({ available: false, sourceKind: "unavailable",
                state: "unavailable", reason: "saved_superseded",
                selectionReason: "saved_replaced_by_live" }, facts);
        }

        const savedEligible = boot?.status === "candidate" && savedAvailable &&
            boot.displayEligible === true && facts.integrityVerified;
        if (savedEligible && !activeContract) {
            return output({ available: false, sourceKind: "unavailable",
                state: "unavailable", reason: "active_contract_unknown",
                selectionReason: "saved_contract_evaluation_deferred" }, facts);
        }
        if (savedEligible && saved.contract !== activeContract) {
            return output({ available: false, sourceKind: "unavailable",
                state: "contract_mismatch", reason: "saved_contract_mismatch",
                selectionReason: "saved_contract_mismatch", contractMatched: false }, facts);
        }
        const pending = PENDING_STATUSES.has(liveStatus);
        const failed = FAILED_STATUSES.has(liveStatus);
        if (savedEligible && (pending || failed)) {
            return output({ available: true, sourceKind: "saved",
                state: pending ? "saved_pending" : "saved_fallback",
                canonical: savedCanonical, contract: saved.contract, channel: "active",
                freshness: boot.freshness, displayEligible: true,
                calculationEligible: "undetermined", fetchedAt: saved.fetchedAt,
                candidateOrigin: "cache", selectionReason: pending
                    ? "live_pending_saved_selected" : "live_failed_saved_selected",
                contractMatched: true }, facts);
        }

        let reason = "saved_unavailable";
        if (LIVE_STATUSES.has(liveStatus)) reason = "live_success_without_matching_canonical";
        else if (!saved) reason = "saved_candidate_missing";
        else if (!facts.integrityVerified) reason = "saved_integrity_unverified";
        else if (boot?.displayEligible !== true) reason = "saved_display_ineligible";
        else if (!savedAvailable) reason = "saved_canonical_invalid";
        return output({ available: false, sourceKind: "unavailable", state: "unavailable",
            reason, selectionReason: "no_eligible_graph_source" }, facts);
    }

    return Object.freeze({ SOURCE_STATE_VERSION, buildQriIvGraphSourceState,
        availableCounts });
});
