(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const historyApi = commonJs ? require("./qriOptionsHistory.js") : root?.OptionMapQriOptionsHistory;
    const api = factory(qriApi, historyApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoryComparison = api;
})(typeof window !== "undefined" ? window : globalThis,
function (qriApi, historyApi) {
    "use strict";
    const clone = value => JSON.parse(JSON.stringify(value));
    const observation = record => record ? {
        present: true, published: record.published, value: record.value
    } : { present: false, published: false, value: null };
    const empty = (status, reason, details = {}) => ({
        source: "formal_qri_options_history", available: false, status, reason,
        contract: details.contract || null, previousSourceDate: null,
        currentSourceDate: null, previousVersionKey: null, currentVersionKey: null,
        comparison: null, ...details
    });

    function summarize(items) {
        const comparable = items.filter(item => item.status === "comparable");
        const increases = comparable.filter(item => item.delta > 0);
        const decreases = comparable.filter(item => item.delta < 0);
        const unchanged = comparable.filter(item => item.delta === 0);
        return {
            comparableCount: comparable.length,
            previousOnlyCount: items.filter(item => item.status === "previous_only").length,
            currentOnlyCount: items.filter(item => item.status === "current_only").length,
            unobservedCount: items.filter(item => item.status === "unobserved").length,
            invalidCount: items.filter(item => item.status === "invalid").length,
            absoluteDeltaTotal: comparable.reduce((sum, item) => sum + Math.abs(item.delta), 0),
            netDelta: comparable.reduce((sum, item) => sum + item.delta, 0),
            increaseCount: increases.length,
            decreaseCount: decreases.length,
            unchangedCount: unchanged.length,
            topIncreases: [...increases].sort((a, b) => b.delta - a.delta || a.strike - b.strike)
                .slice(0, 3).map(clone),
            topDecreases: [...decreases].sort((a, b) => a.delta - b.delta || a.strike - b.strike)
                .slice(0, 3).map(clone),
            newlyPublished: items.filter(item => item.status === "current_only")
                .sort((a, b) => b.current.value - a.current.value || a.strike - b.strike)
                .map(clone),
            noLongerPublished: items.filter(item => item.status === "previous_only")
                .sort((a, b) => b.previous.value - a.previous.value || a.strike - b.strike)
                .map(clone)
        };
    }

    function compareRevisions(previousRevision, currentRevision, options = {}) {
        const contract = options.contract || currentRevision?.contract || null;
        if (!previousRevision || !currentRevision) return empty("invalid", "revision_missing", { contract });
        if (previousRevision.contract !== contract || currentRevision.contract !== contract ||
            previousRevision.canonical?.contract !== contract || currentRevision.canonical?.contract !== contract) {
            return empty("invalid", "contract_mismatch", { contract });
        }
        if (previousRevision.openInterestStatus !== "available" ||
            currentRevision.openInterestStatus !== "available") {
            return empty("invalid", "open_interest_unavailable", { contract });
        }
        if (!qriApi?.validateCanonical?.(previousRevision.canonical, { allowUnresolvedContracts: true }) ||
            !qriApi?.validateCanonical?.(currentRevision.canonical, { allowUnresolvedContracts: true })) {
            return empty("invalid", "canonical_invalid", { contract });
        }
        const previousMap = new Map(previousRevision.canonical.records.map(record =>
            [`${record.optionType}|${record.strike}`, record]));
        const currentMap = new Map(currentRevision.canonical.records.map(record =>
            [`${record.optionType}|${record.strike}`, record]));
        const keys = [...new Set([...previousMap.keys(), ...currentMap.keys()])]
            .sort((a, b) => {
                const [at, as] = a.split("|"); const [bt, bs] = b.split("|");
                return at.localeCompare(bt) || Number(as) - Number(bs);
            });
        const records = keys.map(key => {
            const [optionType, strikeText] = key.split("|");
            const previous = observation(previousMap.get(key));
            const current = observation(currentMap.get(key));
            let status = "unobserved";
            if (previous.published && current.published) status = "comparable";
            else if (previous.published) status = "previous_only";
            else if (current.published) status = "current_only";
            const delta = status === "comparable" ? current.value - previous.value : null;
            const percentChange = status === "comparable" && previous.value !== 0
                ? delta / previous.value : null;
            return { contract, optionType, strike: Number(strikeText), status,
                previous, current, delta, percentChange };
        });
        const byType = {};
        for (const optionType of ["call", "put"]) {
            const items = records.filter(item => item.optionType === optionType);
            byType[optionType] = { records: items.map(clone), summary: summarize(items) };
        }
        return { source: "formal_qri_options_history", available: true,
            status: "comparable", reason: null, contract,
            previousSourceDate: options.previousSourceDate || previousRevision.tradingDate,
            currentSourceDate: options.currentSourceDate || currentRevision.tradingDate,
            previousVersionKey: previousRevision.versionKey,
            currentVersionKey: currentRevision.versionKey,
            previousPageUpdatedAt: previousRevision.pageUpdatedAt,
            currentPageUpdatedAt: currentRevision.pageUpdatedAt,
            comparison: { records, byType } };
    }

    async function compareLatestSavedDates(history, contract) {
        if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(contract || "")) {
            return empty("unavailable", "contract_not_selected", { contract: contract || null });
        }
        const validation = await historyApi?.validateHistory?.(history);
        if (!validation?.valid) return empty("invalid", "invalid_history", {
            contract, diagnostics: clone(validation || null)
        });
        const entries = history.entries.filter(entry => entry.contract === contract)
            .sort((a, b) => a.sourceDateKey.localeCompare(b.sourceDateKey));
        if (entries.length === 0) return empty("unavailable", "history_empty_for_contract", { contract });
        const currentEntry = entries.at(-1);
        const currentRevision = currentEntry.revisions.find(revision =>
            revision.versionKey === currentEntry.activeVersionKey);
        if (!currentRevision) return empty("invalid", "active_revision_missing", { contract });
        if (entries.length === 1) return empty("waiting_previous", "history_one_day", {
            contract, currentSourceDate: currentEntry.sourceDateKey,
            currentVersionKey: currentEntry.activeVersionKey,
            currentPageUpdatedAt: currentRevision.pageUpdatedAt
        });
        const previousEntry = entries.at(-2);
        const previousRevision = previousEntry.revisions.find(revision =>
            revision.versionKey === previousEntry.activeVersionKey);
        if (!previousRevision) return empty("invalid", "active_revision_missing", { contract });
        return compareRevisions(previousRevision, currentRevision, { contract,
            previousSourceDate: previousEntry.sourceDateKey,
            currentSourceDate: currentEntry.sourceDateKey });
    }

    function isCurrentResult({ requestedContract, currentContract, sequence,
        currentSequence, result }) {
        return sequence === currentSequence && requestedContract === currentContract &&
            result?.contract === requestedContract;
    }

    return Object.freeze({ compareRevisions, compareLatestSavedDates, isCurrentResult });
});
