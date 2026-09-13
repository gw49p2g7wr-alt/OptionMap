(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const mappingApi = commonJs ? require("./morningV5CrossContractMapping.js") :
        root?.OptionMapMorningV5CrossContractMapping;
    const factApi = commonJs ? require("./morningV5ReferencePriceFact.js") :
        root?.OptionMapMorningV5ReferencePriceFact;
    const api = factory(mappingApi, factApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningBaselineV5 = api;
})(typeof window !== "undefined" ? window : globalThis, function (mappingApi, factApi) {
    "use strict";
    const BASELINE_VERSION = 5, SCHEMA_VERSION = 1, SIGNATURE_ALGORITHM = "sha256";
    const FIELDS = Object.freeze(["baselineVersion", "schemaVersion", "baselineId", "capturedAt",
        "formalScope", "formalSupplyDemand", "referencePrice", "dataQuality", "comparability",
        "signatureAlgorithm", "contentSignature", "signature", "versionKey"]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => !!text(value) && Number.isFinite(Date.parse(value));
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
        fields.every(field => Object.hasOwn(value, field));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function sha256(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    function content(value) { return { baselineVersion: value.baselineVersion,
        schemaVersion: value.schemaVersion, formalScope: value.formalScope,
        formalSupplyDemand: value.formalSupplyDemand, referencePrice: value.referencePrice,
        dataQuality: value.dataQuality, comparability: value.comparability,
        signatureAlgorithm: value.signatureAlgorithm }; }
    function event(value) { return { ...content(value), baselineId: value.baselineId,
        capturedAt: value.capturedAt, contentSignature: value.contentSignature,
        versionKey: value.versionKey }; }
    async function validInput(input) {
        const scope = input.formalScope, lane = input.formalSupplyDemand;
        if (!object(scope) || !text(scope.formalScopeId) || !text(scope.formalTradingDate) ||
            !text(scope.optionContract) || !object(lane) || lane.available !== true ||
            lane.referenceOnly === true || lane.formalScopeId !== scope.formalScopeId ||
            lane.formalTradingDate !== scope.formalTradingDate || lane.optionContract !== scope.optionContract ||
            !text(lane.sourceFingerprint)) return false;
        if (input.referencePrice === null) return true;
        return object(input.referencePrice) &&
            await factApi?.validateMorningV5ReferencePriceFact?.(input.referencePrice.fact) &&
            await mappingApi?.validateMorningV5CrossContractMapping?.(
                input.referencePrice.mapping, input.referencePrice.fact) &&
            input.referencePrice.mapping.optionContract === scope.optionContract &&
            input.referencePrice.mapping.formalTradingDate === scope.formalTradingDate;
    }
    async function buildMorningBaselineV5(input = {}) {
        if (!timestamp(input.capturedAt) || !await validInput(input))
            return freeze({ success: false, reason: "baseline_input_invalid", baseline: null });
        const hasPrice = input.referencePrice !== null;
        const baseline = { baselineVersion: BASELINE_VERSION, schemaVersion: SCHEMA_VERSION,
            baselineId: text(input.baselineId) || `morning-v5:${input.formalScope.formalScopeId}`,
            capturedAt: input.capturedAt, formalScope: clone(input.formalScope),
            formalSupplyDemand: clone(input.formalSupplyDemand), referencePrice: clone(input.referencePrice),
            dataQuality: object(input.dataQuality) ? clone(input.dataQuality) : {},
            comparability: { supplyDemandEligible: true, priceEligible: hasPrice,
                divergenceEligible: hasPrice }, signatureAlgorithm: SIGNATURE_ALGORITHM,
            contentSignature: "", signature: "", versionKey: "" };
        baseline.contentSignature = await sha256(content(baseline));
        baseline.versionKey = `morning-baseline-v5|sha256:${baseline.contentSignature}`;
        baseline.signature = await sha256(event(baseline));
        return freeze({ success: true, reason: null, baseline: freeze(baseline) });
    }
    async function validateMorningBaselineV5(value) {
        if (!exact(value, FIELDS) || value.baselineVersion !== BASELINE_VERSION ||
            value.schemaVersion !== SCHEMA_VERSION || value.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !timestamp(value.capturedAt) || !await validInput(value)) return false;
        return value.contentSignature === await sha256(content(value)) &&
            value.versionKey === `morning-baseline-v5|sha256:${value.contentSignature}` &&
            value.signature === await sha256(event(value));
    }
    return freeze({ BASELINE_VERSION, SCHEMA_VERSION, SIGNATURE_ALGORITHM,
        buildMorningBaselineV5, validateMorningBaselineV5 });
});
