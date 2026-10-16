"use strict";

// Fixed namespace; never changes the historical selection or records.
// Separate production factory; no public arbitrary root/patch/reset API.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), E = require("./mofStartupCanaryEnvelope.js"), Plan = require("./mofStartupCanaryPlan.js");
const File = require("./writerSafetyFileSchema.js"), Atomic = require("./writerSafetyAtomicCore.js"), Core = require("./formalControlledWriterCore.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js"), Schema = require("./productionSchemaV1.js");
const Guard = require("../../scripts/marketCalendarG14bFilesystemGuard.js");
const Profile = require("./writerSafetyInitialProvisioning.js");
const Filesystem = require("./crossPlatformFilesystemSafety.js");
const DIRECTORY = E.DIRECTORY;
const CRASH_POINTS = Object.freeze(["after_authorization", ...["activation", ...E.PHASES].flatMap(p =>
  [`before_publish_${p}`, `after_${p}`, ...Atomic.CRASH_POINTS.map(k => `${p}:${k}`)])]);
function createIsolatedStore(options) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document ||
      !A.exact(options, ["targetEnvironment", "fixtureRoot", "crashAt"]) || options.targetEnvironment !== "isolated_test" ||
      options.crashAt !== null && !CRASH_POINTS.includes(options.crashAt)) throw Error("isolated_canary_store_required");
  return build(Guard.createIsolatedPolicy({targetEnvironment: options.targetEnvironment, fixtureRoot: options.fixtureRoot}).profile, options.crashAt);
}
function build(profile, crashAt, production=false) {
  const directory = path.join(profile, DIRECTORY);
  const owner = randomUUID(), lock = path.join(directory, "attempt.lock"), pointer = path.join(directory, "selection.json");
  const audit = { loads: 0, persists: 0, authorizations: 0, writes: 0, handles: 0, mainTokens: 0, writerExecution: 0 };
  const handles = new WeakMap(); let owned = false, healthy = true, current = null, issued = false;
  const point = name => { if (crashAt === name) {
    if (process.type === "browser") { process.kill(process.pid, "SIGKILL"); throw Error("isolated_crash_failed"); }
    process.exit(86);
  } };
  function secure(d) { const s = fs.lstatSync(d); if (!Filesystem.secureDirectoryStat(s) ||
    !Filesystem.samePath(fs.realpathSync(d), d)) throw Error("canary_directory_invalid"); }
  function file(p, flags, work) {
    const fd = fs.openSync(p, flags | Filesystem.noFollowFlag(), 0o600); audit.handles++;
    try { const s = fs.fstatSync(fd); if (!Filesystem.secureFileStat(s, { maxBytes: File.MAX_BYTES }))
      throw Error("canary_file_invalid"); return work(fd); }
    finally { fs.closeSync(fd); audit.handles--; }
  }
  function read(p, max) { return file(p, fs.constants.O_RDONLY, fd => { if (fs.fstatSync(fd).size > max) throw Error("canary_file_too_large");
    return fs.readFileSync(fd, "utf8"); }); }
  function syncDir(d) { Filesystem.syncDirectory(d); }
  function exists(p) { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
  function load() {
    audit.loads++;
    try {
      secure(profile); secure(directory);
      const p = File.parse(read(pointer, 1024));
      if (!A.exact(p, ["schemaVersion", "generation", "sequence", "stateChecksum", "checksum"]) || p.schemaVersion !== 1 ||
          !A.integer(p.sequence) || p.generation !== `mof-canary-${p.sequence}` || File.seal(p).checksum !== p.checksum)
        throw Error("canary_selection_invalid");
      const parent = path.join(directory, p.generation), d = path.join(parent, Atomic.DIRECTORY); secure(parent); secure(d);
      if (exists(path.join(d, Atomic.NAMES.lock)) || exists(path.join(d, Atomic.NAMES.intent))) throw Error("canary_generation_unverified");
      const record = File.parse(read(path.join(d, Atomic.NAMES.state), File.MAX_BYTES)), c = File.parse(read(path.join(d, Atomic.NAMES.checkpoint), 1024));
      if (!E.validate(record).valid || record.safety.sequence !== p.sequence || record.checksum !== p.stateChecksum ||
          !A.exact(c, ["schemaVersion", "sequence", "stateChecksum", "checksum"]) || c.schemaVersion !== E.VERSION ||
          c.sequence !== p.sequence || c.stateChecksum !== record.checksum || File.seal(c).checksum !== c.checksum)
        throw Error("canary_generation_invalid");
      return A.freeze({ status: "valid", record, generation: p.generation, owned: exists(lock),
        writeAllowed: false, manualWriteAllowed: false, retryAllowed: false });
    } catch (e) { return A.freeze({ status: e.code === "ENOENT" ? "missing" : "corrupt", reason: e.message,
      record: null, writeAllowed: false, manualWriteAllowed: false, retryAllowed: false }); }
  }
  function own() {
    secure(profile); secure(directory);
    file(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => { fs.writeFileSync(fd, owner); fs.fsyncSync(fd); audit.writes++; });
    owned = true; syncDir(directory);
  }
  function checkOwned() {
    secure(profile); secure(directory);
    if (!owned || !healthy || read(lock, 128) !== owner) throw Error("canary_ownership_invalid");
    if (current) { const latest = load(); if (latest.status !== "valid" || latest.record.checksum !== current.checksum) throw Error("canary_safety_stale"); }
  }
  function persist(next, phase) {
    checkOwned(); if (!E.validate(next).valid) throw Error("canary_next_invalid");
    let io;
    try {
      const generation = `mof-canary-${next.safety.sequence}`, parent = path.join(directory, generation);
      fs.mkdirSync(parent, {mode: 0o700}); syncDir(directory);
      const atomicCrash = crashAt?.startsWith(phase + ":") ? crashAt.slice(phase.length + 1) : null;
      io = Atomic.create(path.join(parent, Atomic.DIRECTORY), { crashAt: atomicCrash }); io.acquire({provision: true});
      const checkpoint = File.seal({schemaVersion: E.VERSION, sequence: next.safety.sequence, stateChecksum: next.checksum});
      io.replace(next, checkpoint);
      if (!Core.same(File.parse(io.read("state", File.MAX_BYTES)), next) || !Core.same(File.parse(io.read("checkpoint", 1024)), checkpoint))
        throw Error("canary_persist_readback_failed");
      io.close();
      const selection = File.seal({schemaVersion: 1, generation, sequence: next.safety.sequence, stateChecksum: next.checksum});
      const temp = path.join(directory, "selection.tmp");
      file(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fd => {
        fs.writeFileSync(fd, JSON.stringify(selection) + "\n"); fs.fsyncSync(fd); audit.writes++; });
      point(`before_publish_${phase}`); fs.renameSync(temp, pointer); syncDir(directory); current = next;
      checkOwned(); audit.persists++; point(`after_${phase}`); return current;
    } catch (e) { healthy = false; throw e; } finally { io?.close(); }
  }
  function release() { checkOwned(); fs.unlinkSync(lock); syncDir(directory); owned = false; }
  function activateHistorical(historical, gateIdentity) {
    if (issued || exists(directory)) throw Error("canary_activation_already_exists"); issued = true;
    const next = E.activate(historical, gateIdentity,E.ACTIVATION_REASONS[production?1:0]); secure(profile); fs.mkdirSync(directory, {mode: 0o700}); syncDir(profile);
    own(); const r = persist(next, "activation"); release(); return r;
  }
  function begin(preparation) {
    if (issued) throw Error("canary_attempt_already_issued"); issued = true;
    const loaded = load(), data = Plan.consume(preparation);
    if (loaded.status !== "valid" || loaded.owned || loaded.record.lifecycleAudit.length || loaded.record.safety.pendingFence ||
        data.safetySequence !== loaded.record.safety.sequence || data.safetyIdentity !== loaded.record.safety.validationIdentity)
      throw Error("canary_authority_unavailable");
    current = loaded.record; own(); checkOwned();
    const material = { sourceId: E.SOURCE, operation: E.OPERATION, attemptIdentity: data.attemptIdentity, cycleIdentity: data.cycleIdentity,
      envelopeVersion: E.VERSION, canaryAuthorityIdentity: E.AUTHORITY.identity, safetySequence: current.safety.sequence,
      safetyIdentity: current.safety.validationIdentity, candidateIdentity: data.candidateIdentity, runtimeIdentity: data.runtimeIdentity,
      semanticPlanIdentity: data.semanticPlanIdentity, acquisitionIdentity: data.acquisitionIdentity, comparisonIdentity: data.comparisonIdentity,
      formalPrecondition: data.formalPrecondition, planIdentity: data.planIdentity, expectedFormalIdentity: A.hash(data.expected), counts: E.COUNTS };
    const binding = A.freeze({...material, authorizationIdentity: A.hash({material,nonce:randomUUID()})});
    audit.authorizations++; point("after_authorization"); current = persist(E.append(current, "prepared", binding), "prepared");
    const token = Object.freeze({}); handles.set(token, {data,binding,phase:"prepared",proof:null}); return {token,binding};
  }
  function get(token, phase) { checkOwned(); const h = handles.get(token); if (!h || h.phase !== phase) throw Error("canary_attempt_invalid"); return h; }
  function advance(token, phase, next, proof = null) { const h = get(token, phase); h.phase = "unsafe";
    current = persist(E.append(current, next, h.binding, proof), next); h.phase = next; return current; }
  const common = h => Object.fromEntries(["sourceId","operation","attemptIdentity","authorizationIdentity","planIdentity","counts"].map(k=>[k,h.binding[k]]));
  function markWriteStarted(token) { return advance(token,"prepared","formal_write_started"); }
  function markCommitObserved(token, metrics) {
    const h = get(token,"formal_write_started");
    if (!A.exact(metrics,["readwrite","commit","abort"]) || metrics.readwrite !== 1 || metrics.commit !== 1 || metrics.abort !== 0) throw Error("canary_commit_incomplete");
    return advance(token,"formal_write_started","commit_observed",{...common(h),...metrics});
  }
  function markReadbackVerified(token, snapshot, freshReadonlyReopen) {
    const h = get(token,"commit_observed"), sorted = Core.sorted(snapshot);
    if (freshReadonlyReopen !== true || !Core.same(sorted,h.data.expected)) throw Error("canary_fresh_readback_incomplete");
    const context = Cycle.create(sorted,Schema.EXPECTED_FINGERPRINT); Cycle.close(context);
    if (Core.STORE_ORDER.some(([f])=>!Core.same(sorted[f].filter(r=>r.sourceId!==E.SOURCE),h.data.before[f].filter(r=>r.sourceId!==E.SOURCE))))
      throw Error("canary_other_source_mutation");
    h.proof = {...common(h),freshReadonlyReopen:true,integrity:true,otherSourcesUnchanged:true,actualFormalIdentity:A.hash(sorted)};
    return advance(token,"commit_observed","readback_verified",h.proof);
  }
  function complete(token) { const h = get(token,"readback_verified"), r = advance(token,"readback_verified","completed",h.proof); release(); return r; }
  return Object.freeze({load,activateHistorical,begin,markWriteStarted,markCommitObserved,markReadbackVerified,complete,
    close: () => {}, audit: () => A.freeze({...audit,owned,healthy})});
}
function createProductionStore(...args) {
  if (args.length) throw Error("production_path_override_rejected");
  const root = Profile.resolveProductionProfile(), store = build(root, null,true);
  const {activateHistorical, ...lifecycle} = store;
  return Object.freeze({...lifecycle, activate(gateIdentity) {
    const old = require("../marketCalendarRuntime/writerSafetyReadOnly.js").createReader(root).load();
    if (old.status !== "valid" || old.envelopeVersion !== 3 || old.controlledAttemptOwned || old.safety.pendingFence ||
        old.record.controlledLifecycleAudit?.at(-1)?.phase !== "completed") throw Error("canary_production_activation_unavailable");
    return activateHistorical(old.record, gateIdentity);
  }});
}
module.exports = Object.freeze({DIRECTORY,CRASH_POINTS,createIsolatedStore,createProductionStore});
