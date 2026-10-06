"use strict";

// Isolated receipt transport / copied-DB inspection only. No production startup,
// controller invocation, acquisition, writer, migration or state transition.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict"), { createHash } = require("node:crypto"), { pathToFileURL } = require("node:url");
const Entry = require("./marketCalendarE4fFreshDayCanaryEntry.js");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function isolated(root) {
  assert.equal(fs.realpathSync(root), root); assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("optionmap-writer-safety-"));
  return JSON.parse(fs.readFileSync(path.join(root, "isolated-inspection.json"), "utf8"));
}
function syntheticReceipt() {
  return { valid: true, status: "HOLD", reason: "already_succeeded_today", sourceId: "jp-esri-machinery-orders-calendar",
    startupInvocations: 1, retryCount: 0, migrationCalls: 0, transitionCalls: 0,
    authorizationCount: 0, fenceCount: 0, completionCount: 0, formalWrite: 0,
    isolatedLargeEvidence: "日本語🫡".repeat(100000), isolatedControllerCalls: 1 };
}
async function runWorker(root) {
  if (process.type !== "browser" || !process.versions.electron) throw Error("isolated_native_required");
  const marker = isolated(root), { app, BrowserWindow, session } = require("electron");
  app.setPath("appData", root); app.setPath("userData", root); app.setPath("sessionData", root); app.disableHardwareAcceleration();
  const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  let window, network = 0;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, done) => {
      network++; done({ cancel: true });
    });
    if (marker.mode === "transport") {
      let calls = 0;
      const adapter = Entry.createEntryAdapter({ runController: async () => { calls++; return syntheticReceipt(); },
        handoff: message => Entry.writeReceipt(root, message), quit: () => {} });
      const first = adapter.run(); assert.equal(adapter.run(), first); await first; await adapter.run();
      assert.equal(calls, 1); assert.equal(Entry.readReceipt(root, 0).delivery.status, "HOLD");
    } else if (marker.mode === "copied-formal-readonly") {
      window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
      await window.loadFile(path.resolve(__dirname, "marketCalendarD2d4ReadOnlyProbe.html"));
      const value = await require("../js/marketCalendarRuntime/formalShadowElectronRead.js").createReader(window.webContents)();
      assert.equal(value.status, "ok", value.reason);
      assert.equal(value.audit.readwrite, 0); assert.equal(value.audit.writes, 0); assert.equal(value.audit.create, 0); assert.equal(value.audit.upgrade, 0);
      assert.equal(value.audit.handles, 0); assert.equal(network, 0);
      value.environment = "copied-formal-readonly";
      const bytes = Buffer.from(JSON.stringify(value) + "\n"), file = path.join(root, "formal-copy-read.json");
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const completion = { byteLength: bytes.length, sha256: sha(bytes), network: 0 };
      const tmp = path.join(root, "formal-copy-read.complete.tmp"), target = path.join(root, "formal-copy-read.complete.json");
      const mfd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(mfd, JSON.stringify(completion) + "\n"); fs.fsyncSync(mfd); } finally { fs.closeSync(mfd); }
      fs.renameSync(tmp, target); const dfd = fs.openSync(root, "r"); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } else throw Error("isolated_mode_invalid");
    assert.equal(network, 0);
  } finally {
    session.defaultSession.webRequest.onBeforeRequest(null);
    if (window && !window.isDestroyed()) await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    app.off("window-all-closed", keepAlive);
  }
  app.quit();
}
function preparePackage(root, mode) {
  fs.writeFileSync(path.join(root, "isolated-inspection.json"), JSON.stringify({ mode }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap-isolated-receipt", version: "1.0.0", main: "entry.cjs" }));
  fs.writeFileSync(path.join(root, "entry.cjs"), `import(${JSON.stringify(pathToFileURL(__filename).href)}).then(m=>m.default.runWorker(__dirname)).catch(()=>require('electron').app.exit(1));\n`);
}
function runTransportNative() {
  if (process.versions.electron) throw Error("node_parent_required");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-receipt-native-"));
  try {
    preparePackage(root, "transport"); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    // Deliberately discard stdout: only the local completion artifact is authority.
    const child = cp.spawnSync(require("electron"), [root], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 30000 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    const received = Entry.readReceipt(root, child.status), expected = Buffer.from(JSON.stringify({ type: Entry.TYPE,
      entryReached: true, controllerReached: true, controllerInvocations: 1, receiptReceived: true, receipt: syntheticReceipt() }) + "\n");
    assert(expected.length > 40960); assert.equal(received.byteLength, expected.length); assert.equal(received.sha256, sha(expected));
    assert.deepEqual(received.message.receipt, syntheticReceipt()); assert.equal(received.delivery.status, "HOLD");
    return { valid: true, byteLength: received.byteLength, sha256: received.sha256, fullJsonParse: true,
      receiptCount: 1, controllerCalls: 1, stdoutAuthority: false, network: 0, productionStartup: 0, writer: 0, productionAccess: 0 };
  } finally { fs.rmSync(root, { recursive: true }); }
}
if (require.main === module) console.log(JSON.stringify(runTransportNative()));
module.exports = Object.freeze({ runWorker, preparePackage, runTransportNative });
