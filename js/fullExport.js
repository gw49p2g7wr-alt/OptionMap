(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports &&
        !(root && root.document);
    const securityApi = commonJs ? require("./fullExportSecurity.js") :
        root?.OptionMapFullExportSecurity;
    const api = factory(securityApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (securityApi) {
    "use strict";

    const SCHEMA_VERSION = "optionmap-full-export-v1";
    const SECTION_STATUSES = Object.freeze([
        "available", "partial", "unavailable", "invalid"
    ]);
    const REQUIRED_SECTION_KEYS = Object.freeze([
        "marketSnapshot", "overallV2", "morning", "importantLevels",
        "qriOptions", "qriHistoryComparison", "weeklyFutures", "weeklyOptions",
        "participants", "intelligence"
    ]);
    const TOP_LEVEL_KEYS = Object.freeze([
        "schemaVersion", "exportMeta", "compactSummary", "sections", "warnings"
    ]);
    const COMPACT_KEYS = Object.freeze([
        "generatedAt", "market", "session", "currentPrice", "currentContract",
        "overallV2", "morningChange", "importantLevels", "qriHighlights",
        "freshnessIssues", "warnings"
    ]);
    const ENVELOPE_KEYS = Object.freeze([
        "status", "reason", "authority", "asOf", "freshness", "summary", "details"
    ]);
    const AS_OF_KEYS = Object.freeze([
        "tradingDate", "sourceDate", "snapshotDate", "pageUpdatedAt", "fetchedAt",
        "confirmedAt"
    ]);
    const SAFE_INTERPRETATION = "supply_demand_assessment_not_trade_signal";

    const object = value => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    };
    const timestamp = value => typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
        Number.isFinite(Date.parse(value));
    const date = value => {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    const exactKeys = (value, keys) => object(value) &&
        Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function orderedClone(value, preferredKeys = null) {
        if (Array.isArray(value)) return value.map(item => orderedClone(item));
        if (!object(value)) return value;
        const sourceKeys = Object.keys(value);
        const keys = preferredKeys
            ? [...preferredKeys.filter(key => sourceKeys.includes(key)),
                ...sourceKeys.filter(key => !preferredKeys.includes(key)).sort()]
            : sourceKeys.sort();
        return Object.fromEntries(keys.map(key => [key, orderedClone(value[key],
            key === "compactSummary" ? COMPACT_KEYS : key === "sections"
                ? REQUIRED_SECTION_KEYS : value[key] && ENVELOPE_KEYS.every(envelopeKey =>
                    Object.hasOwn(value[key], envelopeKey)) ? ENVELOPE_KEYS :
                    key === "asOf" ? AS_OF_KEYS : null)]));
    }

    function validateAuthority(authority) {
        if (!object(authority)) return ["authority_invalid"];
        const origin = authority.origin;
        const nonFormalOrigin = ["fallback", "cache", "reference"].includes(origin);
        const claimsFormal = ["verified", "formal"].includes(authority.formalStatus) ||
            ["formal_live", "formal_history"].includes(authority.sourceClass);
        return nonFormalOrigin && claimsFormal ? ["authority_escalation"] : [];
    }

    function validateAsOf(asOf) {
        if (!exactKeys(asOf, AS_OF_KEYS)) return ["as_of_fields_invalid"];
        const errors = [];
        for (const key of ["tradingDate", "sourceDate", "snapshotDate"]) {
            if (asOf[key] !== null && !date(asOf[key])) errors.push(`${key}_invalid`);
        }
        for (const key of ["pageUpdatedAt", "fetchedAt", "confirmedAt"]) {
            if (asOf[key] !== null && !timestamp(asOf[key])) errors.push(`${key}_invalid`);
        }
        return errors;
    }

    function validateEnvelope(value, name) {
        const errors = [];
        if (!exactKeys(value, ENVELOPE_KEYS)) return [`${name}:section_fields_invalid`];
        if (!SECTION_STATUSES.includes(value.status)) errors.push(`${name}:status_invalid`);
        if (value.status === "available" && value.reason !== null)
            errors.push(`${name}:available_reason_invalid`);
        if (["unavailable", "invalid"].includes(value.status) &&
            (typeof value.reason !== "string" || !value.reason)) errors.push(`${name}:reason_missing`);
        if (value.reason !== null && typeof value.reason !== "string")
            errors.push(`${name}:reason_invalid`);
        errors.push(...validateAuthority(value.authority).map(error => `${name}:${error}`));
        errors.push(...validateAsOf(value.asOf).map(error => `${name}:${error}`));
        if (!object(value.freshness)) errors.push(`${name}:freshness_invalid`);
        if (value.summary !== null && !object(value.summary)) errors.push(`${name}:summary_invalid`);
        if (value.details !== null && !object(value.details)) errors.push(`${name}:details_invalid`);
        return errors;
    }

    function validateFullExport(value) {
        const errors = [];
        const security = securityApi?.inspectFullExportSecurity?.(value) ||
            { valid: false, errors: [{ code: "security_module_unavailable", path: "$" }] };
        if (!security.valid) errors.push(...security.errors.map(error =>
            `security:${error.code}:${error.path}`));
        if (!exactKeys(value, TOP_LEVEL_KEYS)) errors.push("top_level_fields_invalid");
        if (value?.schemaVersion !== SCHEMA_VERSION) errors.push("schema_version_invalid");
        const meta = value?.exportMeta;
        if (!object(meta) || !timestamp(meta.generatedAt) || meta.timeZone !== "Asia/Tokyo" ||
            meta.readOnly !== true || typeof meta.profile !== "string" || !meta.profile) {
            errors.push("export_meta_invalid");
        }
        const compact = value?.compactSummary;
        if (!exactKeys(compact, COMPACT_KEYS)) errors.push("compact_summary_fields_invalid");
        else {
            if (!timestamp(compact.generatedAt) || compact.generatedAt !== meta?.generatedAt)
                errors.push("compact_generated_at_invalid");
            if (typeof compact.market !== "string" || !compact.market) errors.push("market_invalid");
            if (!object(compact.session) || !object(compact.currentPrice) ||
                !object(compact.overallV2) || !object(compact.morningChange) ||
                !object(compact.importantLevels)) errors.push("compact_object_invalid");
            if (compact.currentContract !== null && typeof compact.currentContract !== "string")
                errors.push("current_contract_invalid");
            if (!Array.isArray(compact.qriHighlights) || !Array.isArray(compact.freshnessIssues) ||
                !Array.isArray(compact.warnings)) errors.push("compact_array_invalid");
            if (compact.overallV2?.interpretation !== SAFE_INTERPRETATION)
                errors.push("overall_v2_interpretation_invalid");
        }
        if (!object(value?.sections)) errors.push("sections_invalid");
        else {
            for (const key of REQUIRED_SECTION_KEYS) {
                if (!Object.hasOwn(value.sections, key)) errors.push(`${key}:section_missing`);
            }
            for (const [name, section] of Object.entries(value.sections)) {
                errors.push(...validateEnvelope(section, name));
            }
        }
        if (!Array.isArray(value?.warnings)) errors.push("warnings_invalid");
        return Object.freeze({ valid: errors.length === 0,
            errors: Object.freeze([...new Set(errors)]) });
    }

    function buildFullExport(input = {}) {
        const preflight = securityApi?.inspectFullExportSecurity?.(input);
        if (!preflight?.valid) {
            const codes = preflight?.errors?.map(error => error.code).join(",") ||
                "security_module_unavailable";
            throw new Error(`security_validation_failed:${codes}`);
        }
        const candidate = orderedClone({
            schemaVersion: SCHEMA_VERSION,
            exportMeta: input.exportMeta,
            compactSummary: input.compactSummary,
            sections: input.sections,
            warnings: input.warnings
        }, TOP_LEVEL_KEYS);
        const validation = validateFullExport(candidate);
        if (!validation.valid) throw new Error(`full_export_invalid:${validation.errors.join(",")}`);
        return deepFreeze(candidate);
    }

    function serializeFullExport(value, space = 2) {
        const validation = validateFullExport(value);
        if (!validation.valid) throw new Error(`full_export_invalid:${validation.errors.join(",")}`);
        return JSON.stringify(orderedClone(value, TOP_LEVEL_KEYS), null, space);
    }

    return Object.freeze({ SCHEMA_VERSION, SECTION_STATUSES, REQUIRED_SECTION_KEYS,
        SAFE_INTERPRETATION, buildFullExport, validateFullExport, serializeFullExport });
});
