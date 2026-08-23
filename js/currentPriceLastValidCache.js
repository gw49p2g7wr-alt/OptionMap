(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceLastValidCache = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CACHE_VERSION = 1;
    const SCHEMA_VERSION = 1;
    const SOURCE = "qri-nikkei225-futures";
    const MODE = "automatic";
    const SIGNATURE_ALGORITHM = "sha256";
    const STORAGE_KEY_CANDIDATE = "optionMapCurrentPriceLastValidV1";
    const SCHEMA_VERSION_V2 = 2;
    const QUOTE_DATE_RESOLUTION = "nearest_not_after_page_updated_at";
    const QUOTE_DATE_RESOLUTION_SOURCE = "pageUpdatedAt";
    const UNRESOLVED_QUOTE_DATE = "unresolved";
    const MAX_QUOTE_DISTANCE_DAYS = 7;
    const CACHE_FIELDS = Object.freeze(["cacheVersion", "schemaVersion", "source", "mode", "value",
        "contract", "tradingDate", "quotedAtRaw", "quotedAtNormalized", "fetchedAt", "sourceUrl",
        "signatureAlgorithm", "quoteSignature", "signature", "versionKey"]);
    const CACHE_FIELDS_V2 = Object.freeze(["cacheVersion", "schemaVersion", "source", "mode", "value",
        "contract", "pageTradingDate", "pageUpdatedAt", "quotedAtRaw", "quoteDate",
        "quotedAtNormalized", "quoteDateResolution", "quoteDateResolutionSource", "fetchedAt",
        "sourceUrl", "signatureAlgorithm", "quoteSignature", "signature", "versionKey"]);

    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        Number.isFinite(Date.parse(value));
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function canonicalize(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }

    async function sha256(value) {
        const serialized = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function normalizeQuotedAt(quotedAtRaw, tradingDate) {
        const raw = text(quotedAtRaw);
        if (!raw || !date(tradingDate)) {
            return Object.freeze({ value: null, reason: !raw ? "quoted_at_raw_missing" : "trading_date_invalid" });
        }
        const match = raw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
        if (!match) return Object.freeze({ value: null, reason: "quoted_at_raw_malformed" });
        const month = Number(match[1]); const day = Number(match[2]);
        const hour = Number(match[3]); const minute = Number(match[4]);
        if (hour > 23 || minute > 59) {
            return Object.freeze({ value: null, reason: "quoted_at_time_invalid" });
        }
        const expectedMonth = Number(tradingDate.slice(5, 7));
        const expectedDay = Number(tradingDate.slice(8, 10));
        if (month !== expectedMonth || day !== expectedDay) {
            return Object.freeze({ value: null, reason: "quoted_at_trading_date_mismatch" });
        }
        const normalized = `${tradingDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
        return Object.freeze({ value: timestamp(normalized) ? normalized : null,
            reason: timestamp(normalized) ? null : "quoted_at_calendar_invalid" });
    }

    function validSourceUrl(value) {
        try {
            const parsed = new URL(value);
            return parsed.protocol === "https:" && parsed.hostname === "svc.qri.jp" &&
                parsed.pathname.startsWith("/jpx/nkopm/");
        } catch (_) { return false; }
    }

    function calendarDate(year, month, day) {
        const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        return date(value) ? value : null;
    }

    function resolveQuotedAt({ quotedAtRaw, pageUpdatedAt, pageTradingDate,
        maximumDistanceDays = MAX_QUOTE_DISTANCE_DAYS } = {}) {
        const raw = text(quotedAtRaw);
        if (!raw) return Object.freeze({ success: false, reason: "quoted_at_raw_missing",
            quoteDate: null, quotedAtNormalized: null, distanceDays: null,
            resolution: UNRESOLVED_QUOTE_DATE,
            resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        if (!timestamp(pageUpdatedAt)) {
            return Object.freeze({ success: false, reason: "page_updated_at_invalid",
                quoteDate: null, quotedAtNormalized: null, distanceDays: null,
                resolution: UNRESOLVED_QUOTE_DATE,
                resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        }
        if (!date(pageTradingDate)) {
            return Object.freeze({ success: false, reason: "page_trading_date_invalid",
                quoteDate: null, quotedAtNormalized: null, distanceDays: null,
                resolution: UNRESOLVED_QUOTE_DATE,
                resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        }
        const match = raw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
        if (!match) return Object.freeze({ success: false, reason: "quoted_at_raw_malformed",
            quoteDate: null, quotedAtNormalized: null, distanceDays: null,
            resolution: UNRESOLVED_QUOTE_DATE,
            resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        const month = Number(match[1]); const day = Number(match[2]);
        const hour = Number(match[3]); const minute = Number(match[4]);
        if (hour > 23 || minute > 59) {
            return Object.freeze({ success: false, reason: "quoted_at_time_invalid",
                quoteDate: null, quotedAtNormalized: null, distanceDays: null,
                resolution: UNRESOLVED_QUOTE_DATE,
                resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        }
        const referenceYear = Number(pageUpdatedAt.slice(0, 4));
        const candidates = [referenceYear, referenceYear - 1]
            .map(year => calendarDate(year, month, day))
            .filter(Boolean)
            .map(quoteDate => ({ quoteDate,
                quotedAtNormalized: `${quoteDate}T${String(hour).padStart(2, "0")}:` +
                    `${String(minute).padStart(2, "0")}:00+09:00` }))
            .filter(candidate => timestamp(candidate.quotedAtNormalized) &&
                Date.parse(candidate.quotedAtNormalized) <= Date.parse(pageUpdatedAt))
            .sort((left, right) => Date.parse(right.quotedAtNormalized) -
                Date.parse(left.quotedAtNormalized));
        if (candidates.length === 0) {
            return Object.freeze({ success: false, reason: "quote_date_unresolvable",
                quoteDate: null, quotedAtNormalized: null, distanceDays: null,
                resolution: UNRESOLVED_QUOTE_DATE,
                resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        }
        const selected = candidates[0];
        const distanceDays = (Date.parse(pageUpdatedAt) -
            Date.parse(selected.quotedAtNormalized)) / 86400000;
        if (!Number.isFinite(maximumDistanceDays) || maximumDistanceDays < 0 ||
            distanceDays > maximumDistanceDays) {
            return Object.freeze({ success: false, reason: "quote_distance_exceeded",
                quoteDate: null, quotedAtNormalized: null, distanceDays,
                resolution: UNRESOLVED_QUOTE_DATE,
                resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
        }
        return Object.freeze({ success: true, reason: null, quoteDate: selected.quoteDate,
            quotedAtNormalized: selected.quotedAtNormalized, distanceDays,
            resolution: QUOTE_DATE_RESOLUTION,
            resolutionSource: QUOTE_DATE_RESOLUTION_SOURCE });
    }

    function quoteIdentityV2(cache) {
        return { cacheVersion: cache.cacheVersion, schemaVersion: cache.schemaVersion,
            source: cache.source, mode: cache.mode, value: cache.value, contract: cache.contract,
            quotedAtRaw: cache.quotedAtRaw, quoteDate: cache.quoteDate,
            quotedAtNormalized: cache.quotedAtNormalized,
            quoteDateResolution: cache.quoteDateResolution,
            quoteDateResolutionSource: cache.quoteDateResolutionSource };
    }

    function signedContentV2(cache) {
        return { ...quoteIdentityV2(cache), pageTradingDate: cache.pageTradingDate,
            pageUpdatedAt: cache.pageUpdatedAt, fetchedAt: cache.fetchedAt,
            sourceUrl: cache.sourceUrl, signatureAlgorithm: cache.signatureAlgorithm,
            quoteSignature: cache.quoteSignature };
    }

    async function createQuoteSignatureV2(cache) {
        return sha256(quoteIdentityV2(cache));
    }

    async function createSignatureV2(cache) {
        return sha256(signedContentV2(cache));
    }

    async function createVersionKeyV2(cache) {
        const quoteSignature = await createQuoteSignatureV2(cache);
        return `current-price-last-valid-v1-schema-v2|${cache.contract}|sha256:${quoteSignature}`;
    }

    function validateShapeV2(cache) {
        if (!object(cache) || Object.keys(cache).sort().join("|") !==
            [...CACHE_FIELDS_V2].sort().join("|") || cache.cacheVersion !== CACHE_VERSION ||
            cache.schemaVersion !== SCHEMA_VERSION_V2 || cache.source !== SOURCE ||
            cache.mode !== MODE || typeof cache.value !== "number" ||
            !Number.isFinite(cache.value) || cache.value <= 0 || !text(cache.contract) ||
            !date(cache.pageTradingDate) || !timestamp(cache.pageUpdatedAt) ||
            !text(cache.quotedAtRaw) || !timestamp(cache.fetchedAt) ||
            !validSourceUrl(cache.sourceUrl) || cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^[a-f0-9]{64}$/.test(cache.quoteSignature || "") ||
            !/^[a-f0-9]{64}$/.test(cache.signature || "") || !text(cache.versionKey)) return false;
        const resolved = resolveQuotedAt({ quotedAtRaw: cache.quotedAtRaw,
            pageUpdatedAt: cache.pageUpdatedAt, pageTradingDate: cache.pageTradingDate });
        const resolvedShape = resolved.success && cache.quoteDate === resolved.quoteDate &&
            cache.quotedAtNormalized === resolved.quotedAtNormalized &&
            cache.quoteDateResolution === QUOTE_DATE_RESOLUTION;
        const unresolvedShape = !resolved.success && resolved.reason === "quote_distance_exceeded" &&
            cache.quoteDate === null && cache.quotedAtNormalized === null &&
            cache.quoteDateResolution === UNRESOLVED_QUOTE_DATE;
        return (resolvedShape || unresolvedShape) &&
            cache.quoteDateResolutionSource === QUOTE_DATE_RESOLUTION_SOURCE;
    }

    async function validateCurrentPriceLastValidCacheV2(cache) {
        if (!validateShapeV2(cache)) return false;
        if (cache.quoteSignature !== await createQuoteSignatureV2(cache)) return false;
        if (cache.signature !== await createSignatureV2(cache)) return false;
        return cache.versionKey === await createVersionKeyV2(cache);
    }

    async function buildCurrentPriceLastValidCacheV2(input = {}) {
        const resolution = resolveQuotedAt({ quotedAtRaw: input.quotedAtRaw,
            pageUpdatedAt: input.pageUpdatedAt, pageTradingDate: input.pageTradingDate });
        const canPreserveUnresolved = resolution.reason === "quote_distance_exceeded";
        const candidate = { cacheVersion: CACHE_VERSION, schemaVersion: SCHEMA_VERSION_V2,
            source: text(input.source), mode: text(input.mode), value: Number(input.value),
            contract: text(input.contract), pageTradingDate: text(input.pageTradingDate),
            pageUpdatedAt: text(input.pageUpdatedAt), quotedAtRaw: text(input.quotedAtRaw),
            quoteDate: resolution.success ? resolution.quoteDate : null,
            quotedAtNormalized: resolution.success ? resolution.quotedAtNormalized : null,
            quoteDateResolution: resolution.success ? QUOTE_DATE_RESOLUTION : UNRESOLVED_QUOTE_DATE,
            quoteDateResolutionSource: QUOTE_DATE_RESOLUTION_SOURCE,
            fetchedAt: text(input.fetchedAt), sourceUrl: text(input.sourceUrl),
            signatureAlgorithm: SIGNATURE_ALGORITHM, quoteSignature: "", signature: "", versionKey: "" };
        const diagnostics = Object.freeze({ resolutionReason: resolution.reason,
            quoteDistanceDays: resolution.distanceDays, maximumDistanceDays: MAX_QUOTE_DISTANCE_DAYS });
        if (candidate.source !== SOURCE || candidate.mode !== MODE ||
            !Number.isFinite(candidate.value) || candidate.value <= 0 || !candidate.contract ||
            !date(candidate.pageTradingDate) || !timestamp(candidate.pageUpdatedAt) ||
            !candidate.quotedAtRaw || !timestamp(candidate.fetchedAt) ||
            !validSourceUrl(candidate.sourceUrl) || !resolution.success && !canPreserveUnresolved) {
            return Object.freeze({ success: false, reason: resolution.reason || "input_invalid",
                cache: null, diagnostics });
        }
        candidate.quoteSignature = await createQuoteSignatureV2(candidate);
        candidate.signature = await createSignatureV2(candidate);
        candidate.versionKey = await createVersionKeyV2(candidate);
        if (!await validateCurrentPriceLastValidCacheV2(candidate)) {
            return Object.freeze({ success: false, reason: "cache_validation_failed",
                cache: null, diagnostics });
        }
        return Object.freeze({ success: true, reason: resolution.success ? null : "quote_date_unresolved",
            cache: Object.freeze(clone(candidate)), diagnostics });
    }

    function quoteIdentity(cache) {
        return { cacheVersion: cache.cacheVersion, schemaVersion: cache.schemaVersion,
            source: cache.source, mode: cache.mode, value: cache.value, contract: cache.contract,
            tradingDate: cache.tradingDate, quotedAtRaw: cache.quotedAtRaw,
            quotedAtNormalized: cache.quotedAtNormalized, sourceUrl: cache.sourceUrl };
    }

    function signedContent(cache) {
        return { ...quoteIdentity(cache), fetchedAt: cache.fetchedAt,
            signatureAlgorithm: cache.signatureAlgorithm, quoteSignature: cache.quoteSignature };
    }

    async function createQuoteSignature(cache) {
        return sha256(quoteIdentity(cache));
    }

    async function createSignature(cache) {
        return sha256(signedContent(cache));
    }

    async function createVersionKey(cache) {
        const quoteSignature = await createQuoteSignature(cache);
        return `current-price-last-valid-v1|${cache.contract}|${cache.tradingDate}|` +
            `${cache.quotedAtNormalized}|sha256:${quoteSignature}`;
    }

    function validateShape(cache) {
        if (!object(cache) || Object.keys(cache).sort().join("|") !== [...CACHE_FIELDS].sort().join("|") ||
            cache.cacheVersion !== CACHE_VERSION ||
            cache.schemaVersion !== SCHEMA_VERSION || cache.source !== SOURCE || cache.mode !== MODE ||
            typeof cache.value !== "number" || !Number.isFinite(cache.value) || cache.value <= 0 ||
            !text(cache.contract) || !date(cache.tradingDate) || !text(cache.quotedAtRaw) ||
            !timestamp(cache.quotedAtNormalized) || !timestamp(cache.fetchedAt) ||
            !validSourceUrl(cache.sourceUrl) || cache.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^[a-f0-9]{64}$/.test(cache.quoteSignature || "") ||
            !/^[a-f0-9]{64}$/.test(cache.signature || "") || !text(cache.versionKey)) return false;
        const normalized = normalizeQuotedAt(cache.quotedAtRaw, cache.tradingDate);
        return normalized.value === cache.quotedAtNormalized;
    }

    async function validateCurrentPriceLastValidCache(cache) {
        if (!validateShape(cache)) return false;
        const expectedQuoteSignature = await createQuoteSignature(cache);
        if (cache.quoteSignature !== expectedQuoteSignature) return false;
        if (cache.signature !== await createSignature(cache)) return false;
        return cache.versionKey === await createVersionKey(cache);
    }

    async function buildCurrentPriceLastValidCache(input = {}) {
        const normalization = normalizeQuotedAt(input.quotedAtRaw, input.tradingDate);
        const candidate = {
            cacheVersion: CACHE_VERSION,
            schemaVersion: SCHEMA_VERSION,
            source: text(input.source), mode: text(input.mode), value: Number(input.value),
            contract: text(input.contract), tradingDate: text(input.tradingDate),
            quotedAtRaw: text(input.quotedAtRaw), quotedAtNormalized: normalization.value,
            fetchedAt: text(input.fetchedAt), sourceUrl: text(input.sourceUrl),
            signatureAlgorithm: SIGNATURE_ALGORITHM, quoteSignature: "", signature: "", versionKey: ""
        };
        const diagnostics = Object.freeze({ quotedAtNormalizationReason: normalization.reason });
        if (candidate.source !== SOURCE || candidate.mode !== MODE ||
            typeof candidate.value !== "number" || !Number.isFinite(candidate.value) || candidate.value <= 0 ||
            !candidate.contract || !date(candidate.tradingDate) || !normalization.value ||
            !timestamp(candidate.fetchedAt) || !validSourceUrl(candidate.sourceUrl)) {
            return Object.freeze({ success: false, reason: normalization.reason || "input_invalid",
                cache: null, diagnostics });
        }
        candidate.quoteSignature = await createQuoteSignature(candidate);
        candidate.signature = await createSignature(candidate);
        candidate.versionKey = await createVersionKey(candidate);
        if (!await validateCurrentPriceLastValidCache(candidate)) {
            return Object.freeze({ success: false, reason: "cache_validation_failed", cache: null, diagnostics });
        }
        return Object.freeze({ success: true, reason: null, cache: Object.freeze(clone(candidate)), diagnostics });
    }

    return Object.freeze({ CACHE_VERSION, SCHEMA_VERSION, SOURCE, MODE, SIGNATURE_ALGORITHM,
        STORAGE_KEY_CANDIDATE, normalizeQuotedAt, buildCurrentPriceLastValidCache,
        validateCurrentPriceLastValidCache, createQuoteSignature, createSignature, createVersionKey,
        SCHEMA_VERSION_V2, QUOTE_DATE_RESOLUTION, QUOTE_DATE_RESOLUTION_SOURCE,
        UNRESOLVED_QUOTE_DATE, MAX_QUOTE_DISTANCE_DAYS, resolveQuotedAt,
        buildCurrentPriceLastValidCacheV2, validateCurrentPriceLastValidCacheV2,
        createQuoteSignatureV2, createSignatureV2, createVersionKeyV2 });
});
