(function (root, factory) {
    const ivApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./qriOptionIv.js") : root?.OptionMapQriOptionIv;
    const api = factory(ivApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionIvLastValidCache = api;
})(typeof window !== "undefined" ? window : globalThis, function (ivApi) {
    "use strict";

    const CACHE_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const VERSION_PREFIX = "qri-option-iv-last-valid-v1";
    const STORAGE_KEY_CANDIDATE = "optionMapQriOptionIvLastValidV1";
    const CACHE_FIELDS = Object.freeze(["cacheVersion", "schemaVersion", "canonical",
        "canonicalSignature", "canonicalVersionKey", "fetchedAt", "requestContext",
        "signatureAlgorithm", "signature", "versionKey"]);
    const CONTEXT_FIELDS = Object.freeze(["channel", "mode", "acquisitionOrigin",
        "activeContract", "requestId"]);

    function clone(value) {
        return typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }

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
        return {
            channel: text(input.channel),
            mode: text(input.mode),
            acquisitionOrigin: text(input.acquisitionOrigin),
            activeContract: text(input.activeContract),
            requestId: text(input.requestId)
        };
    }

    function validContext(context, canonical) {
        return exactFields(context, CONTEXT_FIELDS) && context.channel === "active" &&
            ["auto", "automatic"].includes(context.mode) &&
            context.acquisitionOrigin === "live" &&
            context.activeContract === canonical.contract && Boolean(context.requestId);
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
        return {
            cacheVersion: cache.cacheVersion,
            schemaVersion: cache.schemaVersion,
            canonicalSignature: cache.canonicalSignature,
            canonicalVersionKey: cache.canonicalVersionKey,
            fetchedAt: cache.fetchedAt,
            requestContext: cache.requestContext,
            signatureAlgorithm: cache.signatureAlgorithm
        };
    }

    async function createSignature(cache) {
        return sha256(signedContent(cache));
    }

    function createVersionKey(cache) {
        return `${VERSION_PREFIX}|${cache.canonical.contract}|${cache.canonicalVersionKey}`;
    }

    async function validateQriOptionIvLastValidCache(cache) {
        if (!exactFields(cache, CACHE_FIELDS) || cache.cacheVersion !== CACHE_VERSION ||
            cache.schemaVersion !== SCHEMA_VERSION ||
            cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^[a-f0-9]{64}$/.test(cache.canonicalSignature || "") ||
            !/^[a-f0-9]{64}$/.test(cache.signature || "") ||
            !text(cache.canonicalVersionKey) || !text(cache.versionKey) ||
            !timestamp(cache.fetchedAt) || !ivApi?.validateCanonical?.(cache.canonical) ||
            !validContext(cache.requestContext, cache.canonical)) return false;
        const canonicalSignature = await ivApi.createSignature(cache.canonical);
        const canonicalVersionKey = await ivApi.createVersionKey(cache.canonical);
        if (canonicalSignature !== cache.canonicalSignature ||
            canonicalVersionKey !== cache.canonicalVersionKey) return false;
        if (cache.signature !== await createSignature(cache)) return false;
        return cache.versionKey === createVersionKey(cache);
    }

    function reject(reason) {
        return deepFreeze({ success: false, reason, cache: null });
    }

    async function buildQriOptionIvLastValidCache(input = {}) {
        if (input.channel !== "active") return reject("active_channel_required");
        const mode = text(input.requestContext?.mode || input.mode);
        if (!["auto", "automatic"].includes(mode)) return reject("automatic_mode_required");
        if ((input.acquisitionOrigin || "live") !== "live" || input.restored === true) {
            return reject("live_acquisition_required");
        }
        if (input.status === "stale_ignored") return reject("stale_ignored");
        if (input.sourceStatus !== "acquired" || input.available !== true) {
            return reject("source_not_acquired");
        }
        const canonical = input.canonical;
        if (!ivApi?.validateCanonical?.(canonical)) return reject("canonical_invalid");
        const activeContract = text(input.activeContract);
        if (!activeContract || activeContract !== canonical.contract) {
            return reject("contract_mismatch");
        }
        const fetchedAt = timestamp(input.fetchedAt);
        if (!fetchedAt) return reject("fetched_at_invalid");
        const canonicalSignature = await ivApi.createSignature(canonical);
        const canonicalVersionKey = await ivApi.createVersionKey(canonical);
        if (canonicalSignature !== input.canonicalSignature ||
            canonicalVersionKey !== input.canonicalVersionKey) {
            return reject("canonical_identity_mismatch");
        }
        const requestContext = normalizedContext({ channel: input.channel, mode,
            acquisitionOrigin: "live", activeContract,
            requestId: input.requestContext?.requestId });
        if (!validContext(requestContext, canonical)) return reject("request_context_invalid");
        const candidate = {
            cacheVersion: CACHE_VERSION,
            schemaVersion: SCHEMA_VERSION,
            canonical: clone(canonical),
            canonicalSignature,
            canonicalVersionKey,
            fetchedAt,
            requestContext,
            signatureAlgorithm: SIGNATURE_ALGORITHM,
            signature: "",
            versionKey: ""
        };
        candidate.signature = await createSignature(candidate);
        candidate.versionKey = createVersionKey(candidate);
        if (!await validateQriOptionIvLastValidCache(candidate)) {
            return reject("cache_validation_failed");
        }
        return deepFreeze({ success: true, reason: null, cache: clone(candidate) });
    }

    async function createFreshnessInput(cache) {
        if (!await validateQriOptionIvLastValidCache(cache)) {
            return deepFreeze({ success: false, reason: "cache_invalid", input: null });
        }
        return deepFreeze({ success: true, reason: null, input: {
            policyType: "daily",
            sourceType: "qri_option_iv",
            origin: "cache",
            hasData: true,
            dataTradingDate: cache.canonical.tradingDate,
            sourceUpdatedAt: cache.canonical.pageUpdatedAt,
            fetchedAt: cache.fetchedAt,
            mode: "automatic",
            contract: cache.canonical.contract,
            validation: true,
            signatureValid: true,
            displayEligible: true,
            calculationEligible: "undetermined"
        } });
    }

    return Object.freeze({ CACHE_VERSION, SCHEMA_VERSION, SIGNATURE_ALGORITHM,
        VERSION_PREFIX, STORAGE_KEY_CANDIDATE, CACHE_FIELDS, CONTEXT_FIELDS,
        buildQriOptionIvLastValidCache, validateQriOptionIvLastValidCache,
        createSignature, createVersionKey, createFreshnessInput });
});
