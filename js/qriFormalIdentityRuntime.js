(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) {
        root.OptionMapQriFormalIdentityRuntime = api;
        const runtime = api.createRuntime();
        root.beginQriFormalIdentityPublication = runtime.beginRequest;
        root.publishQriFormalIdentityFact = runtime.publish;
        root.markQriFormalIdentityUnavailable = runtime.markUnavailable;
        root.getQriFormalIdentityFact = runtime.getState;
    }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const RUNTIME_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function createRuntime({ now = () => new Date().toISOString() } = {}) {
        let generation = 0; let attempt = 0;
        let state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "empty",
            reason: "not_published", publicationGeneration: 0, publishedAt: null,
            requestId: null, fact: null });
        const current = guard => { try { return typeof guard === "function" && guard() === true; }
            catch (_) { return false; } };
        function unavailable(reason, requestId) { generation += 1; state = freeze({
            runtimeVersion: RUNTIME_VERSION, status: "unavailable", reason,
            publicationGeneration: generation, publishedAt: now(), requestId, fact: null }); }
        function beginRequest({ requestId, isCurrentRequest } = {}) {
            if (!text(requestId) || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_request" });
            attempt += 1; unavailable("acquisition_pending", requestId); return freeze({ published: true, generation });
        }
        async function publish(input = {}, { isCurrentRequest } = {}) {
            const requestId = text(input.requestId); const ownAttempt = ++attempt;
            if (!requestId || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_request" });
            await Promise.resolve();
            if (ownAttempt !== attempt || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_request" });
            const canonical = input.canonical; const persistence = input.persistenceResult;
            const eligible = input.canonicalValid === true && input.sourceKind === "formal_live" &&
                input.origin === "live" && input.mode === "auto" && input.usingFallback === false &&
                input.referenceOnly === false && canonical?.openInterestStatus === "available" &&
                ["saved", "unchanged"].includes(persistence?.status) &&
                text(input.canonicalSignature) && text(input.canonicalVersionKey) &&
                persistence?.versionKey === input.canonicalVersionKey && text(canonical?.contract) &&
                text(canonical?.tradingDate) && text(canonical?.pageUpdatedAt) && text(input.fetchedAt);
            if (!eligible) { unavailable(persistence?.reason || "formal_identity_incomplete", requestId);
                return freeze({ published: true, status: state.status, reason: state.reason, generation }); }
            const entry = `${canonical.contract}|${canonical.tradingDate}`;
            const fact = freeze({ sourceClass: "formal_live", sourceKind: "formal_live",
                origin: "live", usingFallback: false, referenceOnly: false, superseded: false,
                contract: canonical.contract, tradingDate: canonical.tradingDate,
                pageUpdatedAt: canonical.pageUpdatedAt, canonicalSignature: input.canonicalSignature,
                canonicalVersionKey: input.canonicalVersionKey, historyEntryIdentity: entry,
                historyRevisionIdentity: input.canonicalVersionKey,
                persistenceStatus: persistence.status, requestId, fetchedAt: input.fetchedAt,
                identityVerified: true, acquisitionVerified: true,
                generation: { source: "qri", sequence: generation + 1,
                    fingerprint: [requestId, input.canonicalVersionKey, persistence.status].join("|"), current: true } });
            generation += 1; state = freeze({ runtimeVersion: RUNTIME_VERSION, status: "available",
                reason: null, publicationGeneration: generation, publishedAt: now(), requestId, fact });
            return freeze({ published: true, status: "available", generation });
        }
        function markUnavailable({ requestId, reason = "source_invalidated", isCurrentRequest } = {}) {
            if (!text(requestId) || !current(isCurrentRequest)) return freeze({ published: false, reason: "stale_request" });
            attempt += 1; unavailable(reason, requestId); return freeze({ published: true, generation });
        }
        const getState = () => freeze(clone(state));
        return Object.freeze({ beginRequest, publish, markUnavailable, getState });
    }
    return Object.freeze({ RUNTIME_VERSION, createRuntime });
});
