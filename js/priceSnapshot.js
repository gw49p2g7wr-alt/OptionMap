(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapPriceSnapshot = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SNAPSHOT_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const MODES = Object.freeze(["automatic", "manual"]);
    const QUALITY_STATUSES = Object.freeze(["complete", "partial", "unavailable"]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const nullableString = value => value === null || typeof value === "string";

    function canonicalize(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }

    async function sha256(value) {
        const text = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(text).digest("hex");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function jstContext(observedAt) {
        const shifted = new Date(Date.parse(observedAt) + 9 * 60 * 60 * 1000);
        return { calendarDay: shifted.toISOString().slice(0, 10), session: "unknown",
            timeZone: "Asia/Tokyo" };
    }

    function semanticContent(snapshot) {
        const value = clone(snapshot);
        delete value.snapshotId;
        delete value.observedAt;
        delete value.semanticSignature;
        return value;
    }

    function sourceReference(summary) {
        const reference = summary?.sourceVersions?.find(item => item?.source === "qri-options") || null;
        return reference ? { source: reference.source, versionKey: reference.versionKey || null,
            signature: reference.signature || null, contract: reference.contract || null,
            tradingDate: reference.tradingDate || null } : null;
    }

    async function createSnapshot({ summary, rendererState, observedAt }) {
        if (!object(summary) || !object(summary.payload)) throw new Error("summary_unavailable");
        const price = summary.payload.currentPrice;
        if (price?.available !== true || !finite(price.value) || price.value <= 0)
            throw new Error("current_price_unavailable");
        if (typeof price.source !== "string" || !price.source.trim() || !MODES.includes(price.mode))
            throw new Error("current_price_identity_invalid");
        if (price.mode === "automatic" && (typeof price.contract !== "string" || !price.contract.trim()))
            throw new Error("automatic_contract_unavailable");
        const at = observedAt || new Date().toISOString();
        if (!timestamp(at)) throw new Error("observed_at_invalid");
        const rawQuotedAt = typeof rendererState?.currentPrice?.quotedAt === "string"
            ? rendererState.currentPrice.quotedAt : null;
        const quotedAt = rawQuotedAt || price.quotedAt || null;
        const context = jstContext(at);
        const snapshot = { snapshotVersion: SNAPSHOT_VERSION, snapshotId: "", observedAt: at,
            semanticSignature: "", signatureAlgorithm: SIGNATURE_ALGORITHM,
            generatedAt: summary.generatedAt, price: price.value, source: price.source,
            mode: price.mode, contract: price.contract || null, quotedAt,
            quotedAtRaw: rawQuotedAt, quotedAtNormalized: timestamp(rawQuotedAt)
                ? rawQuotedAt : timestamp(price.quotedAt) ? price.quotedAt : null,
            fetchedAt: timestamp(price.fetchedAt) ? price.fetchedAt : null,
            marketDate: summary.marketDate, tradingDate: sourceReference(summary)?.tradingDate || null,
            calendarDay: context.calendarDay, session: context.session, timeZone: context.timeZone,
            dataQuality: { availability: "available", status: summary.dataQuality?.status || "unavailable",
                warnings: Array.isArray(summary.dataQuality?.warnings)
                    ? clone(summary.dataQuality.warnings) : [] },
            sourceVersionReference: sourceReference(summary) };
        snapshot.semanticSignature = await sha256(semanticContent(snapshot));
        const idTime = new Date(at).toISOString().replace(/[^0-9]/g, "").slice(0, 17);
        snapshot.snapshotId = `ps1-${idTime}-${snapshot.semanticSignature.slice(0, 16)}`;
        const validation = validateSnapshot(snapshot);
        if (!validation.valid) throw new Error(`price_snapshot_invalid:${validation.errors.join(",")}`);
        return snapshot;
    }

    function validateSnapshot(snapshot) {
        const errors = [];
        if (!object(snapshot) || snapshot.snapshotVersion !== SNAPSHOT_VERSION) errors.push("version_invalid");
        if (!/^ps1-[0-9]{17}-[0-9a-f]{16}$/.test(snapshot?.snapshotId || "")) errors.push("id_invalid");
        if (!/^[0-9a-f]{64}$/.test(snapshot?.semanticSignature || "") ||
            snapshot?.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push("signature_invalid");
        if (!timestamp(snapshot?.observedAt) || !timestamp(snapshot?.generatedAt) ||
            snapshot?.fetchedAt !== null && !timestamp(snapshot.fetchedAt)) errors.push("timestamp_invalid");
        if (!finite(snapshot?.price) || snapshot.price <= 0 || typeof snapshot?.source !== "string" ||
            !snapshot.source.trim() || !MODES.includes(snapshot?.mode) ||
            snapshot.mode === "automatic" && (typeof snapshot.contract !== "string" || !snapshot.contract.trim()))
            errors.push("price_invalid");
        if (!nullableString(snapshot?.contract) || !nullableString(snapshot?.quotedAt) ||
            !nullableString(snapshot?.quotedAtRaw) ||
            snapshot?.quotedAtNormalized !== null && !timestamp(snapshot.quotedAtNormalized))
            errors.push("price_metadata_invalid");
        if (!date(snapshot?.marketDate) || snapshot?.tradingDate !== null && !date(snapshot.tradingDate) ||
            !date(snapshot?.calendarDay) || snapshot?.timeZone !== "Asia/Tokyo" ||
            !["regular", "night", "unknown"].includes(snapshot?.session)) errors.push("session_invalid");
        const quality = snapshot?.dataQuality;
        if (!object(quality) || quality.availability !== "available" ||
            !QUALITY_STATUSES.includes(quality.status) || !Array.isArray(quality.warnings) ||
            !quality.warnings.every(item => typeof item === "string")) errors.push("quality_invalid");
        const reference = snapshot?.sourceVersionReference;
        if (reference !== null && (!object(reference) || typeof reference.source !== "string" ||
            !nullableString(reference.versionKey) || !nullableString(reference.signature) ||
            !nullableString(reference.contract) ||
            reference.tradingDate !== null && !date(reference.tradingDate))) errors.push("reference_invalid");
        return { valid: errors.length === 0, errors };
    }

    async function verifySnapshot(snapshot) {
        const validation = validateSnapshot(snapshot);
        if (!validation.valid) return validation;
        const expected = await sha256(semanticContent(snapshot));
        return expected === snapshot.semanticSignature ? validation
            : { valid: false, errors: ["semantic_signature_mismatch"] };
    }

    function sortedValid(records) {
        return (Array.isArray(records) ? records : []).filter(item => validateSnapshot(item).valid)
            .slice().sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    }

    function latestSnapshot(records) {
        return sortedValid(records).at(-1) || null;
    }

    function previousComparableSnapshot(records, current = latestSnapshot(records)) {
        if (!current) return { available: false, reason: "current_snapshot_unavailable", snapshot: null };
        if (!current.contract) return { available: false, reason: "contract_unavailable", snapshot: null };
        const previous = sortedValid(records).filter(item => item.snapshotId !== current.snapshotId &&
            item.observedAt < current.observedAt && item.contract === current.contract).at(-1) || null;
        return previous ? { available: true, reason: null, snapshot: previous }
            : { available: false, reason: "previous_comparable_unavailable", snapshot: null };
    }

    function compareSnapshots(previous, current) {
        if (!previous || !current || !validateSnapshot(previous).valid || !validateSnapshot(current).valid)
            return { available: false, reason: "snapshot_invalid" };
        if (!previous.contract || !current.contract)
            return { available: false, reason: "contract_unavailable" };
        if (previous.contract !== current.contract)
            return { available: false, reason: "contract_mismatch", boundary: "rollover_boundary" };
        const elapsedMs = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
        if (elapsedMs <= 0) return { available: false, reason: "observation_order_invalid" };
        const delta = current.price - previous.price;
        return { available: true, reason: null, previousSnapshotId: previous.snapshotId,
            currentSnapshotId: current.snapshotId, contract: current.contract, elapsedMs,
            delta, percentChange: previous.price === 0 ? null : delta / previous.price * 100 };
    }

    function resolveApproximatePrior(records, current, { targetMs, toleranceMs } = {}) {
        if (!current || !validateSnapshot(current).valid)
            return { available: false, reason: "current_snapshot_unavailable", snapshot: null };
        if (!current.contract) return { available: false, reason: "contract_unavailable", snapshot: null };
        if (!finite(targetMs) || targetMs <= 0 || !finite(toleranceMs) || toleranceMs < 0)
            return { available: false, reason: "window_invalid", snapshot: null };
        const currentTime = Date.parse(current.observedAt);
        const candidates = sortedValid(records).filter(item => item.observedAt < current.observedAt &&
            item.contract === current.contract).map(item => ({ snapshot: item,
                distanceMs: Math.abs((currentTime - Date.parse(item.observedAt)) - targetMs) }))
            .filter(item => item.distanceMs <= toleranceMs)
            .sort((left, right) => left.distanceMs - right.distanceMs ||
                right.snapshot.observedAt.localeCompare(left.snapshot.observedAt));
        return candidates[0] ? { available: true, reason: null, snapshot: candidates[0].snapshot,
            targetMs, toleranceMs, distanceMs: candidates[0].distanceMs }
            : { available: false, reason: "target_snapshot_unavailable", snapshot: null,
                targetMs, toleranceMs };
    }

    async function persistBestEffort(input, store, onError = () => undefined) {
        try {
            const snapshot = await createSnapshot(input);
            return await store.append(snapshot);
        } catch (error) {
            onError(error);
            return { saved: false, outcome: "storage_unavailable", error: error?.message || String(error) };
        }
    }

    return Object.freeze({ SNAPSHOT_VERSION, SIGNATURE_ALGORITHM, canonicalize, semanticContent,
        createSnapshot, validateSnapshot, verifySnapshot, latestSnapshot, previousComparableSnapshot,
        compareSnapshots, resolveApproximatePrior, persistBestEffort });
});
