(function (root) {
    "use strict";
    const params = new URLSearchParams(root.location.search);
    const isolated = params.get("isolated") === "1", audit = params.get("audit") === "1";
    if (isolated === audit) return;
    const emit = value => console.log(`OPTIONMAP_PROBE_STAGE ${JSON.stringify(value)}`);
    const nonce = params.get("nonce"), mode = audit ? params.get("mode") : "preflight";
    if (root.location.origin !== "file://" || (audit && (!nonce ||
        !["catalog", "preflight"].includes(mode) ||
        typeof root.optionMapReadOnlyAuditReport?.send !== "function"))) {
        console.error("OPTIONMAP_PROBE_FATAL audit_configuration_invalid"); return; }
    root.OptionMapMarketCalendarReadOnlyProbe.run({
        guardFactory: root.OptionMapMarketCalendarTakeReadOnlyGuard,
        guardOptions: { failTransaction: audit && params.get("testTransactionFailure") === "1",
            failOpen: audit && params.get("testOpenFailure") === "1" },
        gateTools: root.OptionMapMarketCalendarReadOnlyGateTools,
        sourceId: params.get("sourceId") || "us-bea-calendar",
        databaseName: "optionMapMarketCalendarHistory", origin: root.location.origin,
        session: params.get("session"), mode, emit }).then(value => {
        root.document.getElementById("status").textContent = value.ok ? "Probe complete" : "Probe rejected";
        if (audit) { root.optionMapReadOnlyAuditReport.send(nonce, value); return; }
        console.log(`OPTIONMAP_PROBE_RESULT ${JSON.stringify({ ok: value.ok, error: value.error,
            outcome: value.outcome, inventory: value.result?.inventory, resources: value.resources })}`);
    }, error => console.error(`OPTIONMAP_PROBE_FATAL ${error?.stack || error}`));
})(typeof window !== "undefined" ? window : globalThis);
