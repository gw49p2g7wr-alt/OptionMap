(function (root, factory) {
    const cacheApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./currentPriceLastValidCache.js") : root?.OptionMapCurrentPriceLastValidCache;
    const api = factory(cacheApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCurrentPriceLiveIdentityFact = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi) {
    "use strict";

    const FACT_VERSION = 1;
    const SOURCE = "qri-nikkei225-futures";
    const MODE = "automatic";

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function clone(value) {
        if (value == null) return value;
        return typeof structuredClone === "function" ? structuredClone(value) :
            JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function canonicalContract(value) {
        const candidate = text(value);
        if (!candidate) return null;
        if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(candidate)) return candidate;
        const match = candidate.match(/^(\d{2}|20\d{2})年\s*(\d{1,2})月限$/);
        if (!match) return null;
        const year = match[1].length === 4 ? match[1] : `20${match[1]}`;
        const month = String(Number(match[2])).padStart(2, "0");
        return `${year}-${month}`;
    }

    function diagnostics(overrides = {}) {
        return { builderUsed: false, validatorPassed: false,
            quoteSignatureVerified: false, versionKeyVerified: false,
            wrapperSignatureVerified: false, currentRequestVerified: false,
            identityVerified: false, acquisitionVerified: false,
            sameDateMappingVerified: false, crossDateRejected: false,
            storageAccessed: false, databaseAccessed: false, fetchTriggered: false,
            runtimeMutated: false, ...overrides };
    }

    function failure(reason, overrides = {}, diagnosticOverrides = {}) {
        return deepFreeze({ factVersion: FACT_VERSION, available: false,
            status: "unavailable", reason, sourceKind: "live", origin: "live", mode: MODE,
            value: null, contract: null, quotedAtRaw: null, quoteDate: null,
            quotedAtNormalized: null, quoteDateResolution: null,
            quoteDateResolutionSource: null, quoteSignature: null, versionKey: null,
            wrapperSignature: null, fetchedAt: null, sourceUrl: null, requestId: null,
            pageTradingDate: null, pageUpdatedAt: null, currentRequestVerified: false,
            identityVerified: false, acquisitionVerified: false,
            quoteIdentity: null, acquisitionIdentity: null,
            qriTradingDateMapping: { status: "unavailable", quoteDate: null,
                qriTradingDate: null, relation: "unknown", mappingVerified: false,
                mappingSource: null }, diagnostics: diagnostics(diagnosticOverrides), ...overrides });
    }

    async function buildCurrentPriceLiveIdentityFact(input = {}) {
        const price = input && typeof input.priceResult === "object" && input.priceResult
            ? clone(input.priceResult) : null;
        if (!price) return failure("missing_input");
        if (price.mode === "manual") return failure("manual_price");
        if (price.restored === true || price.origin === "cache" || price.origin === "saved" ||
            price.mode === "restored" || price.mode === "cache") return failure("restored_price");
        if (price.source !== SOURCE || price.mode !== MODE || price.origin !== "live" ||
            price.available === false) return failure("source_ineligible");
        const value = Number(price.value ?? price.price);
        if (!Number.isFinite(value) || value <= 0) return failure("invalid_value");

        const activeContract = canonicalContract(input.activeContract);
        const priceContract = canonicalContract(price.contract);
        if (!activeContract || !priceContract || activeContract !== priceContract) {
            return failure("contract_mismatch");
        }
        const requestId = text(input.requestId);
        if (!requestId) return failure("acquisition_unverified");
        if (input.isCurrentRequest !== true) {
            return failure("stale_request", {}, { currentRequestVerified: false });
        }
        const fetchedAt = text(input.fetchedAt ?? price.fetchedAt);
        const sourceUrl = text(input.sourceUrl);
        if (!fetchedAt || !sourceUrl) return failure("acquisition_unverified");
        if (!cacheApi?.buildCurrentPriceLastValidCacheV2 ||
            !cacheApi?.validateCurrentPriceLastValidCacheV2 ||
            !cacheApi?.createQuoteSignatureV2 || !cacheApi?.createVersionKeyV2 ||
            !cacheApi?.createSignatureV2) return failure("identity_unverified");

        let built;
        try {
            built = await cacheApi.buildCurrentPriceLastValidCacheV2({ source: price.source,
                mode: price.mode, value, contract: activeContract,
                pageTradingDate: input.pageTradingDate, pageUpdatedAt: input.pageUpdatedAt,
                quotedAtRaw: price.quotedAtRaw ?? price.quotedAt,
                fetchedAt, sourceUrl });
        } catch (_) {
            return failure("identity_unverified", {}, { builderUsed: true,
                currentRequestVerified: true });
        }
        if (!built?.success || !built.cache) {
            const resolutionFailure = /quoted|quote_|page_updated|page_trading/.test(built?.reason || "");
            return failure(resolutionFailure ? "quote_resolution_failed" : "identity_unverified",
                {}, { builderUsed: true, currentRequestVerified: true });
        }
        const cache = built.cache;
        let validatorPassed = false;
        let quoteSignatureVerified = false;
        let versionKeyVerified = false;
        let wrapperSignatureVerified = false;
        try {
            validatorPassed = await cacheApi.validateCurrentPriceLastValidCacheV2(cache);
            quoteSignatureVerified = cache.quoteSignature ===
                await cacheApi.createQuoteSignatureV2(cache);
            versionKeyVerified = cache.versionKey === await cacheApi.createVersionKeyV2(cache);
            wrapperSignatureVerified = cache.signature === await cacheApi.createSignatureV2(cache);
        } catch (_) { /* fail closed below */ }
        const identityVerified = validatorPassed && quoteSignatureVerified &&
            versionKeyVerified && wrapperSignatureVerified;
        if (!identityVerified) return failure("identity_unverified", {}, { builderUsed: true,
            validatorPassed, quoteSignatureVerified, versionKeyVerified,
            wrapperSignatureVerified, currentRequestVerified: true });

        const acquisitionVerified = requestId !== null && fetchedAt === cache.fetchedAt &&
            sourceUrl === cache.sourceUrl && price.origin === "live" && price.mode === MODE;
        if (!acquisitionVerified) return failure("acquisition_unverified", {}, {
            builderUsed: true, validatorPassed, quoteSignatureVerified, versionKeyVerified,
            wrapperSignatureVerified, currentRequestVerified: true, identityVerified });

        const sameDate = cache.quoteDate !== null && cache.quoteDate === cache.pageTradingDate;
        const crossDate = cache.quoteDate !== null && cache.quoteDate < cache.pageTradingDate;
        const relation = sameDate ? "same_date" : crossDate ? "previous_date" :
            cache.quoteDate ? "future_date" : "unresolved";
        const mapping = { status: sameDate ? "verified" : "date_context_unresolved",
            quoteDate: cache.quoteDate, qriTradingDate: cache.pageTradingDate, relation,
            mappingVerified: sameDate, mappingSource: sameDate ? "same_date_explicit" : null };
        const quoteIdentity = { value: cache.value, contract: cache.contract,
            quotedAtRaw: cache.quotedAtRaw, quoteDate: cache.quoteDate,
            quotedAtNormalized: cache.quotedAtNormalized,
            quoteDateResolution: cache.quoteDateResolution,
            quoteDateResolutionSource: cache.quoteDateResolutionSource,
            quoteSignature: cache.quoteSignature, versionKey: cache.versionKey };
        const acquisitionIdentity = { requestId, fetchedAt: cache.fetchedAt,
            sourceUrl: cache.sourceUrl, wrapperSignature: cache.signature };
        return deepFreeze({ factVersion: FACT_VERSION, available: true, status: "available",
            reason: sameDate ? null : "date_context_unresolved", sourceKind: "live",
            origin: "live", mode: MODE, value: cache.value, contract: cache.contract,
            quotedAtRaw: cache.quotedAtRaw, quoteDate: cache.quoteDate,
            quotedAtNormalized: cache.quotedAtNormalized,
            quoteDateResolution: cache.quoteDateResolution,
            quoteDateResolutionSource: cache.quoteDateResolutionSource,
            quoteSignature: cache.quoteSignature, versionKey: cache.versionKey,
            wrapperSignature: cache.signature, fetchedAt: cache.fetchedAt,
            sourceUrl: cache.sourceUrl, requestId, pageTradingDate: cache.pageTradingDate,
            pageUpdatedAt: cache.pageUpdatedAt, currentRequestVerified: true,
            identityVerified, acquisitionVerified, quoteIdentity, acquisitionIdentity,
            qriTradingDateMapping: mapping, diagnostics: diagnostics({ builderUsed: true,
                validatorPassed, quoteSignatureVerified, versionKeyVerified,
                wrapperSignatureVerified, currentRequestVerified: true, identityVerified,
                acquisitionVerified, sameDateMappingVerified: sameDate,
                crossDateRejected: crossDate }) });
    }

    return Object.freeze({ FACT_VERSION, SOURCE, MODE, buildCurrentPriceLiveIdentityFact });
});
