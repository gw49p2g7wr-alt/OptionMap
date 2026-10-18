(function (root, factory) {
    const api = factory();
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportConsumerReadiness = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VOCABULARY_VERSION = 1;
    const READINESS_VALUES = Object.freeze([
        "current", "reference", "limited", "unavailable", "invalid"
    ]);
    const SECTION_TARGETS = Object.freeze([
        "marketSnapshot", "qriOptions", "qriOptionsNextContract",
        "qriOptionsMajorSqNextContract", "qriHistoryComparison", "qriOptionIv",
        "weeklyFutures", "weeklyOptions", "participants", "overallV2", "morning",
        "morningV5Formal", "importantLevels", "intelligence"
    ]);
    const ROLE_TARGETS = Object.freeze(["active", "next", "major_sq"]);
    const INVALID_REASONS = new Set([
        "current_price_identity_mismatch", "formal_identity_mismatch",
        "next_contract_history_invalid", "next_contract_identity_mismatch",
        "next_contract_locator_invalid", "next_contract_signature_mismatch",
        "major_sq_history_invalid", "major_sq_identity_mismatch",
        "major_sq_locator_invalid", "major_sq_signature_mismatch",
        "qri_history_invalid", "weekly_options_history_invalid",
        "participant_validation_failed", "formal_overall_invalid",
        "formal_iv_validation_failed", "formal_iv_revision_invalid",
        "contract_mismatch", "payload_invalid"
    ]);
    const DATE_LIMITED_REASONS = new Set([
        "date_unverifiable", "trading_date_unverifiable", "source_date_unverifiable",
        "policy_type_unsupported", "multiple_role_freshness", "quote_timestamp_unavailable"
    ]);
    const REFERENCE_REASONS = new Set([
        "saved_last_valid", "stale_reference", "manual_reference", "history_fact",
        "session_based_reference", "formal_history", "previous_trading_day",
        "source_not_updated"
    ]);

    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const scalar = value => value === null || ["string", "boolean"].includes(typeof value) ||
        typeof value === "number" && Number.isFinite(value);
    const ownScalar = (value, key) => object(value) && Object.hasOwn(value, key) &&
        scalar(value[key]) ? value[key] : undefined;
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value);
    }

    function readinessFor({ status, reason, freshness }) {
        const freshnessStatus = text(ownScalar(freshness, "status"));
        const freshnessReason = text(ownScalar(freshness, "reason"));
        const payloadValidation = text(ownScalar(freshness, "payloadValidation"));
        const consumerState = text(ownScalar(freshness, "consumerState"));
        if (status === "invalid" || payloadValidation === "invalid" ||
            INVALID_REASONS.has(reason) || INVALID_REASONS.has(freshnessReason)) return "invalid";
        if (status === "partial") return "limited";
        if (consumerState === "valid_date_unverifiable" ||
            DATE_LIMITED_REASONS.has(freshnessReason) || payloadValidation === "unverified" ||
            consumerState === "unverified") return "limited";
        if (consumerState === "valid_saved_fallback" ||
            REFERENCE_REASONS.has(freshnessReason) || freshnessStatus === "saved" ||
            freshnessStatus === "stale" && payloadValidation === "valid") return "reference";
        if (status === "unavailable" || payloadValidation === "unavailable") return "unavailable";
        if (status === "available" && (consumerState === "valid_current" ||
            ["fresh", "current", "fresh_current"].includes(freshnessStatus))) return "current";
        return status === "available" ? "limited" : "unavailable";
    }

    function entry({ section, value, freshness, contract, dataTradingDate, pointer }) {
        const status = text(ownScalar(value, "status")) || "unavailable";
        const reasonValue = ownScalar(value, "reason");
        const reason = text(reasonValue);
        const result = { sourcePointer: pointer, status,
            readiness: readinessFor({ status, reason, freshness }) };
        if (reasonValue !== undefined) result.reason = reasonValue;
        const field = (target, outputKey, source, sourceKey) => {
            const candidate = ownScalar(source, sourceKey);
            if (candidate !== undefined) target[outputKey] = candidate;
        };
        field(result, "freshnessStatus", freshness, "status");
        field(result, "freshnessReason", freshness, "reason");
        field(result, "consumerState", freshness, "consumerState");
        field(result, "payloadValidation", freshness, "payloadValidation");
        const freshnessOrigin = ownScalar(freshness, "origin");
        const valueOrigin = ownScalar(value, "origin");
        const authorityOrigin = ownScalar(section?.authority, "origin");
        const origin = freshnessOrigin ?? valueOrigin ?? authorityOrigin;
        if (origin !== undefined && origin !== null) result.origin = origin;
        if (contract !== undefined && contract !== null) result.contract = contract;
        if (dataTradingDate !== undefined && dataTradingDate !== null) {
            result.dataTradingDate = dataTradingDate;
        }
        return result;
    }

    function sectionEntry(sections, name) {
        const section = sections[name];
        const freshness = object(section.freshness) ? section.freshness : {};
        return entry({ section, value: section, freshness,
            contract: ownScalar(section.summary, "contract"),
            dataTradingDate: ownScalar(freshness, "dataTradingDate") ??
                ownScalar(section.asOf, "tradingDate"),
            pointer: `/sections/${name}` });
    }

    function roleEntry(sections, role) {
        const section = sections.qriOptionIv;
        const roleValue = object(section.summary?.roles?.[role])
            ? section.summary.roles[role] : section;
        const freshness = object(roleValue.freshness) ? roleValue.freshness :
            object(section.freshness) ? section.freshness : {};
        return entry({ section, value: roleValue, freshness,
            contract: ownScalar(roleValue, "contract"),
            dataTradingDate: ownScalar(freshness, "dataTradingDate") ??
                ownScalar(roleValue, "tradingDate"),
            pointer: "/sections/qriOptionIv" });
    }

    function unavailable(reason) {
        return freeze({ status: "unavailable", reason,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: null, details: { vocabularyVersion: VOCABULARY_VERSION,
                authoritativeRoot: "/sections", authority: "derived_non_authoritative" } });
    }

    function buildConsumerReadinessIndex(sections = {}) {
        if (!object(sections) || SECTION_TARGETS.some(name => !object(sections[name]))) {
            return unavailable("consumer_readiness_source_invalid");
        }
        const entries = Object.fromEntries(SECTION_TARGETS.map(name =>
            [name, sectionEntry(sections, name)]));
        for (const role of ROLE_TARGETS) {
            entries[`qriOptionIv.${role}`] = roleEntry(sections, role);
        }
        return freeze({ status: "available", reason: null,
            authority: { source: "optionmap-full-export", sourceClass: "derived_index",
                origin: "runtime", formalStatus: "derived", versionKey: null, signature: null },
            asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
                pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
            freshness: { status: "not_applicable", reason: "index_only" },
            summary: { vocabularyVersion: VOCABULARY_VERSION,
                authoritativeRoot: "/sections", authority: "derived_non_authoritative", entries },
            details: { vocabulary: {
                current: "valid_current_evidence",
                reference: "valid_non_current_reference",
                limited: "valid_but_relationship_incomplete",
                unavailable: "required_data_absent_or_acquisition_failed",
                invalid: "payload_identity_signature_or_schema_invalid"
            } } });
    }

    return Object.freeze({ VOCABULARY_VERSION, READINESS_VALUES, SECTION_TARGETS,
        ROLE_TARGETS, readinessFor, buildConsumerReadinessIndex });
});
