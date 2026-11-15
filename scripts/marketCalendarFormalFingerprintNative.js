"use strict";

// Disposable Chromium IndexedDB fixture for cross-runtime Formal snapshot
// identity. It never resolves or opens the production profile.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"),
  cp = require("node:child_process"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
const ROOT = path.resolve(__dirname, ".."), sha = value =>
  crypto.createHash("sha256").update(value).digest("hex");

async function worker(root) {
  const { app, BrowserWindow, session } = require("electron");
  const Guard = require("./marketCalendarG14bFilesystemGuard.js");
  const Window = require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js");
  const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
  const Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
  const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
  const Atomic = require("../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
  const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
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
    const seed = configuration.snapshot, definition = Schema.definition();
    await window.run(`(async()=>{const schema=${JSON.stringify(definition)},snapshot=${JSON.stringify(seed)},
      order=${JSON.stringify(Bootstrap.STORE_ORDER)};const db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(schema.databaseName,schema.version);r.onupgradeneeded=()=>{for(const [name,d]
      of Object.entries(schema.stores)){const s=r.result.createObjectStore(name,{keyPath:d.keyPath});
      for(const [n,k,u]of d.indexes)s.createIndex(n,k,{unique:u})}};r.onsuccess=()=>resolve(r.result);
      r.onerror=()=>reject(r.error)});await new Promise((resolve,reject)=>{const tx=db.transaction(
      order.map(value=>value[1]),'readwrite');for(const [field,name]of order)for(const value of
      snapshot[field])tx.objectStore(name).add(value);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
      tx.onerror=()=>undefined});db.close();return true})()`);
    const coreSource = fs.readFileSync(require.resolve(
      "../js/marketCalendarHistory/formalControlledWriterCore.js"), "utf8"), schema = {
        DATABASE_NAME: Schema.DATABASE_NAME, VERSION: Schema.VERSION,
        EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT, STORES: Schema.STORES },
      loader = `const Schema=${JSON.stringify(schema)},stable=(${Canonicalizer.stable.toString()}),
        module={exports:{}},dependencies={"./productionSchemaV1.js":Schema,
        "./bootstrapSchemaV1.js":{STORE_ORDER:${JSON.stringify(Core.STORE_ORDER)}},
        "../marketCalendar/marketEventCanonicalizer.js":{stable}};
        ((module,require)=>{${coreSource}\n})(module,key=>{if(!Object.hasOwn(dependencies,key))
        throw Error('formal_fingerprint_dependency_rejected');return dependencies[key]});`;
    const before = await window.run(`(async()=>{${loader}const request=value=>new Promise((resolve,reject)=>{
      value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error)}),db=await request(
      indexedDB.open(Schema.DATABASE_NAME)),tx=db.transaction(${JSON.stringify(Core.STORE_NAMES)},'readonly'),
      snapshot={};for(const [field,name]of ${JSON.stringify(Bootstrap.STORE_ORDER)})snapshot[field]=await
      request(tx.objectStore(name).getAll());await new Promise((resolve,reject)=>{tx.oncomplete=resolve;
      tx.onabort=()=>reject(tx.error)});db.close();const sorted=module.exports.sorted(snapshot),text=stable({
      databaseStatus:'present',schemaVersion:Schema.VERSION,schemaFingerprint:Schema.EXPECTED_FINGERPRINT,
      snapshot:sorted}),bytes=new TextEncoder().encode(text),digest=await crypto.subtle.digest('SHA-256',bytes);
      return{fingerprint:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),
      eventKeys:sorted.entries.map(value=>value.eventKey),realChromium:true}})()`);
    const raw = await window.run(`(async()=>{${loader}return (${
      Atomic.executeAuthorizedMutationInRenderer.toString()})(${JSON.stringify(configuration.plan)},${
      JSON.stringify(configuration.operation)},module.exports,Schema,${JSON.stringify(
      Bootstrap.STORE_ORDER)},stable,indexedDB)})()`);
    const result = { status: "PASS", before, raw, networkAttempts, realChromium: true,
      cleanup: { windows: 0, handles: 0 } }, bytes = Buffer.from(JSON.stringify(result));
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

function launch(root, input) {
  const packageRoot = path.join(root, "package"); fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "fixture.json"), JSON.stringify({ root, ...input }), { flag: "wx" });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "optionmap",
    version: "1.1.0-beta.16", main: "entry.cjs" }), { flag: "wx" });
  fs.writeFileSync(path.join(packageRoot, "entry.cjs"), `require(${JSON.stringify(__filename)}).worker(${
    JSON.stringify(root)}).catch(error=>{console.error(error.stack);require('electron').app.exit(1);});`,
  { flag: "wx" });
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE"]) delete env[key];
  const stdout = fs.openSync(path.join(root, "stdout.log"), "w"), stderr = fs.openSync(
    path.join(root, "stderr.log"), "w");
  let child;
  try {
    child = Lifecycle.withNativeElectronLaunchLock(() => cp.spawnSync(require("electron"), [packageRoot],
      { cwd: ROOT, env, detached: true, stdio: ["ignore", stdout, stderr], timeout: 60000,
        killSignal: "SIGKILL" }));
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  assert.equal(child.status, 0, fs.readFileSync(path.join(root, "stderr.log"), "utf8"));
  Lifecycle.assertFixtureExited({ child, profile: path.join(root, "Users", "natsu", "Library",
    "Application Support", "OptionMap"), childProcess: cp });
  const bytes = fs.readFileSync(path.join(packageRoot, "result.json")), complete = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "result.complete"), "utf8"));
  assert.equal(bytes.length, complete.bytes); assert.equal(sha(bytes), complete.sha256);
  return JSON.parse(bytes);
}

async function run(input) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-g14bg-fixture-formal-fingerprint-"));
  try { return launch(root, input); }
  finally { fs.rmSync(root, { recursive: true }); }
}

module.exports = Object.freeze({ worker, run });
