(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const planner = commonJs ? require("./transitionPlanner.js") : root?.OptionMapMarketCalendarTransitionPlanner;
    const memory = commonJs ? require("./inMemoryHistory.js") : root?.OptionMapMarketCalendarInMemoryHistory;
    const integrity = commonJs ? require("./historyIntegrity.js") : root?.OptionMapMarketCalendarHistoryIntegrity;
    const api = factory(planner, memory, integrity);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarDisabledShadowWriter = api;
})(typeof window !== "undefined" ? window : globalThis, function (planner, memory, integrity) {
    "use strict";
    const SHADOW_VERSION = 1, PHASE_CEILING = "3G";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const stable = value => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
        if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };
    function createDisabledShadowWriter(configuration = {}) {
        const productionWriterSupplied = typeof configuration.productionWriter === "function";
        async function preview({ snapshot, run, canonicalSet, coverage = null, parserChanged = false } = {}) {
            const before = memory.normalize(snapshot), planned = planner.planTransition({ snapshot: before,
                run, canonicalSet, coverage, parserChanged });
            if (!planned.ok || !planned.changed) return Object.freeze({ shadow: true, readOnly: true,
                storageWrite: false, outcome: planned.outcome, errors: planned.errors || [], plan: null,
                projectedSnapshot: before });
            const applied = await memory.applyPlan(before, planned.plan);
            return Object.freeze({ shadow: true, readOnly: true, storageWrite: false,
                outcome: applied.committed ? "shadow_projected" : applied.outcome,
                errors: applied.error ? [applied.error] : [], plan: clone(planned.plan),
                projectedSnapshot: clone(applied.snapshot), integrity: applied.integrity || null });
        }
        async function compareWithFake({ projectedSnapshot, fakeSnapshot } = {}) {
            const [projectedIntegrity, fakeIntegrity] = await Promise.all([
                integrity.audit(projectedSnapshot), integrity.audit(fakeSnapshot)]), equal =
                projectedIntegrity.valid && fakeIntegrity.valid && stable(memory.normalize(projectedSnapshot)) ===
                stable(memory.normalize(fakeSnapshot));
            return Object.freeze({ shadow: true, storageWrite: false, equal,
                projectedIntegrity, fakeIntegrity });
        }
        function write() { return Promise.resolve(Object.freeze({ saved: false,
            outcome: "production_write_disabled", phaseCeiling: PHASE_CEILING,
            productionWriterSupplied, authorizationIgnored: true })); }
        return Object.freeze({ preview, compareWithFake, write, diagnostics: Object.freeze({
            shadowVersion: SHADOW_VERSION, phaseCeiling: PHASE_CEILING, shadowOnly: true,
            readOnly: true, productionStorageOpen: false, productionStorageWrite: false,
            schemaCreation: false, migration: false, uiConnected: false, timeTravelConnected: false,
            schedulerConnected: false, notificationConnected: false, overallV2Connected: false }) });
    }
    return Object.freeze({ SHADOW_VERSION, PHASE_CEILING, createDisabledShadowWriter });
});
