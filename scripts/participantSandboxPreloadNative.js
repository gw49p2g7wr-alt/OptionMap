"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

function fixtureHtml() {
  return `<!doctype html><meta charset="utf-8">
<button id="refreshAllMarketDataButton">refresh</button>
<script src="startupBootstrap.js"></script>
<script>
  const state = { refreshCalls: 0, phases: [], errors: [] };
  async function refreshAllMarketData() {
    state.refreshCalls += 1;
    state.phases.push("refreshing");
    const result = await optionMapBridge.acquireParticipants({ requestKind: "latest_available" });
    state.phases.push("idle");
    return result;
  }
  window.refreshAllMarketData = refreshAllMarketData;
  const coordinator = OptionMapStartupBootstrap.createCoordinator({
    initializers: [{ name: "fixture", run: async () => true }],
    refresh: refreshAllMarketData,
    timeoutMs: 1000
  });
  window.requestStartupMarketRefresh = () => coordinator.requestManualRefresh();
  window.__startupPromise = coordinator.start().then(result => ({ result,
    state: coordinator.getState(), phases: [...state.phases] }));
  const button = document.getElementById("refreshAllMarketDataButton");
  window.__clickRefresh = async () => {
    if (button.disabled) return null;
    button.disabled = true;
    try { return await window.requestStartupMarketRefresh(); }
    catch (error) { state.errors.push(error.message); return null; }
    finally { button.disabled = false; }
  };
  window.__smokeState = state;
</script>`;
}

async function validFormalPayload() {
  const ParticipantData = require("../js/participantData.js");
  const P1 = require("../js/participantAcquisitionAuthorityContract.js");
  const sourceDate = "2026-11-10", fetchedAt = "2026-11-10T10:00:00.000Z";
  const parsed = ParticipantData.parseParticipantExcel([
    ["手口上位一覧"],
    [null, "取引日 Trading Date :", "20261110"],
    ["NK225F", "161090018", "2026-12", 1, "001", "Fixture", "Fixture", 100]
  ], sourceDate);
  const data = Object.fromEntries(ParticipantData.FILE_KEYS.map(role => [role, parsed]));
  const sourceUrls = Object.fromEntries(ParticipantData.FILE_KEYS.map(role =>
    [role, P1.canonicalWorkbookUrl(role, sourceDate)]));
  const completeSet = await ParticipantData.createCompleteCache({ data, sourceUrls, sourceDate,
    fetchedAt });
  const evidenceSetHash = "a".repeat(64), runHash = "b".repeat(64);
  return { completeSet, confirmedAt: fetchedAt, sourceEvidence: {
    contractVersion: "participants-formal-evidence-binding-v1", state: "available",
    evidenceSetId: `participants-evidence-set-v1|sha256:${evidenceSetHash}`,
    evidenceSetHash, sourceFamily: "participants", sourceId: "jpx-daily-participant-volume",
    sourceDate, runId: `participants-run-v1|sha256:${runHash}`,
    semanticVersionKey: completeSet.versionKey, semanticSignature: completeSet.signature,
    boundAt: fetchedAt, parserLineage: { fixture: true }, authorityKeyId: "fixture-main",
    bindingHash: "c".repeat(64), authoritySignature: "d".repeat(64)
  } };
}

