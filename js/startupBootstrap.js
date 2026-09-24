(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapStartupBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DEFAULT_TIMEOUT_MS = 8000;

    function safeReason(error) {
        if (error && typeof error.message === "string" && error.message) {
            return error.message.slice(0, 200);
        }
        return typeof error === "string" && error ? error.slice(0, 200) : "initializer_rejected";
    }

    function createCoordinator(configuration = {}) {
        const initializers = Array.isArray(configuration.initializers)
            ? configuration.initializers : [];
        const refresh = configuration.refresh;
        const timeoutMs = Number.isFinite(configuration.timeoutMs) && configuration.timeoutMs > 0
            ? configuration.timeoutMs : DEFAULT_TIMEOUT_MS;
        const now = typeof configuration.now === "function" ? configuration.now : Date.now;
        const setTimer = configuration.setTimer || setTimeout;
        const clearTimer = configuration.clearTimer || clearTimeout;
        let phase = "idle";
        let bootstrapPromise = null;
        let startupRefreshPromise = null;
        let startupRefreshTrigger = null;
        let diagnostics = [];

        function settleInitializer(initializer) {
            const name = typeof initializer?.name === "string" && initializer.name
                ? initializer.name : "unknown_initializer";
            const startedAt = now();
            return new Promise(resolve => {
                let settled = false;
                const finish = (outcome, reason = null) => {
                    if (settled) return;
                    settled = true;
                    clearTimer(timer);
                    resolve(Object.freeze({ name, outcome, reason,
                        elapsedMs: Math.max(0, now() - startedAt) }));
                };
                const timer = setTimer(() => finish("timeout", "initializer_timeout"), timeoutMs);
                try {
                    Promise.resolve().then(() => initializer.run()).then(
                        () => finish("success"),
                        error => finish("rejected", safeReason(error))
                    );
                } catch (error) {
                    finish("rejected", safeReason(error));
                }
            });
        }

        function requestStartupRefresh(trigger) {
            if (startupRefreshPromise) return startupRefreshPromise;
            startupRefreshTrigger = trigger;
            startupRefreshPromise = Promise.resolve().then(() => refresh());
            return startupRefreshPromise;
        }

        function start() {
            if (bootstrapPromise) return bootstrapPromise;
            phase = "initializing";
            bootstrapPromise = Promise.all(initializers.map(settleInitializer)).then(results => {
                diagnostics = results;
                phase = "settled";
                return requestStartupRefresh("automatic").then(
                    refreshResult => ({ diagnostics: results, refreshResult }),
                    error => Promise.reject(error)
                );
            }).finally(() => { phase = "complete"; });
            return bootstrapPromise;
        }

        function requestManualRefresh() {
            if (phase === "initializing") return requestStartupRefresh("manual");
            return refresh();
        }

        function getState() {
            return Object.freeze({ phase, timeoutMs, diagnostics: diagnostics.slice(),
                startupRefreshStarted: startupRefreshPromise !== null,
                startupRefreshTrigger });
        }

        return Object.freeze({ start, requestManualRefresh, getState });
    }

    return Object.freeze({ DEFAULT_TIMEOUT_MS, createCoordinator });
});
