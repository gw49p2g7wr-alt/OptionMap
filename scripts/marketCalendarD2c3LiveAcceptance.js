"use strict";
const path = require("node:path"), fs = require("node:fs");
async function runProbe(root) {
  const { app, net, session } = require("electron");
  if (!path.isAbsolute(root) || !fs.existsSync(path.join(root, "d2c3-marker"))) throw Error("isolated_profile_required");
  app.setPath("userData", path.join(root, "userData")); app.setPath("sessionData", path.join(root, "sessionData"));
  app.disableHardwareAcceleration();
  let forbiddenStorageAccess = 0, requests = 0, activeRequests = 0, redirects = 0;
  const watchdog = setTimeout(() => app.exit(3), 480000);
  for (const name of ["indexedDB", "localStorage"]) Object.defineProperty(globalThis, name, {
    get() { forbiddenStorageAccess++; throw Error("storage_forbidden"); } });
  try {
    await app.whenReady();
    const G = require("./marketCalendarD2c3Shadow.js");
    session.defaultSession.webRequest.onBeforeRedirect(() => { redirects++; });
    const runner = G.createRunner({ fetchImpl: async (...args) => {
      requests++; activeRequests++;
      try { return await net.fetch(...args); } finally { activeRequests--; }
    } });
    const result = await runner.run({ assessmentDateJst: "2026-09-28" });
    session.defaultSession.webRequest.onBeforeRedirect(null);
    await session.defaultSession.closeAllConnections(); clearTimeout(watchdog);
    const resources = runner.resources();
    const unexpectedHandles = (process.getActiveResourcesInfo?.() || []).filter(x => !["TTYWrap", "PipeWrap"].includes(x));
    const storageModules = Object.keys(require.cache).filter(p => /[/\\]js[/\\](?:storage|marketCalendarHistory)[/\\]/.test(p));
    // Print only metadata, counts and canonical identities, never response bodies.
    const output = { ...result, sourceResults: result.sourceResults.map(({ canonicalRecords, ...s }) => ({ ...s,
      semanticIdentities: canonicalRecords.map(e => ({ eventKey: e.eventKey, revisionKey: e.revisionKey,
        semanticHash: e.canonicalContentHash, evidenceUrl: e.acquisitionEvidence?.sourceUrl })) })),
      runtime: { electron: process.versions.electron, node: process.versions.node },
      network: { requests, redirects, activeRequests }, resources, unexpectedHandles,
      forbiddenStorageAccess, loadedStorageModuleCount: storageModules.length, productionProfileUsed: false };
    const ok = result.overallCompleteness === "complete" && !forbiddenStorageAccess && !storageModules.length &&
      !unexpectedHandles.length && !activeRequests;
    process.stdout.write(JSON.stringify(output, null, 2) + "\n", () => app.exit(ok ? 0 : 2));
  } catch (_) { clearTimeout(watchdog); process.stderr.write("isolated_probe_failed\n"); app.exit(2); }
}
async function launch() {
  const { spawn } = require("node:child_process"), os = require("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-d2c3-"));
  try {
    fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
    fs.writeFileSync(path.join(root, "d2c3-marker"), "D2c3");
    const p = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: p.name, version: p.version, main: "probe.cjs" }));
    fs.writeFileSync(path.join(root, "probe.cjs"), `require(${JSON.stringify(__filename)}).runProbe(${JSON.stringify(root)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(require("electron"), [root], { env, stdio: "inherit" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 490000);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      child.once("exit", code => { clearTimeout(timer); resolve(code ?? 2); });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify({ cleanup: { tempProfileRemoved: !fs.existsSync(root), childExited: true } }));
  }
}
module.exports = { runProbe };
if (require.main === module) launch().catch(() => { console.error("isolated_launcher_failed"); process.exitCode = 2; });
