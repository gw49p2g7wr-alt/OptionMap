"use strict";

// Explicit opt-in controller. No profile path CLI, no retry, no active writer.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict"), crypto = require("node:crypto");
const P = require("../js/marketCalendarHistory/writerSafetyInitialProvisioning.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Schema = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const emit = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ type: "provision_result", value }) + "\n", e => e ? reject(e) : resolve()));
function readback(profile) {
  const reader = Reader.createReader(profile), v = reader.load();
  assert.equal(v.status, "valid", v.reason); assert.equal(v.safety.sequence, 0); assert.equal(v.safety.pendingFence, null);
  assert.equal(v.safety.globalSuspend.suspended, false);
  assert.ok(v.safety.sources.every(s => !s.suspended && Object.values(s.counters).every(c => c.count === 0 && c.cycleOrdinal === 0)));
  const bytes = fs.readFileSync(path.join(profile, Reader.RELATIVE_PATH)), record = Schema.parse(bytes.toString("utf8"));
  assert.equal(P.initial(record), true);
  return { pid: process.pid, status: "pass", sequence: v.safety.sequence, checksum: record.checksum,
    contentHash: crypto.createHash("sha256").update(bytes).digest("hex"), loadMs: v.latencyMs,
    authority: A.PRODUCTION_POLICY.global.state, sourcePermissions: A.PRODUCTION_POLICY.permissions.entries,
    pendingFence: null, countersZero: true, audit: reader.audit(), writerExecution: 0 };
}
async function worker(root, mode) {
  const { app, session } = require("electron");
  assert.ok(["provision", "restart", "runtime"].includes(mode));
  const profile = path.join(app.getPath("appData"), "OptionMap");
  app.setPath("userData", profile); app.setPath("sessionData", path.join(root, "sessionData"));
  app.disableHardwareAcceleration();
  if (mode === "runtime") return require("./marketCalendarE4eRuntimeShadow.js").worker(root, true, "valid");
  let result, code = 1, networkAttempts = 0;
  const control = require("node:readline").createInterface({ input: process.stdin });
  control.on("line", line => { if (line === "STOP") app.exit(2); });
  const watchdog = setTimeout(() => app.exit(3), 30000);
  try {
    await app.whenReady(); session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_, callback) => {
      networkAttempts++; callback({ cancel: true });
    });
    const fixed = P.resolveProductionProfile();
    if (mode === "provision") {
      const p = P.createProductionProvisioner();
      try { const persisted = p.provision(); assert.equal(persisted.saved, true, persisted.reason);
        result = { ...readback(fixed), mode, productionPath: path.join(fixed, Reader.RELATIVE_PATH), persisted }; }
      finally { p.close(); }
    } else result = { ...readback(fixed), mode };
    assert.equal(networkAttempts, 0); code = 0;
  } catch (e) { result = { status: "fail", mode, reason: /^[a-z_]+$/.test(e.message) ? e.message : "provision_acceptance_failed" }; }
  finally { session.defaultSession.webRequest.onBeforeRequest(null); clearTimeout(watchdog);
    control.removeAllListeners(); control.close();
    result.cleanup = { requests: networkAttempts, windows: 0, watchdogs: 0, fileHandles: 0 };
    await emit(result); app.exit(code); }
}
async function controller() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-e4e-runtime-"));
  let childActive = false;
  try {
    fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
    fs.writeFileSync(path.join(root, "isolated-only"), "Dedicated acceptance\n");
    const metadata = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: metadata.name, version: metadata.version, main: "entry.cjs" }));
    fs.writeFileSync(path.join(root, "entry.cjs"), `require(${JSON.stringify(__filename)});\n`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    async function run(command, args) {
      const child = cp.spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }); childActive = true;
      let latest, unsafe = false;
      const lines = require("node:readline").createInterface({ input: child.stdout });
      lines.on("line", line => { process.stdout.write(line + "\n"); try { const r = JSON.parse(line);
        if (["result", "provision_result"].includes(r.type)) latest = r.value; } catch (_) {} });
      child.stderr.on("data", bytes => { process.stderr.write(bytes); if (/quota.*reset|repair|corrupt/i.test(String(bytes))) {
        unsafe = true; child.stdin.write("STOP\n"); } });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      childActive = false; lines.close(); assert.equal(unsafe, false); assert.equal(code, 0, latest?.reason);
      assert.equal(latest?.status, "pass"); return latest;
    }
    // Disposable native runtime instrumentation preflight before any production mutation.
    await run(process.execPath, [path.join(__dirname, "marketCalendarE4eRuntimeShadow.js")]);
    const provision = await run(require("electron"), [root, "--safety-mode=provision", `--safety-root=${root}`]);
    const restart = await run(require("electron"), [root, "--safety-mode=restart", `--safety-root=${root}`]);
    assert.notEqual(provision.pid, restart.pid);
    for (const key of ["checksum", "contentHash", "sequence", "sourcePermissions"]) assert.deepEqual(restart[key], provision[key]);
    const runtime = await run(require("electron"), [root, "--safety-mode=runtime", `--safety-root=${root}`]);
    assert.equal(runtime.safetyContentHash, provision.contentHash); assert.equal(runtime.canary?.readyCandidate, true);
    await emit({ status: "pass", mode: "final", initialProvision: 1, restartLoads: 1,
      contentHash: provision.contentHash, sequence: provision.sequence, canaryReady: true, writerExecution: 0 });
  } finally {
    if (!childActive) { fs.rmSync(root, { recursive: true }); await emit({ mode: "cleanup", tempRemaining: Number(fs.existsSync(root)), diagnosticProcesses: 0 }); }
  }
}
if (require.main === module || process.versions.electron && process.argv.some(a => a.startsWith("--safety-root="))) {
  const root = process.argv.find(a => a.startsWith("--safety-root="));
  const mode = process.argv.find(a => a.startsWith("--safety-mode="));
  if (process.versions.electron && root && mode) {
    const value = root.slice(14);
    if (path.dirname(value) !== fs.realpathSync(os.tmpdir()) || !path.basename(value).startsWith("optionmap-e4e-runtime-") || !fs.existsSync(path.join(value, "isolated-only"))) throw Error("temp_controller_invalid");
    worker(value, mode.slice(14)).catch(e => { console.error(e.message); process.exitCode = 1; });
  } else {
    if (process.argv.slice(2).join("|") !== "--production") throw Error("explicit_production_approval_required");
    controller().catch(e => { console.error(e.message); process.exitCode = 1; });
  }
}
module.exports = Object.freeze({ readback });
