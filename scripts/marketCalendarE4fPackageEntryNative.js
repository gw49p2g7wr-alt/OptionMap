"use strict";

// Explicit isolated acceptance only. No production profile, approval override or
// production runner invocation. The installed package import loader enters this
// fixture's explicit function, then the same adapter calls the isolated owner.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const Entry = require("./marketCalendarE4fFreshDayCanaryEntry.js");
const Controller = require("./marketCalendarE4fFreshDayCanary.js");
function isolatedRoot(root) {
  assert.equal(fs.realpathSync(root), root); assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("optionmap-writer-safety-entry-"));
  assert.equal(fs.readFileSync(path.join(root, "entry-isolated-marker"), "utf8"), "isolated entry fixture\n");
}
async function runIsolatedWorker(root) {
  if (process.type !== "browser" || !process.versions.electron) throw Error("isolated_native_main_required");
  isolatedRoot(root);
  const { app, BrowserWindow, session } = require("electron");
  app.setPath("appData", path.join(root, "appData")); app.setPath("userData", root);
  app.setPath("sessionData", path.join(root, "sessionData")); app.disableHardwareAcceleration();
  const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  const Historical = require("./marketCalendarE4fStartupCanary.js");
  const Fixture = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");
  const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
  const Old = require("../js/marketCalendarHistory/writerSafetyStore.js");
  const Store = require("../js/marketCalendarHistory/writerSafetyCanaryStore.js");
  const Canary = require("../js/marketCalendarRuntime/machineryStartupCanary.js");
  let window, setup, result, controllerCalls = 0, network = 0;
  const delivered = [], quits = [];
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, done) => {
      network++; done({ cancel: true });
    });
    const old = Old.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, policy: A.PRODUCTION_POLICY, crashAt: null });
    try { assert.equal((await old.provisionDisabled()).saved, true); } finally { old.close(); }
    setup = Store.createIsolatedStore(root);
    assert.equal((await setup.migrate(0)).saved, true); assert.equal((await setup.transition(1)).saved, true); setup.close();
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadFile(path.resolve(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
    const f = await Fixture.fixture({ perSource: 4 }); await Historical.seed(window.webContents, f);
    const controller = Controller.createIsolatedController({ root, wc: window.webContents,
      runtimeStateStore: Canary.genericStore(window.webContents), runtimeOptions: Historical.fixtureOptions(f) });
    // This is an isolated owner, never runProductionAcceptance or a forged native startup.
    const adapter = Entry.createEntryAdapter({ runController: () => { controllerCalls++; return controller.accept(); },
      handoff: async message => { delivered.push(message); }, quit: code => { quits.push(code); } });
    const first = adapter.run(); assert.equal(adapter.run(), first);
    const message = await first; await adapter.run();
    assert.equal(Entry.validateDelivery(message, 0).status, "PASS", message.receipt.reason);
    assert.equal(controllerCalls, 1); assert.equal(delivered.length, 1); assert.deepEqual(quits, [0]);
    const receipt = message.receipt, audit = receipt.runtime.execution.result.audit;
    assert.equal(audit.readwrite, 1); assert.equal(audit.committed, 1); assert.equal(audit.aborted, 0);
    assert.equal(receipt.authorizationCount, 1); assert.equal(receipt.fenceCount, 1); assert.equal(receipt.completionCount, 1);
    // Electron's execPath is Electron, not Node. Use its explicit Node mode for
    // the isolated read-only child; never launch a second Electron package.
    const freshChild = cp.spawnSync(process.execPath, [require.resolve("./marketCalendarE4fEnvelopeNative.js"), "read", root],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 10000 });
    assert.equal(freshChild.status, 0); assert.equal(freshChild.signal, null);
    const fresh = JSON.parse(freshChild.stdout);
    assert.notEqual(fresh.pid, process.pid); assert.equal(fresh.audit.fileHandles, 0); assert.equal(fresh.audit.lockHandles, 0);
    assert.deepEqual(fresh.result.record, receipt.finalSafety.record);
    const held = { valid: true, status: "HOLD", reason: "already_succeeded_today",
      sourceId: require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js").SOURCE,
      startupInvocations: 1, retryCount: 0, migrationCalls: 0, transitionCalls: 0,
      authorizationCount: 0, fenceCount: 0, completionCount: 0, formalWrite: 0 };
    async function mocked(run) {
      let calls = 0, receipt, exit;
      const adapter = Entry.createEntryAdapter({ runController: () => { calls++; return run(); },
        handoff: m => { receipt = m; }, quit: code => { exit = code; } });
      await adapter.run(); await adapter.run(); assert.equal(calls, 1); return { calls, status: receipt.receipt.status, exit };
    }
    const hold = await mocked(() => held), fail = await mocked(() => { throw Error("fixture_reject"); });
    assert.equal(hold.status, "HOLD"); assert.equal(fail.status, "FAIL"); assert.equal(fail.exit, 1);
    assert.equal(network, 0);
    result = { type: "isolated_package_entry_acceptance", valid: true, packageLaunches: 1, loader: "import()",
      entryReached: message.entryReached, controllerReached: message.controllerReached, controllerCalls,
      structuredReceipt: true, receiptStatus: receipt.status, authorization: receipt.authorizationCount,
      fence: receipt.fenceCount, completion: receipt.completionCount, finalSequence: receipt.finalSequence,
      audit, storageAudits: receipt.storageAudits, safetyAudit: receipt.runtime.safetyAudit,
      freshReadback: receipt.freshReadonlyReadback, freshSafetyReload: fresh.result.available,
      hold, fail, network, productionAccess: 0 };
  } catch (e) { result = { type: "isolated_package_entry_acceptance", valid: false,
    reason: /^[a-z_]+$/.test(e.message) ? e.message : "isolated_entry_failed", controllerCalls }; }
  finally {
    setup?.close(); session.defaultSession.webRequest.onBeforeRequest(null);
    if (window && !window.isDestroyed()) await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    app.off("window-all-closed", keepAlive);
    result.cleanup = { windows: BrowserWindow.getAllWindows().length, requests: network, listeners: 0 };
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + "\n", e => e ? reject(e) : resolve()));
    process.exitCode = result.valid ? 0 : 1; app.quit();
  }
}
function runNative() {
  if (process.versions.electron) throw Error("node_parent_required");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-entry-"));
  try {
    for (const name of ["appData", "sessionData"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "entry-isolated-marker"), "isolated entry fixture\n");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap-canary-entry-isolated", version: "1.0.0", main: "entry.cjs" }));
    fs.writeFileSync(path.join(root, "entry.cjs"), `import(${JSON.stringify(pathToFileURL(__filename).href)}).then(m => m.default.runIsolatedWorker(__dirname));\n`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawnSync(require("electron"), [root, `--user-data-dir=${root}`],
      { env, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    let result;
    for (const line of (child.stdout || "").split("\n")) try { const value = JSON.parse(line);
      if (value.type === "isolated_package_entry_acceptance") result = value; } catch (_) {}
    if (child.error || child.status !== 0 || child.signal || result?.valid !== true || !result.structuredReceipt)
      throw Error(result?.reason || "isolated_receipt_missing");
    return { ...result, stderr: child.stderr, tempRemoved: true };
  } finally { fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
if (require.main === module) process.stdout.write(JSON.stringify(runNative()) + "\n");
module.exports = Object.freeze({ runNative, runIsolatedWorker });
