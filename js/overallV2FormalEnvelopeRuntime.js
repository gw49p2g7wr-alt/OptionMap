(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) { root.OptionMapOverallV2FormalEnvelopeRuntime = api; const runtime = api.createRuntime();
        root.publishOverallV2FormalEnvelope = runtime.publish;
        root.markOverallV2FormalEnvelopeUnavailable = runtime.markUnavailable;
        root.getOverallV2FormalEnvelope = runtime.getState; }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const ENVELOPE_VERSION = 1;
    const OVERALL_V2_LOGIC_VERSION = "overall-v2-weights-55-45-v1";
    const clone = value => value == null ? value : typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.values(value).forEach(freeze); return Object.freeze(value); }
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`; return JSON.stringify(value); }
    async function hash(value) { const data = canonical(value); if (typeof module === "object" && module.exports)
        return require("node:crypto").createHash("sha256").update(data).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)); return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    async function createInputFingerprint(input) { return hash({ logicVersion: input.logicVersion,
        optionSourceIdentity: input.optionSourceIdentity || null,
        weeklySourceIdentity: input.weeklySourceIdentity || null,
        optionComponent: input.result?.components?.option || null,
        weeklyComponent: input.result?.components?.weekly || null }); }
    function createRuntime({ now = () => new Date().toISOString() } = {}) {
        let generation = 0; let attempt = 0; let state = freeze({ envelopeVersion: ENVELOPE_VERSION,
            status: "empty", reason: "not_published", publicationGeneration: 0, envelope: null });
        const current = guard => { try { return typeof guard === "function" && guard() === true; } catch (_) { return false; } };
        async function publish(input = {}, { isCurrentRequest } = {}) {
            const own = ++attempt; if (!current(isCurrentRequest)) return freeze({ published: false, reason: "stale_envelope" });
            const result = input.result; const option = result?.components?.option;
            const weekly = result?.components?.weekly; const qri = input.qriFact; const weeklyFact = input.weeklyFact;
            const optionBound = option?.available !== true || qri && option.metadata?.usingFallback === false &&
                option.metadata?.sourceDate === qri.tradingDate;
            const weeklyBound = weekly?.available !== true || weeklyFact &&
                weekly.metadata?.current?.versionKey === weeklyFact.currentVersionKey &&
                weekly.normalizedDirection === weeklyFact.normalizedDirection &&
                weekly.qualityFactor === weeklyFact.qualityFactor;
            const eligible = ["complete", "partial"].includes(result?.status) && optionBound && weeklyBound &&
                (option?.available === true || weekly?.available === true) && input.logicVersion === OVERALL_V2_LOGIC_VERSION;
            const optionSourceIdentity = option?.available === true ? { canonicalVersionKey: qri?.canonicalVersionKey,
                canonicalSignature: qri?.canonicalSignature, requestId: qri?.requestId,
                generation: clone(qri?.generation), sourceFingerprint: qri?.generation?.fingerprint } : null;
            const weeklySourceIdentity = weekly?.available === true ? { currentVersionKey: weeklyFact?.currentVersionKey,
                previousVersionKey: weeklyFact?.previousVersionKey, currentSignature: weeklyFact?.currentSignature,
                weeklyInputFingerprint: weeklyFact?.weeklyInputFingerprint,
                sourceFingerprint: weeklyFact?.sourceFingerprint, generation: clone(weeklyFact?.generation) } : null;
            const fingerprint = eligible ? await createInputFingerprint({ logicVersion: input.logicVersion,
                optionSourceIdentity, weeklySourceIdentity, result }) : null;
            if (own !== attempt || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_envelope" });
            generation += 1;
            if (!eligible) { state = freeze({ envelopeVersion: ENVELOPE_VERSION, status: "unavailable",
                reason: "source_binding_mismatch", publicationGeneration: generation,
                publishedAt: now(), requestId: input.requestId || null, envelope: null });
                return freeze({ published: true, status: "unavailable", generation }); }
            const envelope = freeze({ envelopeVersion: ENVELOPE_VERSION, status: result.status,
                reason: null, logicVersion: input.logicVersion, evaluatedAt: result.metadata?.calculatedAt || now(),
                publicationGeneration: generation, requestId: input.requestId,
                result: clone(result), optionSourceIdentity, weeklySourceIdentity,
                inputFingerprint: fingerprint, formalApplied: true, referenceOnly: false,
                identityVerified: true, diagnostics: { optionAvailable: option?.available === true,
                    weeklyAvailable: weekly?.available === true, warnings: clone(result.metadata?.warnings || []),
                    fallbackUsed: option?.metadata?.usingFallback === true,
                    scoreChanged: false, weightsChanged: false, qualityChanged: false } });
            state = freeze({ envelopeVersion: ENVELOPE_VERSION, status: "available", reason: null,
                publicationGeneration: generation, publishedAt: now(), requestId: input.requestId, envelope });
            return freeze({ published: true, status: "available", generation });
        }
        function markUnavailable(reason = "source_invalidated") { attempt += 1; generation += 1;
            state = freeze({ envelopeVersion: ENVELOPE_VERSION, status: "unavailable", reason,
                publicationGeneration: generation, publishedAt: now(), requestId: null, envelope: null }); }
        const getState = () => freeze(clone(state));
        return Object.freeze({ publish, markUnavailable, getState });
    }
    return Object.freeze({ ENVELOPE_VERSION, OVERALL_V2_LOGIC_VERSION, canonical,
        createInputFingerprint, createRuntime });
});
