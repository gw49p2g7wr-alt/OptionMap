(function (root, factory) { const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const factApi = commonJs ? require("./morningV5ReferencePriceFact.js") : root?.OptionMapMorningV5ReferencePriceFact;
    const mappingApi = commonJs ? require("./morningV5CrossContractMapping.js") : root?.OptionMapMorningV5CrossContractMapping;
    const api = factory(factApi, mappingApi); if (commonJs) module.exports = api;
    if (root) { root.OptionMapMorningV5ReferencePriceRuntime = api; const runtime = api.createRuntime();
        root.publishMorningV5ReferencePriceFact = runtime.publish;
        root.invalidateMorningV5ReferencePriceFact = runtime.invalidate;
        root.getMorningV5ReferencePriceFact = runtime.getState; }
})(typeof window !== "undefined" ? window : globalThis, function (factApi, mappingApi) {
    "use strict"; const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function createRuntime({ now = () => new Date().toISOString() } = {}) {
        let attempt = 0, generation = 0; let state = freeze({ runtimeVersion: RUNTIME_VERSION,
            status: "empty", reason: "not_published", publicationGeneration: 0,
            publishedAt: null, requestId: null, fact: null, mapping: null });
        const current = guard => { try { return typeof guard === "function" && guard() === true; }
            catch (_) { return false; } };
        async function publish(input = {}, { isCurrentRequest } = {}) {
            const own = ++attempt; if (!current(isCurrentRequest))
                return freeze({ published: false, reason: "stale_request" });
            const fact = await factApi?.buildMorningV5ReferencePriceFact?.({ ...input,
                isCurrentRequest: current(isCurrentRequest) });
            const mapping = fact?.available === true ?
                await mappingApi?.buildMorningV5CrossContractMapping?.(fact) : null;
            if (own !== attempt || !current(isCurrentRequest))
                return freeze({ published: false, reason: "stale_request" });
            generation += 1; const available = fact?.available === true && mapping;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: available ? "available" : "unavailable",
                reason: available ? null : fact?.reason || "mapping_unavailable",
                publicationGeneration: generation, publishedAt: now(), requestId: input.requestId || null,
                fact: available ? fact : null, mapping: available ? mapping : null });
            return freeze({ published: true, status: state.status, reason: state.reason, generation });
        }
        function invalidate(reason = "source_invalidated") { attempt += 1; generation += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "unavailable", reason,
                publicationGeneration: generation, publishedAt: now(), requestId: null,
                fact: null, mapping: null }); }
        const getState = () => freeze(clone(state));
        return freeze({ publish, invalidate, getState });
    }
    return freeze({ RUNTIME_VERSION, createRuntime });
});
