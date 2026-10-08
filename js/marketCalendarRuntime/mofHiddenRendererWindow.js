"use strict";

// Main-owned fixed document/session/window. No normal application integration.
const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const Profile = require("../marketCalendarHistory/writerSafetyInitialProvisioning.js");
const Base = require("../../scripts/marketCalendarG14bFilesystemGuard.js");
const ROOT = path.resolve(__dirname, "../.."), WORLD = 1754;
const DOCUMENT = path.join(ROOT, "scripts/marketCalendarD2d4ReadOnlyProbe.html");
const PRELOAD = path.join(__dirname, "mofHiddenRendererPreload.js");
const URL = pathToFileURL(DOCUMENT).href;
const networkPolicies = new WeakMap();
function networkOwner(session, wc, audit) {
  let policy = networkPolicies.get(session);
  if (!policy) {
    policy = { owners: new Map() }; networkPolicies.set(session, policy);
    session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (request, done) => {
      const owner = policy.owners.get(request.webContentsId);
      if (owner) owner.networkAttempts++; else for (const row of policy.owners.values()) row.networkAttempts++;
      done({ cancel: true });
    });
  }
  policy.owners.set(wc.id, audit);
  return () => { policy.owners.delete(wc.id); if (!policy.owners.size) { session.webRequest.onBeforeRequest(null); networkPolicies.delete(session); } };
}
const ARTIFACTS = ["js/marketCalendarRuntime/mofHiddenRendererPreload.js", "js/marketCalendarRuntime/mofHiddenRendererExecutor.js",
  "js/marketCalendarRuntime/mofHiddenRendererWindow.js", "js/marketCalendarRuntime/mofControlledGrantController.js",
  "js/marketCalendarHistory/formalControlledWriterCore.js", "js/marketCalendarHistory/firstProductionWriteExecutor.js",
  "js/marketCalendarHistory/productionSchemaV1.js", "scripts/marketCalendarD2d4ReadOnlyProbe.html"];
function mainOnly() { if (process.type !== "browser" || !process.versions.electron) throw Error("native_main_required"); }
function artifactIdentity() { return A.hash(ARTIFACTS.map(p => ({ path: p, bytes: fs.readFileSync(path.join(ROOT, p)).toString("base64") }))); }
async function create(root, crashAt = null) {
  mainOnly(); const { app, BrowserWindow, session } = require("electron"); await app.whenReady();
  if (app.getPath("userData") !== root || app.getPath("sessionData") !== root || session.defaultSession.getStoragePath() !== root)
    throw Error("native_profile_session_mismatch");
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, devTools: false, preload: PRELOAD, session: session.defaultSession } });
  const wc = window.webContents, network = { networkAttempts: 0 }, releaseNetwork = networkOwner(session.defaultSession, wc, network);
  let invalidated = false, closing = false, attempts = 0, epoch = A.hash({ document: require("node:crypto").randomUUID() });
  const invalidate = () => { invalidated = true; };
  const navigate = event => { attempts++; event.preventDefault(); invalidate(); };
  wc.on("will-navigate", navigate); wc.on("will-frame-navigate", navigate);
  wc.setWindowOpenHandler(() => { attempts++; invalidate(); return { action: "deny" }; });
  wc.on("render-process-gone", invalidate); wc.on("destroyed", invalidate);
  if (crashAt === "before_load") { process.kill(process.pid, "SIGKILL"); throw Error("isolated_crash_did_not_terminate"); }
  try { await window.loadFile(DOCUMENT); }
  catch (e) { releaseNetwork(); window.destroy(); throw e; }
  const changedDocument = () => invalidate(); wc.on("did-start-navigation", changedDocument);
  const frame = wc.mainFrame;
  const target = A.freeze({ webContentsId: wc.id, osProcessId: wc.getOSProcessId(), frameProcessId: frame.processId,
    frameRoutingId: frame.routingId, frameToken: frame.frameToken, documentEpoch: epoch, documentUrl: URL });
  function valid(event) {
    if (invalidated || closing || network.networkAttempts || wc.isDestroyed() || wc.getURL() !== URL || wc.mainFrame !== frame ||
      wc.getOSProcessId() !== target.osProcessId || frame.processId !== target.frameProcessId ||
      frame.routingId !== target.frameRoutingId || frame.frameToken !== target.frameToken) return false;
    return !event || event.sender === wc && event.senderFrame === frame;
  }
  return Object.freeze({ wc, target, valid, artifactIdentity: artifactIdentity(),
    run: code => { if (!valid()) throw Error("native_document_invalid"); return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); },
    revoke: invalidate,
    close: async () => { closing = true; releaseNetwork(); wc.removeListener("will-navigate", navigate); wc.removeListener("will-frame-navigate", navigate);
      wc.removeListener("did-start-navigation", changedDocument); wc.removeListener("render-process-gone", invalidate);
      wc.removeListener("destroyed", invalidate); if (!window.isDestroyed()) window.destroy(); },
    audit: () => ({ invalidated, navigationAttempts: attempts, networkAttempts: network.networkAttempts, windows: window.isDestroyed() ? 0 : 1,
      listeners: closing ? 0 : 5,
      profile: root, sessionStoragePath: session.defaultSession.getStoragePath(), documentUrl: URL, world: WORLD }) });
}
async function createProductionWindow(...args) { mainOnly(); if (args.length) throw Error("production_path_override_rejected"); return create(Profile.resolveProductionProfile()); }
async function createIsolatedWindow({ targetEnvironment, fixtureRoot, crashAt = null }) {
  mainOnly(); if (targetEnvironment !== "isolated_test" || crashAt !== null && crashAt !== "before_load") throw Error("isolated_environment_required");
  return create(Base.createIsolatedPolicy({ targetEnvironment, fixtureRoot }).profile, crashAt);
}
module.exports = Object.freeze({ ROOT, WORLD, DOCUMENT, URL, ARTIFACTS, artifactIdentity, createProductionWindow, createIsolatedWindow });
