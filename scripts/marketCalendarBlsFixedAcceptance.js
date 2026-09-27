"use strict";

// Explicit isolated launcher only. No production app, registry activation or history writer.
const path = require("node:path");
async function runElectronProbe(tempRoot) {
  const { app, net, session } = require("electron"), fs = require("node:fs");
  if (!path.isAbsolute(tempRoot) || !fs.existsSync(path.join(tempRoot, "isolated-bls-fixed-marker")))
    throw Error("isolated_profile_required");
  app.setPath("userData", path.join(tempRoot, "userData"));
  app.setPath("sessionData", path.join(tempRoot, "sessionData"));
  app.disableHardwareAcceleration();
  const watchdog = setTimeout(() => app.exit(3), 140000);
  let forbiddenStorageAccess = 0;
  for (const name of ["indexedDB", "localStorage"]) Object.defineProperty(globalThis, name, {
    configurable: true, get() { forbiddenStorageAccess++; throw Error("storage_forbidden"); } });
  try {
    await app.whenReady();
    const R = require("../js/marketCalendarIsolated/blsFixedRoute.js"),
      A = require("../js/marketCalendarIsolated/blsFixedAssessment.js"),
      Legacy = require("../js/marketCalendarShadow/representativeParsers.js"),
      C = require("../js/marketCalendar/marketEventCanonicalizer.js");
    let redirectCount = 0;
    session.defaultSession.webRequest.onBeforeRedirect({ urls: R.ROLES.map(r => r.url) }, () => { redirectCount++; });
    const acquirer = R.createAcquirer({ fetchImpl: (url, options) => net.fetch(url, options) });
    const acquired = await acquirer.acquire({ sourceId: R.SOURCE_ID });
    const result = await A.assess({ acquisitionResult: acquired, assessmentDateJst: "2026-09-26" });
    const fixture = Legacy.parseBls(fs.readFileSync(path.join(__dirname,
      "../test/fixtures/marketCalendar/blsMonthlyCalendar.html"), "utf8"), {
      sourceId: R.SOURCE_ID, sourceUrl: "https://www.bls.gov/schedule/", fetchedAt: acquired.fetchedAt,
      parserId: R.shadowRegistry.getSource(R.SOURCE_ID).parserId, parserVersion: 1, rawContentHash: "a".repeat(64) });
    const parity = [];
    for (const record of fixture.records) {
      const old = await C.canonicalize(record), current = result.canonicalRecords.find(e => e.eventKey === old.event?.eventKey);
      parity.push({ eventType: record.eventType, present: !!current,
        semanticHashEqual: current ? current.canonicalContentHash === old.event.canonicalContentHash : null });
    }
    session.defaultSession.webRequest.onBeforeRedirect(null);
    await session.defaultSession.closeAllConnections(); clearTimeout(watchdog);
    const unexpectedHandles = (process.getActiveResourcesInfo?.() || []).filter(n => !["TTYWrap", "PipeWrap"].includes(n));
    const loadedStorageModules = Object.keys(require.cache).filter(f => /[/\\]js[/\\](?:storage|marketCalendarHistory)[/\\]/.test(f)).length;
    const output = { phase: "D2c2b-2", runtime: { electron: process.versions.electron, node: process.versions.node },
      productionProfileUsed: false, productionActive: false, writerEnabled: false, retry: 0, redirectCount,
      resources: acquirer.diagnostics(), unexpectedHandles, forbiddenStorageAccess, loadedStorageModules,
      outcome: result.outcome, candidateCount: result.candidateCount, coverageState: result.coverageState,
      absenceAuthority: result.absenceAuthority, roleCoverage: result.roleCoverage, parity,
      documents: result.documents.map(d => { const fetch = acquired.documents.find(a => a.role === d.role);
        return { role: d.role, requestedUrl: d.requestedUrl, httpStatus: fetch.httpStatus,
          mime: fetch.mime, responseUrlAvailable: fetch.responseUrlAvailable, byteCount: fetch.byteCount,
          encodingEvidence: d.encodingEvidence, encodingWarnings: d.encodingWarnings,
          fetchOutcome: d.fetchOutcome, parseOutcome: d.parseOutcome,
          candidateCount: d.candidateCount, diagnostic: d.diagnostic, fetchReason: fetch.reason,
          canonicalDiagnostics: d.canonicalDiagnostics || [] }; }) };
    const passed = result.outcome === "complete" && result.coverageState === "sufficient" &&
      !redirectCount && !unexpectedHandles.length && !forbiddenStorageAccess && !loadedStorageModules &&
      parity.every(p => !p.present || p.semanticHashEqual);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n", () => app.exit(passed ? 0 : 2));
  } catch (_) { clearTimeout(watchdog); process.stderr.write("isolated_acceptance_failed\n"); app.exit(2); }
}
async function launch() {
  const fs = require("node:fs"), os = require("node:os"), { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-bls-fixed-isolated-")); let code = 2;
  try {
    fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
    fs.writeFileSync(path.join(root, "isolated-bls-fixed-marker"), "D2c2b-2");
    const meta = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: meta.name, version: meta.version, main: "probe.cjs" }));
    fs.writeFileSync(path.join(root, "probe.cjs"), `require(${JSON.stringify(__filename)}).runElectronProbe(${JSON.stringify(root)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    code = await new Promise((resolve, reject) => {
      const child = spawn(require("electron"), [root], { stdio: "inherit", env });
      const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      child.once("exit", n => { clearTimeout(timer); resolve(n ?? 2); });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ cleanup: { tempUserDataCreated: 1, tempUserDataRemoved: 1,
      tempSessionDataCreated: 1, tempSessionDataRemoved: 1, tempRootExists: fs.existsSync(root), childProcessExited: true } }) + "\n");
  }
  process.exitCode = code;
}
module.exports = { runElectronProbe };
if (require.main === module) launch().catch(() => { process.stderr.write("isolated_launcher_failed\n"); process.exitCode = 2; });
