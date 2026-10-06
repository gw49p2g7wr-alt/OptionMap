"use strict";

// Explicit isolated package only. Receipt is lossless local data; stdout is summary.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const assert = require("node:assert/strict"), { pathToFileURL } = require("node:url"), { createHash } = require("node:crypto");
const S = require("../js/marketCalendarIsolated/mofJgbSource.js");
const C = require("../js/marketCalendarIsolated/mofJgbCanonical.js");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const TYPE = "G1_mof_jgb_isolated_receipt";
async function runIsolatedWorker(root) {
  assert.equal(process.type, "browser"); assert.ok(process.versions.electron);
  assert.equal(fs.realpathSync(root), root); assert.ok(root.startsWith(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g1-mof-")));
  assert.equal(fs.readFileSync(path.join(root, "isolated-marker"), "utf8"), "G1");
  const { app, net, session } = require("electron");
  app.setPath("appData", path.join(root, "appData")); app.setPath("userData", path.join(root, "userData"));
  app.setPath("sessionData", path.join(root, "sessionData")); app.disableHardwareAcceleration();
  const meta = require("../package.json"); assert.equal(app.getName(), meta.name); assert.equal(app.getVersion(), meta.version);
  let observer = 0, forbiddenNetwork = 0, result, acquirer;
  const guard = setTimeout(() => app.exit(3), 90000);
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (d, done) => {
      observer++; if (!S.validateUrl(d.url).valid) forbiddenNetwork++; done({ cancel: !S.validateUrl(d.url).valid });
    });
    acquirer = S.createAcquirer({ fetchImpl: (url, options) => net.fetch(url, options) });
    const assessmentDateJst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const started = performance.now(), acquired = await acquirer.acquire({ sourceId: S.SOURCE_ID, assessmentDateJst }),
      fetched = performance.now(), assessed = await C.assess(acquired), finished = performance.now();
    const documents = acquired.documents.map(d => ({ requestedUrl: d.requestedUrl, outcome: d.outcome, reason: d.reason,
      httpStatus: d.httpStatus, redirects: d.redirects.length, contentType: d.contentType || null,
      byteCount: d.byteCount, encoding: d.encoding || null, encodingEvidence: d.encodingEvidence || null }));
    result = { type: TYPE, valid: assessed.outcome === "complete", sourceId: S.SOURCE_ID, assessmentDateJst,
      runtime: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron,
        userAgent: session.defaultSession.getUserAgent(), manualUaOverride: 0 },
      documents, discovery: acquired.discovery, parser: assessed.diagnostics, monthDiagnostics: assessed.documents,
      candidateCount: assessed.candidateCount,
      futureCandidateCount: assessed.futureCandidateCount, byMaturity: assessed.byMaturity,
      candidates: assessed.canonicalRecords.map(e => ({ eventKey: e.eventKey, revisionKey: e.revisionKey,
        date: e.schedule.sourceLocal.startDate, time: e.schedule.sourceLocal.startTime, title: e.title.ja })),
      outcome: assessed.outcome, reason: assessed.reason, absenceAuthority: assessed.absenceAuthority,
      coverage: assessed.coverage, network: { requests: acquirer.diagnostics().requests, observer, forbiddenNetwork, retry: 0 },
      latency: { fetchMs: fetched - started, planningMs: finished - fetched, totalMs: finished - started },
      productionAccess: 0, formalComparison: 0, formalPlan: 0, writerExecution: 0 };
    result.valid &&= observer === result.network.requests && forbiddenNetwork === 0;
  } catch (_) { result = { type: TYPE, valid: false, reason: "isolated_native_failed", productionAccess: 0 }; }
  finally {
    clearTimeout(guard); session.defaultSession.webRequest.onBeforeRequest(null);
    await session.defaultSession.closeAllConnections();
    const resources = acquirer?.diagnostics() || { activeTasks: 0, activeTimers: 0 };
    const unexpected = (process.getActiveResourcesInfo?.() || []).filter(n => !["TTYWrap", "PipeWrap"].includes(n));
    result.cleanup = { ...resources, listeners: 0, windows: 0, dbHandles: 0, unexpectedResources: unexpected,
      cookies: (await session.defaultSession.cookies.get({})).length };
    result.valid &&= !resources.activeTasks && !resources.activeTimers && !unexpected.length && result.cleanup.cookies === 0;
    const bytes = Buffer.from(JSON.stringify(result));
    fs.writeFileSync(path.join(root, "receipt.tmp"), bytes, { flag: "wx" }); fs.renameSync(path.join(root, "receipt.tmp"), path.join(root, "receipt.json"));
    fs.writeFileSync(path.join(root, "complete.tmp"), JSON.stringify({ type: TYPE, byteLength: bytes.length, sha256: digest(bytes) }), { flag: "wx" });
    fs.renameSync(path.join(root, "complete.tmp"), path.join(root, "complete.json"));
    process.stdout.write(JSON.stringify({ type: TYPE, valid: result.valid, candidateCount: result.candidateCount }) + "\n",
      () => app.exit(result.valid ? 0 : 2));
  }
}
function runNative() {
  if (process.versions.electron) throw Error("node_parent_required");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g1-mof-"));
  try {
    for (const name of ["appData", "userData", "sessionData"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "isolated-marker"), "G1");
    const meta = require("../package.json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: meta.name, version: meta.version, main: "entry.cjs" }));
    fs.writeFileSync(path.join(root, "entry.cjs"), `import(${JSON.stringify(pathToFileURL(__filename).href)}).then(m => m.default.runIsolatedWorker(__dirname));\n`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawnSync(require("electron"), [root, `--user-data-dir=${path.join(root, "userData")}`],
      { env, encoding: "utf8", timeout: 100000, maxBuffer: 65536 });
    if (child.error || child.signal) throw Error("isolated_native_incomplete");
    const marker = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8")), bytes = fs.readFileSync(path.join(root, "receipt.json"));
    assert.equal(marker.type, TYPE); assert.equal(bytes.length, marker.byteLength); assert.equal(digest(bytes), marker.sha256);
    const result = JSON.parse(bytes.toString("utf8")); assert.equal(result.type, TYPE); assert.equal(result.sourceId, S.SOURCE_ID);
    assert.equal(child.status, result.valid ? 0 : 2);
    return { ...result, receiptVerified: true, stderr: child.stderr, tempRemoved: true, childExited: true };
  } finally { fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
module.exports = Object.freeze({ runNative, runIsolatedWorker });
if (require.main === module) {
  const result = runNative(); process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.valid ? 0 : 2;
}
