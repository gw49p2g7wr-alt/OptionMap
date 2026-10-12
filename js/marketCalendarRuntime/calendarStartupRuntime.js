(function (root, factory) {
  const node = typeof module === "object" && module.exports && !root?.document;
  const api = factory(node ? require("../storage/marketCalendarRuntimeStateStore.js") : root.OptionMapCalendarRuntimeStateStore,
    node ? require("./calendarRuntimeStateIntegration.js") : root.OptionMapCalendarRuntimeStateIntegration,
    node ? require("../marketCalendar/sourceRegistry.js") : root.OptionMapMarketEventSourceRegistry,
    node ? require("./normalAcquisitionContract.js") : null);
  if (node) module.exports = api;
  if (root) root.OptionMapCalendarStartupRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function (Store, Integration, Registry, Contracts) {
  "use strict";
  function create({ bridge, indexedDB = globalThis.indexedDB }) {
    const store = Store.createRuntimeStateStore({ indexedDB, targetEnvironment: "browser_runtime" });
    const runtime = Integration.createRuntimeStateIntegration({ store, targetEnvironment: "browser_runtime",
      acquisitionContract: Contracts?.NORMAL13,
      service: { check: request => bridge.checkCalendarSources(request.sourceIds === undefined ?
        { ...request, sourceIds: Registry.getNormalAcquisitionEnabledSourceIds() } : request) } });
    return Object.freeze({ check: runtime.check, startup: runtime.startup, restore: runtime.restore,
      diagnostics: store.diagnostics });
  }
  return Object.freeze({ create });
});
