"use strict";

// Main-only fixed code in a separate JS world, sharing the existing file-origin IndexedDB.
// No exposed renderer/preload API, dynamic file path, or renderer-provided approval.
const fs = require("node:fs"), path = require("node:path");
const Authority = require("./calendarRouteAuthority.js");
const ID = "jp-stat-labor", WORLD = 1741;
const sources = ["../marketCalendar/sourceRegistry.js", "./sourceUpdateState.js",
  "../storage/marketCalendarRuntimeStateStore.js"].map(file => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
const b1 = fs.readFileSync(path.join(__dirname, "updatePolicy.js"), "utf8");
const policy = fs.readFileSync(path.join(__dirname, "routeReevaluationPolicy.js"), "utf8");
function createLaborRuntimeStateElectron({ webContents, getAuthority = () => Authority.PRODUCTION_AUTHORITY } = {}) {
  if (!webContents?.executeJavaScriptInIsolatedWorld) throw TypeError("labor_storage_context_required");
  const audits = [];
  async function invoke(operation, input) {
    const selected = Authority.selectRoute({ sourceId: ID, operation: "source-document-set" }, getAuthority());
    if (!selected.valid) return { status: "unavailable", reason: "authority_invalid", networkEligible: false };
    const code = `(async () => {
      ${sources}
      const selected = Object.freeze(${JSON.stringify(selected)});
      const state = window.OptionMapCalendarSourceUpdateState;
      const registry = window.OptionMapMarketEventSourceRegistry;
      const b1 = ((require) => { const module = { exports: {} }; ${b1}\n return module.exports; })(name => {
        if (name === '../marketCalendar/sourceRegistry.js') return registry;
        if (name === './sourceUpdateState.js') return state;
        throw Error('dependency_not_allowed');
      });
      const policy = ((require) => { const module = { exports: {} }; ${policy}\n return module.exports; })(name => {
        if (name === './sourceUpdateState.js') return state;
        if (name === './updatePolicy.js') return b1;
        if (name === './calendarRouteAuthority.js') return { selectRoute: request =>
          request.sourceId === '${ID}' && request.operation === 'source-document-set' && Object.keys(request).length === 2
            ? selected : { valid: false, reason: 'source_out_of_scope', acquisitionAllowed: false } };
        throw Error('dependency_not_allowed');
      });
      const store = window.OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({ indexedDB,
        targetEnvironment: 'controlled_labor', reevaluationPolicy: policy, getRouteAuthority: () => null });
      const result = await store.${operation}(${JSON.stringify(input)});
      return { result: ${operation === "read" ? "{ status: result.status, reason: result.reason || null, value: result.value }" : "result"},
        audit: store.diagnostics() };
    })()`;
    const output = await webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    audits.push(output.audit); return output.result;
  }
  return Object.freeze({
    read: () => invoke("read", ID),
    reserveReevaluation: input => invoke("reserveReevaluation", input),
    completeReevaluation: input => invoke("completeReevaluation", input),
    completeActiveAcquisition: input => invoke("completeActiveAcquisition", input),
    diagnostics: () => structuredClone(audits)
  });
}
module.exports = Object.freeze({ createLaborRuntimeStateElectron });
