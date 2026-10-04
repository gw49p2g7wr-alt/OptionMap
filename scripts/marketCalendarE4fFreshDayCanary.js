"use strict";

// Fresh-day acceptance owner, not a writable worker protocol. Historical E4f-1R
// migration/transition controller is never invoked. Production is revision-gated.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const Preflight = require("../js/marketCalendarRuntime/freshDayCanaryPreflight.js");
const Receipt = require("../js/marketCalendarRuntime/freshDayCanaryReceipt.js");
const Canary = require("../js/marketCalendarRuntime/machineryStartupCanary.js");
const Historical = require("./marketCalendarE4fStartupCanary.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const State = require("../js/storage/marketCalendarRuntimeStateStore.js");
const REPO = path.resolve(__dirname, ".."), owners = new WeakMap();
function mainOnly() {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
}
function isolatedRoot(root) {
  if (typeof root !== "string" || root !== fs.realpathSync(root) || fs.lstatSync(root).isSymbolicLink() ||
      path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith("optionmap-writer-safety-"))
    throw Error("isolated_profile_invalid");
}
async function instrument(wc, installed) {
  for (const world of [0, 1741, 1742]) {
    const code = `(${Historical.installAudit.toString()})(${JSON.stringify(Schema.DATABASE_NAME)},
      ${JSON.stringify(State.DATABASE_NAME)}, ${JSON.stringify(Bootstrap.STORE_ORDER.map(s => s[1]))}, ${world === 0})`;
    if (world === 0) await wc.executeJavaScript(code, true);
    else await wc.executeJavaScriptInIsolatedWorld(world, [{ code }]);
    installed.push(world);
  }
}
async function detach(wc, worlds = [0, 1741, 1742]) {
  const audits = [];
  for (const world of worlds) {
    const code = "(() => { const a = __canaryAudit; __canaryDetach(); return structuredClone(a); })()";
    audits.push(world === 0 ? await wc.executeJavaScript(code, true) :
      await wc.executeJavaScriptInIsolatedWorld(world, [{ code }]));
  }
  return audits;
}
function owner({ load, makeCanary, wc, revisionCheck }) {
  const token = Object.freeze(Object.create(null));
  const state = { used: false, load, makeCanary, wc, revisionCheck, invocationCount: 0 };
  owners.set(token, state);
  return Object.freeze({ accept: async (...args) => {
    const own = owners.get(token);
    if (!own) return { status: "FAIL", reason: "acceptance_attempt_consumed", startupInvocations: state.invocationCount };
    if (args.length) return { status: "FAIL", reason: "acceptance_arguments_forbidden", startupInvocations: own.invocationCount };
    if (own.used) return { status: "FAIL", reason: "acceptance_attempt_consumed", startupInvocations: own.invocationCount };
    own.used = true;
    let before, after, runtime, canary, storageAudits = [], preflight;
    const installed = [];
    try {
      const code = own.revisionCheck(); if (!code.valid) throw Error(code.reason);
      before = own.load(); preflight = Preflight.validateState(before);
      if (!preflight.valid) throw Error(preflight.reason);
      await instrument(own.wc, installed);
      canary = own.makeCanary();
      own.invocationCount++; runtime = await canary.startup();
      canary.close(); runtime = { ...runtime, safetyAudit: canary.audit() };
      after = own.load(); storageAudits = await detach(own.wc, installed); installed.length = 0;
      const checked = Receipt.validate({ before, after, runtime, storageAudits });
      return { ...checked, preflight, runtime, storageAudits, finalSafety: after,
        startupInvocations: own.invocationCount, retryCount: 0, migrationCalls: 0, transitionCalls: 0 };
    } catch (e) {
      return { status: "FAIL", reason: /^[a-z_]+$/.test(e.message) ? e.message : "acceptance_failed", preflight,
        runtime: runtime || null, finalSafety: after || null, storageAudits, startupInvocations: own.invocationCount, retryCount: 0 };
    } finally {
      let cleanupFailed = false;
      try { canary?.close(); if (installed.length) await detach(own.wc, installed); }
      catch (_) { cleanupFailed = true; }
      owners.delete(token); // The returned closure stays one-use, including failures.
      own.used = true;
      if (cleanupFailed) return { status: "FAIL", reason: "acceptance_cleanup_incomplete", runtime: runtime || null,
        finalSafety: after || null, storageAudits, startupInvocations: own.invocationCount, retryCount: 0 };
    }
  } });
}
function createIsolatedController({ root, wc, runtimeStateStore, runtimeOptions } = {}) {
  mainOnly(); isolatedRoot(root);
  return owner({ load: () => Preflight.loadIsolated(root), wc, revisionCheck: () => ({ valid: true }),
    makeCanary: () => Canary.createIsolatedCanary({ root, wc, runtimeStateStore, runtimeOptions }) });
}
// Private native-main entry: no exported worker, execute callback, CLI context token,
// arbitrary DB name or arbitrary production root. The opaque context is created ONLY
// inside existing machineryStartupCanary.startup(), after its real B1 decision.
async function productionEntry() {
  mainOnly();
  if (process.type !== "browser" || !process.versions.electron) throw Error("native_controller_required");
  const revision = Preflight.revision(REPO); if (!revision.valid) throw Error(revision.reason);
  const { app, BrowserWindow, session } = require("electron"), metadata = require("../package.json");
  if (app.getName() !== metadata.name || app.getVersion() !== metadata.version) throw Error("package_identity_required");
  const profile = path.join(app.getPath("appData"), "OptionMap");
  const processes = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  if (processes.some(line => Number(line.trim().split(/\s/)[0]) !== process.pid &&
      /Electron\.app\/Contents\/(MacOS\/Electron|Frameworks)/.test(line) && /OptionMap|optionmap-writer-safety-/.test(line)))
    throw Error("optionmap_process_present");
  for (const target of ["IndexedDB", "market-calendar-writer-safety"]) {
    const lock = cp.spawnSync("lsof", ["-t", "+D", path.join(profile, target)], { encoding: "utf8" });
    if (lock.error || ![0, 1].includes(lock.status) || lock.stdout.trim()) throw Error("profile_lock_holder_present");
  }
  app.setPath("userData", profile); app.setPath("sessionData", profile);
  await app.whenReady();
  const initial = Preflight.validateState(Preflight.loadProduction()); if (!initial.valid) throw Error(initial.reason);
  const keepAlive = () => {}; app.on("window-all-closed", keepAlive);
  let window, observed = 0;
  try {
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadFile(path.join(REPO, "scripts", "marketCalendarD2d4ReadOnlyProbe.html"));
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, done) => { observed++; done({ cancel: false }); });
    const controller = owner({ load: Preflight.loadProduction, wc: window.webContents,
      revisionCheck: () => Preflight.revision(REPO), makeCanary: () => Canary.createProductionCanary(window.webContents) });
    const result = await controller.accept();
    if (result.runtime?.safetyAudit?.transportRequests !== observed || result.runtime?.safetyAudit?.pendingTransports !== 0)
      return { ...result, status: "FAIL", reason: "network_audit_mismatch", observed };
    return { ...result, observed };
  } finally {
    session.defaultSession.webRequest.onBeforeRequest(null);
    if (window && !window.isDestroyed()) await new Promise(resolve => { window.once("closed", resolve); window.close(); });
    app.off("window-all-closed", keepAlive);
  }
}
if (require.main === module) {
  // No worker flags exist. Calling the script in Node/renderer does not start Electron
  // or mint a startup capability. Output handoff finishes before app exit.
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--production") throw Error("explicit_acceptance_entry_required");
  productionEntry().then(result => new Promise(resolve => process.stdout.write(JSON.stringify(result) + "\n", resolve)))
    .then(() => require("electron").app.quit()).catch(e => {
      process.stderr.write(e.message + "\n"); process.exitCode = 1;
      if (process.type === "browser") require("electron").app.quit();
    });
}
module.exports = Object.freeze({ createIsolatedController });
