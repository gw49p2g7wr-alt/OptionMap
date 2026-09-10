(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4Scheduler = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const INTERVAL_MS = 30 * 60 * 1000;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function windowDecision(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return freeze({ status: "invalid", eligible: false,
            millisecondsUntilStart: null });
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo",
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            second: "2-digit", hourCycle: "h23" }).formatToParts(date).map(part => [part.type, part.value]));
        const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
        if (seconds < 5 * 3600) return freeze({ status: "before", eligible: false,
            millisecondsUntilStart: (5 * 3600 - seconds) * 1000 });
        return freeze({ status: seconds < 9 * 3600 ? "inside" : "after",
            eligible: seconds < 9 * 3600, millisecondsUntilStart: null });
    }
    function createScheduler(configuration = {}) {
        const now = configuration.now || (() => new Date().toISOString());
        const setTimer = configuration.setTimer || ((fn, delay) => setTimeout(fn, delay));
        const clearTimer = configuration.clearTimer || (id => clearTimeout(id));
        const getRestore = configuration.getRestoreState || (() => null);
        const evaluateRestore = configuration.evaluateRestore || (async () => getRestore());
        const capture = configuration.captureAutomatic;
        const targetedRefresh = configuration.targetedRefresh;
        const userRefreshActive = configuration.isUserRefreshActive || (() => false);
        const createRequestId = configuration.createRequestId || (sequence => `morning-v4-retry-${sequence}`);
        const onStateChange = configuration.onStateChange || (() => {});
        let generation = 0; let attempt = 0; let timer = null; let disposed = false; let inProgress = false;
        let state = freeze({ status: "idle", generation: 0, inProgress: false, lastAttemptAt: null,
            nextEligibleAt: null, lastReason: null, targetedSources: [], stoppedReason: null,
            windowState: "unknown", attemptCount: 0 });
        const publish = values => { state = freeze({ ...clone(state), ...clone(values) });
            onStateChange(freeze(clone(state))); return freeze(clone(state)); };
        const schedule = delay => { if (disposed || timer !== null) return;
            const next = new Date(new Date(now()).getTime() + delay).toISOString();
            timer = setTimer(() => { timer = null; void tick(); }, delay);
            publish({ status: "scheduled", nextEligibleAt: next }); };
        function stop(reason, windowState = state.windowState) { generation += 1;
            if (timer !== null) clearTimer(timer); timer = null;
            return publish({ status: "stopped", generation, inProgress: false,
                nextEligibleAt: null, stoppedReason: reason, windowState }); }
        async function tick() {
            if (disposed || inProgress) return freeze(clone(state));
            const decision = windowDecision(now());
            if (decision.status === "after") return stop("window_closed", "after");
            if (decision.status === "invalid") return stop("clock_invalid", "invalid");
            if (decision.status === "before") { publish({ windowState: "before" });
                schedule(decision.millisecondsUntilStart); return freeze(clone(state)); }
            const ownGeneration = generation; const attemptId = ++attempt;
            if (userRefreshActive()) { publish({ status: "waiting", windowState: "inside",
                lastReason: "user_refresh_priority" }); schedule(INTERVAL_MS); return freeze(clone(state)); }
            inProgress = true; publish({ status: "running", inProgress: true, windowState: "inside",
                lastAttemptAt: now(), nextEligibleAt: null, attemptCount: attemptId,
                targetedSources: [], stoppedReason: null });
            const current = await evaluateRestore();
            if (disposed || ownGeneration !== generation) { inProgress = false; return freeze(clone(state)); }
            if (current?.restoreStatus === "invalid" || current?.integrityStatus === "integrity_invalid") {
                inProgress = false; return stop("storage_invalid", "inside"); }
            if (current?.restoreStatus === "valid" && current?.integrityStatus === "valid" &&
                current?.applicabilityStatus === "applicable" && current?.selectedBaselineId) {
                inProgress = false; return stop("baseline_applicable", "inside"); }
            const requestId = createRequestId(attemptId);
            let outcome = await capture?.({ mode: "automatic_first_success", requestId,
                requestedAt: now() });
            if (disposed || ownGeneration !== generation || userRefreshActive()) {
                inProgress = false; publish({ status: "waiting", inProgress: false,
                    lastReason: "user_refresh_priority" }); schedule(INTERVAL_MS); return freeze(clone(state)); }
            if (outcome?.saved || ["already_saved", "duplicate"].includes(outcome?.status)) {
                const restored = await evaluateRestore(); inProgress = false;
                if (restored?.applicabilityStatus === "applicable") return stop("baseline_applicable", "inside");
            }
            const refreshed = await targetedRefresh?.({ reason: outcome?.deficiencyReason ||
                outcome?.reason || outcome?.errorCode,
                requestId: createRequestId(`${attemptId}-targeted`) },
            () => !disposed && ownGeneration === generation && !userRefreshActive());
            if (disposed || ownGeneration !== generation || userRefreshActive() ||
                refreshed?.status === "stale") { inProgress = false; publish({ status: "waiting",
                    inProgress: false, lastReason: "user_refresh_priority" }); schedule(INTERVAL_MS);
                return freeze(clone(state)); }
            if (refreshed?.status === "completed" && windowDecision(now()).eligible) {
                outcome = await capture?.({ mode: "automatic_first_success",
                    requestId: createRequestId(`${attemptId}-capture`), requestedAt: now() });
                if (outcome?.saved || ["already_saved", "duplicate"].includes(outcome?.status)) {
                    const restored = await evaluateRestore(); inProgress = false;
                    if (restored?.applicabilityStatus === "applicable")
                        return stop("baseline_applicable", "inside");
                }
            }
            inProgress = false;
            const endWindow = windowDecision(now());
            if (!endWindow.eligible) return stop("window_closed", endWindow.status);
            publish({ status: "waiting", inProgress: false,
                lastReason: outcome?.reason || refreshed?.reason || "waiting_for_eligibility",
                targetedSources: clone(refreshed?.targetedSources || []) });
            schedule(INTERVAL_MS); return freeze(clone(state));
        }
        function start() { if (disposed) return freeze(clone(state)); generation += 1;
            publish({ generation, stoppedReason: null }); void tick(); return freeze(clone(state)); }
        function dispose() { disposed = true; return stop("disposed", state.windowState); }
        const getState = () => freeze(clone(state));
        return Object.freeze({ start, tick, dispose, getState });
    }
    return Object.freeze({ INTERVAL_MS, windowDecision, createScheduler });
});
