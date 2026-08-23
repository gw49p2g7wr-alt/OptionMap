(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapDataFreshness = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const FOUNDATION_VERSION = 1;
    const ORIGINS = new Set(["live", "cache", "history", "runtime"]);
    const ATTEMPT_STATUSES = new Set(["success", "failed", "not_updated", "pending", "not_attempted"]);
    const CALCULATION_STATES = new Set(["eligible", "ineligible", "undetermined"]);
    const NON_CURRENT_TYPES = new Set(["morning_baseline", "price_snapshot", "observation_history"]);

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function iso(value) {
        const candidate = text(value);
        return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
    }

    function date(value) {
        const candidate = text(value);
        if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
        const parsed = new Date(`${candidate}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
            ? candidate : null;
    }

    function origin(value) {
        return ORIGINS.has(value) ? value : null;
    }

    function calculation(value) {
        return CALCULATION_STATES.has(value) ? value : "undetermined";
    }

    function diagnostics(input, extra = {}) {
        const invalidFields = [];
        for (const field of ["sourceUpdatedAt", "fetchedAt", "lastAttemptedAt", "quotedAt",
            "publishedAt", "listingUpdatedAt"]) {
            if (input[field] != null && !iso(input[field])) invalidFields.push(field);
        }
        for (const field of ["dataTradingDate", "tradingDate", "sourceDate",
            "expectedTradingDate", "currentReferenceDate"]) {
            if (input[field] != null && !date(input[field])) invalidFields.push(field);
        }
        return Object.freeze({
            ...extra,
            sourceType: text(input.sourceType),
            validation: input.validation === false ? "invalid"
                : input.validation === true ? "valid" : "unverified",
            signature: input.signatureValid === false ? "invalid"
                : input.signatureValid === true ? "valid" : "unverified",
            invalidFields: Object.freeze(invalidFields),
            secondaryReasons: Object.freeze([...(extra.secondaryReasons || [])])
        });
    }

    function output(input, values, extra = {}) {
        return Object.freeze({
            status: values.status,
            reason: values.reason,
            origin: origin(input.origin),
            dataTradingDate: date(input.dataTradingDate || input.tradingDate || input.sourceDate),
            sourceUpdatedAt: iso(input.sourceUpdatedAt || input.pageUpdatedAt ||
                input.publishedAt || input.listingUpdatedAt),
            fetchedAt: iso(input.fetchedAt),
            lastAttemptedAt: iso(input.lastAttemptedAt),
            lastAttemptStatus: ATTEMPT_STATUSES.has(input.lastAttemptStatus)
                ? input.lastAttemptStatus : null,
            displayEligible: values.displayEligible,
            calculationEligible: calculation(input.calculationEligible),
            staleSince: values.status === "stale" ? iso(input.staleSince) : null,
            staleReason: values.status === "stale" ? values.staleReason : null,
            diagnostics: diagnostics(input, extra)
        });
    }

    function unavailable(input, reason, extra = {}) {
        return output(input, { status: "unavailable", reason, displayEligible: false,
            staleReason: null }, extra);
    }

    function evaluateDailyFreshness(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
            return unavailable({}, "no_saved_data", { policyType: "daily" });
        }
        const dataDate = date(input.dataTradingDate || input.tradingDate);
        const hasData = input.hasData === true || Boolean(dataDate || iso(input.sourceUpdatedAt) ||
            iso(input.pageUpdatedAt) || iso(input.quotedAt) || iso(input.fetchedAt));
        const attemptFailed = input.lastAttemptStatus === "failed";
        const validated = input.validation !== false && input.signatureValid !== false;
        const saved = input.origin === "cache" || input.origin === "history";
        const secondaryReasons = [];
        if (attemptFailed) secondaryReasons.push("fetch_failed");
        if (input.signatureValid == null) secondaryReasons.push("signature_unverified");
        if (input.mode === "manual") secondaryReasons.push("manual_value");
        if (input.contractMatches === false) secondaryReasons.push("contract_mismatch");

        const extra = { policyType: "daily", mode: text(input.mode),
            contract: text(input.contract), secondaryReasons };
        if (!hasData) return unavailable(input, attemptFailed ? "fetch_failed" : "no_saved_data", extra);
        if (!validated) return unavailable(input, "no_saved_data", extra);

        const expected = date(input.expectedTradingDate);
        const reference = date(input.currentReferenceDate);
        const comparison = expected || reference;
        const invalidDateInput = (input.dataTradingDate != null || input.tradingDate != null) && !dataDate;
        const displayEligible = input.displayEligible !== false;

        if (input.mode === "manual") {
            return output(input, { status: "stale", reason: "date_unverifiable", displayEligible,
                staleReason: "manual_not_automatic_freshness" }, extra);
        }
        if (input.contractMatches === false) {
            return output(input, { status: "stale", reason: saved ? "saved_last_valid" : "date_unverifiable",
                displayEligible, staleReason: "contract_mismatch" }, extra);
        }
        if (invalidDateInput || !dataDate) {
            return output(input, { status: "stale", reason: "date_unverifiable", displayEligible,
                staleReason: "trading_date_unverifiable" }, extra);
        }
        if (comparison && dataDate === comparison && !attemptFailed && !saved) {
            return output(input, { status: "fresh", reason: "current", displayEligible,
                staleReason: null }, extra);
        }
        if (expected && input.isPreviousTradingDay === true && dataDate < expected) {
            return output(input, { status: "stale", reason: "previous_trading_day", displayEligible,
                staleReason: "data_older_than_expected" }, extra);
        }
        if (comparison && dataDate < comparison) {
            return output(input, { status: "stale",
                reason: saved ? "saved_last_valid" : "source_not_updated", displayEligible,
                staleReason: expected ? "data_older_than_expected" : "date_unverifiable" }, extra);
        }
        if (saved || attemptFailed) {
            return output(input, { status: "stale", reason: "saved_last_valid", displayEligible,
                staleReason: attemptFailed ? "update_check_failed" : "saved_data_origin" }, extra);
        }
        if (!comparison) {
            return output(input, { status: "stale", reason: "date_unverifiable", displayEligible,
                staleReason: "expected_trading_date_unknown" }, extra);
        }
        return output(input, { status: "fresh", reason: "current", displayEligible,
            staleReason: null }, extra);
    }

    function evaluateWeeklyFreshness(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
            return unavailable({}, "no_saved_data", { policyType: "weekly" });
        }
        const sourceDate = date(input.sourceDate || input.dataTradingDate);
        const hasData = input.hasData === true || Boolean(sourceDate || iso(input.publishedAt) ||
            iso(input.listingUpdatedAt) || iso(input.fetchedAt));
        const validated = input.validation === true && input.signatureValid === true;
        const remote = text(input.remoteCheckStatus);
        const secondaryReasons = [];
        if (remote === "failed") secondaryReasons.push("fetch_failed");
        if (remote === "newer_available") secondaryReasons.push("new_revision_available");
        const extra = { policyType: "weekly", remoteCheckStatus: remote, secondaryReasons };
        if (!hasData) return unavailable(input, remote === "failed" ? "fetch_failed" : "no_saved_data", extra);
        if (!validated) return unavailable(input, "no_saved_data", extra);
        if (!sourceDate) return output(input, { status: "stale", reason: "date_unverifiable",
            displayEligible: true, staleReason: "source_date_unverifiable" }, extra);
        if (remote === "newer_available" || remote === "not_updated") {
            return output(input, { status: "stale", reason: "source_not_updated",
                displayEligible: true, staleReason: remote }, extra);
        }
        if (remote === "failed") {
            return output(input, { status: "stale", reason: "saved_last_valid",
                displayEligible: true, staleReason: "update_check_failed" }, extra);
        }
        return output(input, { status: "fresh", reason: "current", displayEligible: true,
            staleReason: null }, extra);
    }

    function evaluateFreshness(input = {}) {
        if (NON_CURRENT_TYPES.has(input.sourceType)) {
            return Object.freeze({ applicable: false, status: "not_applicable",
                reason: input.sourceType === "morning_baseline" ? "session_based_reference" : "history_fact",
                sourceType: input.sourceType, promotedToCurrent: false });
        }
        if (input.policyType === "daily") return evaluateDailyFreshness(input);
        if (input.policyType === "weekly") return evaluateWeeklyFreshness(input);
        return Object.freeze({ applicable: false, status: "not_applicable",
            reason: "policy_type_unsupported", sourceType: text(input.sourceType),
            promotedToCurrent: false });
    }

    return Object.freeze({ FOUNDATION_VERSION, evaluateDailyFreshness,
        evaluateWeeklyFreshness, evaluateFreshness });
});
