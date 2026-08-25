(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const factApi = commonJs ? require("./currentPriceLiveIdentityFact.js") :
        root?.OptionMapCurrentPriceLiveIdentityFact;
    const api = factory(factApi);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapCurrentPriceLiveIdentityRuntime = api;
        const runtime = api.createCurrentPriceLiveIdentityRuntime();
        root.beginCurrentPriceLiveIdentityPublication = runtime.beginRequest;
        root.publishCurrentPriceLiveIdentityFact = runtime.publish;
        root.markCurrentPriceLiveIdentityUnavailable = runtime.markUnavailable;
        root.getCurrentPriceLiveIdentityFact = runtime.getState;
        root.getCurrentPriceLiveIdentityDiagnostics = runtime.getDiagnostics;
    }
})(typeof window !== "undefined" ? window : globalThis, function (factApi) {
    "use strict";

    const RUNTIME_VERSION = 1;

    function clone(value) {
        if (value == null) return value;
        return typeof structuredClone === "function" ? structuredClone(value) :
            JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function createCurrentPriceLiveIdentityRuntime({
        buildFact = factApi?.buildCurrentPriceLiveIdentityFact,
        now = () => new Date().toISOString()
    } = {}) {
        let publicationGeneration = 0;
        let latestAttempt = 0;
        let state = makeState("empty", "not_published", null, null, 0, null);

        function makeState(status, reason, requestId, fact, generation, formalMode) {
            return deepFreeze({ runtimeVersion: RUNTIME_VERSION, status, reason,
                publicationGeneration: generation, publishedAt: now(), requestId, fact,
                diagnostics: { loaded: true, status, reason, requestId,
                    publicationGeneration: generation, factAvailable: fact?.available === true,
                    identityVerified: fact?.identityVerified === true,
                    acquisitionVerified: fact?.acquisitionVerified === true,
                    mappingVerified: fact?.qriTradingDateMapping?.mappingVerified === true,
                    formalCurrentPriceMode: formalMode || null,
                    formalCurrentPriceMutated: false, storageAccessed: false,
                    fetchTriggered: false, domMutated: false,
                    overallV2Recalculated: false, morningCollectorInvoked: false } });
        }

        function guardCurrent(isCurrentRequest) {
            try { return typeof isCurrentRequest === "function" && isCurrentRequest() === true; }
            catch (_) { return false; }
        }

        function beginRequest({ requestId, isCurrentRequest, formalCurrentPriceMode = null } = {}) {
            const normalizedRequestId = text(requestId);
            if (!normalizedRequestId || !guardCurrent(isCurrentRequest)) {
                return deepFreeze({ published: false, reason: "stale_request",
                    publicationGeneration });
            }
            latestAttempt += 1;
            publicationGeneration += 1;
            state = makeState("unavailable", "acquisition_pending", normalizedRequestId, null,
                publicationGeneration, formalCurrentPriceMode);
            return deepFreeze({ published: true, status: state.status,
                publicationGeneration, requestId: normalizedRequestId });
        }

        async function publish(input = {}, options = {}) {
            const requestId = text(input.requestId);
            if (!requestId || !guardCurrent(options.isCurrentRequest)) {
                return deepFreeze({ published: false, reason: "stale_request",
                    publicationGeneration });
            }
            const attempt = ++latestAttempt;
            let fact;
            try {
                fact = typeof buildFact === "function"
                    ? await buildFact({ ...clone(input), isCurrentRequest: true }) : null;
            } catch (_) {
                fact = null;
            }
            if (attempt !== latestAttempt || !guardCurrent(options.isCurrentRequest)) {
                return deepFreeze({ published: false, reason: "stale_request",
                    publicationGeneration });
            }
            const eligible = fact?.available === true && fact.sourceKind === "live" &&
                fact.origin === "live" && fact.mode === "automatic" &&
                fact.identityVerified === true && fact.acquisitionVerified === true &&
                fact.currentRequestVerified === true && fact.requestId === requestId &&
                fact.contract === input.activeContract;
            publicationGeneration += 1;
            if (!eligible) {
                state = makeState("unavailable", fact?.reason || "identity_unavailable",
                    requestId, null, publicationGeneration, options.formalCurrentPriceMode);
            } else {
                state = makeState("available", fact.reason, requestId, clone(fact),
                    publicationGeneration, options.formalCurrentPriceMode);
            }
            return deepFreeze({ published: true, status: state.status, reason: state.reason,
                publicationGeneration, requestId });
        }

        function markUnavailable({ requestId, reason = "acquisition_failed", isCurrentRequest,
            formalCurrentPriceMode = null } = {}) {
            const normalizedRequestId = text(requestId);
            if (!normalizedRequestId || !guardCurrent(isCurrentRequest)) {
                return deepFreeze({ published: false, reason: "stale_request",
                    publicationGeneration });
            }
            latestAttempt += 1;
            publicationGeneration += 1;
            state = makeState("unavailable", text(reason) || "acquisition_failed",
                normalizedRequestId, null, publicationGeneration, formalCurrentPriceMode);
            return deepFreeze({ published: true, status: state.status, reason: state.reason,
                publicationGeneration, requestId: normalizedRequestId });
        }

        function getState() { return deepFreeze(clone(state)); }
        function getDiagnostics() { return deepFreeze(clone(state.diagnostics)); }

        return Object.freeze({ beginRequest, publish, markUnavailable, getState, getDiagnostics });
    }

    return Object.freeze({ RUNTIME_VERSION, createCurrentPriceLiveIdentityRuntime });
});
