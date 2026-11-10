(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("./qriVolumeHistory.js") : root?.OptionMapQriVolumeHistory;
    const storeApi = commonJs ? require("./storage/qriVolumeHistoryStore.js")
        : root?.OptionMapQriVolumeHistoryStore;
    const api = factory(historyApi, storeApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriVolumeHistoryPersistence = api;
})(typeof window !== "undefined" ? window : globalThis, function (defaultHistoryApi, defaultStoreApi) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function createQriVolumeHistoryPersistence(configuration = {}) {
        const historyApi = configuration.historyApi || defaultHistoryApi;
        const store = configuration.store || defaultStoreApi;
        const now = configuration.now || (() => new Date().toISOString());
        let state = { status: "not_attempted", storeStatus: "not_opened", contract: null,
            tradingDate: null, observationId: null, reason: null, attemptedAt: null };
        const update = patch => clone(state = { ...state, ...patch });
        async function openPersistence() {
            try {
                await store.openHistoryStore(); const loaded = await store.loadHistory();
                return loaded.status === "corrupted" ? update({ status: "failed",
                    storeStatus: "corrupted", reason: "corrupted_existing_history", attemptedAt: now() })
                    : update({ storeStatus: "ready", reason: null });
            } catch (_error) { return update({ status: "failed", storeStatus: "failed",
                reason: "indexeddb_open_failure", attemptedAt: now() }); }
        }
        async function persistEvidenceCandidate(candidate, options = {}) {
            const attemptedAt = now(), isolated = clone(candidate);
            const identity = { contract: isolated?.contract || null,
                tradingDate: isolated?.tradingDate || null,
                observationId: isolated?.observationId || null };
            if (!['auto', 'reference_history'].includes(options.mode) ||
                typeof options.isCurrentRequest !== "function" || !options.isCurrentRequest()) {
                return update({ status: "not_attempted", ...identity,
                    reason: "evidence_context_invalid", attemptedAt });
            }
            if (!await historyApi.validateCandidate(isolated)) return update({ status: "failed",
                ...identity, reason: "volume_evidence_invalid", attemptedAt });
            const role = isolated.sourceEvidence.receipt.role;
            if (options.mode === "auto" && role !== "active" ||
                options.mode === "reference_history" && !["next", "major_sq"].includes(role)) {
                return update({ status: "failed", ...identity, reason: "volume_role_mismatch", attemptedAt });
            }
            try {
                if (state.storeStatus !== "ready") await store.openHistoryStore();
                if (!options.isCurrentRequest()) return update({ status: "not_attempted",
                    storeStatus: "ready", ...identity, reason: "stale_request", attemptedAt });
                const result = await store.persistCandidate(isolated, { confirmedAt: attemptedAt });
                if (result.outcome === "same_semantic_volume") return update({ status: "unchanged",
                    storeStatus: "ready", ...identity, reason: "duplicate_no_op", attemptedAt });
                if (result.saved) return update({ status: "saved", storeStatus: "ready",
                    ...identity, reason: result.outcome, attemptedAt });
                return update({ status: "failed", storeStatus: "ready", ...identity,
                    reason: result.outcome || "transaction_failure", attemptedAt });
            } catch (_error) { return update({ status: "failed", storeStatus: "failed",
                ...identity, reason: "transaction_failure", attemptedAt }); }
        }
        return Object.freeze({ openPersistence, persistEvidenceCandidate,
            persistCandidate: persistEvidenceCandidate,
            getState: () => clone(state) });
    }
    return Object.freeze({ createQriVolumeHistoryPersistence });
});
