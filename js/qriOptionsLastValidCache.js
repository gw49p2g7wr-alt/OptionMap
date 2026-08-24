(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const qriApi = commonJs ? require("./qriOptions.js") : root?.OptionMapQriOptions;
    const api = factory(qriApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsLastValidCache = api;
})(typeof window !== "undefined" ? window : globalThis, function (qriApi) {
    "use strict";

    const CACHE_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const VERSION_PREFIX = "qri-options-last-valid-v1";
    const STORAGE_KEY_CANDIDATE = "optionMapQriOptionsLastValidV1";
    const CACHE_FIELDS = Object.freeze(["cacheVersion", "schemaVersion", "canonical",
        "canonicalSignature", "canonicalVersionKey", "fetchedAt", "requestContext",
        "signatureAlgorithm", "signature", "versionKey"]);
    const CONTEXT_FIELDS = Object.freeze(["channel", "mode", "acquisitionOrigin",
        "requestId", "requestedContract", "responseContract"]);

    const clone = value => typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function timestamp(value) {
        const candidate = text(value);
        return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
    }

    function exactFields(value, fields) {
        return value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).sort().join("|") === [...fields].sort().join("|");
    }

    function normalizedContext(input = {}) {
        return { channel: text(input.channel), mode: text(input.mode),
            acquisitionOrigin: text(input.acquisitionOrigin), requestId: text(input.requestId),
            requestedContract: text(input.requestedContract),
            responseContract: text(input.responseContract) };
    }

    function validContext(context, canonical) {
        return exactFields(context, CONTEXT_FIELDS) && context.channel === "active" &&
            context.mode === "auto" && context.acquisitionOrigin === "live" &&
            Boolean(context.requestId) && context.requestedContract === "auto" &&
            context.responseContract === canonical.contract;
    }

    function publishedCounts(canonical) {
        const records = Array.isArray(canonical?.records) ? canonical.records : [];
        return { call: records.filter(record => record.optionType === "call" &&
            record.published === true).length,
        put: records.filter(record => record.optionType === "put" &&
            record.published === true).length };
    }

    function fullyAvailable(canonical) {
        const counts = publishedCounts(canonical);
        return canonical?.openInterestStatus === "available" && counts.call > 0 && counts.put > 0;
    }

    async function sha256(value) {
        const serialized = JSON.stringify(value);
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest(
                "SHA-256", new TextEncoder().encode(serialized));
            return [...new Uint8Array(digest)]
                .map(byte => byte.toString(16).padStart(2, "0")).join("");
        }
        return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
    }

    function signedContent(cache) {
        return { cacheVersion: cache.cacheVersion, schemaVersion: cache.schemaVersion,
            canonicalSignature: cache.canonicalSignature,
            canonicalVersionKey: cache.canonicalVersionKey, fetchedAt: cache.fetchedAt,
            requestContext: cache.requestContext, signatureAlgorithm: cache.signatureAlgorithm };
    }

    const createSignature = cache => sha256(signedContent(cache));
    const createVersionKey = cache =>
        `${VERSION_PREFIX}|${cache.canonical.contract}|${cache.canonicalVersionKey}`;

    async function formalIdentity(canonical, fetchedAt) {
        const formal = await qriApi?.createCacheV2?.(canonical, fetchedAt);
        if (!formal || !await qriApi?.validateCacheV2?.(formal)) return null;
        return { signature: formal.signature, versionKey: formal.versionKey };
    }

    async function validateQriOptionsLastValidCache(cache) {
        try {
            if (!exactFields(cache, CACHE_FIELDS) || cache.cacheVersion !== CACHE_VERSION ||
                cache.schemaVersion !== SCHEMA_VERSION ||
                cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
                !/^[a-f0-9]{64}$/.test(cache.canonicalSignature || "") ||
                !/^[a-f0-9]{64}$/.test(cache.signature || "") ||
                !text(cache.canonicalVersionKey) || !text(cache.versionKey) ||
                !timestamp(cache.fetchedAt) ||
                !qriApi?.validateCanonical?.(cache.canonical, { allowUnresolvedContracts: true }) ||
                !fullyAvailable(cache.canonical) ||
                !validContext(cache.requestContext, cache.canonical)) return false;
            const identity = await formalIdentity(cache.canonical, cache.fetchedAt);
            if (!identity || identity.signature !== cache.canonicalSignature ||
                identity.versionKey !== cache.canonicalVersionKey) return false;
            if (cache.signature !== await createSignature(cache)) return false;
            return cache.versionKey === createVersionKey(cache);
        } catch (_error) { return false; }
    }

    function diagnostics(input = {}, canonical = null) {
        const counts = publishedCounts(canonical);
        return { cacheVersion: CACHE_VERSION, schemaVersion: SCHEMA_VERSION,
            channel: input.channel ?? input.requestContext?.channel ?? null,
            mode: input.mode ?? input.requestContext?.mode ?? null,
            acquisitionOrigin: input.acquisitionOrigin ??
                input.requestContext?.acquisitionOrigin ?? null,
            canonicalValid: Boolean(canonical && qriApi?.validateCanonical?.(
                canonical, { allowUnresolvedContracts: true })),
            openInterestStatus: canonical?.openInterestStatus || null,
            publishedCallCount: counts.call, publishedPutCount: counts.put };
    }

    function reject(reason, input, canonical) {
        return deepFreeze({ success: false, reason, cache: null,
            diagnostics: diagnostics(input, canonical) });
    }

    async function buildQriOptionsLastValidCache(input = {}) {
        const canonical = input.canonical;
        try {
            const channel = text(input.channel || input.requestContext?.channel);
            if (channel !== "active") return reject("active_channel_required", input, canonical);
            const mode = text(input.mode || input.requestContext?.mode);
            if (mode !== "auto") return reject("automatic_mode_required", input, canonical);
            const origin = text(input.acquisitionOrigin ||
                input.requestContext?.acquisitionOrigin);
            if (origin !== "live" || input.restored === true) {
                return reject("live_acquisition_required", input, canonical);
            }
            if (input.status === "stale_ignored" || input.isCurrent !== true) {
                return reject("stale_ignored", input, canonical);
            }
            if (input.sourceStatus !== "acquired" || input.available !== true) {
                return reject("source_not_acquired", input, canonical);
            }
            if (!qriApi?.validateCanonical?.(canonical, { allowUnresolvedContracts: true })) {
                return reject("canonical_invalid", input, canonical);
            }
            if (!fullyAvailable(canonical)) {
                return reject("open_interest_not_fully_available", input, canonical);
            }
            const fetchedAt = timestamp(input.fetchedAt);
            if (!fetchedAt) return reject("fetched_at_invalid", input, canonical);
            const activeContract = text(input.activeContract);
            const responseContract = text(input.responseContract ||
                input.requestContext?.responseContract);
            if (!activeContract || activeContract !== canonical.contract ||
                responseContract !== canonical.contract) {
                return reject("contract_mismatch", input, canonical);
            }
            const identity = await formalIdentity(canonical, fetchedAt);
            if (!identity) return reject("canonical_identity_invalid", input, canonical);
            if ((input.canonicalSignature && input.canonicalSignature !== identity.signature) ||
                (input.canonicalVersionKey && input.canonicalVersionKey !== identity.versionKey)) {
                return reject("canonical_identity_mismatch", input, canonical);
            }
            const requestContext = normalizedContext({ channel, mode,
                acquisitionOrigin: origin, requestId: input.requestId ||
                    input.requestContext?.requestId,
                requestedContract: input.requestedContract ||
                    input.requestContext?.requestedContract,
                responseContract });
            if (!validContext(requestContext, canonical)) {
                return reject("request_context_invalid", input, canonical);
            }
            const candidate = { cacheVersion: CACHE_VERSION, schemaVersion: SCHEMA_VERSION,
                canonical: clone(canonical), canonicalSignature: identity.signature,
                canonicalVersionKey: identity.versionKey, fetchedAt, requestContext,
                signatureAlgorithm: SIGNATURE_ALGORITHM, signature: "", versionKey: "" };
            candidate.signature = await createSignature(candidate);
            candidate.versionKey = createVersionKey(candidate);
            if (!await validateQriOptionsLastValidCache(candidate)) {
                return reject("cache_validation_failed", input, canonical);
            }
            return deepFreeze({ success: true, reason: null, cache: clone(candidate),
                diagnostics: diagnostics(input, canonical) });
        } catch (_error) {
            return reject("builder_exception", input, canonical);
        }
    }

    async function createFreshnessInput(cache) {
        if (!await validateQriOptionsLastValidCache(cache)) {
            return deepFreeze({ success: false, reason: "cache_invalid", input: null });
        }
        return deepFreeze({ success: true, reason: null, input: {
            policyType: "daily", sourceType: "qri_options_open_interest", origin: "cache",
            hasData: true, dataTradingDate: cache.canonical.tradingDate,
            sourceUpdatedAt: cache.canonical.pageUpdatedAt, fetchedAt: cache.fetchedAt,
            mode: "automatic", contract: cache.canonical.contract, validation: true,
            signatureValid: true, displayEligible: true,
            calculationEligible: "undetermined"
        } });
    }

    return Object.freeze({ CACHE_VERSION, SCHEMA_VERSION, SIGNATURE_ALGORITHM,
        VERSION_PREFIX, STORAGE_KEY_CANDIDATE, CACHE_FIELDS, CONTEXT_FIELDS,
        buildQriOptionsLastValidCache, validateQriOptionsLastValidCache,
        createSignature, createVersionKey, createFreshnessInput });
});
