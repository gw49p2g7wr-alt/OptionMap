"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// Acceptance workers must let Chromium finish its own shutdown. Immediate
// app.exit() can leave Windows utility processes holding disposable userData.
async function shutdown(app, session, code = 0) {
  if (process.platform === "win32") {
    if (session?.defaultSession) {
      await session.defaultSession.closeAllConnections();
      session.defaultSession.flushStorageData();
    }
    process.exitCode = code;
    app.quit();
    return;
  }
  app.exit(code);
}

function isIntentionalForcedTermination({ child, mode, fault, forcedFaults, platform = process.platform }) {
  if (mode !== "execute" || !forcedFaults.includes(fault) || child.error) return false;
  if (child.signal === "SIGKILL") return true;
  return platform === "win32" && child.signal === null && child.status === 1;
}

function assertFixtureExited({ child, profile, childProcess, platform = process.platform }) {
  if (child.error) throw child.error;
  if (child.status === null && child.signal === null) throw Error("fixture_child_exit_unresolved");
  if (platform === "win32") return Object.freeze({ method: "spawnSync_exit", exited: true });
  const rows = childProcess.spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (rows.status !== 0) throw Error("fixture_process_inventory_failed");
  if (rows.stdout.split("\n").some(row => row.includes(profile))) throw Error("fixture_child_leftover");
  return Object.freeze({ method: "posix_process_inventory", exited: true });
}

function waitForFilesystemRelease(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeFixtureTreeAfterExit({ root, child, profile, childProcess, platform = process.platform,
  filesystem = fs, wait = waitForFilesystemRelease, maxRetries = 20, retryDelayMs = 50 }) {
  const exit = assertFixtureExited({ child, profile, childProcess, platform });
  let retries = 0;
  for (;;) {
    try {
      filesystem.rmSync(root, { recursive: true, force: true });
      if (filesystem.existsSync(root)) throw Error("fixture_cleanup_incomplete");
      return Object.freeze({ ...exit, removed: true, attempts: retries + 1, retries });
    } catch (error) {
      const releasePending = platform === "win32" && (error.code === "EBUSY" || error.code === "EPERM");
      if (!releasePending || retries >= maxRetries) throw error;
      retries++;
      wait(retryDelayMs);
    }
  }
}

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

function withNativeElectronLaunchLock(callback, options = {}) {
  if (typeof callback !== "function") throw Error("native_launch_callback_required");
  const lockRoot = options.lockRoot || fs.realpathSync(os.tmpdir());
  const lockPath = path.join(lockRoot, "optionmap-native-electron-launch.lock");
  const deadline = Date.now() + (options.timeoutMs ?? 120000);
  const token = crypto.randomBytes(16).toString("hex");
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch {}
      if (owner && !ownerAlive(owner.pid)) {
        try { fs.rmSync(lockPath, { recursive: true }); } catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
        continue;
      }
      if (Date.now() >= deadline) throw Error("native_electron_launch_lock_timeout");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return callback(); }
  finally {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch {}
    if (!owner || owner.pid !== process.pid || owner.token !== token) throw Error("native_electron_launch_lock_ownership_lost");
    fs.rmSync(lockPath, { recursive: true });
  }
}

module.exports = Object.freeze({ shutdown, isIntentionalForcedTermination, assertFixtureExited,
  removeFixtureTreeAfterExit, withNativeElectronLaunchLock });
