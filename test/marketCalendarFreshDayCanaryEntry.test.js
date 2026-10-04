"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const Entry = require("../scripts/marketCalendarE4fFreshDayCanaryEntry.js");
const V = require("../js/marketCalendarRuntime/freshDayCanaryApproval.js");
const controllerPath = require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js");
const entryPath = require.resolve("../scripts/marketCalendarE4fFreshDayCanaryEntry.js");
const hold = () => ({ valid: true, status: "HOLD", reason: "already_succeeded_today", sourceId: V.SOURCE,
  startupInvocations: 1, retryCount: 0, migrationCalls: 0, transitionCalls: 0,
  authorizationCount: 0, fenceCount: 0, completionCount: 0, formalWrite: 0 });
const pass = () => ({ ...hold(), status: "PASS", reason: null, authorizationCount: 1,
  fenceCount: 1, completionCount: 1, freshReadonlyReadback: true });
function adapter(runController, extra = {}) {
  const messages = [], exits = [];
  const instance = Entry.createEntryAdapter({ runController,
    handoff: async m => { messages.push(m); }, quit: code => { exits.push(code); }, ...extra });
  return { instance, messages, exits };
}
for (const [id, expression] of [["E1 require", `require(${JSON.stringify(controllerPath)})`],
  ["E2 import", `import(${JSON.stringify(pathToFileURL(controllerPath).href)})`]]) {
  test(id + " controller import performs no startup/network/writer/state access", () => {
    // Deny all observable production effects, not merely inspect stdout.
    const script = `const fs=require('node:fs'),cp=require('node:child_process'),Module=require('node:module');
      fs.openSync=fs.writeFileSync=fs.renameSync=fs.mkdirSync=()=>{throw Error('persistent_access_forbidden')};
      cp.spawn=cp.spawnSync=cp.execFileSync=()=>{throw Error('process_access_forbidden')};
      const load=Module._load; Module._load=function(id,...a){
        if(['electron','http','https','node:http','node:https'].includes(id))throw Error('production_import_forbidden');
        return load.call(this,id,...a);
      }; global.fetch=()=>{throw Error('network_forbidden')}; ${expression};`;
    const child = cp.spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
  });
}
test("E3 installed-loader import shape invokes dedicated package entry once", async () => {
  let invocations = 0, quits = 0; const messages = [], order = [];
  const source = fs.readFileSync(entryPath, "utf8");
  const context = vm.createContext({ __filename: entryPath, module: { exports: {} },
    process: { type: "browser", versions: { electron: "42.5.1" }, stdout: { write(text, callback) {
      messages.push(JSON.parse(text)); order.push("handoff"); callback();
    } } },
    require: key => {
      if (key === "node:fs") return { readFileSync: () => JSON.stringify({ main: entryPath }), realpathSync: p => p };
      if (key === "node:path") return path;
      if (key === "./marketCalendarE4fFreshDayCanary.js") return { runProductionAcceptance: async () => { invocations++; order.push("controller"); return hold(); } };
      if (key === "../js/marketCalendarRuntime/freshDayCanaryApproval.js") return V;
      if (key === "electron") return { app: { getAppPath: () => "/isolated/package", quit: () => { quits++; order.push("quit"); } } };
      throw Error("unexpected_dependency");
    } });
  // No require.main exists in this import-shaped native realm.
  vm.runInContext(source, context);
  const pending = vm.runInContext("globalThis[Symbol.for('optionmap.fresh-day-canary.package-entry.v1')]", context);
  await pending;
  assert.equal(invocations, 1); assert.equal(quits, 1); assert.equal(messages.length, 1);
  assert.deepEqual(order, ["controller", "handoff", "quit"]);
  assert.equal(Entry.validateDelivery(messages[0], 0).status, "HOLD");
});
test("E4 duplicate callbacks join one promise; reject never permits second invocation", async () => {
  let count = 0; const f = adapter(async () => { count++; return hold(); });
  const one = f.instance.run(), two = f.instance.run(); assert.equal(one, two);
  await one; await f.instance.run(); assert.equal(count, 1); assert.equal(f.messages.length, 1); assert.deepEqual(f.exits, [0]);
});
test("duplicate entry module evaluation cannot issue another controller call", async () => {
  let count = 0;
  const wrapped = `(function() { ${fs.readFileSync(entryPath, "utf8")} })()`;
  const c = vm.createContext({ __filename: entryPath, module: { exports: {} },
    process: { type: "browser", versions: { electron: "42.5.1" }, stdout: { write: (_, cb) => cb() } },
    require: key => key === "node:fs" ? { readFileSync: () => JSON.stringify({ main: entryPath }), realpathSync: p => p } :
      key === "node:path" ? path : key === "./marketCalendarE4fFreshDayCanary.js" ? { runProductionAcceptance: async () => { count++; return hold(); } } :
      key === "../js/marketCalendarRuntime/freshDayCanaryApproval.js" ? V :
      key === "electron" ? { app: { getAppPath: () => "/isolated", quit() {} } } : null });
  vm.runInContext(wrapped, c); vm.runInContext(wrapped, c);
  await vm.runInContext("globalThis[Symbol.for('optionmap.fresh-day-canary.package-entry.v1')]", c);
  assert.equal(count, 1);
});
test("native rejection delivers explicit FAIL before Electron exit(1), not quit's zero exit", async () => {
  const order = [], messages = [], source = fs.readFileSync(entryPath, "utf8"); let calls = 0;
  const c = vm.createContext({ __filename: entryPath, module: { exports: {} },
    process: { type: "browser", versions: { electron: "42.5.1" }, stdout: { write(text, cb) {
      messages.push(JSON.parse(text)); order.push("handoff"); cb();
    } } }, require: key => key === "node:fs" ? { readFileSync: () => JSON.stringify({ main: entryPath }), realpathSync: p => p } :
      key === "node:path" ? path : key === "./marketCalendarE4fFreshDayCanary.js" ? { runProductionAcceptance: async () => {
        calls++; throw Error("explicit_acceptance_entry_required");
      } } : key === "../js/marketCalendarRuntime/freshDayCanaryApproval.js" ? V : key === "electron" ? { app: {
        getAppPath: () => "/isolated", quit: () => order.push("quit"), exit: code => order.push("exit:" + code)
      } } : null });
  vm.runInContext(source, c);
  await vm.runInContext("globalThis[Symbol.for('optionmap.fresh-day-canary.package-entry.v1')]", c);
  assert.equal(calls, 1); assert.equal(messages[0].receipt.status, "FAIL");
  assert.deepEqual(order, ["handoff", "exit:1"]); assert.equal(Entry.validateDelivery(messages[0], 0).valid, false);
});
test("E5 missing controller receipt yields explicit FAIL and unsuccessful exit", async () => {
  const f = adapter(async () => undefined), m = await f.instance.run();
  assert.equal(m.receipt.status, "FAIL"); assert.equal(m.receipt.reason, "controller_receipt_missing");
  assert.equal(m.receiptReceived, false); assert.deepEqual(f.exits, [1]); assert.equal(Entry.validateDelivery(m, 0).valid, false);
});
test("E6 exit zero with no receipt or reached markers is never PASS", () => {
  for (const message of [null, {}, { type: Entry.TYPE, receipt: pass() }])
    assert.equal(Entry.validateDelivery(message, 0).valid, false);
});
test("E7 throw/reject normalizes reason, hands off FAIL, never retries", async () => {
  let count = 0; const f = adapter(async () => { count++; throw Error("/private/raw/path secret"); });
  const m = await f.instance.run(); await f.instance.run();
  assert.equal(count, 1); assert.equal(m.controllerReached, true); assert.equal(m.receipt.status, "FAIL");
  assert.equal(m.receipt.reason, "controller_rejected"); assert.deepEqual(f.exits, [1]);
});
test("E8 same-day fixture retains HOLD and zero authorization/fence/write", async () => {
  const f = adapter(async () => hold()), m = await f.instance.run();
  assert.equal(Entry.validateDelivery(m, 0).status, "HOLD"); assert.equal(m.receipt.formalWrite, 0);
  assert.equal(m.receipt.authorizationCount + m.receipt.fenceCount, 0);
});
test("E9 validated success receipt retained, not synthesized by adapter", async () => {
  const r = pass(), f = adapter(async () => r), m = await f.instance.run();
  assert.equal(m.receipt, r); assert.equal(Entry.validateDelivery(m, 0).status, "PASS");
  const malformed = pass(); delete malformed.freshReadonlyReadback;
  const bad = await adapter(async () => malformed).instance.run(); assert.equal(bad.receipt.status, "FAIL");
});
test("E10 renderer cannot invoke adapter or explicit production controller", async () => {
  const module = { exports: {} }, source = fs.readFileSync(entryPath, "utf8");
  vm.runInNewContext(source, { module, __filename: entryPath, require: require("node:module").createRequire(entryPath),
    process: { type: "renderer", versions: { electron: "42.5.1" } }, window: { document: {} } });
  assert.throws(() => module.exports.createEntryAdapter({}), /main_side_only/);
  const controller = { exports: {} };
  vm.runInNewContext(fs.readFileSync(controllerPath, "utf8"), { module: controller,
    __dirname: path.dirname(controllerPath), require: require("node:module").createRequire(controllerPath),
    process: { type: "renderer" }, window: { document: {} } });
  await assert.rejects(controller.exports.runProductionAcceptance(), /main_side_only/);
});
test("E11 source/operation/worker/retry input cannot be supplied", async () => {
  let count = 0; const f = adapter(async () => { count++; return hold(); });
  for (const input of [{ sourceId: "us-bls-calendar" }, { operation: "manual" }, { worker: "elsewhere" }, { retries: 1 }]) {
    assert.throws(() => f.instance.run(input), /entry_arguments_forbidden/);
    await assert.rejects(require(controllerPath).runProductionAcceptance(input), /acceptance_arguments_forbidden/);
  }
  assert.equal(count, 0); assert.deepEqual(Object.keys(Entry), ["TYPE", "createEntryAdapter", "validateDelivery"]);
  await assert.rejects(require(controllerPath).runProductionAcceptance(), /native_controller_required/);
});
test("E12 future approval covers new entry and invalidates old sixteen-artifact approval", () => {
  assert.equal(V.CRITICAL_ARTIFACTS.length, 17);
  assert.equal(V.CRITICAL_ARTIFACTS.filter(p => p === "scripts/marketCalendarE4fFreshDayCanaryEntry.js").length, 1);
  const old = fs.readFileSync(path.resolve(__dirname, "../approvals/marketCalendarFreshDayCanary.json"), "utf8");
  assert.equal(V.parseManifest(old).reason, "manifest_digests_invalid");
  assert.equal(V.verifyRepository(path.resolve(__dirname, "..")).valid, false);
});
test("explicit production export rejects non-dedicated package and extra CLI input before approval/state access", async () => {
  for (const argv of [["electron", "/isolated", "--production"], ["electron", "/isolated", "--production", "--source=other"]]) {
    let approvalCalls = 0, stateCalls = 0; const module = { exports: {} };
    const baseRequire = require("node:module").createRequire(controllerPath);
    vm.runInNewContext(fs.readFileSync(controllerPath, "utf8"), { module, __dirname: path.dirname(controllerPath),
      process: { type: "browser", versions: { electron: "42.5.1" }, argv }, require: key => {
        if (key === "node:fs") return { readFileSync: () => JSON.stringify({ main: "other.js" }), realpathSync: p => p };
        if (key === "electron") return { app: { getAppPath: () => "/isolated" } };
        if (key === "../js/marketCalendarRuntime/freshDayCanaryPreflight.js") return {
          revision: () => { approvalCalls++; }, loadProduction: () => { stateCalls++; }
        };
        return baseRequire(key);
      } });
    await assert.rejects(module.exports.runProductionAcceptance(), argv.length === 3 ?
      /dedicated_package_entry_required/ : /explicit_acceptance_entry_required/);
    assert.equal(approvalCalls, 0); assert.equal(stateCalls, 0);
  }
});
test("receipt handoff completes before quit; broken transport never reports successful exit", async () => {
  const order = [], f = adapter(async () => hold(), { handoff: async () => {
    order.push("begin"); await new Promise(resolve => setImmediate(resolve)); order.push("confirmed");
  }, quit: code => order.push("quit:" + code) });
  await f.instance.run(); assert.deepEqual(order, ["begin", "confirmed", "quit:0"]);
  const failed = adapter(async () => pass(), { handoff: async () => { throw Error("closed"); } });
  assert.equal((await failed.instance.run()).receipt.reason, "receipt_handoff_failed"); assert.deepEqual(failed.exits, [1]);
});
test("non-dedicated package cannot auto-run entry just by importing it", () => {
  let calls = 0;
  vm.runInNewContext(fs.readFileSync(entryPath, "utf8"), { module: { exports: {} }, __filename: entryPath,
    process: { type: "browser", versions: { electron: "42.5.1" } }, require: key =>
      key === "node:fs" ? { readFileSync: () => JSON.stringify({ main: "/isolated/other.js" }), realpathSync: p => p } :
      key === "node:path" ? path : key === "./marketCalendarE4fFreshDayCanary.js" ? { runProductionAcceptance: () => calls++ } :
      key === "../js/marketCalendarRuntime/freshDayCanaryApproval.js" ? V :
      key === "electron" ? { app: { getAppPath: () => "/isolated" } } : null });
  assert.equal(calls, 0);
});
