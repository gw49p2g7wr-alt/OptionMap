(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const factApi = commonJs ? require("./morningV5ReferencePriceFact.js") :
        root?.OptionMapMorningV5ReferencePriceFact;
    const api = factory(factApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5CrossContractMapping = api;
})(typeof window !== "undefined" ? window : globalThis, function (factApi) {
    "use strict";
    const MAPPING_VERSION = 1;
    const FIELDS = Object.freeze(["mappingVersion", "status", "mappingClass", "optionContract",
        "referenceContract", "formalTradingDate", "quoteDate", "referenceInstrument",
        "referenceSource", "referenceVersionKey", "mappingId"]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
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
    function content(mapping) { const value = { ...mapping }; delete value.mappingId;
        // The quote version is evidence attached to the mapping, not part of the stable
        // contract/date mapping identity used to compare two price observations.
        delete value.referenceVersionKey; return value; }
    async function buildMorningV5CrossContractMapping(fact) {
        if (!await factApi?.validateMorningV5ReferencePriceFact?.(fact)) return null;
        const mapping = { mappingVersion: MAPPING_VERSION, status: "verified",
            mappingClass: fact.optionContract === fact.contract ? "same_contract_reference" :
                "explicit_cross_contract_reference", optionContract: fact.optionContract,
            referenceContract: fact.contract, formalTradingDate: fact.formalTradingDate,
            quoteDate: fact.quoteDate, referenceInstrument: fact.instrument,
            referenceSource: fact.source, referenceVersionKey: fact.versionKey, mappingId: "" };
        mapping.mappingId = `morning-v5-mapping|sha256:${await sha256(content(mapping))}`;
        return freeze(mapping);
    }
    async function validateMorningV5CrossContractMapping(mapping, fact) {
        if (!exact(mapping, FIELDS) || mapping.mappingVersion !== MAPPING_VERSION ||
            mapping.status !== "verified" || !["same_contract_reference",
                "explicit_cross_contract_reference"].includes(mapping.mappingClass) ||
            !mapping.mappingId?.startsWith("morning-v5-mapping|sha256:")) return false;
        const expected = await buildMorningV5CrossContractMapping(fact);
        return !!expected && canonical(mapping) === canonical(expected);
    }
    return freeze({ MAPPING_VERSION, buildMorningV5CrossContractMapping,
        validateMorningV5CrossContractMapping });
});
