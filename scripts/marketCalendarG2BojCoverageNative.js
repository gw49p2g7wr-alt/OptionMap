"use strict";

// Official public network only in explicit live-readonly mode; all app storage
// is disposable. No production profile resolver, IndexedDB, safety or writer.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"),
  cp = require("node:child_process"), assert = require("node:assert/strict");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
const ROOT = path.resolve(__dirname, "..");
function sentinel(root) {
  const audit = { forbiddenAttempts: 0, repositoryWrites: 0 };
  const inside = (p, base) => p === base || p.startsWith(base + path.sep);
  function check(p, writing) {
    if (typeof p !== "string" && !Buffer.isBuffer(p)) return;
    const resolved = path.resolve(String(p));
    if (inside(resolved, root)) return;
    if (!writing && inside(resolved, ROOT)) return;
    audit.forbiddenAttempts++; if (writing && inside(resolved, ROOT)) audit.repositoryWrites++;
    throw Error("g2_filesystem_scope_forbidden");
  }
  for (const key of ["readFileSync", "writeFileSync", "openSync", "statSync", "lstatSync", "realpathSync", "existsSync",
    "readdirSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "readFile", "writeFile", "open", "stat", "lstat",
    "realpath", "readdir", "mkdir", "rename", "unlink", "rm", "copyFileSync", "symlinkSync", "linkSync", "truncateSync"]) {
    const raw = fs[key]; if (typeof raw !== "function") continue;
    fs[key] = function(p, ...args) {
      const writing = /^(write|mkdir|rename|unlink|rm|copy|symlink|link|truncate)/.test(key) ||
        key.startsWith("open") && !(args[0] === "r" || args[0] === fs.constants.O_RDONLY ||
          args[0] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
      check(p, writing); if (/^(rename|copy|symlink|link)/.test(key)) check(args[0], true);
      return raw.call(this, p, ...args);
    };
  }
  for (const key of ["open", "readFile", "writeFile", "stat", "lstat", "realpath", "readdir", "mkdir", "rename", "unlink", "rm"]) {
    const raw = fs.promises[key];
    fs.promises[key] = function(p, ...args) {
      check(p, /^(write|mkdir|rename|unlink|rm)/.test(key) || key === "open" && args[0] !== "r");
      if (key === "rename") check(args[0], true); return raw.call(this, p, ...args);
    };
  }
  return audit;
}
async function worker() {
  const { app, net, session } = require("electron"), pack = app.getAppPath();
  const config = JSON.parse(fs.readFileSync(path.join(pack, "fixture.json"), "utf8"));
  if (!Filesystem.samePath(path.dirname(config.root), fs.realpathSync(os.tmpdir())) || !path.basename(config.root).startsWith("optionmap-g2-boj-") ||
      !Filesystem.samePath(pack, path.join(config.root, "package")) || !["isolated", "live-readonly"].includes(config.mode)) throw Error("g2_fixture_scope_invalid");
  const profile = path.join(config.root, "profile"), appData = path.join(config.root, "appData");
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(appData, { recursive: true });
  app.setPath("appData", appData); app.setPath("userData", profile); app.setPath("sessionData", profile);
  app.setPath("crashDumps", path.join(config.root, "crashes"));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
  const guard = sentinel(config.root); let report;
  try {
    const Coverage = require("../js/marketCalendarRuntime/bojCoverageAcquisition.js"),
      Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js"),
      Fixture = config.mode === "isolated" ? require("../test/fixtures/marketCalendar/bojCoverageFixture.js") : null;
    const allowed = Policy.BOJ_COVERAGE_V2.documents.map(d => d.url);
    let requests = 0, observer = 0; const userAgents = new Set();
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, done) => {
      observer++; done({ cancel: config.mode !== "live-readonly" || !allowed.includes(details.url) });
    });
    session.defaultSession.webRequest.onBeforeSendHeaders((details, done) => {
      userAgents.add(details.requestHeaders["User-Agent"] || ""); done({ requestHeaders: details.requestHeaders });
    });
    const result = await Coverage.create({ fetchImpl: async (url, options) => {
      requests++; assert(allowed.includes(url));
      return Fixture ? Fixture.response(url) : net.fetch(url, options);
    } }).acquire({ sourceId: Coverage.SOURCE_ID, operation: Policy.OPERATION });
    const records = result.candidate.canonicalRecords;
    report = { gate: "G2", mode: config.mode, status: result.success ? "PASS" : "FAIL", reason: result.reason,
      package: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron },
      requests, observer, userAgents: [...userAgents], manualUAOverride: 0, retry: 0,
      documents: result.documents, coverage: result.coverageAudit,
      candidateCount: records.length, candidates: records.map(r => ({ type: r.logical.eventType,
        identity: r.logical.speechIdentity || null, title: r.title.ja, date: r.schedule.sourceLocal.startDate,
        time: r.schedule.sourceLocal.startTime, referencePeriod: r.logical.referencePeriod || null,
        sourceUrl: r.acquisitionEvidence.sourceUrl, speechPublicationUrl: r.acquisitionEvidence.httpMetadata?.speechPublicationUrl || null })),
      diagnostics: result.candidate.parserDiagnostics, guard, productionAccess: 0,
      runtimeStateWrites: 0, formalReadwrite: 0, safetyWrites: 0, authorization: 0, grant: 0, token: 0, writer: 0 };
    if (config.mode === "live-readonly" && result.success) {
      assert.equal(requests, 3); assert.equal(observer, 3);
      const ueda = records.find(r => r.logical.eventType === "BOJ_SPEECH" && r.logical.speechIdentity.eventDate === "2026-10-06" &&
        r.logical.speechIdentity.speakerId === "植田");
      assert(ueda);
      assert.equal(ueda.acquisitionEvidence.httpMetadata.speechPublicationUrl, "https://www.boj.or.jp/about/press/koen_2026/ko261006a.htm");
      assert(records.some(r => r.logical.eventType === "JP_TANKAN"));
    }
    assert.equal(guard.forbiddenAttempts, 0);
  } catch (e) { report = { ...report, status: "FAIL", reason: e.message, guard }; }
  finally {
    session.defaultSession.webRequest.onBeforeRequest(null);
    session.defaultSession.webRequest.onBeforeSendHeaders(null);
    const destination = path.join(config.root, "receipt.json"), temp = destination + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(report)); fs.renameSync(temp, destination);
    await Lifecycle.shutdown(app, session, report.status === "PASS" ? 0 : 1);
  }
}
function run(mode = "isolated") {
  if (!["isolated", "live-readonly"].includes(mode)) throw Error("g2_mode_invalid");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g2-boj-"));
  try {
    const pack = path.join(root, "package"); fs.mkdirSync(pack);
    const identity = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    fs.writeFileSync(path.join(pack, "package.json"), JSON.stringify({ name: identity.name, version: identity.version, main: "entry.cjs" }));
    fs.writeFileSync(path.join(pack, "entry.cjs"), `require(${JSON.stringify(__filename)}).worker().catch(async e=>{console.error(e.message);const electron=require('electron');await require(${JSON.stringify(require.resolve("../test/fixtures/nativeElectronFixtureLifecycle.js"))}).shutdown(electron.app,electron.session,1)});`);
    fs.writeFileSync(path.join(pack, "fixture.json"), JSON.stringify({ root, mode }));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const stdoutPath = path.join(root, "stdout.log"), stderrPath = path.join(root, "stderr.log");
    const stdout = fs.openSync(stdoutPath, "w", 0o600), stderr = fs.openSync(stderrPath, "w", 0o600);
    let child;
    try { child = Lifecycle.withNativeElectronLaunchLock(() =>
      cp.spawnSync(require("electron"), [pack, `--user-data-dir=${path.join(root, "profile")}`],
        { cwd: ROOT, env, stdio: ["ignore", stdout, stderr], timeout: 90000, killSignal: "SIGKILL" })); }
    finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    const receiptPath = path.join(root, "receipt.json");
    if (!fs.existsSync(receiptPath)) {
      const diagnostics = { status: child.status, signal: child.signal, error: child.error?.message || null,
        stdout: fs.readFileSync(stdoutPath, "utf8").slice(0, 500), stderr: fs.readFileSync(stderrPath, "utf8").slice(0, 500) };
      throw Error(`g2_native_receipt_missing:${JSON.stringify(diagnostics)}`);
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    return { ...receipt, processExitCode: child.status, tempDeleted: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = Object.freeze({ run, worker });
if (require.main === module && process.type !== "browser") {
  const receipt = run(process.argv[2] || "isolated"); console.log(JSON.stringify(receipt));
  process.exitCode = receipt.status === "PASS" ? 0 : 1;
}
