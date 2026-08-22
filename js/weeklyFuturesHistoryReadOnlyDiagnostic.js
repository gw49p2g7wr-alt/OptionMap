(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const historyApi = commonJs
        ? require("./weeklyFuturesHistory.js")
        : root.OptionMapWeeklyFuturesHistory;
    const api = factory(historyApi);

    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapWeeklyFuturesHistoryReadOnlyDiagnostic = api;
        root.listWeeklyFuturesHistoryReadOnly = () =>
            api.listWeeklyFuturesHistoryReadOnly(root.localStorage);
    }
})(typeof window !== "undefined" ? window : globalThis,
function (historyApi) {
    "use strict";

    const STORAGE_KEY = "optionMapWeeklyFuturesHistory";

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        for (const child of Object.values(value)) deepFreeze(child);
        return Object.freeze(value);
    }

    function metadata(history) {
        const entries = Array.isArray(history?.entries) ? history.entries : [];
        return {
            entryCount: entries.length,
            revisionCount: entries.reduce(
                (sum, entry) => sum + (Array.isArray(entry?.revisions)
                    ? entry.revisions.length : 0),
                0
            ),
            sourceDates: entries.map(entry => entry.sourceDate)
        };
    }

    async function listWeeklyFuturesHistoryReadOnly(storage) {
        if (!storage || typeof storage.getItem !== "function") {
            return deepFreeze({
                status: "storage_unavailable",
                valid: false,
                ...metadata(null),
                history: null
            });
        }
        let serialized;
        try {
            serialized = storage.getItem(STORAGE_KEY);
        } catch (_error) {
            return deepFreeze({
                status: "storage_unavailable",
                valid: false,
                ...metadata(null),
                history: null
            });
        }
        const parsed = await historyApi.parseHistory(serialized);
        if (!parsed.history) {
            return deepFreeze({
                status: parsed.status,
                valid: false,
                ...metadata(null),
                history: null
            });
        }
        const snapshot = clone(parsed.history);
        const valid = await historyApi.validateHistory(snapshot);
        return deepFreeze({
            status: parsed.status,
            valid,
            ...metadata(snapshot),
            history: snapshot
        });
    }

    return Object.freeze({
        STORAGE_KEY,
        clone,
        deepFreeze,
        listWeeklyFuturesHistoryReadOnly
    });
});
