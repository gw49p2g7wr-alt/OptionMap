(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) { root.OptionMapMorningV5ShadowRuntime = api; const runtime = api.createRuntime({
        collect: options => root.collectMorningV5Shadow?.(options) });
        root.publishMorningV5Shadow = runtime.publish; root.invalidateMorningV5Shadow = runtime.invalidate;
        root.getMorningV5ShadowState = runtime.getState; }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict"; const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function createRuntime({ collect, now = () => new Date().toISOString() } = {}) {
        let attempt = 0, generation = 0; let state = freeze({ runtimeVersion: RUNTIME_VERSION,
            status: "empty", reason: "not_published", publicationGeneration: 0,
            publishedAt: null, shadow: null });
        async function publish() { const own = ++attempt; const candidate = await collect?.();
            if (own !== attempt) return freeze({ published: false, reason: "stale_collection" });
            generation += 1; state = freeze({ runtimeVersion: RUNTIME_VERSION,
                status: candidate?.status === "ready" ? "available" : "unavailable",
                reason: candidate?.status === "ready" ? null : candidate?.reason || "collector_unavailable",
                publicationGeneration: generation, publishedAt: now(), shadow: clone(candidate || null) });
            return freeze({ published: true, status: state.status, generation }); }
        function invalidate(reason = "source_invalidated") { attempt += 1; generation += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "unavailable", reason,
                publicationGeneration: generation, publishedAt: now(), shadow: null }); }
        return freeze({ publish, invalidate, getState: () => freeze(clone(state)) }); }
    return freeze({ RUNTIME_VERSION, createRuntime });
});
