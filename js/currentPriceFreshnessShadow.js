(function (root, factory) {
    const freshnessApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./dataFreshness.js") : root?.OptionMapDataFreshness;
    const api = factory(freshnessApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceFreshnessShadow = api;
})(typeof window !== "undefined" ? window : globalThis, function (freshnessApi) {
    "use strict";

    const ADAPTER_VERSION = 1;
    const QRI_SOURCE = "qri-nikkei225-futures";

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function timestamp(value) {
        const candidate = text(value);
        return candidate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) &&
            Number.isFinite(Date.parse(candidate)) ? candidate : null;
    }

    function date(value) {
        const candidate = text(value);
        if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
        const parsed = new Date(`${candidate}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
            ? candidate : null;
    }

    function quotedDate(value) {
        const validTimestamp = timestamp(value);
        if (!validTimestamp) return null;
        const prefix = validTimestamp.slice(0, 10);
        return date(prefix);
    }

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function buildCurrentPriceFreshnessInput(priceState = {}, context = {}) {
        const numericValue = Number(priceState?.value);
        const hasPrice = Number.isFinite(numericValue) && numericValue > 0;
        const mode = priceState?.mode === "automatic" ? "automatic"
            : priceState?.mode === "manual" ? "manual" : null;
        const source = text(priceState?.source);
        const contract = text(priceState?.contract);
        const quotedAt = timestamp(priceState?.quotedAt);
        const fetchedAt = timestamp(priceState?.fetchedAt);
        const explicitTradingDate = date(context?.dataTradingDate);
        const selectedContract = text(context?.selectedContract);
        const restored = context?.restored === true;
        const invalidFields = [];
        if (priceState?.quotedAt != null && !quotedAt) invalidFields.push("quotedAt");
        if (priceState?.fetchedAt != null && !fetchedAt) invalidFields.push("fetchedAt");
        if (context?.dataTradingDate != null && !explicitTradingDate) invalidFields.push("dataTradingDate");
        if (priceState?.value != null && !hasPrice) invalidFields.push("value");

        return Object.freeze({
            sourceType: "current_price",
            origin: restored ? "cache" : context?.origin === "cache" ? "cache"
                : context?.origin === "runtime" ? "runtime" : "live",
            hasData: hasPrice,
            dataTradingDate: explicitTradingDate || quotedDate(priceState?.quotedAt),
            sourceUpdatedAt: quotedAt,
            quotedAt,
            fetchedAt,
            currentReferenceDate: date(context?.currentReferenceDate),
            expectedTradingDate: date(context?.expectedTradingDate),
            lastAttemptedAt: timestamp(context?.lastAttemptedAt),
            lastAttemptStatus: text(context?.lastAttemptStatus),
            mode,
            contract,
            contractMatches: selectedContract ? contract === selectedContract : undefined,
            validation: hasPrice && mode !== null && invalidFields.length === 0,
            signatureValid: context?.signatureValid === true ? true
                : context?.signatureValid === false ? false : undefined,
            calculationEligible: "undetermined",
            shadowMetadata: Object.freeze({
                adapterVersion: ADAPTER_VERSION,
                value: hasPrice ? numericValue : null,
                source,
                restored,
                selectedContract,
                quotedAtPresent: priceState?.quotedAt != null,
                fetchedAtPresent: priceState?.fetchedAt != null,
                invalidFields: Object.freeze(invalidFields)
            })
        });
    }

    function evaluateCurrentPriceFreshness(priceState = {}, context = {}) {
        const input = buildCurrentPriceFreshnessInput(priceState, context);
        if (!freshnessApi?.evaluateDailyFreshness) {
            return Object.freeze({ available: false, reason: "freshness_api_unavailable",
                input, freshness: null });
        }
        return Object.freeze({ available: true, reason: null, input,
            freshness: freshnessApi.evaluateDailyFreshness(input),
            priceState: clone(priceState) });
    }

    return Object.freeze({ ADAPTER_VERSION, QRI_SOURCE,
        buildCurrentPriceFreshnessInput, evaluateCurrentPriceFreshness });
});
