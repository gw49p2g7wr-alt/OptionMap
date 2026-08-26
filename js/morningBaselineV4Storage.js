(function (root, factory) {
    const baselineApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./morningBaselineV4.js") : root?.OptionMapMorningBaselineV4;
    const api = factory(baselineApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4StorageFoundation = api;
})(typeof window !== "undefined" ? window : globalThis, function (baselineApi) {
    "use strict";

    const STORAGE_VERSION = 1;
    const BASELINE_VERSION = 4;
    const STORAGE_KEY = "optionMapMorningBaselinesV4";
    const STORAGE_FIELDS = Object.freeze(["storageVersion", "baselineVersion", "series"]);
    const SERIES_FIELDS = Object.freeze(["scopeId", "formalTradingDate", "contract",
        "activeBaselineId", "revisions"]);
    const REVISION_FIELDS = Object.freeze(["baselineId", "contentSignature", "versionKey",
        "capturedAt", "replacedAt", "snapshot"]);

    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
        fields.every(field => Object.hasOwn(value, field));
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function failure(reason, status = "invalid") {
        return deepFreeze({ success: false, status, reason, changed: false,
            duplicate: false, container: null, serialized: null });
    }

    function success(container, overrides = {}) {
        return deepFreeze({ success: true, status: "ready", reason: null, changed: true,
            duplicate: false, container: deepFreeze(clone(container)), serialized: null, ...overrides });
    }

    function revisionFrom(baseline) {
        return { baselineId: baseline.baselineId, contentSignature: baseline.contentSignature,
            versionKey: baseline.versionKey, capturedAt: baseline.capturedAt,
            replacedAt: null, snapshot: clone(baseline) };
    }

    function scopeFrom(baseline) {
        return { scopeId: baseline.marketContext.sessionIdentity,
            formalTradingDate: baseline.marketContext.formalTradingDate,
            contract: baseline.qri.contract, activeBaselineId: baseline.baselineId,
            revisions: [revisionFrom(baseline)] };
    }

    function normalize(container) {
        return { storageVersion: container.storageVersion, baselineVersion: container.baselineVersion,
            series: container.series.map(series => ({ scopeId: series.scopeId,
                formalTradingDate: series.formalTradingDate, contract: series.contract,
                activeBaselineId: series.activeBaselineId,
                revisions: series.revisions.map(revision => ({ baselineId: revision.baselineId,
                    contentSignature: revision.contentSignature, versionKey: revision.versionKey,
                    capturedAt: revision.capturedAt, replacedAt: revision.replacedAt,
                    snapshot: clone(revision.snapshot) })) })) };
    }

    async function validateStorageValue(container) {
        if (!exact(container, STORAGE_FIELDS) || container.storageVersion !== STORAGE_VERSION ||
            container.baselineVersion !== BASELINE_VERSION || !Array.isArray(container.series)) return false;
        const scopeIds = new Set();
        for (const series of container.series) {
            if (!exact(series, SERIES_FIELDS) || !text(series.scopeId) ||
                !/^\d{4}-\d{2}-\d{2}$/.test(series.formalTradingDate || "") ||
                !text(series.contract) || !text(series.activeBaselineId) ||
                !Array.isArray(series.revisions) || series.revisions.length === 0 ||
                scopeIds.has(series.scopeId)) return false;
            scopeIds.add(series.scopeId);
            const ids = new Set(); const contents = new Set(); let activeCount = 0;
            for (let index = 0; index < series.revisions.length; index += 1) {
                const revision = series.revisions[index]; const next = series.revisions[index + 1];
                if (!exact(revision, REVISION_FIELDS) || !text(revision.baselineId) ||
                    !text(revision.contentSignature) || !text(revision.versionKey) ||
                    !timestamp(revision.capturedAt) || revision.replacedAt !== null &&
                        !timestamp(revision.replacedAt) || ids.has(revision.baselineId) ||
                    contents.has(`${revision.contentSignature}|${revision.versionKey}`) ||
                    !await baselineApi?.validateMorningBaselineV4?.(revision.snapshot)) return false;
                ids.add(revision.baselineId); contents.add(`${revision.contentSignature}|${revision.versionKey}`);
                const snapshot = revision.snapshot;
                if (revision.baselineId !== snapshot.baselineId ||
                    revision.contentSignature !== snapshot.contentSignature ||
                    revision.versionKey !== snapshot.versionKey || revision.capturedAt !== snapshot.capturedAt ||
                    snapshot.marketContext.sessionMappingStatus !== "verified" ||
                    snapshot.marketContext.sessionIdentity !== series.scopeId ||
                    snapshot.marketContext.formalTradingDate !== series.formalTradingDate ||
                    snapshot.qri.contract !== series.contract) return false;
                if (revision.baselineId === series.activeBaselineId) {
                    activeCount += 1; if (revision.replacedAt !== null || next) return false;
                } else if (revision.replacedAt === null ||
                    !next || revision.replacedAt !== next.capturedAt) return false;
                if (next && Date.parse(revision.capturedAt) >= Date.parse(next.capturedAt)) return false;
            }
            if (activeCount !== 1) return false;
        }
        return true;
    }

    async function validateMorningBaselineV4Storage(container) {
        try { return await validateStorageValue(container); }
        catch (_error) { return false; }
    }

    async function buildMorningBaselineV4Storage({ baseline, existingContainer = null } = {}) {
        let baselineValid = false;
        try { baselineValid = await baselineApi?.validateMorningBaselineV4?.(baseline) === true; }
        catch (_error) { baselineValid = false; }
        if (!baselineValid) return failure("invalid_baseline");
        if (baseline.marketContext.sessionMappingStatus !== "verified" ||
            !text(baseline.marketContext.sessionIdentity)) return failure("session_unverified");
        let container;
        if (existingContainer === null) {
            container = { storageVersion: STORAGE_VERSION, baselineVersion: BASELINE_VERSION, series: [] };
        } else {
            if (!await validateMorningBaselineV4Storage(existingContainer))
                return failure("invalid_storage_container");
            container = normalize(existingContainer);
        }
        const scopeId = baseline.marketContext.sessionIdentity;
        const series = container.series.find(item => item.scopeId === scopeId);
        if (!series) container.series.push(scopeFrom(baseline));
        else {
            if (series.formalTradingDate !== baseline.marketContext.formalTradingDate ||
                series.contract !== baseline.qri.contract) return failure("scope_identity_mismatch");
            const duplicate = series.revisions.find(revision =>
                revision.contentSignature === baseline.contentSignature &&
                revision.versionKey === baseline.versionKey);
            if (duplicate) return success(container, { status: "unchanged", changed: false,
                duplicate: true });
            const active = series.revisions.find(revision => revision.baselineId === series.activeBaselineId);
            if (!active || Date.parse(baseline.capturedAt) <= Date.parse(active.capturedAt))
                return failure("stale_capture");
            active.replacedAt = baseline.capturedAt;
            series.revisions.push(revisionFrom(baseline));
            series.activeBaselineId = baseline.baselineId;
        }
        if (!await validateMorningBaselineV4Storage(container)) return failure("invalid_storage_container");
        return success(container);
    }

    async function serializeMorningBaselineV4Storage(container, { stringify } = {}) {
        if (!await validateMorningBaselineV4Storage(container)) return failure("invalid_storage_container");
        try {
            const serializer = typeof stringify === "function" ? stringify : baselineApi.canonicalize;
            const serialized = serializer(normalize(container));
            if (typeof serialized !== "string" || !serialized) return failure("serialization_failed");
            return success(container, { status: "serialized", changed: false, serialized });
        } catch (_error) { return failure("serialization_failed"); }
    }

    async function restoreMorningBaselineV4Storage(serialized) {
        if (serialized === null || serialized === undefined || serialized === "")
            return failure("missing", "missing");
        let parsed;
        try { parsed = typeof serialized === "string" ? JSON.parse(serialized) : clone(serialized); }
        catch (_error) { return failure("parse_failed"); }
        if (!await validateMorningBaselineV4Storage(parsed)) return failure("invalid_storage_container");
        return success(normalize(parsed), { status: "ready", changed: false });
    }

    return Object.freeze({ STORAGE_VERSION, BASELINE_VERSION, STORAGE_KEY, STORAGE_FIELDS,
        SERIES_FIELDS, REVISION_FIELDS, validateMorningBaselineV4Storage,
        buildMorningBaselineV4Storage, serializeMorningBaselineV4Storage,
        restoreMorningBaselineV4Storage });
});
