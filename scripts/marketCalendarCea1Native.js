"use strict";

// Disposable Chromium IndexedDB acceptance for the database-absent Calendar
// bootstrap. This fixture never resolves or opens the production profile.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const cp = require("node:child_process"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
const ROOT = path.resolve(__dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

async function worker(root) {
  const { app, BrowserWindow, session } = require("electron");
  const Guard = require("./marketCalendarG14bFilesystemGuard.js");
  const Window = require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js");
  const Runtime = require("../js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js");
  const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js");
  const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
  const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
  const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
  const policy = Guard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot: root });
  const packageRoot = app.getAppPath(), configuration = JSON.parse(fs.readFileSync(
    path.join(packageRoot, "fixture.json"), "utf8"));
  assert.equal(configuration.root, root);
  fs.mkdirSync(policy.profile, { recursive: true });
  app.setPath("appData", policy.parents[1]); app.setPath("userData", policy.profile);
  app.setPath("sessionData", policy.profile); app.setPath("crashDumps", path.join(root, "crashes"));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  let window = null, networkAttempts = 0;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*",
      "ws://*/*", "wss://*/*"] }, (_details, done) => { networkAttempts++; done({ cancel: true }); });
    window = await Window.createIsolatedWindow({ targetEnvironment: "isolated_test", fixtureRoot: root });
    const receipt = await window.run(`(${Runtime.executeBootstrapInRenderer.toString()})(${
      JSON.stringify(configuration.material)},${JSON.stringify(Schema.definition())},${JSON.stringify(
        Bootstrap.STORE_ORDER)})`);
    const readback = await Reader.createReader(window.wc)();
    assert.equal(receipt.status, "committed"); assert.equal(receipt.created, 1);
    assert.equal(receipt.transactions, 1); assert.equal(readback.status, "ok", readback.reason);
    assert.deepEqual(Object.fromEntries(Object.entries(readback.snapshot).map(([field, records]) =>
      [field, records.length])), configuration.material.counts);
    assert.equal((await Integrity.audit(readback.snapshot)).valid, true);
    assert.equal(Integrity.auditStorageSnapshot(readback.snapshot).valid, true);
    const day = readback.snapshot.revisions.map(value => value.calendarDateStart).sort()[0];
    const nativeQuery = await window.run(`(async()=>{const name=${JSON.stringify(Schema.DATABASE_NAME)},day=${JSON.stringify(day)};
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const tx=db.transaction(['marketCalendarEventEntries','marketCalendarSemanticRevisions'],'readonly');
      const get=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const [entries,revisions]=await Promise.all([get(tx.objectStore('marketCalendarEventEntries').getAll()),
        get(tx.objectStore('marketCalendarSemanticRevisions').getAll())]);
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
      const active=new Set(entries.map(value=>value.activeRevisionKey));return {day,events:revisions.filter(value=>
        active.has(value.revisionKey)&&value.validTo===null&&value.calendarDateStart<=day&&value.calendarDateEnd>=day).length};})()`);
    assert(nativeQuery.events > 0);
    const result = { status: "PASS", realChromium: true, profile: policy.profile,
      snapshotIdentity: receipt.snapshotIdentity, counts: receipt.counts, day: nativeQuery.day,
      dayEvents: nativeQuery.events, networkAttempts, cleanup: { windows: 0, handles: 0 } };
    const bytes = Buffer.from(JSON.stringify(result));
    fs.writeFileSync(path.join(packageRoot, "result.json"), bytes, { flag: "wx" });
    fs.writeFileSync(path.join(packageRoot, "result.complete"), JSON.stringify({ bytes: bytes.length,
      sha256: sha(bytes) }), { flag: "wx" });
  } finally {
    if (window) await window.close();
    session.defaultSession.webRequest.onBeforeRequest(null);
    await session.defaultSession.closeAllConnections();
    assert.equal(BrowserWindow.getAllWindows().length, 0); assert.equal(networkAttempts, 0);
  }
  await Lifecycle.shutdown(app, session, 0);
}

function launch(root, material) {
  const packageRoot = path.join(root, "package"); fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "fixture.json"), JSON.stringify({ root, material }), { flag: "wx" });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "optionmap",
    version: "1.1.0-beta.10", main: "entry.cjs" }), { flag: "wx" });
  fs.writeFileSync(path.join(packageRoot, "entry.cjs"), `require(${JSON.stringify(__filename)}).worker(${
    JSON.stringify(root)}).catch(error=>{console.error(error.stack);require('electron').app.exit(1);});`, { flag: "wx" });
  const env = { ...process.env }; for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_TEST_CONTEXT",
    "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) delete env[key];
  const stdout = fs.openSync(path.join(root, "stdout.log"), "w"), stderr = fs.openSync(path.join(root, "stderr.log"), "w");
  let child;
  try { child = Lifecycle.withNativeElectronLaunchLock(() => cp.spawnSync(require("electron"), [packageRoot],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", stdout, stderr], timeout: 60000,
      killSignal: "SIGKILL" })); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  assert.equal(child.status, 0, fs.readFileSync(path.join(root, "stderr.log"), "utf8"));
  Lifecycle.assertFixtureExited({ child, profile: path.join(root, "Users", "natsu", "Library",
    "Application Support", "OptionMap"), childProcess: cp });
  const bytes = fs.readFileSync(path.join(packageRoot, "result.json"));
  const complete = JSON.parse(fs.readFileSync(path.join(packageRoot, "result.complete"), "utf8"));
  assert.equal(bytes.length, complete.bytes); assert.equal(sha(bytes), complete.sha256);
  return JSON.parse(bytes);
}

async function run(material) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g14bg-fixture-cea1-"));
  try { return launch(root, material); }
  finally { fs.rmSync(root, { recursive: true }); }
}

module.exports = Object.freeze({ worker, run });
