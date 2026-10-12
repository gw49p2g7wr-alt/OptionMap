"use strict";

// Explicit Acceptance entry, not main/startup wiring. Default: disposable profile.
// Production parity mode performs only fixed-path safety/IndexedDB reads.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, ".."), sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function worker(root, mode) {
  if (path.dirname(root) !== fs.realpathSync(require("node:os").tmpdir()) ||
      !path.basename(root).startsWith("optionmap-g14bg-fixture-g16a-") || !["isolated", "parity"].includes(mode) ||
      fs.readFileSync(path.join(root, "guard.json"), "utf8") !== JSON.stringify({ gate: "G1.6a", mode })) throw Error("self_contained_guard_invalid");
  const { app, BrowserWindow, session } = require("electron");
  const W = require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js");
  const Base = require("./marketCalendarG14bFilesystemGuard.js");
  const Profile = require("../js/marketCalendarHistory/writerSafetyInitialProvisioning.js");
  if (mode === "parity") app.setPath("userData", Base.createProductionPolicy().profile);
  const profile = mode === "parity" ? Profile.resolveProductionProfile() : Base.createIsolatedPolicy({
    targetEnvironment: "isolated_test", fixtureRoot: root }).profile;
  if (mode === "isolated") fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  app.setPath("crashDumps", path.join(root, "crashes"));
  if (mode === "isolated") app.setPath("appData", path.join(root, "appData"));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
  const denied = { productionContentAttempts: 0, networkAttempts: 0 };
  // Guard JS filesystem operations in isolated mode; native Chromium is pinned
  // to the dedicated profile above. No home discovery or production resolver.
  if (mode === "isolated") {
    const check = p => { if (typeof p !== "string" && !Buffer.isBuffer(p)) return;
      const value = path.resolve(String(p)); if (value === "/Users/natsu/Library" || value.startsWith("/Users/natsu/Library/")) {
        denied.productionContentAttempts++; throw Error("production_path_forbidden"); } };
    for (const name of ["readFileSync", "writeFileSync", "openSync", "statSync", "lstatSync", "realpathSync", "existsSync", "readdirSync", "mkdirSync", "unlinkSync", "renameSync"]) {
      const original = fs[name]; fs[name] = (p, ...args) => { check(p); if (name === "renameSync") check(args[0]); return original(p, ...args); };
    }
  }
  global.fetch = () => { denied.networkAttempts++; throw Error("network_forbidden"); };
  for (const m of ["node:http", "node:https"]) for (const k of ["get", "request"]) require(m)[k] = () => { denied.networkAttempts++; throw Error("network_forbidden"); };
  const hold = () => {}; app.on("window-all-closed", hold);
  let window, report;
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_, done) => {
      denied.networkAttempts++; done({ cancel: true });
    });
    window = mode === "parity" ? await W.createProductionWindow() : await W.createIsolatedWindow({ targetEnvironment: "isolated_test", fixtureRoot: root });
    const Reader = require("../js/marketCalendarRuntime/formalShadowElectronRead.js");
    const readFormal = Reader.createReader(window.wc);
    const files = ["js/marketCalendar/sourceRegistry.js", "js/marketCalendarRuntime/sourceUpdateState.js", "js/storage/marketCalendarRuntimeStateStore.js"];
    for (const file of files) await window.run(fs.readFileSync(path.join(ROOT, file), "utf8"));
    await window.run("globalThis.__normalState = OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({indexedDB,targetEnvironment:'isolated_test'}); void 0;");
    const call = (name, args = []) => window.run(`__normalState.${name}(...${JSON.stringify(args)})`);
    const store = { readAll: () => call("readAll"), write: (id, state) => call("write", [id, state]) };
    if (mode === "isolated") {
      const writerTraps = { authorization: 0, grant: 0, executionToken: 0 };
      for (const [file, method, key] of [["../js/marketCalendarHistory/mofControlledAuthorization.js", "createControlledAuthorization", "authorization"],
        ["../js/marketCalendarRuntime/mofControlledGrantController.js", "createProductionController", "grant"],
        ["../js/marketCalendarHistory/formalControlledWriterCore.js", "prepareExecution", "executionToken"]]) {
        const filename = require.resolve(file), original = require(filename);
        if (typeof original[method] !== "function") throw Error("writer_trap_contract_invalid");
        require.cache[filename].exports = Object.freeze({ ...original, [method]: () => {
          writerTraps[key]++; throw Error("normal_writer_forbidden"); } });
      }
      const F = require("../test/fixtures/marketCalendar/mofNormalFixture.js"), Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
      const Order = require("../js/marketCalendarHistory/bootstrapSchemaV1.js").STORE_ORDER;
      const f = await F.setup({ store, readFormal });
      await window.run(`(async()=>{const schema=${JSON.stringify(Schema.definition())}, snapshot=${JSON.stringify(f.snapshot)}, order=${JSON.stringify(Order)};
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(schema.databaseName,schema.version);
        r.onupgradeneeded=()=>{for(const [name,s] of Object.entries(schema.stores)){const st=r.result.createObjectStore(name,{keyPath:s.keyPath});for(const [name,keyPath,unique] of s.indexes)st.createIndex(name,keyPath,{unique});}};
        r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('seed_failed'));});
        await new Promise((resolve,reject)=>{const tx=db.transaction(order.map(x=>x[1]),'readwrite');for(const [field,name] of order)for(const row of snapshot[field])tx.objectStore(name).put(row);
        tx.oncomplete=resolve;tx.onabort=()=>reject(Error('seed_failed'));});db.close();
        globalThis.__nativeAudit={formalReadwrite:0,runtimeCreates:0,runtimeUpdates:0,writerInvocations:0};
        const tx=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...args){if(this.name===schema.databaseName && mode==='readwrite'){__nativeAudit.formalReadwrite++;throw Error('formal_write_forbidden');}return tx.call(this,stores,mode,...args);};
        const put=IDBObjectStore.prototype.put,keys=new Set();IDBObjectStore.prototype.put=function(value,...args){if(this.name==='sourceUpdateStates' && value.sourceId===${JSON.stringify(F.MOF)}){if(keys.has(value.sourceId))__nativeAudit.runtimeUpdates++;else{__nativeAudit.runtimeCreates++;keys.add(value.sourceId);}}return put.call(this,value,...args);};return true;})()`);
      const before = await readFormal(); assert.equal(before.status, "ok");
      const first = await f.runtime.check({ trigger: "startup" }); assert.equal(first.state, "success");
      const initialState = await call("read", [F.MOF]); assert.equal(initialState.value.lastOutcome, "success");
      const initialDiag = f.runtime.diagnostics();
      const unchanged = initialDiag.comparison.comparison.summaries.find(s => s.sourceId === F.MOF);
      assert.equal(unchanged.unchanged, 16); assert.equal(unchanged.new, 0); assert.equal(unchanged.changed, 0); assert.equal(unchanged.evidenceOnly, 0);
      const writes = (await call("diagnostics")).successfulWrites, requests = f.requests.length;
      const skip = await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
      assert.equal(skip.sources[0].reasonClass, "already_succeeded_today"); assert.equal(f.requests.length, requests);
      assert.equal((await call("diagnostics")).successfulWrites, writes);
      f.setClock("2026-10-14T00:00:00.000Z"); await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
      const updated = await call("read", [F.MOF]); assert.equal(updated.value.lastSuccessAt, "2026-10-14T00:00:00.000Z");
      f.setClock("2026-10-15T00:00:00.000Z");
      f.documents["https://www.mof.go.jp/jgbs/auction/calendar/2611.htm"] = () => new Response(null, { status: 500 });
      const limited = await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
      assert.equal(limited.sources[0].reasonClass, "session_attempt_limit_reached");
      const partial = await f.runtime.check({ trigger: "manual", sourceIds: [F.MOF] }); assert.equal(partial.sources[0].status, "failed");
      const failure = await call("read", [F.MOF]); assert.equal(failure.value.lastSuccessAt, updated.value.lastSuccessAt);
      const after = await readFormal(); assert.deepEqual(after.snapshot, before.snapshot);
      const audit = await window.run("__nativeAudit"); assert.equal(audit.runtimeCreates, 1); assert.equal(audit.runtimeUpdates, 2); assert.equal(audit.formalReadwrite, 0);
      report = { gate: "G1.6a", mode, status: "PASS", sources: first.sources.length, concurrency: first.peakSourceConcurrency,
        fixtureRequests: requests, candidates: unchanged.candidate, comparison: unchanged, runtime: { initialState, updated, failure, sameDay: "already_succeeded_today", audit },
        formalUnchanged: true, formalAudits: [before.audit, after.audit], storeAudit: await call("diagnostics"),
        writerExecution: f.runtime.diagnostics().writerExecution, writerTraps,
        safetyWrites: f.runtime.diagnostics().safetyWrites };
      assert.deepEqual(writerTraps, { authorization: 0, grant: 0, executionToken: 0 });
    } else {
      // Parity never constructs normal acquisition/authorization/grant factories.
      await window.run(`(()=>{globalThis.__readonlyAudit={writeAttempts:0};
        for(const name of ['put','add','delete','clear'])IDBObjectStore.prototype[name]=function(){__readonlyAudit.writeAttempts++;throw Error('parity_write_forbidden');};
        const tx=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...args){if(mode && mode!=='readonly'){__readonlyAudit.writeAttempts++;throw Error('parity_tx_forbidden');}return tx.call(this,stores,mode,...args);};return true;})()`);
      const Guard = require("./marketCalendarG15b1FilesystemGuard.js"), Safety = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
      const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
      const policy = Guard.policyFor(profile), reader = Safety.createReader(profile);
      const safetyBefore = Guard.scoped(policy, () => reader.load());
      assert.equal(safetyBefore.value.status, "valid", safetyBefore.value.reason);
      const statePaths = [path.join(profile, "market-calendar-source-set-safety", "selection.json"),
        path.join(profile, "market-calendar-source-set-safety", safetyBefore.value.generation, "market-calendar-writer-safety", "safety.json"),
        path.join(profile, "market-calendar-source-set-safety", safetyBefore.value.generation, "market-calendar-writer-safety", "sequence.json")];
      const hashes = () => Guard.scoped(policy, () => Object.fromEntries(statePaths.map(p => [p, sha(fs.readFileSync(p))])));
      const hashesBefore = hashes();
      const formalBefore = await readFormal(); assert.equal(formalBefore.status, "ok", formalBefore.reason);
      const state = await call("read", ["jp-mof-jgb-auction-calendar"]); assert.equal(state.value, null);
      const formalAfter = await readFormal(); assert.deepEqual(formalAfter.snapshot, formalBefore.snapshot);
      const safetyAfter = Guard.scoped(policy, () => reader.load()), hashesAfter = hashes();
      assert.deepEqual(hashesBefore.value, hashesAfter.value); assert.equal(safetyBefore.value.safety.sequence, 13);
      assert.equal(safetyAfter.value.safety.sequence, 13);
      const permissions = safetyAfter.value.permissions.entries;
      assert.equal(permissions.find(p => p.sourceId === "jp-mof-jgb-auction-calendar").permission, "not_approved");
      const counts = Object.fromEntries(Object.entries(formalAfter.snapshot).map(([k, v]) => [k, v.length]));
      assert.deepEqual(counts, { entries: 268, revisions: 268, evidence: 709, observations: 709, runs: 38, cursors: 13 });
      const integrity = await require("../js/marketCalendarRuntime/automaticFormalShadow.js").integrity(formalAfter.snapshot); assert(integrity);
      const runtimeAudit = await call("diagnostics"), readonlyAudit = await window.run("__readonlyAudit");
      assert.equal(runtimeAudit.successfulWrites, 0); assert.equal(runtimeAudit.readwriteTransactions, 0); assert.equal(readonlyAudit.writeAttempts, 0);
      report = { gate: "G1.6a", mode, status: "PASS", counts, integrity, formalIdentity: A.hash(formalBefore.snapshot),
        formalUnchanged: true, formalAudits: [formalBefore.audit, formalAfter.audit], runtimeMof: state, runtimeAudit, readonlyAudit,
        safety: { envelope: safetyAfter.value.envelopeVersion, sourceSet: safetyAfter.value.sourceSetVersion,
          permission: safetyAfter.value.permissionVersion, sequence: safetyAfter.value.safety.sequence,
          generation: safetyAfter.value.generation, pending: safetyAfter.value.safety.pendingFence, permissions },
        hashesBefore: hashesBefore.value, hashesAfter: hashesAfter.value,
        safetyTouches: [...safetyBefore.touches, ...safetyAfter.touches, ...hashesBefore.touches, ...hashesAfter.touches],
        productionWrites: 0, acquisition: 0, writerExecution: 0, safetyWrites: 0 };
    }
  } finally {
    if (window) { const audit = window.audit(); denied.networkAttempts += audit.networkAttempts; await window.close(); }
    session.defaultSession.webRequest.onBeforeRequest(null); await session.defaultSession.closeAllConnections();
    app.removeListener("window-all-closed", hold);
  }
  assert.equal(denied.networkAttempts, 0); assert.equal(denied.productionContentAttempts, 0);
  report.guard = denied; report.cleanup = { windows: BrowserWindow.getAllWindows().length, ipcHandlers: 0, safetyLocks: 0, dbHandles: 0 };
  const bytes = Buffer.from(JSON.stringify(report));
  fs.writeFileSync(path.join(root, "receipt.tmp"), bytes, { flag: "wx" }); fs.renameSync(path.join(root, "receipt.tmp"), path.join(root, "receipt.json"));
  fs.writeFileSync(path.join(root, "receipt.complete"), JSON.stringify({ bytes: bytes.length, sha256: sha(bytes) }), { flag: "wx" });
  app.exit(0);
}
function run(mode = "isolated") {
  if (!["isolated", "parity"].includes(mode)) throw Error("acceptance_mode_invalid");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(require("node:os").tmpdir()), "optionmap-g14bg-fixture-g16a-"));
  try {
    fs.writeFileSync(path.join(root, "guard.json"), JSON.stringify({ gate: "G1.6a", mode }), { flag: "wx" });
    const entry = path.join(root, "entry.cjs"), script = require.resolve("./marketCalendarG16aNormalNative.js");
    fs.writeFileSync(entry, `require(${JSON.stringify(script)}).worker(${JSON.stringify(root)},${JSON.stringify(mode)}).catch(e=>{console.error(e.stack);require('electron').app.exit(1);});`);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "optionmap", version: "1.1.0-beta.6", main: "entry.cjs" }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_TEST_CONTEXT;
    const out = fs.openSync(path.join(root, "stdout.log"), "w"), err = fs.openSync(path.join(root, "stderr.log"), "w");
    let child; try { child = cp.spawnSync(require("electron"), [root], { env, cwd: ROOT, stdio: ["ignore", out, err], timeout: 60000 }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    assert.equal(child.status, 0, fs.readFileSync(path.join(root, "stderr.log"), "utf8"));
    const bytes = fs.readFileSync(path.join(root, "receipt.json")), marker = JSON.parse(fs.readFileSync(path.join(root, "receipt.complete")));
    assert.equal(bytes.length, marker.bytes); assert.equal(sha(bytes), marker.sha256);
    return { ...JSON.parse(bytes), transport: marker, tempDeleted: true };
  } finally { fs.rmSync(root, { recursive: true }); }
}
if (require.main === module && process.type !== "browser") {
  try { console.log(JSON.stringify(run(process.argv[2] || "isolated"))); } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
module.exports = { worker, run };
