"use strict";

// Fixed production composition for CAL-PB-B4/B5. The hidden renderer receives an
// already-authorized source plan only; grant issuance/consumption and durable
// receipt acceptance remain main-owned.
const fs = require("node:fs");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../marketCalendarHistory/bootstrapSchemaV1.js");
const WriterCore = require("../marketCalendarHistory/formalControlledWriterCore.js");
const Authority = require("../marketCalendarHistory/calendarPartialSourceExecutionAuthority.js");
const Atomic = require("../marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const FormalReader = require("./formalShadowElectronRead.js");
const HiddenWindow = require("./mofHiddenRendererWindow.js");
const Coordinator = require("./calendarPartialBootstrapCoordinator.js");

function mainOnly() {
  if (process.type !== "browser" || !process.versions.electron) throw new Error("native_main_required");
}
function rendererProgram(plan, operation) {
  const coreSource = fs.readFileSync(require.resolve(
    "../marketCalendarHistory/formalControlledWriterCore.js"), "utf8"), schema = {
      DATABASE_NAME: Schema.DATABASE_NAME, VERSION: Schema.VERSION,
      EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT, STORES: Schema.STORES };
  return `(async()=>{const Schema=${JSON.stringify(schema)},stable=(${Canonicalizer.stable.toString()}),
    module={exports:{}},dependencies={"./productionSchemaV1.js":Schema,
    "./bootstrapSchemaV1.js":{STORE_ORDER:${JSON.stringify(WriterCore.STORE_ORDER)}},
    "../marketCalendar/marketEventCanonicalizer.js":{stable}};
    ((module,require)=>{${coreSource}\n})(module,key=>{if(!Object.hasOwn(dependencies,key))
      throw Error("partial_bootstrap_dependency_rejected");return dependencies[key]});
    return (${Atomic.executeAuthorizedMutationInRenderer.toString()})(${JSON.stringify(plan)},
      ${JSON.stringify(operation)},module.exports,Schema,${JSON.stringify(BootstrapSchema.STORE_ORDER)},
      stable,indexedDB);})()`;
}
function createExecutor(executionAuthority) {
  let serial = Promise.resolve(), last = null;
  async function perform(input = {}) {
    if (!input || Object.keys(input).sort().join("|") !== "grant|plan")
      return { status: "rejected", reason: "invalid_plan", committed: false };
    const checked = await Authority.validatePlan(input.plan);
    if (!checked.valid) return { status: "rejected", reason: checked.reason, committed: false };
    const consumed = await executionAuthority.consumeGrant(input.grant, input.plan);
    if (!consumed.valid) return { status: "rejected", reason: consumed.reason, committed: false };
    if (consumed.binding.noOp || !["create_schema_and_commit_first_source",
      "append_missing_source", "append_source_revision"].includes(consumed.binding.operation))
      return { status: "rejected", reason: "operation_not_enabled", committed: false };
    const window = await HiddenWindow.createProductionWindow();
    try {
      const raw = await window.run(rendererProgram(input.plan, consumed.binding.operation));
      return await Atomic.finalizeAuthorizedRendererExecution(input.plan,
        consumed.binding.operation, raw);
    } finally { await window.close(); }
  }
  function executeCalendarFormalSourceMutation(input) {
    const task = serial.then(() => perform(input));
    serial = task.then(value => { last = value; return undefined; }, () => undefined);
    return task;
  }
  return Object.freeze({ executeCalendarFormalSourceMutation,
    diagnostics: () => last == null ? null : structuredClone(last) });
}
function createProductionRuntime(webContents) {
  mainOnly();
  if (!webContents || webContents.session !== require("electron").session.defaultSession)
    throw new Error("production_context_invalid");
  const readFormal = FormalReader.createReader(webContents), executionAuthority =
    Authority.createCalendarPartialExecutionAuthority(), executor = createExecutor(executionAuthority),
    coordinator = Coordinator.createCalendarPartialBootstrapCoordinator({ readFormal,
      executionAuthority, executor, notify: () => webContents.executeJavaScript(
        "document.dispatchEvent(new CustomEvent('optionmap:calendar-formal-updated'))") });
  return Object.freeze({ processGeneration: coordinator.processGeneration,
    diagnostics: () => ({ coordinator: coordinator.diagnostics(), executor: executor.diagnostics() }),
    close: coordinator.close });
}

module.exports = Object.freeze({ createProductionRuntime });
