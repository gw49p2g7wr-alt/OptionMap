(function (root, factory) {
    const contract = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceContract.js") : root?.OptionMapMarketEventSourceContract;
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const api = factory(contract, registry);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventParserContract = api;
})(typeof window !== "undefined" ? window : globalThis, function (contract, registry) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function parseFixtureDocument(document) {
        const source = registry?.getSource(document?.sourceId), diagnostics = [];
        if (!source) return Object.freeze({ status: "rejected", records: [],
            diagnostics: ["source_unregistered"] });
        if (document.parserId !== source.parserId || document.parserVersion !== source.parserVersion)
            return Object.freeze({ status: "rejected", records: [], diagnostics: ["parser_contract_mismatch"] });
        if (!Array.isArray(document.records)) return Object.freeze({ status: "rejected", records: [],
            diagnostics: ["records_not_array"] });
        const accepted = [];
        document.records.forEach((record, index) => {
            const value = { ...clone(record), sourceId: source.sourceId, sourceUrl: record.sourceUrl ||
                source.canonicalUrl, fetchedAt: document.fetchedAt, parserId: source.parserId,
                parserVersion: source.parserVersion, rawContentHash: document.rawContentHash };
            const validation = contract.validateSourceRecord(value);
            if (validation.valid) accepted.push(value);
            else diagnostics.push(...validation.errors.map(error => `record_${index}:${error}`));
        });
        const status = diagnostics.length === 0 ? "success" : accepted.length ? "partial" : "rejected";
        return Object.freeze({ status, records: Object.freeze(accepted.map(Object.freeze)),
            diagnostics: Object.freeze(diagnostics) });
    }
    return Object.freeze({ parseFixtureDocument });
});
