(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsDisplayPositionsAdapter = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const ADAPTER_VERSION = 1;

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function cleanText(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function displayLabel(strike) {
        if (typeof strike !== "number" || !Number.isFinite(strike)) return String(strike ?? "");
        const parts = String(strike).split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return parts.join(".");
    }

    function canonicalRows(positions) {
        const rows = [];
        for (const position of positions) {
            const type = position?.optionType;
            if (type !== "call" && type !== "put") continue;
            const field = type === "call" ? "call" : "put";
            let row = rows.find(item => item.strike === position.strike &&
                item[`${field}Assigned`] === false);
            if (!row) {
                row = { strike: position?.strike ?? null, callOpenInterest: null,
                    putOpenInterest: null, callPublished: false, putPublished: false,
                    callAssigned: false, putAssigned: false };
                rows.push(row);
            }
            const published = position.published === true;
            row[`${field}OpenInterest`] = published ? position.value ?? null : null;
            row[`${field}Published`] = published;
            row[`${field}Assigned`] = true;
        }
        return rows.map(({ callAssigned: _call, putAssigned: _put, ...row }) => row);
    }

    function legacyRows(positions) {
        return positions.map(position => ({ strike: position?.strike ?? null,
            callOpenInterest: position?.callOpenInterest ?? null,
            putOpenInterest: position?.putOpenInterest ?? null,
            callPublished: typeof position?.callPublished === "boolean"
                ? position.callPublished : position?.callOpenInterest != null,
            putPublished: typeof position?.putPublished === "boolean"
                ? position.putPublished : position?.putOpenInterest != null }));
    }

    function rowsFromSource(sourceKind, positions) {
        return sourceKind === "legacy" ? legacyRows(positions) : canonicalRows(positions);
    }

    function buildQriOptionsDisplayPositions(input = {}) {
        const source = input?.displaySourceState || {};
        const sourceKind = cleanText(source.sourceKind) || "unavailable";
        const state = cleanText(source.state) || "unavailable";
        const positions = Array.isArray(source.positions) ? source.positions : [];
        const unavailable = sourceKind === "unavailable";
        const rows = unavailable ? [] : rowsFromSource(sourceKind, positions);
        const metadata = source.metadata || {};
        const sourcePolicy = source.analysisPolicy || {};
        const result = { adapterVersion: ADAPTER_VERSION,
            available: !unavailable && source.available === true,
            sourceKind, state, contract: source.contract ?? metadata.contract ?? null,
            rows,
            labels: rows.map(row => displayLabel(row.strike)),
            callValues: rows.map(row => row.callPublished ? row.callOpenInterest : 0),
            putValues: rows.map(row => row.putPublished ? row.putOpenInterest : 0),
            metadata: { sourceKind, state, contract: metadata.contract ?? source.contract ?? null,
                tradingDate: metadata.tradingDate ?? null,
                pageUpdatedAt: metadata.pageUpdatedAt ?? null,
                fetchedAt: metadata.fetchedAt ?? null, origin: metadata.origin ?? null },
            displayOnly: true,
            analysisPolicy: { allowFormalAnalysis: sourcePolicy.allowFormalAnalysis ?? false,
                allowLegacyAnalysis: sourcePolicy.allowLegacyAnalysis ?? false,
                calculationSourcePolicy: sourcePolicy.calculationSourcePolicy ?? "none",
                reason: sourcePolicy.reason ?? null },
            diagnostics: { sourceKind, sourceState: state,
                inputRowCount: positions.length, outputRowCount: rows.length,
                displayOnly: true, analysisSuppressed: true,
                sourceAnalysisSuppressed: source.diagnostics?.analysisSuppressed ?? null,
                orderingPreserved: true, transformationVersion: ADAPTER_VERSION }
        };
        return deepFreeze(result);
    }

    return Object.freeze({ ADAPTER_VERSION, buildQriOptionsDisplayPositions,
        displayLabel, rowsFromSource });
});
