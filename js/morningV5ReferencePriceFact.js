(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const cacheApi = commonJs ? require("./currentPriceLastValidCache.js") :
        root?.OptionMapCurrentPriceLastValidCache;
    const api = factory(cacheApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5ReferencePriceFact = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi) {
    "use strict";
    const FACT_VERSION = 1;
    const SOURCE = "qri-nikkei225-futures";
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function contract(value) { const candidate = text(value); if (!candidate) return null;
        if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(candidate)) return candidate;
        const match = candidate.match(/^(\d{2}|20\d{2})年\s*(\d{1,2})月限$/); if (!match) return null;
        return `${match[1].length === 4 ? match[1] : `20${match[1]}`}-${String(Number(match[2])).padStart(2, "0")}`; }
    function failure(reason) { return freeze({ factVersion: FACT_VERSION, available: false,
        status: "unavailable", reason, sourceClass: "reference_live", source: SOURCE,
        referenceOnly: true, overallEligible: false, value: null, instrument: null,
        contract: null, quoteDate: null, quotedAtNormalized: null, sourceUrl: null,
        requestId: null, fetchedAt: null, quoteSignature: null, versionKey: null,
        wrapperSignature: null, acquisitionIdentity: null }); }
    async function buildMorningV5ReferencePriceFact(input = {}) {
        const reference = clone(input.referencePrice);
        const value = Number(reference?.value ?? reference?.price);
        const referenceContract = contract(reference?.contract);
        const requestId = text(input.requestId); const fetchedAt = text(input.fetchedAt);
        const sourceUrl = text(input.sourceUrl); const optionContract = contract(input.optionContract);
        if (reference?.available !== true || !Number.isFinite(value) || value <= 0 ||
            !referenceContract || !optionContract) return failure("reference_invalid");
        if (!requestId || input.isCurrentRequest !== true || !fetchedAt || !sourceUrl)
            return failure(input.isCurrentRequest === false ? "stale_request" : "acquisition_unverified");
        const built = await cacheApi?.buildCurrentPriceLastValidCacheV2?.({ source: SOURCE,
            mode: "automatic", value, contract: referenceContract,
            pageTradingDate: input.formalTradingDate, pageUpdatedAt: input.pageUpdatedAt,
            quotedAtRaw: reference.quotedAt, fetchedAt, sourceUrl });
        if (!built?.success || !await cacheApi.validateCurrentPriceLastValidCacheV2(built.cache))
            return failure("identity_unverified");
        const cache = built.cache;
        return freeze({ factVersion: FACT_VERSION, available: true, status: "available",
            reason: null, sourceClass: "reference_live", source: SOURCE, referenceOnly: true,
            overallEligible: false, value: cache.value, instrument: "nikkei225_futures",
            contract: cache.contract, optionContract, formalTradingDate: cache.pageTradingDate,
            quoteDate: cache.quoteDate, quotedAtNormalized: cache.quotedAtNormalized,
            sourceUrl: cache.sourceUrl, requestId, fetchedAt: cache.fetchedAt,
            quoteSignature: cache.quoteSignature, versionKey: cache.versionKey,
            wrapperSignature: cache.signature, acquisitionIdentity: freeze({ requestId,
                fetchedAt: cache.fetchedAt, sourceUrl: cache.sourceUrl,
                wrapperSignature: cache.signature }) });
    }
    async function validateMorningV5ReferencePriceFact(fact) {
        if (!fact || fact.factVersion !== FACT_VERSION || fact.available !== true ||
            fact.status !== "available" || fact.sourceClass !== "reference_live" ||
            fact.source !== SOURCE || fact.referenceOnly !== true || fact.overallEligible !== false ||
            !Number.isFinite(fact.value) || fact.value <= 0 || !contract(fact.contract) ||
            !contract(fact.optionContract) || !text(fact.formalTradingDate) ||
            !text(fact.quoteDate) || !text(fact.quotedAtNormalized) || !text(fact.sourceUrl) ||
            !text(fact.requestId) || !text(fact.fetchedAt) || !text(fact.quoteSignature) ||
            !text(fact.versionKey) || !text(fact.wrapperSignature)) return false;
        return fact.acquisitionIdentity?.requestId === fact.requestId &&
            fact.acquisitionIdentity?.fetchedAt === fact.fetchedAt &&
            fact.acquisitionIdentity?.sourceUrl === fact.sourceUrl &&
            fact.acquisitionIdentity?.wrapperSignature === fact.wrapperSignature;
    }
    return freeze({ FACT_VERSION, SOURCE, buildMorningV5ReferencePriceFact,
        validateMorningV5ReferencePriceFact });
});
