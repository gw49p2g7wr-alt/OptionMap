(function (root, factory) {
    const ivApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv;
    const api = factory(ivApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriIvGraphViewModel = api;
})(typeof window !== "undefined" ? window : globalThis, function (ivApi) {
    "use strict";

    const VIEW_MODEL_VERSION = 1;
    const RANGE_MODES = Object.freeze({
        plus_minus_3000: Object.freeze({ radius: 3000, label: "±3,000円" }),
        plus_minus_5000: Object.freeze({ radius: 5000, label: "±5,000円" }),
        all: Object.freeze({ radius: null, label: "全範囲" })
    });

    function unavailable(reason, rangeMode, currentPrice) {
        const range = RANGE_MODES[rangeMode] || null;
        return {
            viewModelVersion: VIEW_MODEL_VERSION,
            available: false,
            reason,
            chartAvailable: false,
            state: "unavailable",
            message: null,
            metadata: {
                contract: null,
                tradingDate: null,
                pageUpdatedAt: null,
                valueUnit: null,
                rangeMode: range ? rangeMode : null,
                rangeLabel: range?.label || null
            },
            currentPrice: Number.isFinite(currentPrice) && currentPrice > 0
                ? currentPrice : null,
            currentPriceAvailable: Number.isFinite(currentPrice) && currentPrice > 0,
            labels: [],
            strikeUniverse: [],
            series: { call: null, put: null }
        };
    }

    function sideSeries(optionType, strikes, byKey) {
        const values = [];
        const invalidStrikes = [];
        let availablePoints = 0; let missingPoints = 0; let invalidPoints = 0;
        for (const strike of strikes) {
            const record = byKey.get(`${optionType}|${strike}`);
            if (record.iv.status === "available") {
                values.push(record.iv.value); availablePoints += 1;
            } else {
                values.push(null);
                if (record.iv.status === "invalid") {
                    invalidPoints += 1; invalidStrikes.push(strike);
                } else missingPoints += 1;
            }
        }
        const state = availablePoints === 0 ? "empty"
            : availablePoints === 1 ? "point_only" : "line_and_point";
        const message = availablePoints === 0 ? "IV公表データなし"
            : availablePoints === 1 ? "IVデータ1点のみ"
                : missingPoints > 0 || invalidPoints > 0 ? "公表点のみ表示" : null;
        return {
            optionType,
            labels: strikes.slice(),
            values,
            strikeCount: strikes.length,
            availablePoints,
            missingPoints,
            invalidPoints,
            invalidStrikes,
            coverageRatio: strikes.length > 0 ? availablePoints / strikes.length : 0,
            state,
            message
        };
    }

    function build(input = {}) {
        const { canonical, rangeMode, currentPrice } = input;
        if (!RANGE_MODES[rangeMode]) return unavailable("range_mode_invalid", rangeMode, currentPrice);
        if (!canonical) return unavailable("data_unavailable", rangeMode, currentPrice);
        if (!ivApi?.validateCanonical?.(canonical)) {
            return unavailable("canonical_invalid", rangeMode, currentPrice);
        }
        const range = RANGE_MODES[rangeMode];
        const priceValid = Number.isFinite(currentPrice) && currentPrice > 0;
        if (range.radius !== null && !priceValid) {
            return unavailable("current_price_invalid", rangeMode, currentPrice);
        }
        const allStrikes = [...new Set(canonical.records.map(record => record.strike))]
            .filter(strike => strike % 500 === 0)
            .sort((left, right) => left - right);
        const strikes = range.radius === null ? allStrikes : allStrikes.filter(strike =>
            strike >= currentPrice - range.radius && strike <= currentPrice + range.radius);
        const byKey = new Map(canonical.records.map(record =>
            [`${record.optionType}|${record.strike}`, record]));
        const call = sideSeries("call", strikes, byKey);
        const put = sideSeries("put", strikes, byKey);
        const bothEmpty = call.availablePoints === 0 && put.availablePoints === 0;
        const oneEmpty = call.availablePoints === 0 || put.availablePoints === 0;
        return {
            viewModelVersion: VIEW_MODEL_VERSION,
            available: true,
            reason: null,
            chartAvailable: !bothEmpty,
            state: bothEmpty ? "empty" : oneEmpty ? "partial" : "available",
            message: bothEmpty ? "この範囲にはIV公表データがありません" : null,
            metadata: {
                contract: canonical.contract,
                tradingDate: canonical.tradingDate,
                pageUpdatedAt: canonical.pageUpdatedAt,
                valueUnit: canonical.valueUnit,
                rangeMode,
                rangeLabel: range.label
            },
            currentPrice: priceValid ? currentPrice : null,
            currentPriceAvailable: priceValid,
            labels: strikes.slice(),
            strikeUniverse: strikes.slice(),
            series: { call, put }
        };
    }

    return Object.freeze({ VIEW_MODEL_VERSION, RANGE_MODES, build });
});
