(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriReferenceReadinessBarrier = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    // A normal hidden-window QRI reference pass includes the fixed JPX navigation
    // sequence and can take about a minute. Keep Export bounded without cutting
    // off that accepted acquisition lifecycle before it can publish its result.
    const DEFAULT_TIMEOUT_MS = 90000;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const identity = value => JSON.stringify(value ?? null);

    function createBarrier(configuration = {}) {
        const timeoutMs = configuration.timeoutMs || DEFAULT_TIMEOUT_MS;
        const setTimer = configuration.setTimer || ((callback, delay) => setTimeout(callback, delay));
        const clearTimer = configuration.clearTimer || (timer => clearTimeout(timer));
        if (typeof configuration.getNextRuntime !== "function" ||
            typeof configuration.getMajorSqRuntime !== "function" ||
            typeof configuration.getBinding !== "function") {
            throw new TypeError("reference_readiness_dependencies_missing");
        }

        async function wait() {
            const nextRuntime = configuration.getNextRuntime();
            const majorSqRuntime = configuration.getMajorSqRuntime();
            const settle = Promise.all([
                nextRuntime.waitForCurrentSettle(), majorSqRuntime.waitForCurrentSettle()
            ]);
            let timer = null;
            const timeout = new Promise(resolve => {
                timer = setTimer(() => resolve({ timedOut: true }), timeoutMs);
            });
            const result = await Promise.race([settle, timeout]);
            if (timer !== null) clearTimer(timer);
            if (result?.timedOut) throw new Error("qri_reference_readiness_timeout");
            const [next, majorSq] = result;
            const binding = clone(configuration.getBinding());
            if (next.status !== "settled" || majorSq.status !== "settled" ||
                binding?.next?.generation !== next.generation ||
                binding?.majorSq?.generation !== majorSq.generation ||
                binding?.next?.activeRequestId !== binding?.majorSq?.activeRequestId) {
                throw new Error("qri_reference_generation_changed");
            }
            return Object.freeze(clone(binding));
        }

        function matches(expected) {
            return identity(configuration.getBinding()) === identity(expected);
        }
        return Object.freeze({ wait, matches });
    }

    return Object.freeze({ DEFAULT_TIMEOUT_MS, createBarrier });
});
