"use strict";

// Disposable Node main-like restart reader ONLY. No production factory or migration CLI.
const cp = require("node:child_process");
const Store = require("../js/marketCalendarHistory/writerSafetyVersionedStore.js");
function read(root) {
  const store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  try { return { pid: process.pid, result: store.load() }; }
  finally { store.close(); }
}
function freshRead(root) {
  const child = cp.spawnSync(process.execPath, [__filename, "read", root], { encoding: "utf8", timeout: 10000 });
  if (child.error || child.status !== 0 || child.signal) throw Error("isolated_restart_failed");
  const value = JSON.parse(child.stdout);
  if (value.pid === process.pid || value.audit.fileHandles !== 0 || value.audit.lockHandles !== 0) throw Error("isolated_restart_invalid");
  return value;
}
if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== "read") throw Error("isolated_read_only_command_required");
  const root = process.argv[3], store = Store.createIsolatedStore({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
  let result;
  try { result = store.load(); } finally { store.close(); }
  process.stdout.write(JSON.stringify({ pid: process.pid, result, audit: store.audit() }) + "\n");
}
module.exports = Object.freeze({ read, freshRead });
