(function (root, factory) {
    const historyApi = typeof module === "object" && module.exports
        ? require("./weeklyOptionsHistory.js")
        : root?.OptionMapWeeklyOptionsHistory;
    const storeApi = typeof module === "object" && module.exports
        ? require("./storage/weeklyOptionsHistoryStore.js")
        : root?.OptionMapWeeklyOptionsHistoryStore;
    const api = factory(historyApi, storeApi);

    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsHistoryPersistence = api;
})(typeof window !== "undefined" ? window : globalThis,
function (defaultHistoryApi, defaultStoreApi) {
    "use strict";

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function errorCode(error) {
        if (typeof error?.message === "string" && error.message) {
            return error.message;
        }
        return typeof error === "string" && error ? error : "unknown_error";
    }

    function createWeeklyOptionsHistoryPersistence(configuration = {}) {
        const historyApi = configuration.historyApi || defaultHistoryApi;
        const store = configuration.store || defaultStoreApi;
        const now = configuration.now || (() => new Date().toISOString());
        let state = {
            status: "not_attempted",
            storeStatus: "not_opened",
            sourceDate: null,
            versionKey: null,
            reason: null,
            errorCode: null,
            attemptedAt: null
        };

        function update(patch) {
            state = { ...state, ...patch };
            return clone(state);
        }

        async function openWeeklyOptionsHistoryPersistence() {
            try {
                await store.openWeeklyOptionsHistoryStore();
                return update({ storeStatus: "ready", errorCode: null });
            } catch (error) {
                return update({
                    status: "failed",
                    storeStatus: "failed",
                    reason: "store_open_failed",
                    errorCode: errorCode(error),
                    attemptedAt: now()
                });
            }
        }

        async function persistConfirmedWeeklyOptionsCache(cache, options = {}) {
            const attemptedAt = now();
            const identity = {
                sourceDate: typeof cache?.sourceDate === "string"
                    ? cache.sourceDate : null,
                versionKey: typeof cache?.versionKey === "string"
                    ? cache.versionKey : null
            };
            let candidateResult;
            try {
                const formalCache = options.currentOfficialRefetch === true
                    ? { ...clone(cache), currentOfficialRefetch: true }
                    : clone(cache);
                candidateResult = await historyApi
                    .createWeeklyOptionsHistoryCandidate(formalCache);
            } catch (error) {
                return update({
                    status: "not_attempted",
                    ...identity,
                    reason: "candidate_creation_failed",
                    errorCode: errorCode(error),
                    attemptedAt
                });
            }
            if (!candidateResult?.ok || !candidateResult.candidate) {
                return update({
                    status: "not_attempted",
                    ...identity,
                    reason: candidateResult?.reason || "invalid_formal_cache",
                    errorCode: null,
                    attemptedAt
                });
            }
            try {
                if (state.storeStatus !== "ready") {
                    await store.openWeeklyOptionsHistoryStore();
                    state = { ...state, storeStatus: "ready" };
                }
                const result = await store.persistWeeklyOptionsHistoryCandidate(
                    candidateResult.candidate,
                    { confirmedAt: attemptedAt }
                );
                if (result?.outcome === "same_version") {
                    return update({
                        status: "unchanged",
                        storeStatus: "ready",
                        ...identity,
                        reason: "same_version",
                        errorCode: null,
                        attemptedAt
                    });
                }
                if (result?.saved === true) {
                    return update({
                        status: "saved",
                        storeStatus: "ready",
                        ...identity,
                        reason: result.outcome || "saved",
                        errorCode: null,
                        attemptedAt
                    });
                }
                if (result?.outcome === "unconfirmed_revision") {
                    return update({
                        status: "unchanged",
                        storeStatus: "ready",
                        ...identity,
                        reason: result.outcome,
                        errorCode: null,
                        attemptedAt
                    });
                }
                return update({
                    status: "failed",
                    storeStatus: "ready",
                    ...identity,
                    reason: result?.outcome || "persistence_failed",
                    errorCode: result?.error || null,
                    attemptedAt
                });
            } catch (error) {
                return update({
                    status: "failed",
                    storeStatus: "failed",
                    ...identity,
                    reason: "persistence_exception",
                    errorCode: errorCode(error),
                    attemptedAt
                });
            }
        }

        function getWeeklyOptionsHistoryPersistenceState() {
            return clone(state);
        }

        return Object.freeze({
            openWeeklyOptionsHistoryPersistence,
            persistConfirmedWeeklyOptionsCache,
            getWeeklyOptionsHistoryPersistenceState
        });
    }

    return Object.freeze({ createWeeklyOptionsHistoryPersistence });
});
