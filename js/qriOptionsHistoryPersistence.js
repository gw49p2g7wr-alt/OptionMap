(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("./qriOptionsHistory.js") : root?.OptionMapQriOptionsHistory;
    const storeApi = commonJs ? require("./storage/qriOptionsHistoryStore.js") : root?.OptionMapQriOptionsHistoryStore;
    const api = factory(historyApi, storeApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoryPersistence = api;
})(typeof window !== "undefined" ? window : globalThis,
function (defaultHistoryApi, defaultStoreApi) {
    "use strict";
    const clone = value => JSON.parse(JSON.stringify(value));
    const errorCode = error => error?.name === "QuotaExceededError" ? "quota_failure"
        : error?.message || String(error || "unknown_error");
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

    function createQriOptionsHistoryPersistence(configuration = {}) {
        const historyApi = configuration.historyApi || defaultHistoryApi;
        const store = configuration.store || defaultStoreApi;
        const now = configuration.now || (() => new Date().toISOString());
        let state = { status: "not_attempted", storeStatus: "not_opened",
            contract: null, sourceDateKey: null, versionKey: null,
            reason: null, errorCode: null, attemptedAt: null };
        const update = patch => clone(state = { ...state, ...patch });

        async function openPersistence() {
            try {
                await store.openHistoryStore();
                const loaded = await store.loadHistory();
                if (loaded.status === "corrupted") return update({ status: "failed",
                    storeStatus: "corrupted", reason: "corrupted_existing_history",
                    errorCode: null, attemptedAt: now() });
                return update({ storeStatus: "ready", reason: null, errorCode: null });
            } catch (error) {
                return update({ status: "failed", storeStatus: "failed",
                    reason: "indexeddb_open_failure", errorCode: errorCode(error),
                    attemptedAt: now() });
            }
        }

        async function persistActiveContractCache(cache, options = {}) {
            const attemptedAt = now();
            const identity = { contract: cache?.contract || null,
                sourceDateKey: cache?.canonical?.tradingDate || null,
                versionKey: cache?.versionKey || null };
            if (options.mode && options.mode !== "auto") {
                return update({ status: "not_attempted", ...identity,
                    reason: "specific_display_not_persisted", errorCode: null, attemptedAt });
            }
            if (typeof options.isCurrentRequest === "function" && !options.isCurrentRequest()) {
                return update({ status: "not_attempted", ...identity,
                    reason: "stale_request", errorCode: null, attemptedAt });
            }
            let candidateResult;
            try { candidateResult = await historyApi.createHistoryCandidate(clone(cache)); }
            catch (error) { return update({ status: "failed", ...identity,
                reason: "candidate_creation_failed", errorCode: errorCode(error), attemptedAt }); }
            if (!candidateResult.ok) {
                return update({ status: "not_attempted", ...identity,
                    reason: candidateResult.reason, errorCode: null, attemptedAt });
            }
            if (typeof options.isCurrentRequest === "function" && !options.isCurrentRequest()) {
                return update({ status: "not_attempted", ...identity,
                    reason: "stale_request", errorCode: null, attemptedAt });
            }
            try {
                if (state.storeStatus !== "ready") await store.openHistoryStore();
                if (typeof options.isCurrentRequest === "function" && !options.isCurrentRequest()) {
                    return update({ status: "not_attempted", storeStatus: "ready",
                        ...identity, reason: "stale_request", errorCode: null, attemptedAt });
                }
                const result = await store.persistCandidate(candidateResult.candidate,
                    { confirmedAt: attemptedAt });
                if (result.outcome === "same_version") return update({ status: "unchanged",
                    storeStatus: "ready", ...identity, reason: "duplicate_no_op",
                    errorCode: null, attemptedAt });
                if (result.saved) return update({ status: "saved", storeStatus: "ready",
                    ...identity, reason: result.outcome, errorCode: null, attemptedAt });
                return update({ status: "failed", storeStatus: "ready", ...identity,
                    reason: result.outcome || "transaction_failure",
                    errorCode: result.error || null, attemptedAt });
            } catch (error) {
                return update({ status: "failed", storeStatus: "failed", ...identity,
                    reason: errorCode(error).includes("Quota") ? "quota_failure"
                        : "transaction_failure", errorCode: errorCode(error), attemptedAt });
            }
        }

        async function persistReferenceContractCache(cache, options = {}) {
            const attemptedAt = now();
            const isolatedCache = cache == null ? cache : clone(cache);
            const identity = { contract: isolatedCache?.contract || null,
                sourceDateKey: isolatedCache?.canonical?.tradingDate || null,
                versionKey: isolatedCache?.versionKey || null };
            const requestedContract = text(options.requestedContract);
            const sourceUrl = text(options.sourceUrl);
            const requestId = text(options.requestId);
            if (options.mode !== "reference_history" ||
                options.acquisitionOrigin !== "live" || !requestId) {
                return update({ status: "not_attempted", ...identity,
                    reason: "reference_context_invalid", errorCode: null, attemptedAt });
            }
            if (typeof options.isCurrentRequest !== "function" ||
                !options.isCurrentRequest()) {
                return update({ status: "not_attempted", ...identity,
                    reason: "stale_request", errorCode: null, attemptedAt });
            }
            if (!requestedContract || requestedContract !== isolatedCache?.contract ||
                requestedContract !== isolatedCache?.canonical?.contract) {
                return update({ status: "not_attempted", ...identity,
                    reason: "requested_contract_mismatch", errorCode: null, attemptedAt });
            }
            if (!sourceUrl || sourceUrl !== isolatedCache?.sourceUrl ||
                sourceUrl !== isolatedCache?.canonical?.sourceUrl) {
                return update({ status: "not_attempted", ...identity,
                    reason: "source_url_mismatch", errorCode: null, attemptedAt });
            }
            let candidateResult;
            try { candidateResult = await historyApi.createHistoryCandidate(isolatedCache); }
            catch (error) { return update({ status: "failed", ...identity,
                reason: "candidate_creation_failed", errorCode: errorCode(error), attemptedAt }); }
            if (!candidateResult.ok) {
                return update({ status: "not_attempted", ...identity,
                    reason: candidateResult.reason, errorCode: null, attemptedAt });
            }
            if (!options.isCurrentRequest()) {
                return update({ status: "not_attempted", ...identity,
                    reason: "stale_request", errorCode: null, attemptedAt });
            }
            try {
                if (state.storeStatus !== "ready") await store.openHistoryStore();
                if (!options.isCurrentRequest()) return update({ status: "not_attempted",
                    storeStatus: "ready", ...identity, reason: "stale_request",
                    errorCode: null, attemptedAt });
                const result = await store.persistCandidate(candidateResult.candidate,
                    { confirmedAt: attemptedAt });
                if (result.outcome === "same_version") return update({ status: "unchanged",
                    storeStatus: "ready", ...identity, reason: "duplicate_no_op",
                    errorCode: null, attemptedAt });
                if (result.saved) return update({ status: "saved", storeStatus: "ready",
                    ...identity, reason: result.outcome, errorCode: null, attemptedAt });
                return update({ status: "failed", storeStatus: "ready", ...identity,
                    reason: result.outcome || "transaction_failure",
                    errorCode: result.error || null, attemptedAt });
            } catch (error) {
                return update({ status: "failed", storeStatus: "failed", ...identity,
                    reason: errorCode(error).includes("Quota") ? "quota_failure"
                        : "transaction_failure", errorCode: errorCode(error), attemptedAt });
            }
        }
        const getState = () => clone(state);
        return Object.freeze({ openPersistence, persistActiveContractCache,
            persistReferenceContractCache, getState });
    }
    return Object.freeze({ createQriOptionsHistoryPersistence });
});
