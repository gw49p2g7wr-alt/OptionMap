(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaseline = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const BASELINE_VERSION = 2;
    const LEGACY_BASELINE_VERSION = 1;
    const STORAGE_VERSION = 1;
    const mobileSummaryApi = typeof module === "object" && module.exports && !globalThis.document
        ? require("./mobileSummary.js") : globalThis.OptionMapMobileSummary;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
        keys.every(key => Object.hasOwn(value, key));
    const canonicalize = value => Array.isArray(value) ? `[${value.map(canonicalize).join(",")}]` :
        object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}` :
            JSON.stringify(value);
    async function sha256(value) {
        const text = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(text).digest("hex");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    const sensitive = value => {
        const text = JSON.stringify(value);
        return [/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)/i,
            /(?:api[_-]?key|credential|service.?account|password|auth.?token|bearer\s+[\w.-]+)/i,
            /(?:git\s*(?:branch|commit)|refs\/heads\/)/i, /(?:<!doctype|<html|<script|<table)/i,
            /(?:raw.?excel|workbook|worksheet)/i, /(?:local\s*storage|indexeddb).*dump/i,
            /\b(?:Error|TypeError|ReferenceError):.*(?:\n|\\n).*\bat\s/i].some(pattern => pattern.test(text));
    };

    function snapshotContent(summary, qriAvailability, comparisonReference) {
        const snapshot = { marketDate: summary.marketDate, sourceVersions: clone(summary.sourceVersions),
            dataQuality: clone(summary.dataQuality), freshness: clone(summary.freshness),
            overallV2: clone(summary.payload.overallV2), currentPrice: clone(summary.payload.currentPrice),
            nearestLevels: clone(summary.payload.nearestLevels) };
        if (qriAvailability !== undefined) {
            snapshot.qriAvailability = clone(qriAvailability);
            snapshot.comparisonReference = clone(comparisonReference);
        }
        return snapshot;
    }

    function qriReference(summary) {
        const qri = summary.sourceVersions.find(item => item.source === "qri-options");
        if (!qri) return null;
        return { contract: qri.contract, tradingDate: qri.tradingDate,
            versionKey: qri.versionKey, signature: qri.signature,
            pageUpdatedAt: summary.freshness.qriAt };
    }

    async function createCandidate(summary, capturedAt = new Date().toISOString(), options = {}) {
        const mobile = await mobileSummaryApi?.validateMobileSummary?.(summary);
        if (!mobile?.valid) throw new Error("source_summary_invalid");
        if (summary.dataQuality.status === "unavailable") throw new Error("source_summary_unavailable");
        if (!timestamp(capturedAt)) throw new Error("captured_at_invalid");
        const v2 = Object.hasOwn(options, "qriAvailability");
        const availability = v2 ? clone(options.qriAvailability) : undefined;
        const reference = v2 ? clone(options.comparisonReference ?? null) : qriReference(summary);
        const snapshot = snapshotContent(summary, availability, reference);
        const contentSignature = await sha256(snapshot);
        const idSeed = await sha256({ contentSignature, capturedAt, sourceSummaryId: summary.summaryId });
        return { baselineId: `mb1-${idSeed.slice(0, 24)}`, contentSignature,
            capturedAt, replacedAt: null, sourceSummaryId: summary.summaryId,
            sourceSummarySignature: summary.signature, dataQuality: snapshot.dataQuality,
            sourceVersions: snapshot.sourceVersions, freshness: snapshot.freshness,
            overallV2: snapshot.overallV2, currentPrice: snapshot.currentPrice,
            nearestLevels: snapshot.nearestLevels, comparisonReference: reference,
            ...(v2 ? { qriAvailability: availability } : {}) };
    }

    function validateQriAvailability(value, reference) {
        const keys = ["canonicalExists", "available", "openInterestStatus", "reason",
            "publishedCount", "formalRevisionAvailable", "persistenceStatus", "persistenceReason"];
        if (!exact(value, keys) || typeof value.canonicalExists !== "boolean" ||
            typeof value.available !== "boolean" || typeof value.formalRevisionAvailable !== "boolean" ||
            !["available", "partial", "unavailable", null].includes(value.openInterestStatus) ||
            value.reason !== null && typeof value.reason !== "string" ||
            value.persistenceStatus !== null && typeof value.persistenceStatus !== "string" ||
            value.persistenceReason !== null && typeof value.persistenceReason !== "string" ||
            value.publishedCount !== null && (!Number.isSafeInteger(value.publishedCount) || value.publishedCount < 0))
            return false;
        if (!value.canonicalExists) return value.available === false && value.openInterestStatus === null &&
            value.publishedCount === null && value.formalRevisionAvailable === false &&
            value.reason === "canonical_missing" && reference === null;
        if (value.available) return value.openInterestStatus === "available" && value.publishedCount > 0 &&
            value.formalRevisionAvailable === true && value.reason === null && reference !== null;
        return value.reason !== null && value.formalRevisionAvailable === false && reference === null &&
            (value.openInterestStatus === "unavailable" ? value.publishedCount === 0 :
                value.openInterestStatus === "partial" ? value.publishedCount >= 0 :
                    value.openInterestStatus === "available" && value.publishedCount > 0 &&
                    value.reason === "formal_revision_missing_at_capture");
    }

    async function validateRevision(revision, marketDate, baselineVersion) {
        const errors = [];
        const legacyKeys = ["baselineId", "contentSignature", "capturedAt", "replacedAt", "sourceSummaryId",
            "sourceSummarySignature", "dataQuality", "sourceVersions", "freshness", "overallV2",
            "currentPrice", "nearestLevels", "comparisonReference"];
        const v2Keys = [...legacyKeys, "qriAvailability"];
        const isV2Revision = exact(revision, v2Keys);
        const keys = isV2Revision ? v2Keys : legacyKeys;
        if (!exact(revision, keys)) errors.push("revision_fields_invalid");
        if (baselineVersion === LEGACY_BASELINE_VERSION && isV2Revision)
            errors.push("legacy_revision_version_invalid");
        if (!/^mb1-[a-f0-9]{24}$/.test(revision?.baselineId || "")) errors.push("baseline_id_invalid");
        if (!/^[a-f0-9]{64}$/.test(revision?.contentSignature || "")) errors.push("content_signature_invalid");
        if (!timestamp(revision?.capturedAt) || revision?.replacedAt !== null && !timestamp(revision.replacedAt))
            errors.push("revision_timestamp_invalid");
        if (!/^ms1-[a-f0-9]{24}$/.test(revision?.sourceSummaryId || "")) errors.push("source_summary_id_invalid");
        if (!/^[a-f0-9]{64}$/.test(revision?.sourceSummarySignature || "") ||
            revision?.sourceSummaryId !== `ms1-${String(revision?.sourceSummarySignature).slice(0, 24)}`)
            errors.push("source_summary_signature_invalid");
        if (!object(revision?.dataQuality) || !["complete", "partial"].includes(revision.dataQuality.status) ||
            !Array.isArray(revision.dataQuality.warnings)) errors.push("data_quality_invalid");
        if (!Array.isArray(revision?.sourceVersions) || revision.sourceVersions.some(item =>
            !object(item) || typeof item.source !== "string")) errors.push("source_versions_invalid");
        const overall = revision?.overallV2;
        if (!object(overall) || typeof overall.available !== "boolean" ||
            overall.direction !== null && (!finite(overall.direction) || overall.direction < -100 || overall.direction > 100))
            errors.push("overall_v2_invalid");
        const price = revision?.currentPrice;
        if (!object(price) || typeof price.available !== "boolean" ||
            price.available && (!finite(price.value) || price.value <= 0) || !price.available && price.value !== null)
            errors.push("current_price_invalid");
        const levels = revision?.nearestLevels;
        if (!object(levels) || !object(levels.upper) || !object(levels.lower) ||
            [levels.upper, levels.lower].some(level => typeof level.available !== "boolean" ||
                level.available && (!finite(level.price) || !finite(level.distance)))) errors.push("nearest_levels_invalid");
        const reference = revision?.comparisonReference;
        if (reference !== null && (!exact(reference,
            ["contract", "tradingDate", "versionKey", "signature", "pageUpdatedAt"]) ||
            typeof reference.contract !== "string" || !date(reference.tradingDate) ||
            typeof reference.versionKey !== "string" || typeof reference.signature !== "string" ||
            !timestamp(reference.pageUpdatedAt))) errors.push("comparison_reference_invalid");
        const qri = revision?.sourceVersions?.find(item => item.source === "qri-options");
        if (reference && (!qri || reference.contract !== qri.contract ||
            reference.tradingDate !== qri.tradingDate || reference.versionKey !== qri.versionKey ||
            reference.signature !== qri.signature || reference.pageUpdatedAt !== revision.freshness?.qriAt))
            errors.push("comparison_reference_mismatch");
        if (isV2Revision && !validateQriAvailability(revision.qriAvailability, reference))
            errors.push("qri_availability_invalid");
        if (revision?.sourceVersions?.some(item => item.tradingDate && item.tradingDate !== marketDate &&
            item.source === "qri-options")) errors.push("revision_market_date_invalid");
        if (exact(revision, keys)) {
            const snapshot = { marketDate, sourceVersions: revision.sourceVersions,
                dataQuality: revision.dataQuality, freshness: revision.freshness,
                overallV2: revision.overallV2, currentPrice: revision.currentPrice,
                nearestLevels: revision.nearestLevels };
            if (isV2Revision) {
                snapshot.qriAvailability = revision.qriAvailability;
                snapshot.comparisonReference = revision.comparisonReference;
            }
            const expectedContent = await sha256(snapshot);
            if (revision.contentSignature !== expectedContent) errors.push("content_signature_mismatch");
            const expectedId = await sha256({ contentSignature: expectedContent,
                capturedAt: revision.capturedAt, sourceSummaryId: revision.sourceSummaryId });
            if (revision.baselineId !== `mb1-${expectedId.slice(0, 24)}`) errors.push("baseline_id_mismatch");
        }
        if (sensitive(revision)) errors.push("sensitive_content");
        return errors;
    }

    async function validateBaseline(baseline) {
        const errors = [];
        const keys = ["baselineVersion", "marketDate", "activeBaselineId", "firstCapturedAt",
            "lastUpdatedAt", "revisions"];
        if (!exact(baseline, keys)) errors.push("baseline_fields_invalid");
        if (![LEGACY_BASELINE_VERSION, BASELINE_VERSION].includes(baseline?.baselineVersion))
            errors.push("baseline_version_invalid");
        if (!date(baseline?.marketDate)) errors.push("market_date_invalid");
        if (typeof baseline?.activeBaselineId !== "string" || !baseline.activeBaselineId)
            errors.push("active_baseline_id_invalid");
        if (!timestamp(baseline?.firstCapturedAt) || !timestamp(baseline?.lastUpdatedAt))
            errors.push("baseline_timestamp_invalid");
        if (!Array.isArray(baseline?.revisions) || baseline.revisions.length === 0) errors.push("revisions_invalid");
        const ids = baseline?.revisions?.map(item => item?.baselineId) || [];
        if (new Set(ids).size !== ids.length) errors.push("duplicate_baseline_id");
        if (Array.isArray(baseline?.revisions)) {
            const revisionErrors = await Promise.all(baseline.revisions.map(revision =>
                validateRevision(revision, baseline.marketDate, baseline.baselineVersion)));
            revisionErrors.forEach(items => errors.push(...items));
        }
        const activeIndex = baseline?.revisions?.findIndex(item => item.baselineId === baseline.activeBaselineId) ?? -1;
        if (activeIndex < 0) errors.push("active_revision_missing");
        if (baseline?.baselineVersion === BASELINE_VERSION && activeIndex >= 0 &&
            !Object.hasOwn(baseline.revisions[activeIndex], "qriAvailability"))
            errors.push("active_qri_availability_missing");
        baseline?.revisions?.forEach((revision, index) => {
            if (index === activeIndex && revision.replacedAt !== null) errors.push("active_revision_replaced");
            if (index !== activeIndex && revision.replacedAt === null) errors.push("inactive_revision_not_replaced");
            if (index > 0 && Date.parse(revision.capturedAt) < Date.parse(baseline.revisions[index - 1].capturedAt))
                errors.push("revision_order_invalid");
        });
        if (baseline?.revisions?.[0]?.capturedAt !== baseline?.firstCapturedAt ||
            baseline?.revisions?.at(-1)?.capturedAt !== baseline?.lastUpdatedAt)
            errors.push("baseline_audit_timestamp_mismatch");
        return { valid: errors.length === 0, errors: [...new Set(errors)] };
    }

    async function saveCandidate(existing, candidate, marketDate, { allowUpdate = false } = {}) {
        if (!date(marketDate) || !candidate || sensitive(candidate)) throw new Error("candidate_invalid");
        if (!existing) {
            const baseline = { baselineVersion: Object.hasOwn(candidate, "qriAvailability")
                ? BASELINE_VERSION : LEGACY_BASELINE_VERSION, marketDate,
                activeBaselineId: candidate.baselineId, firstCapturedAt: candidate.capturedAt,
                lastUpdatedAt: candidate.capturedAt, revisions: [clone(candidate)] };
            if (!(await validateBaseline(baseline)).valid) throw new Error("baseline_invalid");
            return { status: "created", baseline };
        }
        const validation = await validateBaseline(existing);
        if (!validation.valid || existing.marketDate !== marketDate) throw new Error("existing_baseline_invalid");
        if (!allowUpdate) return { status: "confirmation_required", baseline: clone(existing) };
        const active = existing.revisions.find(item => item.baselineId === existing.activeBaselineId);
        if (active.contentSignature === candidate.contentSignature) {
            return { status: "unchanged", baseline: clone(existing) };
        }
        const baseline = clone(existing);
        baseline.revisions.find(item => item.baselineId === baseline.activeBaselineId).replacedAt = candidate.capturedAt;
        baseline.revisions.push(clone(candidate));
        if (Object.hasOwn(candidate, "qriAvailability")) baseline.baselineVersion = BASELINE_VERSION;
        baseline.activeBaselineId = candidate.baselineId;
        baseline.lastUpdatedAt = candidate.capturedAt;
        if (!(await validateBaseline(baseline)).valid) throw new Error("baseline_invalid");
        return { status: "updated", baseline };
    }

    function createEmptyStorage() { return { storageVersion: STORAGE_VERSION, baselines: [] }; }
    async function validateStorage(storage) {
        if (!exact(storage, ["storageVersion", "baselines"]) || storage.storageVersion !== STORAGE_VERSION ||
            !Array.isArray(storage.baselines)) return { valid: false, errors: ["storage_invalid"] };
        if (new Set(storage.baselines.map(item => item?.marketDate)).size !== storage.baselines.length)
            return { valid: false, errors: ["duplicate_market_date"] };
        const results = await Promise.all(storage.baselines.map(validateBaseline));
        const errors = results.flatMap(result => result.errors);
        return { valid: errors.length === 0, errors: [...new Set(errors)] };
    }
    async function getForMarketDate(storage, marketDate) {
        if (!(await validateStorage(storage)).valid) return { available: false, reason: "morning_baseline_corrupted", baseline: null };
        const baseline = storage.baselines.find(item => item.marketDate === marketDate);
        return baseline ? { available: true, reason: null, baseline: clone(baseline) } :
            { available: false, reason: "not_captured", baseline: null };
    }
    async function upsertStorage(storage, baseline) {
        if (!(await validateStorage(storage)).valid || !(await validateBaseline(baseline)).valid)
            throw new Error("storage_or_baseline_invalid");
        const next = clone(storage); const index = next.baselines.findIndex(item => item.marketDate === baseline.marketDate);
        if (index < 0) next.baselines.push(clone(baseline)); else next.baselines[index] = clone(baseline);
        next.baselines.sort((a, b) => a.marketDate.localeCompare(b.marketDate));
        if (!(await validateStorage(next)).valid) throw new Error("storage_invalid");
        return next;
    }
    function activeRevision(baseline) {
        return clone(baseline?.revisions?.find(item => item.baselineId === baseline.activeBaselineId) || null);
    }
    return Object.freeze({ BASELINE_VERSION, LEGACY_BASELINE_VERSION, STORAGE_VERSION, canonicalize, createCandidate,
        validateBaseline, saveCandidate, createEmptyStorage, validateStorage, getForMarketDate,
        upsertStorage, activeRevision });
});
