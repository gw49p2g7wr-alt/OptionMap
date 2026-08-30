(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsReferenceAcquisitionRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

    function createRuntime({ orchestrator, buildFormalContext, now = () => new Date().toISOString() } = {}) {
        if (!orchestrator || typeof orchestrator.run !== "function" ||
            typeof orchestrator.invalidate !== "function" ||
            typeof orchestrator.dispose !== "function" ||
            typeof orchestrator.getState !== "function") throw new TypeError("orchestrator_invalid");
        if (typeof buildFormalContext !== "function") throw new TypeError("build_formal_context_missing");
        let generation = 0;
        let activeRequestId = null;
        let formalCompletedRequestId = null;
        let disposed = false;
        let runtimeState = freeze({ status: "idle", reason: null, generation: 0,
            activeRequestId: null, formalCompletedRequestId: null, startedAt: null,
            completedAt: null, errorCode: null });
        const publish = patch => {
            runtimeState = freeze({ ...runtimeState, ...clone(patch) });
            return getState();
        };
        const getState = () => freeze({ runtime: clone(runtimeState),
            acquisition: clone(orchestrator.getState()) });
        const getLifecycleState = () => freeze({ generation: null, disposed });

        function beginMarketRefresh(requestId) {
            const normalized = text(requestId);
            if (!normalized || disposed) return getState();
            generation += 1;
            activeRequestId = normalized;
            formalCompletedRequestId = null;
            orchestrator.invalidate("new_market_refresh");
            publish({ status: "pending_formal_completion", reason: null, generation,
                activeRequestId, formalCompletedRequestId: null, startedAt: now(),
                completedAt: null, errorCode: null });
            return getState();
        }

        function completeFormalRender(requestId) {
            const normalized = text(requestId);
            if (disposed || !normalized || normalized !== activeRequestId) return getState();
            formalCompletedRequestId = normalized;
            let context;
            try {
                context = buildFormalContext({ requestId: normalized,
                    formalCompletionVerified: true });
            } catch (error) {
                publish({ status: "failed", reason: "formal_context_adapter_failed",
                    completedAt: now(), errorCode: error?.message || String(error) });
                return getState();
            }
            publish({ status: "scheduled", reason: null, formalCompletedRequestId,
                completedAt: now(), errorCode: null });
            void Promise.resolve(orchestrator.run(context)).then(result => {
                if (!disposed && normalized === activeRequestId) publish({
                    status: result?.status || "completed", reason: result?.reason || null,
                    completedAt: now(), errorCode: result?.errorCode || null });
            }).catch(error => {
                if (!disposed && normalized === activeRequestId) publish({ status: "failed",
                    reason: "reference_run_rejected", completedAt: now(),
                    errorCode: error?.message || String(error) });
            });
            return getState();
        }

        function dispose() {
            if (!disposed) {
                disposed = true; generation += 1; orchestrator.dispose();
                publish({ status: "disposed", reason: "disposed", generation,
                    completedAt: now() });
            }
            return getState();
        }
        return Object.freeze({ beginMarketRefresh, completeFormalRender, dispose,
            getState, getLifecycleState });
    }

    return Object.freeze({ createRuntime });
});
