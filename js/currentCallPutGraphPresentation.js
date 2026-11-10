(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentCallPutGraphPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SAFE_ZERO_RANGE = 1;

    function metricValue(value) {
        if (value === null || value === undefined || value === "") return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.abs(numeric) : null;
    }

    function strikeValue(value) {
        const numeric = Number(String(value).replace(/,/g, ""));
        return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }

    function highlightKinds(values) {
        const numeric = values.map(value => metricValue(value) ?? 0);
        const positive = numeric.filter(value => value > 0).sort((a, b) => b - a);
        const thirdLargest = positive[2] || positive[0] || 0;
        return numeric.map((value, index) => {
            if (value >= thirdLargest && value > 0) return "strong";
            const isEdge = index === 0 || index === numeric.length - 1;
            const previous = numeric[index - 1] || 0;
            const next = numeric[index + 1] || 0;
            const nearbyAverage = (previous + next) / 2;
            if (!isEdge && value > 0 && nearbyAverage > 0 &&
                value >= nearbyAverage * 1.5) return "spike";
            return "normal";
        });
    }

    function createModel({ strikes, callValues, putValues, metric = "openInterest" } = {}) {
        if (!Array.isArray(strikes) || !Array.isArray(callValues) ||
            !Array.isArray(putValues) || strikes.length !== callValues.length ||
            strikes.length !== putValues.length ||
            (metric !== "openInterest" && metric !== "volume")) {
            return Object.freeze({ status: "invalid", reason: "input_invalid", rows: [] });
        }
        const ascending = strikes.map((strike, index) => ({
            strike: strikeValue(strike),
            callOriginal: metricValue(callValues[index]),
            putOriginal: metricValue(putValues[index])
        })).filter(row => row.strike !== null).sort((a, b) => a.strike - b.strike);
        const callHighlights = highlightKinds(ascending.map(row => row.callOriginal));
        const putHighlights = highlightKinds(ascending.map(row => row.putOriginal));
        const rows = ascending.map((row, index) => ({
            ...row,
            callDisplay: row.callOriginal === null ? null : -row.callOriginal,
            putDisplay: row.putOriginal,
            callHighlight: callHighlights[index],
            putHighlight: putHighlights[index]
        })).reverse();
        const sharedMaximum = rows.reduce((maximum, row) => Math.max(maximum,
            row.callOriginal ?? 0, row.putOriginal ?? 0), 0);
        return Object.freeze({ status: "available", metric,
            sharedMaximum, displayMaximum: sharedMaximum > 0 ? sharedMaximum : SAFE_ZERO_RANGE,
            rows: Object.freeze(rows.map(row => Object.freeze(row))) });
    }

    function nearestStrikeIndex(rows, currentPrice) {
        if (!Array.isArray(rows) || !Number.isFinite(Number(currentPrice))) return -1;
        return rows.reduce((best, row, index) => {
            const difference = Math.abs(row.strike - Number(currentPrice));
            return difference < best.difference ||
                (difference === best.difference && row.strike < best.strike)
                ? { index, difference, strike: row.strike } : best;
        }, { index: -1, difference: Infinity, strike: Infinity }).index;
    }

    function formatAbsolute(value) {
        if (value === null || value === undefined || value === "") return "—";
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.abs(numeric).toLocaleString("ja-JP") : "—";
    }

    function createTooltip({ row, side, metric, contract = null } = {}) {
        if (!row || (side !== "call" && side !== "put") ||
            (metric !== "openInterest" && metric !== "volume")) return null;
        const value = side === "call" ? row.callOriginal : row.putOriginal;
        return Object.freeze({
            title: `${contract ? `限月 ${contract} / ` : ""}Strike ${row.strike.toLocaleString()}円`,
            label: `${side === "call" ? "CALL" : "PUT"}` +
                `${metric === "volume" ? "取引高" : "建玉残"}：` +
                `${value === null ? "—" : formatAbsolute(value)}枚`
        });
    }

    return Object.freeze({ SAFE_ZERO_RANGE, createModel, nearestStrikeIndex,
        formatAbsolute, createTooltip });
});
