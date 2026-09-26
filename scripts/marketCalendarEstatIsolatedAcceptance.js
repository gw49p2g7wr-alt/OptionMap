"use strict";

// Standalone acceptance only. Never imported by OptionMap main/preload or production runtime.
const path = require("node:path");
async function runElectronProbe(tempRoot) {
  const { app, net, session } = require("electron");
  const fs = require("node:fs");
  if (!path.isAbsolute(tempRoot) || !fs.existsSync(path.join(tempRoot, "isolated-estat-marker")))
    throw Error("isolated_profile_required");
  app.setPath("userData", path.join(tempRoot, "userData"));
  app.setPath("sessionData", path.join(tempRoot, "sessionData"));
  app.disableHardwareAcceleration();
  const watchdog = setTimeout(() => app.exit(3), 90000);
  let forbiddenStorageAccess = 0;
  for (const name of ["indexedDB", "localStorage"]) Object.defineProperty(globalThis, name, {
    configurable: true, get() { forbiddenStorageAccess++; throw Error("storage_forbidden"); } });
  try {
    await app.whenReady();
    const Route = require("../js/marketCalendarIsolated/estatRoute.js");
    const Parser = require("../js/marketCalendarIsolated/estatParser.js");
    const Coverage = require("../js/marketCalendarIsolated/estatCoverage.js");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric",
      month: "2-digit", day: "2-digit" }).format(new Date());
    const acquirer = Route.createAcquirer({ fetchImpl: (url, options) => net.fetch(url, options) });
    const sources = []; let passed = true;
    for (const sourceId of ["jp-stat-cpi", "jp-stat-labor"]) {
      const started = Date.now(), acquired = await acquirer.acquire({ sourceId });
      const candidate = await Parser.buildCandidate({ sourceId, acquisitionResult: acquired });
      const coverage = await Coverage.assessCoverage({ sourceId, assessmentDateJst: date,
        classifiedRows: candidate.classifiedRows, parserStatus: candidate.parserStatus });
      sources.push({ sourceId, httpStatus: acquired.document?.httpStatus || acquired.httpStatus || null,
        reason: acquired.reason || null, mime: acquired.document?.mime || null,
        encodingEvidence: acquired.document?.encodingEvidence || null,
        bytes: acquired.document?.byteCount || null, redirects: acquired.document?.redirects.length || 0,
        elapsedMs: Date.now() - started, parserStatus: candidate.parserStatus,
        candidateStatus: candidate.candidateStatus, candidateIdentity: candidate.candidateIdentity,
        totalRows: candidate.classifiedRows.length, eligibleRows: candidate.recordCount,
        noneligibleRows: candidate.classifiedRows.filter(row => !row.eligible).length,
        diagnostics: candidate.diagnostics, canonicalDiagnostics: candidate.canonicalDiagnostics || [], coverage });
      if (!acquired.success || candidate.parserStatus !== "success" || coverage.coverageState === "invalid") {
        passed = false; break;
      }
    }
    await session.defaultSession.closeAllConnections();
    clearTimeout(watchdog);
    const activeResources = process.getActiveResourcesInfo?.() || [];
    const unexpectedHandles = activeResources.filter(name => !["TTYWrap", "PipeWrap"].includes(name));
    const loadedStorageModules = Object.keys(require.cache).filter(file =>
      /[/\\]js[/\\](?:storage|marketCalendarHistory)[/\\]/.test(file)).length;
    const output = { phase: "D2c2a-2", runtime: { electron: process.versions.electron, node: process.versions.node },
      productionProfileUsed: false, customUserAgent: false, writerEnabled: false, productionActive: false,
      assessmentDateJst: date, resources: acquirer.diagnostics(), unexpectedHandles,
      storage: { forbiddenStorageAccess, loadedStorageModules, runtimeStateRead: 0, runtimeStateWrite: 0,
        formalDbOpen: 0, formalDbCreate: 0, formalWrite: 0, externalHistoryWrite: 0 }, sources };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n", () => app.exit(
      passed && !forbiddenStorageAccess && !loadedStorageModules && !unexpectedHandles.length ? 0 : 2));
  } catch (_) { clearTimeout(watchdog); process.stderr.write("isolated_acceptance_failed\n"); app.exit(2); }
}
async function launch() {
  const fs = require("node:fs"), os = require("node:os"), { spawn } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-estat-isolated-"));
  let code = 2;
  try {
    fs.mkdirSync(path.join(root, "userData")); fs.mkdirSync(path.join(root, "sessionData"));
    fs.writeFileSync(path.join(root, "isolated-estat-marker"), "D2c2a-2");
    const metadata = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: metadata.name,
      version: metadata.version, main: "probe.cjs" }));
    fs.writeFileSync(path.join(root, "probe.cjs"),
      `require(${JSON.stringify(__filename)}).runElectronProbe(${JSON.stringify(root)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    code = await new Promise((resolve, reject) => {
      const child = spawn(require("electron"), [root], { stdio: "inherit", env });
      const timer = setTimeout(() => child.kill("SIGKILL"), 100000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", value => { clearTimeout(timer); resolve(value ?? 2); });
    });
  } finally {
    // Only the exact directory created by mkdtemp; no repository or OptionMap profile path.
    fs.rmSync(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ cleanup: { tempUserDataCreated: 1, tempUserDataRemoved: 1,
      tempSessionDataCreated: 1, tempSessionDataRemoved: 1, tempRootExists: fs.existsSync(root),
      childProcessExited: true } }) + "\n");
  }
  process.exitCode = code;
}
module.exports = { runElectronProbe };
if (require.main === module) launch().catch(() => { process.stderr.write("isolated_launcher_failed\n"); process.exitCode = 2; });
