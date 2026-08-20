(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const snapshotApi = commonJs ? require("./priceSnapshot.js") : root?.OptionMapPriceSnapshot;
    const api = factory(snapshotApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapTimeframeOutcomeResolver = api;
})(typeof window !== "undefined" ? window : globalThis, function (snapshotApi) {
    "use strict";

    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function validOrigin(origin) {
        return origin && timestamp(origin.asOf) && finite(origin.price) && origin.price > 0 &&
            typeof origin.contract === "string" && origin.contract.trim() && date(origin.marketDate);
    }

    function empty(reason, targetType, origin, requestedAt = null, toleranceMs = null) {
        return { available: false, reason, targetType,
            origin: validOrigin(origin) ? clone(origin) : null,
            target: { requestedAt, matchedAt: null, toleranceMs, distanceFromTargetMs: null,
                snapshotId: null, price: null, contract: null, source: null },
            result: { elapsedMs: null, priceDelta: null, percentChange: null, direction: "unavailable" } };
    }

    function outcome(origin, targetType, requestedAt, toleranceMs, match) {
        const elapsedMs = Date.parse(match.matchedAt) - Date.parse(origin.asOf);
        if (elapsedMs <= 0) return empty("elapsed_invalid", targetType, origin,
            requestedAt, toleranceMs);
        const priceDelta = match.price - origin.price;
        return { available: true, reason: null, targetType, origin: clone(origin),
            target: { requestedAt, matchedAt: match.matchedAt, toleranceMs,
                distanceFromTargetMs: Math.abs(Date.parse(match.matchedAt) - Date.parse(requestedAt)),
                snapshotId: match.snapshotId, price: match.price, contract: match.contract,
                source: match.source },
            result: { elapsedMs, priceDelta, percentChange: priceDelta / origin.price * 100,
                direction: priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "neutral" } };
    }

    function resolveApproximateFuture({ origin, originAt, originPrice, marketDate, targetMs,
        toleranceMs, contract, records, targetType = "custom" } = {}) {
        const normalizedOrigin = origin || { asOf: originAt, price: originPrice, contract, marketDate };
        if (!validOrigin(normalizedOrigin)) return empty("origin_invalid", targetType, normalizedOrigin);
        if (!finite(targetMs) || targetMs <= 0 || !finite(toleranceMs) || toleranceMs < 0)
            return empty("window_invalid", targetType, normalizedOrigin);
        const requestedTime = Date.parse(normalizedOrigin.asOf) + targetMs;
        const requestedAt = new Date(requestedTime).toISOString();
        const validRecords = (Array.isArray(records) ? records : [])
            .filter(record => snapshotApi.validateSnapshot(record).valid);
        const future = validRecords.filter(record => Date.parse(record.observedAt) >
            Date.parse(normalizedOrigin.asOf));
        const withinWindow = future.filter(record =>
            Math.abs(Date.parse(record.observedAt) - requestedTime) <= toleranceMs);
        const candidates = withinWindow.filter(record => record.contract === normalizedOrigin.contract)
            .slice().sort((left, right) =>
                Math.abs(Date.parse(left.observedAt) - requestedTime) -
                    Math.abs(Date.parse(right.observedAt) - requestedTime) ||
                left.observedAt.localeCompare(right.observedAt) ||
                left.snapshotId.localeCompare(right.snapshotId));
        if (!candidates[0]) return empty(withinWindow.some(record =>
            record.contract !== normalizedOrigin.contract) ? "contract_mismatch" :
            "target_snapshot_unavailable", targetType, normalizedOrigin, requestedAt, toleranceMs);
        const snapshot = candidates[0];
        return outcome(normalizedOrigin, targetType, requestedAt, toleranceMs, {
            matchedAt: snapshot.observedAt, snapshotId: snapshot.snapshotId, price: snapshot.price,
            contract: snapshot.contract, source: "price_snapshot"
        });
    }

    const resolveThreeHour = input => resolveApproximateFuture({ ...input,
        targetMs: input?.targetMs ?? THREE_HOURS_MS, targetType: "3h" });
    const resolveSixHour = input => resolveApproximateFuture({ ...input,
        targetMs: input?.targetMs ?? SIX_HOURS_MS, targetType: "6h" });

    function formalMorningTarget(revision, targetCalendarDay) {
        if (!revision || revision.baselineDay !== targetCalendarDay ||
            revision.sessionBoundary !== "jst_calendar_day" || !timestamp(revision.capturedAt) ||
            revision.validFrom !== revision.capturedAt || !revision.currentPrice?.available ||
            !finite(revision.currentPrice.value) || revision.currentPrice.value <= 0 ||
            typeof revision.currentPrice.contract !== "string" || !revision.currentPrice.contract.trim())
            return null;
        return revision;
    }

    function resolveNextMorning({ origin, nextMorningBaseline, targetCalendarDay, records = [],
        priceSource = "baseline", toleranceMs } = {}) {
        if (!validOrigin(origin)) return empty("origin_invalid", "next_morning", origin);
        if (!date(targetCalendarDay)) return empty("next_morning_target_unavailable",
            "next_morning", origin);
        const baseline = formalMorningTarget(nextMorningBaseline, targetCalendarDay);
        if (!baseline || Date.parse(baseline.capturedAt) <= Date.parse(origin.asOf))
            return empty("next_morning_target_unavailable", "next_morning", origin);
        if (baseline.currentPrice.contract !== origin.contract)
            return empty("contract_mismatch", "next_morning", origin, baseline.capturedAt,
                priceSource === "snapshot" ? toleranceMs ?? null : 0);
        if (priceSource === "baseline") return outcome(origin, "next_morning", baseline.capturedAt, 0, {
            matchedAt: baseline.capturedAt, snapshotId: null, price: baseline.currentPrice.value,
            contract: baseline.currentPrice.contract, source: "morning_baseline"
        });
        if (priceSource !== "snapshot" || !finite(toleranceMs) || toleranceMs < 0)
            return empty("window_invalid", "next_morning", origin, baseline.capturedAt,
                toleranceMs ?? null);
        return resolveApproximateFuture({ origin,
            targetMs: Date.parse(baseline.capturedAt) - Date.parse(origin.asOf), toleranceMs,
            records, targetType: "next_morning" });
    }

    return Object.freeze({ THREE_HOURS_MS, SIX_HOURS_MS, resolveApproximateFuture,
        resolveThreeHour, resolveSixHour, resolveNextMorning });
});
