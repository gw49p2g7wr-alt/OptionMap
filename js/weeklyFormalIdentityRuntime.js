(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) { root.OptionMapWeeklyFormalIdentityRuntime = api; const runtime = api.createRuntime();
        root.publishWeeklyFormalIdentityFact = runtime.publish;
        root.markWeeklyFormalIdentityUnavailable = runtime.markUnavailable;
        root.getWeeklyFormalIdentityFact = runtime.getState; }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const finite = Number.isFinite;
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
    async function hash(value) { const data = canonical(value); if (typeof module === "object" && module.exports)
        return require("node:crypto").createHash("sha256").update(data).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    async function createWeeklyInputFingerprint(input) { return hash({ previousVersionKey: input.previous?.versionKey,
        currentVersionKey: input.current?.versionKey, currentSignature: input.current?.signature,
        component: input.component }); }
    function createRuntime({ now = () => new Date().toISOString() } = {}) {
        let generation = 0; let attempt = 0; let state = freeze({ runtimeVersion: RUNTIME_VERSION,
            status: "empty", reason: "not_published", publicationGeneration: 0, fact: null });
        const current = guard => { try { return typeof guard === "function" && guard() === true; } catch (_) { return false; } };
        async function publish(input = {}, { isCurrentRequest } = {}) {
            const own = ++attempt; if (!current(isCurrentRequest)) return freeze({ published: false, reason: "stale_candidate" });
            const component = input.component; const valid = input.sourceClass === "formal_history" &&
                text(input.previous?.versionKey) && text(input.current?.versionKey) && text(input.current?.signature) &&
                input.activeVersionKey === input.current.versionKey && input.activeVersionMatched === true &&
                input.candidateComplete === true && text(input.requestId) && [component?.normalizedDirection,
                    component?.qualityFactor, component?.evidenceFactor, component?.effectiveWeight,
                    component?.weightedContribution].every(finite);
            const fingerprint = valid ? await createWeeklyInputFingerprint(input) : null;
            if (own !== attempt || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_candidate" });
            generation += 1;
            if (!valid) { state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "unavailable",
                reason: "formal_identity_incomplete", publicationGeneration: generation,
                publishedAt: now(), requestId: input.requestId || null, fact: null });
                return freeze({ published: true, status: "unavailable", generation }); }
            const fact = freeze({ sourceClass: "formal_history", sourceDate: input.current.sourceDate,
                previousVersionKey: input.previous.versionKey, currentVersionKey: input.current.versionKey,
                currentSignature: input.current.signature, activeVersionMatched: true,
                dataStatus: "formal_history", origin: "weekly_futures_history",
                sourceFingerprint: fingerprint, weeklyInputFingerprint: fingerprint,
                requestId: input.requestId, normalizedDirection: component.normalizedDirection,
                qualityFactor: component.qualityFactor, evidenceFactor: component.evidenceFactor,
                effectiveWeight: component.effectiveWeight, weightedContribution: component.weightedContribution,
                componentMetadata: clone(component.metadata || {}), requestContext: clone(input.requestContext || {}),
                generation: { source: "weekly", sequence: generation,
                    fingerprint: [input.requestId, fingerprint].join("|"), current: true } });
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "available", reason: null,
                publicationGeneration: generation, publishedAt: now(), requestId: input.requestId, fact });
            return freeze({ published: true, status: "available", generation });
        }
        function markUnavailable(reason = "source_invalidated") { attempt += 1; generation += 1;
            state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "unavailable", reason,
                publicationGeneration: generation, publishedAt: now(), requestId: null, fact: null }); }
        const getState = () => freeze(clone(state));
        return Object.freeze({ publish, markUnavailable, getState });
    }
    return Object.freeze({ RUNTIME_VERSION, canonical, createWeeklyInputFingerprint, createRuntime });
});
