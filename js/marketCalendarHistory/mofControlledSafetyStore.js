"use strict";

// Isolated acceptance factory ONLY. No production resolver/provisioning/activation.
// Immutable generations + a durable attempt ownership latch make interruption
// fail closed, including an authorization-only crash before a pending fence exists.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { randomUUID } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), File = require("./writerSafetyFileSchema.js");
const E = require("./writerSafetySourceSetEnvelope.js"), L = require("./writerSafetyControlledLifecycle.js");
const Auth = require("./mofControlledAuthorization.js"), Semantic = require("./mofControlledSemanticPlan.js");
const Atomic = require("./writerSafetyAtomicCore.js"), Core = require("./formalControlledWriterCore.js");
const Reader = require("../marketCalendarRuntime/writerSafetyReadOnly.js");
const Generation = require("../marketCalendarRuntime/writerSafetyGenerationReadOnly.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js"), Schema = require("./productionSchemaV1.js");
const CRASH_POINTS = Object.freeze(["after_authorization", "after_prepared", "after_formal_write_started",
  "after_commit_observed", "after_readback_verified", "before_completion_persist", "after_completion_persist",
  ...Atomic.CRASH_POINTS.map(p => `completion_${p}`)]);
function createIsolatedStore({ userData, crashAt = null } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof userData !== "string" || !path.isAbsolute(userData) ||
    path.dirname(userData) !== fs.realpathSync(os.tmpdir()) || !path.basename(userData).startsWith("optionmap-writer-safety-") ||
    fs.realpathSync(userData) !== userData ||
    crashAt !== null && !CRASH_POINTS.includes(crashAt)) throw Error("isolated_store_path_invalid");
  const directory = path.join(userData, Generation.DIRECTORY); Generation.secureDirectory(directory);
  const rootStat = fs.lstatSync(userData), directoryStat = fs.lstatSync(directory);
  const owner = randomUUID(), lock = path.join(directory, "controlled.lock"), pointer = path.join(directory, "selection.json");
  const handles = new WeakMap(), audit = { authorizations: 0, persists: 0, writes: 0, handles: 0, readonlyTransactions: 0,
    readwriteTransactions: 0, committedTransactions: 0, abortedTransactions: 0, committedWrites: Core.emptyCounts() };
  let current = null, base = null, owned = false, healthy = true, issued = false, completed = false;
  function point(name) { if (crashAt === name) process.exit(86); }
  function handle(file, flags, action) {
    const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600); audit.handles++;
    try { const s = fs.fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.size > File.MAX_BYTES ||
      process.platform !== "win32" && (s.mode & 0o077)) throw Error("controlled_file_invalid"); return action(fd); }
    finally { fs.closeSync(fd); audit.handles--; }
  }
  function syncDir(d) { const fd = fs.openSync(d, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); audit.handles++;
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); audit.handles--; } }
  function checkDirectories() {
    const r = fs.lstatSync(userData), d = fs.lstatSync(directory);
    if (r.dev !== rootStat.dev || r.ino !== rootStat.ino || d.dev !== directoryStat.dev || d.ino !== directoryStat.ino ||
      r.isSymbolicLink() || d.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw Error("controlled_path_changed");
  }
  function checkOwned() {
    checkDirectories();
    if (!owned || !healthy || handle(lock, fs.constants.O_RDONLY, fd => fs.readFileSync(fd, "utf8")) !== owner)
      throw Error("controlled_ownership_invalid");
    const selection = handle(pointer, fs.constants.O_RDONLY, fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (File.seal(selection).checksum !== selection.checksum || selection.sequence !== current.safety.sequence ||
      selection.stateChecksum !== current.checksum) throw Error("controlled_safety_stale");
    const selected = Generation.select(userData, (dir, name) => handle(path.join(dir, name), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8"))));
    Generation.secureDirectory(selected.directory);
    const record = handle(path.join(selected.directory, "safety.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    const checkpoint = handle(path.join(selected.directory, "sequence.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (record.checksum !== current.checksum || !E.validate(record).valid ||
      !A.exact(checkpoint, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || checkpoint.schemaVersion !== 3 ||
      checkpoint.sequence !== selection.sequence ||
      checkpoint.stateChecksum !== record.checksum || File.seal(checkpoint).checksum !== checkpoint.checksum)
      throw Error("controlled_safety_stale");
    const retainedDirectory = path.join(userData, Atomic.DIRECTORY); Generation.secureDirectory(retainedDirectory);
    const retained = handle(path.join(retainedDirectory, "safety.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    const retainedCheckpoint = handle(path.join(retainedDirectory, "sequence.json"), fs.constants.O_RDONLY,
      fd => File.parse(fs.readFileSync(fd, "utf8")));
    if (A.hash(retained) !== A.hash(current.historicalRecord) || !E.validate(retained).valid ||
      !A.exact(retainedCheckpoint, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) ||
      retainedCheckpoint.schemaVersion !== retained.schemaVersion ||
      retainedCheckpoint.stateChecksum !== retained.checksum || retainedCheckpoint.sequence !== retained.safety.sequence ||
      File.seal(retainedCheckpoint).checksum !== retainedCheckpoint.checksum) throw Error("controlled_retained_state_changed");
  }
  function persist(next, phase) {
    checkOwned(); if (!E.validate(next).valid) throw Error("controlled_next_state_invalid");
    const name = `controlled-${next.safety.sequence}`, parent = path.join(directory, name);
    let io;
    try {
      if (phase === "completed") point("before_completion_persist");
      fs.mkdirSync(parent, { mode: 0o700 }); syncDir(directory);
      io = Atomic.create(path.join(parent, Atomic.DIRECTORY), { crashAt: phase === "completed" &&
        crashAt?.startsWith("completion_") ? crashAt.slice("completion_".length) : null });
      io.acquire({ provision: true });
      const checkpoint = File.seal({ schemaVersion: 3, sequence: next.safety.sequence, stateChecksum: next.checksum });
      io.replace(next, checkpoint);
      if (A.hash(File.parse(io.read("state", File.MAX_BYTES))) !== A.hash(next) ||
        A.hash(File.parse(io.read("checkpoint", 1024))) !== A.hash(checkpoint)) throw Error("controlled_persist_readback_failed");
      io.close();
      const selection = File.seal({ schemaVersion: 1, generation: name, sequence: next.safety.sequence, stateChecksum: next.checksum });
      const temp = path.join(directory, "controlled-selection.tmp");
      handle(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
        fs.writeFileSync(fd, JSON.stringify(selection) + "\n"); fs.fsyncSync(fd); audit.writes++; });
      fs.renameSync(temp, pointer); syncDir(directory);
      current = next; checkOwned(); audit.persists++;
      if (phase === "completed") { completed = true; point("after_completion_persist"); }
      else point(`after_${phase}`);
    } catch (e) { healthy = false; throw e; }
    finally { io?.close(); }
  }
  function createControlledAuthorization(input) {
    if (issued) throw Error("controlled_attempt_already_issued"); issued = true;
    const loaded = Reader.createReader(userData).load();
    if (loaded.status !== "valid" || loaded.record.schemaVersion !== 3 || loaded.record.controlledLifecycleAudit ||
      loaded.record.safety.pendingFence) throw Error("controlled_safety_unavailable");
    current = loaded.record; base = E.migrateSourceSet(current.historicalRecord,
      E.requestFor(current.historicalRecord, current.sourceSetAudit[0].gateIdentity));
    checkDirectories();
    handle(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
      fs.writeFileSync(fd, owner); fs.fsyncSync(fd); audit.writes++; }); owned = true; syncDir(directory);
    checkOwned();
    const authorization = Auth.createControlledAuthorization({ ...input, record: current });
    audit.authorizations++; point("after_authorization"); return authorization;
  }
  function createPendingFence(authorization, input) {
    checkOwned();
    const context = Auth.consume(authorization, { ...input, record: current });
    const token = Object.freeze({});
    persist(L.append(base, current, "prepared", context.binding), "prepared");
    handles.set(token, { ...context, phase: "prepared", attempted: false, result: null, database: null, readback: null }); return token;
  }
  function get(token, phase) { const h = handles.get(token); if (!h || h.phase !== phase) throw Error("controlled_handle_invalid");
    checkOwned(); return h; }
  async function markWriteStarted(token, database) {
    const h = get(token, "prepared"); if (h.attempted) throw Error("controlled_second_write_forbidden");
    h.attempted = true; h.phase = "formal_write_started";
    persist(L.append(base, current, h.phase, h.binding), h.phase); h.database = database;
    try { h.result = await Core.executePrepared(database, h.execution, null, audit); return h.result; }
    catch (e) { healthy = false; throw e; }
  }
  function common(h) { return Object.fromEntries(["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity", "counts"]
    .map(k => [k, h.binding[k]])); }
  function markCommitObserved(token) {
    const h = get(token, "formal_write_started");
    const expectedCounts = Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f,
      f === "runs" || f === "cursors" ? 1 : 16]));
    if (h.result?.committed !== true || A.hash(h.result.counts) !== A.hash(expectedCounts) ||
      audit.readwriteTransactions !== 1 || audit.committedTransactions !== 1 || audit.abortedTransactions !== 0)
      throw Error("controlled_commit_ambiguous_or_mismatch");
    const proof = { ...common(h), readwriteTransactions: audit.readwriteTransactions,
      committedTransactions: audit.committedTransactions, abortedTransactions: audit.abortedTransactions };
    persist(L.append(base, current, "commit_observed", h.binding, proof), "commit_observed"); h.phase = "commit_observed";
  }
  async function markReadbackVerified(token, openFreshReadonly) {
    const h = get(token, "commit_observed");
    h.phase = "readback_in_progress"; // A failed read-back never re-enters this attempt.
    if (typeof openFreshReadonly !== "function") throw Error("controlled_fresh_readback_required");
    h.database.close(); const database = await openFreshReadonly();
    if (!database || database === h.database) throw Error("controlled_fresh_readback_required");
    let snapshot;
    try {
      snapshot = await new Promise((resolve, reject) => {
        const tx = database.transaction(Core.STORE_NAMES, "readonly"), values = {}; audit.readonlyTransactions++;
        tx.onabort = () => reject(Error("controlled_readback_incomplete")); tx.onerror = () => undefined;
        tx.oncomplete = () => resolve(values);
        for (const [f, name] of Core.STORE_ORDER) { const r = tx.objectStore(name).getAll(); r.onsuccess = () => { values[f] = r.result; }; }
      });
    } finally { database.close(); }
    const identity = A.hash(Core.sorted(snapshot));
    if (identity !== h.binding.expectedFormalIdentity) throw Error("controlled_readback_mismatch");
    const cycle = Cycle.create(snapshot, Schema.EXPECTED_FINGERPRINT); Cycle.close(cycle);
    const afterSorted = Core.sorted(snapshot), beforeSorted = Core.sorted(h.data.before);
    if (Core.STORE_ORDER.some(([f]) => A.hash(afterSorted[f].filter(r => r.sourceId !== Semantic.SOURCE)) !==
      A.hash(beforeSorted[f].filter(r => r.sourceId !== Semantic.SOURCE)))) throw Error("controlled_cross_source_mutation");
    const proof = { ...common(h), freshReadonlyReopen: true, integrity: true, otherSourcesUnchanged: true,
      expectedFormalIdentity: h.binding.expectedFormalIdentity, actualFormalIdentity: identity };
    persist(L.append(base, current, "readback_verified", h.binding, proof), "readback_verified");
    h.phase = "readback_verified"; h.readback = proof;
  }
  function completeControlledAttempt(token) {
    const h = get(token, "readback_verified");
    persist(L.append(base, current, "completed", h.binding, h.readback), "completed"); h.phase = "completed";
    close(); const reloaded = Reader.createReader(userData).load();
    if (reloaded.status !== "valid" || reloaded.record.checksum !== current.checksum || reloaded.safety.pendingFence)
      throw Error("controlled_completion_reload_failed"); return reloaded.record;
  }
  function close() {
    // Uncompleted ownership is a durable stop latch, never silently removed.
    if (owned && healthy && completed) { checkOwned(); fs.unlinkSync(lock); syncDir(directory); owned = false; }
  }
  return Object.freeze({ createControlledAuthorization, createPendingFence, markWriteStarted, markCommitObserved,
    markReadbackVerified, completeControlledAttempt, close, audit: () => structuredClone({ ...audit, owned, healthy }) });
}
module.exports = Object.freeze({ CRASH_POINTS, createIsolatedStore });
