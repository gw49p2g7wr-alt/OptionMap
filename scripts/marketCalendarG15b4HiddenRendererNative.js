"use strict";

// Acceptance-only package entry. Every profile is a freshly seeded temp mirror;
// no production factory or production acquisition is invoked by this harness.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
const ROOT = path.resolve(__dirname, ".."), sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function installSentinel(root) {
  const audit = { forbiddenAttempts: 0, networkAttempts: 0 };
  const check = p => { if (typeof p !== "string" && !Buffer.isBuffer(p)) return;
    p = path.resolve(String(p)); if (p === "/Users/natsu/Library" || p.startsWith("/Users/natsu/Library/")) {
      audit.forbiddenAttempts++; throw Error("fixture_production_access_forbidden");
    } };
  for (const k of ["readFileSync", "writeFileSync", "lstatSync", "statSync", "realpathSync", "existsSync", "readdirSync", "openSync",
    "mkdirSync", "renameSync", "unlinkSync", "rmSync", "readFile", "writeFile", "stat", "lstat", "readdir", "open", "mkdir", "rename"]) {
    const raw = fs[k]; fs[k] = function(p, ...rest) { check(p); if (k.startsWith("rename")) check(rest[0]); return raw.call(this, p, ...rest); };
  }
  for (const k of Object.keys(fs.promises)) if (typeof fs.promises[k] === "function") {
    const raw = fs.promises[k]; fs.promises[k] = function(p, ...rest) { check(p); if (k === "rename") check(rest[0]); return raw.call(this, p, ...rest); };
  }
  for (const mod of ["node:http", "node:https"]) for (const k of ["get", "request"]) require(mod)[k] = () => {
    audit.networkAttempts++; throw Error("fixture_network_forbidden");
  };
  global.fetch = () => { audit.networkAttempts++; throw Error("fixture_network_forbidden"); };
  return audit;
}
async function worker() {
  const { app, BrowserWindow, session } = require("electron"), packageRoot = app.getAppPath();
  const config = JSON.parse(fs.readFileSync(path.join(packageRoot, "fixture.json"), "utf8"));
  if (!Filesystem.samePath(packageRoot, path.join(config.fixtureRoot, "package")) ||
      !Filesystem.samePath(path.dirname(config.fixtureRoot), fs.realpathSync(require("node:os").tmpdir())) ||
      !path.basename(config.fixtureRoot).startsWith("optionmap-g14bg-fixture-")) throw Error("fixture_package_path_required");
  const Guard = require("./marketCalendarG14bFilesystemGuard.js"), policy = Guard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot: config.fixtureRoot });
  assert(Filesystem.samePath(packageRoot, path.join(config.fixtureRoot, "package")));
  app.setPath("appData", policy.parents[1]); app.setPath("userData", policy.profile); app.setPath("sessionData", policy.profile);
  app.setPath("crashDumps", path.join(config.fixtureRoot, "crashes")); app.commandLine.appendSwitch("disable-background-networking");
  const guard = installSentinel(config.fixtureRoot); app.on("window-all-closed", () => {});
  const corePath = require.resolve("../js/marketCalendarHistory/formalControlledWriterCore.js"), originalCore = require(corePath);
  let mainTokenAttempts = 0;
  require.cache[corePath].exports = Object.freeze({ ...originalCore, prepareExecution() { mainTokenAttempts++; throw Error("fixture_main_execution_token_forbidden"); } });
  const W = require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js"), C = require("../js/marketCalendarRuntime/mofControlledGrantController.js");
  const S = require("../js/marketCalendarHistory/mofControlledSemanticPlan.js"), A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
  const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js"), Safety = require("../js/marketCalendarHistory/mofControlledSafetyProductionAdapter.js");
  const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"), Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
  const F = require("../test/fixtures/marketCalendar/mofControlledFixture.js"), AF = require("../test/fixtures/marketCalendar/automaticShadowFixture.js");
  await app.whenReady(); let result;
  if (config.mode === "read") {
    const adapter = Safety.createIsolatedAdapter({ targetEnvironment: "isolated_test", fixtureRoot: config.fixtureRoot, crashAt: null });
    const win = await W.createIsolatedWindow({ targetEnvironment: "isolated_test", fixtureRoot: config.fixtureRoot });
    try { const formal = await Reader.createReader(win.wc)();
      result = { loaded: adapter.load(), preflight: adapter.preflight(), formal, guard }; }
    finally { await win.close(); adapter.close(); }
  } else {
    const { snapshot } = await AF.fixture(), source = await F.source("hidden-native");
    const preparation = await S.prepareNativeMaterial({ source, snapshot, attemptIdentity: A.hash("hidden-native") });
    const seedWindow = await W.createIsolatedWindow({ targetEnvironment: "isolated_test", fixtureRoot: config.fixtureRoot });
    const seedCode = `(async()=>{const schema=${JSON.stringify(Schema.definition())}, snapshot=${JSON.stringify(snapshot)}, order=${JSON.stringify(Core.STORE_ORDER)};
      if(typeof indexedDB!=='object'||typeof IDBDatabase!=='function'||typeof require!=='undefined')throw Error('native_fixture_context_invalid');
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(schema.databaseName,schema.version);r.onupgradeneeded=()=>{
        for(const [name,d]of Object.entries(schema.stores)){const s=r.result.createObjectStore(name,{keyPath:d.keyPath});for(const [n,k,u]of d.indexes)s.createIndex(n,k,{unique:u})}
      };r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      await new Promise((resolve,reject)=>{const tx=db.transaction(order.map(r=>r[1]),'readwrite');for(const [f,n]of order)for(const row of snapshot[f])tx.objectStore(n).add(row);
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});
      const parity={url:location.href,origin:location.origin,database:db.name,version:db.version,realChromium:true};db.close();return parity;})()`;
    let parity, tokenChecks, security;
    try {
      parity = await seedWindow.run(seedCode);
      const prefs = seedWindow.wc.getLastWebPreferences(), ui = await seedWindow.wc.executeJavaScript("({bridge:typeof __mofPrivateGrant,node:typeof require})");
      security = { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox,
        mainWorldBridge: ui.bridge, mainWorldNode: ui.node };
      assert.deepEqual(security, { nodeIntegration: false, contextIsolation: true, sandbox: true, mainWorldBridge: "undefined", mainWorldNode: "undefined" });
      const nativeSource = fs.readFileSync(corePath, "utf8"), material = S.inspectNativeMaterial(preparation);
      const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
      tokenChecks = await seedWindow.run(`(async()=>{const Schema=${JSON.stringify(Schema.definition())}, stable=(${Canonical.stable.toString()}), deps={
        './productionSchemaV1.js':{DATABASE_NAME:Schema.databaseName,STORES:Schema.stores}, './bootstrapSchemaV1.js':{STORE_ORDER:${JSON.stringify(Core.STORE_ORDER)}},
        '../marketCalendar/marketEventCanonicalizer.js':{stable}};const load=()=>{const module={exports:{}};((module,require)=>{${nativeSource}\n})(module,k=>deps[k]);return module.exports};
        const a=load(),b=load(),data=${JSON.stringify(material)},t=a.prepareExecution(data.plan,data.before);let tx=0;
        const db={transaction(){tx++;throw Error('negative_token_reached_db')}};
        const results=[];for(const [core,token]of [[a,{}],[a,JSON.parse(JSON.stringify(t))],[b,t]])results.push(await core.executePrepared(db,token,null,{}));
        if(tx||results.some(r=>r.committed||r.reason!=='execution_context_invalid'))throw Error('token_copy_accepted');return{recreatedRejected:true,copiedRejected:true,otherModuleRejected:true,transactions:tx};})()`);
    } finally { await seedWindow.close(); }
    const controller = C.createIsolatedController({ targetEnvironment: "isolated_test", fixtureRoot: config.fixtureRoot, preparation, fault: config.fault });
    result = await controller.start(); result.audit = controller.audit(); result.parity = { ...parity, profile: app.getPath("userData"),
      defaultSessionStorage: session.defaultSession.getStoragePath(), schemaFingerprint: Schema.EXPECTED_FINGERPRINT, stores: Schema.STORES };
    result.guard = guard; result.tokenChecks = tokenChecks; result.mainTokenAttempts = mainTokenAttempts; result.security = security;
    assert.equal(mainTokenAttempts, 0); await assert.rejects(controller.start(), /native_attempt_replayed/);
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const bytes = Buffer.from(JSON.stringify(result)), output = path.join(packageRoot, "result.json");
  fs.writeFileSync(output + ".temp", bytes, { mode: 0o600 }); fs.renameSync(output + ".temp", output);
  fs.writeFileSync(output + ".complete", JSON.stringify({ length: bytes.length, sha256: sha(bytes) }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ mode: config.mode, status: result.status || "read", bytes: bytes.length }) + "\n");
  await Lifecycle.shutdown(app, session, 0);
}
function launch(fixtureRoot, profile, mode = "execute", fault = null) {
  const packageRoot = path.join(fixtureRoot, "package"); fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "optionmap", version: "1.1.0-beta.6", main: __filename }));
  fs.writeFileSync(path.join(packageRoot, "fixture.json"), JSON.stringify({ fixtureRoot, mode, fault }));
  for (const suffix of ["", ".complete"]) { const file = path.join(packageRoot, "result.json" + suffix); if (fs.existsSync(file)) fs.unlinkSync(file); }
  const env = { ...process.env }; for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"]) delete env[name];
  const outPath = path.join(packageRoot, "stdout.log"), errPath = path.join(packageRoot, "stderr.log");
  const out = fs.openSync(outPath, "w", 0o600), err = fs.openSync(errPath, "w", 0o600);
  let child;
  try { child = Lifecycle.withNativeElectronLaunchLock(() =>
    cp.spawnSync(require("electron"), [packageRoot, "--user-data-dir=" + profile], { env, detached: true,
      stdio: ["ignore", out, err], timeout: 45000, killSignal: "SIGKILL" })); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const crashFaults = ["before_window", "before_load", "after_load", "consume_before_started", "started_before_permit", "commit_before_readback", "readback_before_completion"];
  const intentionalCrash = Lifecycle.isIntentionalForcedTermination({ child, mode, fault, forcedFaults: crashFaults });
  if ((child.error || child.signal) && !intentionalCrash) {
    // Only the process group freshly created above, never an existing app.
    if (process.platform !== "win32" && child.error && Number.isInteger(child.pid) && child.pid > 0)
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (!["ESRCH", "EPERM"].includes(e.code)) throw e; }
    throw Error("native_child_failed: " + (child.error?.message || child.signal));
  }
  let output = null;
  if (child.status === 0) {
    const bytes = fs.readFileSync(path.join(packageRoot, "result.json")), marker = JSON.parse(fs.readFileSync(path.join(packageRoot, "result.json.complete")));
    assert.equal(bytes.length, marker.length); assert.equal(sha(bytes), marker.sha256); output = JSON.parse(bytes);
  }
  return { code: intentionalCrash ? 86 : child.status, crashSignal: child.signal, output, stderr: fs.readFileSync(errPath, "utf8") };
}
async function nativeCase(fault = null) {
  const { withSeed } = require("./marketCalendarG15b1ControlledAdapterNative.js");
  return withSeed((fixtureRoot, profile) => {
    const executed = launch(fixtureRoot, profile, "execute", fault);
    if (executed.code !== 0 && executed.code !== 86) throw Error(executed.stderr);
    const fresh = launch(fixtureRoot, profile, "read"); assert.equal(fresh.code, 0, fresh.stderr);
    assert.equal(fresh.output.loaded.status, "valid", fresh.output.loaded.reason);
    if (!fault && executed.output?.status !== "PASS") throw Error(JSON.stringify({ reason: executed.output?.reason, phases: executed.output?.phases, stderr: executed.stderr }));
    assert.equal(fresh.output.preflight.eligible, false); assert.equal(fresh.output.guard.forbiddenAttempts, 0);
    assert.equal(fresh.output.formal.audit.readwrite, 0); assert.equal(fresh.output.formal.audit.writes, 0);
    Lifecycle.assertFixtureExited({ child: { status: fresh.code, signal: fresh.crashSignal, error: null }, profile, childProcess: cp });
    return { fault, executed, reload: fresh.output, cleanup: { profileDeleted: true, windows: 0, children: 0 } };
  });
}
if (process.type === "browser") worker().catch(async e => {
  console.error(e.stack);
  const electron = require("electron");
  await Lifecycle.shutdown(electron.app, electron.session, 1);
});
else if (require.main === module) nativeCase(process.argv[2] || null).then(r => process.stdout.write(JSON.stringify({ fault: r.fault,
  code: r.executed.code, status: r.executed.output?.status, reason: r.executed.output?.reason,
  phases: r.executed.output?.phases?.map(p => ({ sequence: p.sequence, phase: p.phase })),
  localToken: r.executed.output?.receipt?.localToken, counts: r.executed.output?.receipt?.counts,
  transactions: r.executed.output?.receipt?.transactions, tokenChecks: r.executed.output?.tokenChecks,
  freshRenderer: r.executed.output?.freshRenderer, finalSequence: r.reload.loaded.safety.sequence,
  pending: r.reload.loaded.safety.pendingFence?.phase || null, retry: r.reload.preflight.eligible, cleanup: r.cleanup }) + "\n"), e => { console.error(e.stack); process.exitCode = 1; });
module.exports = Object.freeze({ launch, nativeCase });
