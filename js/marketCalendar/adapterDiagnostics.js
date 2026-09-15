(function (root, factory) {
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const api = factory(registry);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventAdapterDiagnostics = api;
})(typeof window !== "undefined" ? window : globalThis, function (registry) {
    "use strict";
    function evaluateFetchEnvelope(value) {
        const errors = [], source = registry?.getSource(value?.sourceId);
        if (!source) errors.push("source_unregistered");
        const requested = registry?.validateSourceUrl(value?.sourceId, value?.requestedUrl);
        const final = registry?.validateSourceUrl(value?.sourceId, value?.finalUrl);
        if (!requested?.valid) errors.push("requested_url_rejected");
        if (!final?.valid) errors.push("final_url_rejected");
        if (requested?.valid && final?.valid && new URL(requested.url).hostname !== new URL(final.url).hostname)
            errors.push("redirect_host_changed");
        if (!Number.isInteger(value?.httpStatus) || value.httpStatus < 200 || value.httpStatus >= 300)
            errors.push("http_status_rejected");
        if (value?.adapterVersion !== source?.parserVersion) errors.push("adapter_version_mismatch");
        if (!Array.isArray(value?.records) || !Array.isArray(value?.diagnostics)) errors.push("result_shape_invalid");
        const formalReady = errors.length === 0 && value.diagnostics.length === 0;
        return Object.freeze({ valid: errors.length === 0, formalReady,
            status: formalReady ? "success" : errors.length ? "rejected" : "partial",
            errors: Object.freeze(errors) });
    }
    return Object.freeze({ evaluateFetchEnvelope });
});