async function worker() {
  const { app, BrowserWindow, ipcMain, session } = require("electron");
  const config = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "fixture.json"), "utf8"));
  app.setPath("appData", config.root);
  app.setPath("userData", config.profile);
  app.setPath("sessionData", config.profile);
  app.commandLine.appendSwitch("disable-background-networking");
  app.disableHardwareAcceleration();
  let acquireCount = 0;
  ipcMain.handle("optionmap:mof-startup:claim", async () => null);
  ipcMain.handle("acquire-participants", async (_event, request) => {
    acquireCount += 1;
    await new Promise(resolve => setTimeout(resolve, 40));
    if (acquireCount === 3) throw new Error("fixture_acquisition_failed");
    return { status: "available", reason: null, sourceDate: "2026-11-10",
      completeSet: { fixture: true }, request };
  });
  await app.whenReady();
  const messages = [], win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
    preload: path.join(app.getAppPath(), "preload.bundle.js")
  } });
  win.webContents.on("console-message", (_event, _level, message) => messages.push(message));
  await win.loadFile(path.join(app.getAppPath(), "fixture.html"));
  const startup = await win.webContents.executeJavaScript("window.__startupPromise");
  const bridge = await win.webContents.executeJavaScript(`({
    keys: Object.keys(window.optionMapBridge).sort(),
    frozen: Object.isFrozen(window.optionMapBridge),
    startupRefresh: typeof window.requestStartupMarketRefresh,
    refresh: typeof window.refreshAllMarketData,
    node: typeof require
  })`);
  const successDuring = await win.webContents.executeJavaScript(`(() => {
    window.__successRefresh = window.__clickRefresh();
    return document.getElementById("refreshAllMarketDataButton").disabled;
  })()`);
  const successResult = await win.webContents.executeJavaScript(`window.__successRefresh.then(
    value => ({ value, disabled: document.getElementById("refreshAllMarketDataButton").disabled }))`);
  const failureDuring = await win.webContents.executeJavaScript(`(() => {
    window.__failureRefresh = window.__clickRefresh();
    return document.getElementById("refreshAllMarketDataButton").disabled;
  })()`);
  const failureResult = await win.webContents.executeJavaScript(`window.__failureRefresh.then(
    value => ({ value, disabled: document.getElementById("refreshAllMarketDataButton").disabled,
      errors: [...window.__smokeState.errors] }))`);
  const MainBridge = require("../js/participantFormalMainBridge.js"), formalBridge =
    MainBridge.createParticipantFormalMainBridge({ ipcMain, getWebContents: () => win.webContents,
      timeoutMs: MainBridge.DEFAULT_TIMEOUT_MS });
  const formal = await formalBridge.commit(await validFormalPayload());
  formalBridge.close();
  const preferences = win.webContents.getLastWebPreferences();
  const result = { bridge, startup, acquireCount, successDuring, successResult, failureDuring,
    failureResult, formal, security: { sandbox: preferences.sandbox,
      nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation },
    consoleErrors: messages.filter(message => /module not found|Unable to load preload|bridge unavailable/i
      .test(message)) };
  fs.writeFileSync(path.join(app.getAppPath(), "result.json"), JSON.stringify(result));
  win.destroy();
  ipcMain.removeHandler("optionmap:mof-startup:claim");
  ipcMain.removeHandler("acquire-participants");
  await session.defaultSession.closeAllConnections();
  app.exit(0);
}

function nativeCase() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-participant-preload-native-")), pack = path.join(root, "package"),
    profile = path.join(root, "profile");
  fs.mkdirSync(pack, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "preload.bundle.js"), path.join(pack, "preload.bundle.js"));
  fs.copyFileSync(path.join(ROOT, "js/startupBootstrap.js"), path.join(pack, "startupBootstrap.js"));
  fs.writeFileSync(path.join(pack, "fixture.html"), fixtureHtml());
  fs.writeFileSync(path.join(pack, "fixture.json"), JSON.stringify({ root, profile }));
  fs.writeFileSync(path.join(pack, "package.json"), JSON.stringify({ name: "optionmap-preload-smoke",
    version: "1.0.0", main: __filename }));
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_TEST_CONTEXT", "NODE_CHANNEL_FD",
    "NODE_CHANNEL_SERIALIZATION_MODE"]) delete env[key];
  let child;
  try {
    const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
    child = Lifecycle.withNativeElectronLaunchLock(() => childProcess.spawnSync(
      require("electron"), [pack, `--user-data-dir=${profile}`], {
        cwd: ROOT, env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL"
      }));
    if (child.status !== 0 || child.error || child.signal)
      throw new Error(`participant_preload_native_failed: ${child.stderr || child.error || child.signal}`);
    return JSON.parse(fs.readFileSync(path.join(pack, "result.json"), "utf8"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.type === "browser") worker().catch(error => {
  console.error(error.stack); require("electron").app.exit(1);
});
else if (require.main === module) {
  try { console.log(JSON.stringify(nativeCase())); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}

module.exports = Object.freeze({ nativeCase });
