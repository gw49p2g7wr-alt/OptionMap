(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionOpenInterestComparisonDiagnostics = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const NO_CHANGE_REASON = "option_open_interest_no_change";
    const NO_CHANGE_MESSAGE = "建玉差分なし（比較対象と同一）";

    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }

    function parseSide(labels, values) {
        if (!Array.isArray(labels) || !Array.isArray(values) ||
            labels.length === 0 || labels.length !== values.length) {
            return null;
        }

        const result = new Map();
        for (let index = 0; index < labels.length; index += 1) {
            const label = labels[index];
            const value = values[index];
            if (label === null || label === undefined || String(label).trim() === "" ||
                value === null || value === undefined || String(value).trim() === "") {
                return null;
            }
            const strike = Number(String(label).replace(/,/g, ""));
            const numericValue = Number(value);
            if (!Number.isFinite(strike) || strike <= 0 ||
                !Number.isFinite(numericValue) || result.has(strike)) {
                return null;
            }
            result.set(strike, numericValue);
        }
        return result;
    }

    function compareSide(currentLabels, currentValues, comparisonLabels, comparisonValues) {
        const current = parseSide(currentLabels, currentValues);
        const comparison = parseSide(comparisonLabels, comparisonValues);
        if (!current || !comparison) return { valid: false };
        if (current.size !== comparison.size ||
            [...current.keys()].some(strike => !comparison.has(strike))) {
            return { valid: true, strikeSetsMatched: false };
        }

        let nonZeroDiffCount = 0;
        let maxAbsDiff = 0;
        for (const [strike, currentValue] of current) {
            const absoluteDifference = Math.abs(currentValue - comparison.get(strike));
            if (absoluteDifference !== 0) nonZeroDiffCount += 1;
            maxAbsDiff = Math.max(maxAbsDiff, absoluteDifference);
        }
        return {
            valid: true,
            strikeSetsMatched: true,
            comparedStrikeCount: current.size,
            nonZeroDiffCount,
            maxAbsDiff
        };
    }

    function assess(input = {}) {
        const current = input.current || {};
        const comparison = input.comparison || {};
        const call = compareSide(current.labels, current.callOpenInterest,
            comparison.labels, comparison.callOpenInterest);
        const put = compareSide(current.labels, current.putOpenInterest,
            comparison.labels, comparison.putOpenInterest);
        const strikeSetsMatched = call.valid === true && put.valid === true &&
            call.strikeSetsMatched === true && put.strikeSetsMatched === true;
        const comparedStrikeCount = strikeSetsMatched &&
            call.comparedStrikeCount === put.comparedStrikeCount
            ? call.comparedStrikeCount : 0;
        const diagnostics = {
            strikeSetsMatched,
            comparedStrikeCount,
            callNonZeroDiffCount: strikeSetsMatched ? call.nonZeroDiffCount : null,
            putNonZeroDiffCount: strikeSetsMatched ? put.nonZeroDiffCount : null,
            maxCallAbsDiff: strikeSetsMatched ? call.maxAbsDiff : null,
            maxPutAbsDiff: strikeSetsMatched ? put.maxAbsDiff : null
        };
        const valid = call.valid === true && put.valid === true && strikeSetsMatched &&
            comparedStrikeCount > 0;
        const noChange = valid && call.nonZeroDiffCount === 0 &&
            put.nonZeroDiffCount === 0 && call.maxAbsDiff === 0 && put.maxAbsDiff === 0;
        return freeze({
            status: valid ? "valid" : "invalid",
            reason: noChange ? NO_CHANGE_REASON : null,
            diagnostics
        });
    }

    function formatReason(reason) {
        return reason === NO_CHANGE_REASON ? NO_CHANGE_MESSAGE : null;
    }

    return freeze({ NO_CHANGE_REASON, assess, formatReason });
});
