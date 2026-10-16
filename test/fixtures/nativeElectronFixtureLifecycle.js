"use strict";

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

module.exports = Object.freeze({ shutdown, isIntentionalForcedTermination, assertFixtureExited });
