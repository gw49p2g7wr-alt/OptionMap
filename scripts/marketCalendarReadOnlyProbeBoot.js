(function (root) {
    "use strict";
    const params = new URLSearchParams(root.location.search);
    if (params.get("isolated") !== "1") return;
    const emit = value => console.log(`OPTIONMAP_PROBE_STAGE ${JSON.stringify(value)}`);
    const rawIndexedDB = root.indexedDB;
    try { Object.defineProperty(root, "indexedDB", { value: undefined, writable: false,
        configurable: false }); }
    catch (error) { console.error(`OPTIONMAP_PROBE_FATAL indexeddb_capability_seal_failed:${error}`); return; }
    root.OptionMapMarketCalendarReadOnlyProbe.run({ indexedDB: rawIndexedDB,
        gateTools: root.OptionMapMarketCalendarReadOnlyGateTools,
        sourceId: params.get("sourceId") || "us-bea-calendar",
        databaseName: "optionMapMarketCalendarHistory", origin: root.location.origin,
        session: params.get("session"), emit }).then(value => {
        root.document.getElementById("status").textContent = value.ok ? "Probe complete" : "Probe rejected";
        console.log(`OPTIONMAP_PROBE_RESULT ${JSON.stringify({ ok: value.ok, error: value.error,
            outcome: value.outcome, inventory: value.result?.inventory, resources: value.resources })}`);
    }, error => console.error(`OPTIONMAP_PROBE_FATAL ${error?.stack || error}`));
})(typeof window !== "undefined" ? window : globalThis);
