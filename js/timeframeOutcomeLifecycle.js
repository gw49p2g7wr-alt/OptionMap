(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapTimeframeOutcomeLifecycle = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const STATUSES = Object.freeze(["pending", "available", "unavailable", "invalid"]);
    const INVALID_REASONS = Object.freeze(["origin_invalid", "window_invalid", "elapsed_invalid"]);
    const UNAVAILABLE_REASONS = Object.freeze(["target_snapshot_unavailable", "contract_mismatch",
        "next_morning_target_unavailable"]);
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        !Number.isNaN(Date.parse(value));

    function result(status, reason, input, details = {}) {
        return { status, reason, targetType: typeof input?.targetType === "string"
            ? input.targetType : null, evaluatedAt: timestamp(input?.evaluatedAt) ? input.evaluatedAt : null,
        targetAt: timestamp(input?.targetAt) ? input.targetAt : null,
        toleranceMs: finite(input?.toleranceMs) ? input.toleranceMs : null,
        deadlineAt: timestamp(input?.targetDeadlineAt) ? input.targetDeadlineAt : null,
        windowStart: details.windowStart || null, windowEnd: details.windowEnd || null,
        candidateAvailable: details.candidateAvailable === true,
        final: status === "available" || status === "unavailable" || status === "invalid" };
    }

    function classifyOutcomeLifecycle(input = {}) {
        if (!timestamp(input.evaluatedAt)) return result("invalid", "evaluated_at_invalid", input);
        if (typeof input.targetType !== "string" || !input.targetType.trim())
            return result("invalid", "target_type_invalid", input);
        const resolver = input.resolverResult;
        if (!resolver || typeof resolver.available !== "boolean" ||
            resolver.reason !== null && typeof resolver.reason !== "string")
            return result("invalid", "resolver_result_invalid", input);
        if (INVALID_REASONS.includes(resolver.reason))
            return result("invalid", resolver.reason, input);
        if (input.targetDeadlineAt !== undefined && input.targetDeadlineAt !== null &&
            !timestamp(input.targetDeadlineAt))
            return result("invalid", "deadline_at_invalid", input);

        if (input.targetAt === undefined || input.targetAt === null) {
            if (input.targetType !== "next_morning")
                return result("invalid", "target_at_invalid", input);
            if (!input.targetDeadlineAt || Date.parse(input.evaluatedAt) < Date.parse(input.targetDeadlineAt))
                return result("pending", "target_not_established", input,
                    { candidateAvailable: resolver.available });
            return result("unavailable", "next_morning_target_unavailable", input);
        }

        if (!timestamp(input.targetAt)) return result("invalid", "target_at_invalid", input);
        if (!finite(input.toleranceMs) || input.toleranceMs < 0)
            return result("invalid", "window_invalid", input);
        if (input.targetDeadlineAt && input.targetType !== "next_morning")
            return result("invalid", "deadline_not_applicable", input);

        const targetTime = Date.parse(input.targetAt);
        const windowStart = new Date(targetTime - input.toleranceMs).toISOString();
        const windowEnd = new Date(targetTime + input.toleranceMs).toISOString();
        const details = { windowStart, windowEnd, candidateAvailable: resolver.available };
        if (Date.parse(input.evaluatedAt) < Date.parse(windowEnd))
            return result("pending", Date.parse(input.evaluatedAt) < Date.parse(windowStart)
                ? "window_not_started" : "window_open", input, details);
        if (resolver.available) return result("available", null, input, details);
        if (UNAVAILABLE_REASONS.includes(resolver.reason))
            return result("unavailable", resolver.reason, input, details);
        return result("invalid", resolver.reason || "resolver_result_invalid", input, details);
    }

    return Object.freeze({ STATUSES, INVALID_REASONS, UNAVAILABLE_REASONS,
        classifyOutcomeLifecycle });
});
