(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMultiTimeframeState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const DIRECTIONS = Object.freeze(["up", "down", "neutral", "unavailable"]);
    const HORIZON = "1日～数日";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

    function normalizeDirection(value, numericFallback = null) {
        if (DIRECTIONS.includes(value)) return value;
        if (finite(value)) return value > 0 ? "up" : value < 0 ? "down" : "neutral";
        if (finite(numericFallback)) return numericFallback > 0 ? "up"
            : numericFallback < 0 ? "down" : "neutral";
        return "unavailable";
    }

    function qualityState(quality) {
        const values = [];
        if (typeof quality === "string") values.push(quality);
        if (object(quality)) {
            [quality.status, quality.currentStatus, quality.baselineStatus, quality.availability]
                .filter(value => typeof value === "string").forEach(value => values.push(value));
        }
        if (values.includes("unavailable")) return "unavailable";
        if (values.some(value => ["partial", "stale", "unknown"].includes(value))) return "partial";
        return values.length > 0 && values.every(value => ["complete", "available"].includes(value))
            ? "complete" : "partial";
    }

    function pairRelationship(left, right) {
        if (![left, right].every(value => DIRECTIONS.includes(value)) ||
            left === "unavailable" || right === "unavailable") return "unavailable";
        if (left === "neutral" || right === "neutral") return "neutral_mixed";
        return left === right ? "same_direction" : "opposite_direction";
    }

    function unavailableMorning(reason, input = null) {
        const quality = input?.quality || input?.dataQuality || null;
        return { available: false, reason, direction: "unavailable", priceDelta: null,
            capturedAt: input?.capturedAt || input?.baselineCapturedAt || null,
            comparedAt: input?.comparedAt || null, elapsedMs: null,
            contract: input?.contract || input?.currentPrice?.current?.contract || null,
            quality: { status: qualityState(quality), source: clone(quality) } };
    }

    function adaptMorning(input) {
        if (!object(input) || input.available !== true) return unavailableMorning(
            input?.reason || "morning_comparison_unavailable", input);
        const priceDelta = input.priceDelta ?? input.currentPrice?.delta;
        const capturedAt = input.capturedAt || input.baselineCapturedAt;
        const comparedAt = input.comparedAt;
        if (!finite(priceDelta)) return unavailableMorning("morning_price_delta_invalid", input);
        if (!timestamp(capturedAt) || !timestamp(comparedAt))
            return unavailableMorning("morning_timestamp_invalid", input);
        const elapsedMs = Date.parse(comparedAt) - Date.parse(capturedAt);
        if (elapsedMs <= 0) return unavailableMorning("morning_elapsed_invalid", input);
        const direction = normalizeDirection(input.direction, priceDelta);
        if (direction === "unavailable") return unavailableMorning("morning_direction_unavailable", input);
        if (direction !== normalizeDirection(priceDelta))
            return unavailableMorning("morning_direction_inconsistent", input);
        const qualitySource = input.quality || input.dataQuality || null;
        const quality = { status: qualityState(qualitySource), source: clone(qualitySource) };
        if (quality.status === "unavailable") return unavailableMorning("morning_quality_unavailable", input);
        const contractValue = input.contract || input.currentPrice?.current?.contract;
        return { available: true, reason: null, direction, priceDelta,
            capturedAt, comparedAt, elapsedMs,
            contract: typeof contractValue === "string" && contractValue ? contractValue : null, quality };
    }

    function unavailablePrevious(reason, input = null, boundary = null) {
        return { available: false, reason, direction: "unavailable", priceDelta: null,
            percentChange: null, previousObservedAt: input?.previousObservedAt ||
                input?.previous?.observedAt || null, currentObservedAt: input?.currentObservedAt ||
                input?.current?.observedAt || null, elapsedMs: null,
            contract: input?.contract || input?.current?.contract || null,
            boundary: boundary || input?.boundary || null,
            quality: { status: qualityState(input?.quality), source: clone(input?.quality || null) } };
    }

    function adaptPrevious(input, morningContract) {
        if (!object(input) || input.available !== true) return unavailablePrevious(
            input?.reason || "previous_comparison_unavailable", input);
        if (input.reason === "contract_mismatch" || input.boundary === "rollover_boundary")
            return unavailablePrevious("contract_mismatch", input, "rollover_boundary");
        const previousObservedAt = input.previousObservedAt || input.previous?.observedAt;
        const currentObservedAt = input.currentObservedAt || input.current?.observedAt;
        if (!timestamp(previousObservedAt) || !timestamp(currentObservedAt))
            return unavailablePrevious("previous_timestamp_invalid", input);
        const calculatedElapsed = Date.parse(currentObservedAt) - Date.parse(previousObservedAt);
        if (!finite(input.elapsedMs) || input.elapsedMs <= 0 || calculatedElapsed <= 0 ||
            input.elapsedMs !== calculatedElapsed)
            return unavailablePrevious("previous_elapsed_invalid", input);
        if (!finite(input.priceDelta) || !finite(input.percentChange))
            return unavailablePrevious("previous_price_change_invalid", input);
        const direction = normalizeDirection(input.direction, input.priceDelta);
        if (direction === "unavailable")
            return unavailablePrevious("previous_direction_unavailable", input);
        if (direction !== normalizeDirection(input.priceDelta))
            return unavailablePrevious("previous_direction_inconsistent", input);
        const contract = input.contract || input.current?.contract || null;
        if (morningContract && contract && morningContract !== contract)
            return unavailablePrevious("contract_mismatch", input, "rollover_boundary");
        const quality = { status: qualityState(input.quality), source: clone(input.quality || null) };
        if (quality.status === "unavailable")
            return unavailablePrevious("previous_quality_unavailable", input);
        return { available: true, reason: null, direction, priceDelta: input.priceDelta,
            percentChange: input.percentChange, previousObservedAt, currentObservedAt,
            elapsedMs: input.elapsedMs, contract, boundary: input.boundary || null, quality };
    }

    function unavailableMedium(reason, input = null) {
        return { available: false, reason, direction: "unavailable", directionLabel: null,
            overallDirection: null, confidence: null, coverage: null, agreement: null,
            horizon: HORIZON,
            quality: { status: qualityState(input?.quality || input?.status),
                source: clone(input?.quality || input?.status || null) } };
    }

    function adaptMedium(input) {
        if (!object(input) || input.available !== true) return unavailableMedium(
            input?.reason || "medium_term_unavailable", input);
        if (!finite(input.direction)) return unavailableMedium("medium_direction_invalid", input);
        const direction = normalizeDirection(input.direction);
        const metrics = [input.confidence, input.coverage, input.agreement];
        if (metrics.some(value => value !== null && value !== undefined && !finite(value)))
            return unavailableMedium("medium_metrics_invalid", input);
        const qualitySource = input.quality || input.status || null;
        const quality = { status: qualityState(qualitySource), source: clone(qualitySource) };
        if (quality.status === "unavailable") return unavailableMedium("medium_quality_unavailable", input);
        return { available: true, reason: null, direction,
            directionLabel: typeof input.directionLabel === "string" ? input.directionLabel : null,
            overallDirection: input.direction, confidence: input.confidence ?? null,
            coverage: input.coverage ?? null, agreement: input.agreement ?? null,
            horizon: HORIZON, quality };
    }

    function createMultiTimeframeState(input = {}) {
        const contextValid = timestamp(input.asOf) && date(input.marketDate);
        const morning = adaptMorning(input.morning);
        const previousObservation = adaptPrevious(input.previousObservation, morning.contract);
        const mediumTerm = adaptMedium(input.mediumTerm);
        const directions = [morning.direction, previousObservation.direction, mediumTerm.direction];
        const relationship = { allAligned: directions.every(direction => direction === "up") ||
                directions.every(direction => direction === "down"),
            morningVsMedium: pairRelationship(morning.direction, mediumTerm.direction),
            previousVsMedium: pairRelationship(previousObservation.direction, mediumTerm.direction),
            morningVsPrevious: pairRelationship(morning.direction, previousObservation.direction) };
        const components = [morning, previousObservation, mediumTerm];
        const unavailableComponent = components.find(component => !component.available);
        const status = !contextValid || unavailableComponent ? "unavailable"
            : components.some(component => component.quality.status !== "complete") ? "partial" : "complete";
        const reason = !contextValid ? "context_invalid"
            : unavailableComponent ? unavailableComponent.reason : status === "partial" ? "quality_partial" : null;
        const contracts = [morning.contract, previousObservation.contract].filter(Boolean);
        const contract = contracts.length > 0 && contracts.every(value => value === contracts[0])
            ? contracts[0] : null;
        return { available: status !== "unavailable", status, reason,
            asOf: contextValid ? input.asOf : null, marketDate: date(input.marketDate) ? input.marketDate : null,
            contract, morning, previousObservation, mediumTerm, relationship };
    }

    return Object.freeze({ DIRECTIONS, HORIZON, normalizeDirection, pairRelationship,
        createMultiTimeframeState });
});
