(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const v1 = commonJs ? require("./fullExport.js") : root?.OptionMapFullExport;
    const security = commonJs ? require("./fullExportSecurity.js") : root?.OptionMapFullExportSecurity;
    const api = factory(v1, security);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportV2 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (v1, security) {
    "use strict";
    const SCHEMA_VERSION = "optionmap-full-export-v2";
    const TOP_LEVEL_KEYS = Object.freeze(["schemaVersion", "exportMeta", "compactSummary",
        "sections", "sourceFaithfulCanonical", "warnings"]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    function cloneOrdered(value) {
        if (Array.isArray(value)) return value.map(cloneOrdered);
        if (!object(value)) return value;
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, cloneOrdered(value[key])]));
    }
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze); return Object.freeze(value);
    }
    function v1Projection(value) {
        return { schemaVersion: v1.SCHEMA_VERSION, exportMeta: value.exportMeta,
            compactSummary: value.compactSummary, sections: value.sections, warnings: value.warnings };
    }
    function validateSource(value) {
        const errors = [];
        if (!object(value) || value.contractVersion !== 1) return ["source_contract_invalid"];
        const expected = ["selectionPolicy", "qriOpenInterest", "qriImpliedVolatility",
            "weeklyFutures", "weeklyOptions", "participants", "jpxDerivativesOpenInterestDaily"];
        for (const key of expected) if (!Object.hasOwn(value, key)) errors.push(`${key}_missing`);
        const policy = value.selectionPolicy;
        if (!object(policy) || policy.scope !== "export_basis_revisions" ||
            policy.wholeHistoryIncluded !== false || policy.rawHtmlIncluded !== false ||
            policy.rawExcelIncluded !== false) errors.push("selection_policy_invalid");
        const participant = value.participants;
        if (participant?.status === "available") {
            for (const role of ["dayAuction", "dayJnet", "nightAuction", "nightJnet"]) {
                const file = participant.files?.[role];
                if (!file || file.fileRole !== role || !Array.isArray(file.records) ||
                    file.records.some(item => item?.provenance?.fileRole !== role ||
                        !object(item.record))) errors.push(`participant_${role}_invalid`);
            }
        }
        const daily = value.jpxDerivativesOpenInterestDaily;
        if (daily?.status === "available") {
            const futures = daily.canonical?.blocks?.oseIndexFutures?.records;
            const options = daily.canonical?.blocks?.oseIndexOptions?.records;
            if (daily.selectionPolicy?.aggregation !== "none" || daily.selectionPolicy?.filtering !== "none" ||
                daily.selectionPolicy?.rawExcelIncluded !== false || !Array.isArray(futures) ||
                !Array.isArray(options) || futures.length + options.length === 0 ||
                !object(daily.sourceProvenance?.evidence)) errors.push("jpx_derivatives_open_interest_invalid");
        }
        return errors;
    }
    function validate(value) {
        const errors = [];
        if (!object(value) || Object.keys(value).length !== TOP_LEVEL_KEYS.length ||
            !TOP_LEVEL_KEYS.every(key => Object.hasOwn(value, key))) errors.push("top_level_invalid");
        if (value?.schemaVersion !== SCHEMA_VERSION) errors.push("schema_version_invalid");
        const projected = value ? v1Projection(value) : null;
        const v1Validation = v1?.validateFullExport?.(projected) || { valid: false,
            errors: ["v1_validator_unavailable"] };
        if (!v1Validation.valid) errors.push(...v1Validation.errors.map(error => `v1:${error}`));
        errors.push(...validateSource(value?.sourceFaithfulCanonical));
        const secure = security?.inspectFullExportSecurity?.(value) || { valid: false, errors: [] };
        if (!secure.valid) errors.push(...secure.errors.map(error =>
            `security:${error.code}:${error.path}`));
        return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
    }
    function build(v1Export, sourceFaithfulCanonical) {
        if (v1?.validateFullExport?.(v1Export)?.valid !== true) throw new Error("v1_export_invalid");
        const candidate = { schemaVersion: SCHEMA_VERSION, exportMeta: cloneOrdered(v1Export.exportMeta),
            compactSummary: cloneOrdered(v1Export.compactSummary), sections: cloneOrdered(v1Export.sections),
            sourceFaithfulCanonical: cloneOrdered(sourceFaithfulCanonical),
            warnings: cloneOrdered(v1Export.warnings) };
        const result = Object.fromEntries(TOP_LEVEL_KEYS.map(key => [key, candidate[key]]));
        const checked = validate(result);
        if (!checked.valid) throw new Error(`full_export_v2_invalid:${checked.errors.join(",")}`);
        return deepFreeze(result);
    }
    function serialize(value, space = 2) {
        const checked = validate(value);
        if (!checked.valid) throw new Error(`full_export_v2_invalid:${checked.errors.join(",")}`);
        return JSON.stringify(Object.fromEntries(TOP_LEVEL_KEYS.map(key =>
            [key, cloneOrdered(value[key])])), null, space);
    }
    return Object.freeze({ SCHEMA_VERSION, build, validate, serialize, v1Projection });
});
