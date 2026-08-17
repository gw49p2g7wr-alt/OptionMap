(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const historyApi = commonJs
        ? require("./weeklyOptionsHistory.js") : root?.OptionMapWeeklyOptionsHistory;
    const changesApi = commonJs
        ? require("./weeklyOptionsChanges.js") : root?.OptionMapWeeklyOptionsChanges;
    const api = factory(historyApi, changesApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWeeklyOptionsHistoryComparison = api;
})(typeof window !== "undefined" ? window : globalThis,
function (historyApi, changesApi) {
    "use strict";
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function empty(status, reason, details = {}) {
        return { source: "formal_weekly_options_history", available: false,
            status, reason, previousSourceDate: null, currentSourceDate: null,
            previousExpiry: null, currentExpiry: null, changes: null,
            counts: { comparable: 0, unavailable: 0 }, ...details };
    }
    function activeEntryRevision(entry) {
        return entry?.revisions?.find(revision =>
            revision.versionKey === entry.activeVersionKey
        ) || null;
    }
    function summarize(changes) {
        const strikeChanges = changes?.strikeChanges || [];
        return {
            comparable: strikeChanges.filter(item => item.status === "continued").length,
            unavailable: strikeChanges.filter(item => item.status !== "continued").length,
            previousOnly: strikeChanges.filter(item => item.status === "previous_only").length,
            currentOnly: strikeChanges.filter(item => item.status === "current_only").length,
            unobserved: strikeChanges.filter(item => item.status === "unobserved").length
        };
    }
    async function compareLatestWeeklyOptionsHistory(history) {
        const validation = await historyApi?.validateWeeklyOptionsHistory?.(history);
        if (!validation?.valid) return empty("invalid", "invalid_history", {
            diagnostics: clone(validation || null)
        });
        const entries = [...history.entries].sort((a, b) =>
            a.sourceDate.localeCompare(b.sourceDate)
        );
        if (entries.length === 0) return empty("unavailable", "history_empty");
        const currentEntry = entries.at(-1);
        const current = activeEntryRevision(currentEntry);
        if (!current) return empty("invalid", "active_revision_missing");
        if (entries.length === 1) return empty("waiting_previous", "history_one_week", {
            currentSourceDate: currentEntry.sourceDate,
            currentExpiry: currentEntry.expiries?.[0] || null
        });
        const previousEntry = entries.at(-2);
        const previous = activeEntryRevision(previousEntry);
        if (!previous) return empty("invalid", "active_revision_missing");
        const changes = changesApi.compareWeeklyOptions(
            previous.canonical, current.canonical
        );
        return {
            source: "formal_weekly_options_history",
            available: changes.available,
            status: changes.status,
            reason: changes.reason,
            previousSourceDate: previousEntry.sourceDate,
            currentSourceDate: currentEntry.sourceDate,
            previousExpiry: previousEntry.expiries[0],
            currentExpiry: currentEntry.expiries[0],
            previousVersionKey: previousEntry.activeVersionKey,
            currentVersionKey: currentEntry.activeVersionKey,
            changes: clone(changes),
            counts: summarize(changes)
        };
    }
    return Object.freeze({ compareLatestWeeklyOptionsHistory });
});
