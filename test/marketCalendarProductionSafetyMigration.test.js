"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const os = require("node:os"), Module = require("node:module");
const Adapter = require("../js/marketCalendarHistory/writerSafetyProductionMigration.js");
const Reader = require("../js/marketCalendarRuntime/writerSafetyReadOnly.js");
const Core = require("../js/marketCalendarHistory/writerSafetySourceSetAtomicCore.js");
const Store = require("../js/marketCalendarHistory/writerSafetySourceSetStore.js");
const E = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const P = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
const Historical = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const F = require("./fixtures/marketCalendar/safetySourceSetFixture.js");
const Native = require("../scripts/marketCalendarG14b0SafetyAdapterNative.js");
const adapterFor = root => Adapter.createIsolatedAdapter({ targetEnvironment: "isolated_test", userData: root, crashAt: null });
const fileFor = (root, generation, name) => path.join(root, Core.DIRECTORY, generation, "market-calendar-writer-safety", name);
async function migrated(action) { return Native.withSeed(async (root, old) => {
  const a = adapterFor(root);
  try { const r = await a.migrateSourceSet(E.requestFor(old, F.GATE)); assert.equal(r.saved, true, r.reason); return await action(root, old, r.record); }
  finally { a.close(); }
}); }
test("P1 fixed production resolver/factory with mock Electron uses only OptionMap path and explicit migration", async () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-")), root = path.join(parent, "OptionMap");
  fs.mkdirSync(root, { mode: 0o700 }); const old = Native.seed(root);
  const load = Module._load, previousType = process.type, electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  let a;
  try {
    process.type = "browser"; Object.defineProperty(process.versions, "electron", { value: "fixture", configurable: true });
    Module._load = function(id, ...rest) { return id === "electron" ? { app: { getPath: name => name === "appData" ? parent : root } } : load.call(this, id, ...rest); };
    a = Adapter.createProductionAdapter(); assert.equal(a.audit().attempted, false);
    const before = fs.readFileSync(path.join(root, Reader.RELATIVE_PATH));
    assert.equal(a.preflight(E.requestFor(old, F.GATE)).eligible, true); assert.deepEqual(fs.readFileSync(path.join(root, Reader.RELATIVE_PATH)), before);
    assert.equal(a.audit().reader.writes, 0); assert.equal(a.audit().generations.length, 0);
    const r = await a.migrateSourceSet(E.requestFor(old, F.GATE)); assert.equal(r.saved, true, r.reason);
    assert.equal(Reader.createReader(root).load().generation, "extended");
    assert.equal((await a.migrateSourceSet(E.requestFor(old, F.GATE))).reason, "migration_attempt_consumed");
    assert.deepEqual(fs.readFileSync(path.join(root, Reader.RELATIVE_PATH)), before);
  } finally {
    a?.close(); Module._load = load;
    if (previousType === undefined) delete process.type; else process.type = previousType;
    if (electron) Object.defineProperty(process.versions, "electron", electron); else delete process.versions.electron;
    fs.rmSync(parent, { recursive: true });
  }
});
test("P2/P15 production factory rejects any supplied path/options and non-native CLI", () => {
  for (const input of ["/not-a-profile", {}, { userData: "/not-a-profile" }, undefined])
    assert.throws(() => Adapter.createProductionAdapter(input), /production_path_override_rejected/);
  assert.throws(() => Adapter.createProductionAdapter(), /native_main_required/);
});
test("fixed production resolver rejects a mock userData mismatch before any filesystem access", () => {
  const load = Module._load, previous = process.type, descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  try {
    process.type = "browser"; Object.defineProperty(process.versions, "electron", { value: "fixture", configurable: true });
    Module._load = function(id, ...rest) { return id === "electron" ? { app: { getPath: n => n === "appData" ? "/not-a-profile" : "/wrong-profile" } } : load.call(this, id, ...rest); };
    assert.throws(() => Adapter.createProductionAdapter(), /production_profile_identity_invalid/);
  } finally { Module._load = load; if (previous === undefined) delete process.type; else process.type = previous;
    if (descriptor) Object.defineProperty(process.versions, "electron", descriptor); else delete process.versions.electron; }
});
test("P3 historical isolated factory/environment/path guard unchanged", () => {
  assert.deepEqual(Object.keys(Store), ["DIRECTORY", "CRASH_POINTS", "createIsolatedStore"]);
  assert.throws(() => Store.createIsolatedStore({ targetEnvironment: "production", userData: "/not-a-profile", crashAt: null }));
  assert.throws(() => adapterFor(process.cwd()), /isolated_store_path_invalid/);
  assert.throws(() => adapterFor("/Users/natsu/Library/Application Support/OptionMap"), /isolated_store_path_invalid/);
});
test("P4 legacy Envelope2 yields original historical12 material/read-only status", () => Native.withSeed((root, old) => {
  const r = Reader.createReader(root).load(); assert.equal(r.status, "valid", r.reason); assert.equal(r.generation, "legacy");
  assert.deepEqual(r.safety, Historical.safetyInput(old.safety)); assert.deepEqual(r.record, old);
  assert.equal(r.envelopeVersion, 2); assert.equal(r.sourceSetVersion, 1); assert.equal(r.permissionVersion, 1);
  assert.equal(r.audit.writes, 0); assert.equal(r.audit.handles, 0);
}));
test("P5/P9 readonly Envelope3 retains exact13/history/version pair without historical12 projection", () => migrated((root, old, next) => {
  const r = Reader.createReader(root).load(); assert.equal(r.status, "valid", r.reason);
  assert.equal(r.envelopeVersion, 3); assert.equal(r.sourceSetVersion, 2); assert.equal(r.permissionVersion, 2);
  assert.deepEqual(r.safety, next.safety); assert.equal(r.safety.sources.length, 13); assert.deepEqual(r.record.historicalRecord, old);
  assert.equal(E.validate(r.record).valid, true); assert.equal(Historical.validateEnvelope(r.record.historicalRecord).valid, true);
  assert.equal(r.writeAllowed, false); assert.equal(r.executionAllowed, false); assert.equal(r.audit.writes, 0);
}));
test("P6 unsupported future envelope never misinterpreted as legacy", () => Native.withSeed(root => {
  const file = path.join(root, Reader.RELATIVE_PATH), r = File.parse(fs.readFileSync(file, "utf8")); r.schemaVersion = 4;
  fs.writeFileSync(file, JSON.stringify(File.seal(r)), { mode: 0o600 });
  const loaded = Reader.createReader(root).load(); assert.equal(loaded.status, "corrupt"); assert.equal(loaded.reason, "safety_envelope_version_unsupported");
}));
test("P7 torn selected generation rejects without old fallback", () => migrated(root => {
  fs.unlinkSync(fileFor(root, "extended", "sequence.json"));
  const r = Reader.createReader(root).load(); assert.equal(r.status, "corrupt"); assert.equal(r.safety, null); assert.equal(r.audit.writes, 0);
}));
test("selected checkpoint schema/sequence/checksum mixing always rejects", async () => {
  for (const key of ["schemaVersion", "sequence", "stateChecksum"]) await migrated(root => {
    const file = fileFor(root, "extended", "sequence.json"), c = File.parse(fs.readFileSync(file, "utf8"));
    c[key] = key === "stateChecksum" ? F.H("wrong-state") : c[key] + 1;
    fs.writeFileSync(file, JSON.stringify(File.seal(c)), { mode: 0o600 });
    assert.equal(Reader.createReader(root).load().reason, "safety_sequence_invalid");
  });
});
test("direct schema3 in legacy path is rejected rather than interpreted as historical12", () => Native.withSeed((root, old) => {
  const next = E.migrateSourceSet(old, E.requestFor(old, F.GATE));
  fs.writeFileSync(path.join(root, Reader.RELATIVE_PATH), JSON.stringify(next), { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().reason, "safety_generation_required");
}));
test("P8 verified selected generation ignores unselected generation but not pointer tamper", () => migrated(root => {
  fs.writeFileSync(fileFor(root, "baseline", "safety.json"), "unselected corrupt", { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().status, "valid");
  const pointer = path.join(root, Core.DIRECTORY, "selection.json");
  const bad = File.parse(fs.readFileSync(pointer, "utf8")); bad.sequence++;
  fs.writeFileSync(pointer, JSON.stringify(File.seal(bad)), { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().reason, "safety_selection_mismatch");
}));
test("P10/P11/P12 exact Machinery/MOF/BOJ and manual ceilings preserved", () => migrated((root, _, next) => {
  const r = Reader.createReader(root).load(); assert.deepEqual(r.permissions, P.PERMISSIONS);
  assert.deepEqual(r.authorityCeiling, Historical.policyFor(3).global);
  for (const sourceId of P.SOURCE_IDS) for (const operation of ["startup", "manual"])
    assert.equal(P.evaluate({ ...F.candidate(next.historicalRecord, sourceId + operation, sourceId, operation), record: r.record }).writeAllowed,
      sourceId === Historical.SOURCE && operation === "startup");
  assert.equal(r.permissions.entries.find(p => p.sourceId === P.MOF).permission, "not_approved");
  assert.equal(r.permissions.entries.find(p => p.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
}));
test("P13 preflight load/eligibility is write0 and does not create a generation tree", () => Native.withSeed((root, old) => {
  const a = adapterFor(root);
  try { assert.equal(a.preflight(E.requestFor(old, F.GATE)).eligible, true); assert.equal(a.audit().attempted, false);
    assert.equal(a.audit().generations.length, 0); assert.equal(fs.existsSync(path.join(root, Core.DIRECTORY)), false);
  } finally { a.close(); }
}));
test("P14 import/factory only has no migration, automatic upgrade, setter or execution", () => Native.withSeed(root => {
  const a = adapterFor(root);
  assert.deepEqual(Object.keys(a), ["preflight", "migrateSourceSet", "close", "audit"]);
  assert.equal(a.audit().attempted, false); assert.equal(a.audit().writerExecution, 0); assert.equal(a.audit().generations.length, 0); a.close();
}));
test("renderer factory rejected before profile resolution", () => {
  const previous = process.type;
  try { process.type = "renderer"; assert.throws(() => Adapter.createProductionAdapter(), /main_side_only/); }
  finally { if (previous === undefined) delete process.type; else process.type = previous; }
});
test("pending/global suspend/stale invalid requests never prepare or mutate", async () => {
  for (const kind of ["pending", "global", "stale", "wrong_scope"]) await Native.withSeed(async (root, old) => {
    if (kind === "pending") old = F.pending(old);
    if (kind === "global") old = F.historical({ globalSuspend: true });
    if (["pending", "global"].includes(kind)) {
      fs.rmSync(path.join(root, "market-calendar-writer-safety"), { recursive: true }); Native.seed(root, old);
    }
    const a = adapterFor(root), input = E.requestFor(old, F.GATE);
    try {
      const r = await a.migrateSourceSet({ ...input, ...(kind === "stale" ? { expectedSequence: 99 } : kind === "wrong_scope" ? { addedSourceIds: [] } : {}) });
      assert.equal(r.saved, false); assert.equal(a.audit().generations.length, 0); assert.equal(fs.existsSync(path.join(root, Core.DIRECTORY)), false);
    } finally { a.close(); }
  });
});
test("invalid historical audit/new permission material rejects even with re-sealed outer checksum", () => migrated((root, _, next) => {
  const file = fileFor(root, "extended", "safety.json"), bad = structuredClone(next);
  bad.historicalRecord.transitionAudit[0].gateIdentity = F.H("tampered");
  fs.writeFileSync(file, JSON.stringify(File.seal(bad)), { mode: 0o600 });
  const r = Reader.createReader(root).load(); assert.equal(r.status, "corrupt"); assert.equal(r.record, null);
}));
test("symlink pointer/parent paths and arbitrary generation names fail closed", () => migrated(root => {
  const pointer = path.join(root, Core.DIRECTORY, "selection.json"), original = fs.readFileSync(pointer);
  fs.unlinkSync(pointer); fs.symlinkSync(path.join(root, Reader.RELATIVE_PATH), pointer);
  assert.equal(Reader.createReader(root).load().status, "corrupt");
  fs.unlinkSync(pointer); const bad = File.parse(original.toString("utf8")); bad.generation = "../escape";
  fs.writeFileSync(pointer, JSON.stringify(File.seal(bad)), { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().reason, "safety_selection_invalid");
}));
test("unpublished preparation falls back only to verified original; never repaired/adopted", () => Native.withSeed((root, old) => {
  fs.mkdirSync(path.join(root, Core.DIRECTORY), { mode: 0o700 });
  fs.writeFileSync(path.join(root, Core.DIRECTORY, "selection.tmp"), "partial", { mode: 0o600 });
  assert.deepEqual(Reader.createReader(root).load().record, old);
  const a = adapterFor(root); try { assert.equal(a.preflight(E.requestFor(old, F.GATE)).reason, "source_set_preparation_exists"); }
  finally { a.close(); }
}));
test("bad published JSON/checksum never falls back even though retained original is valid", async () => {
  for (const body of ["{", "{}", JSON.stringify({ schemaVersion: 1, generation: "baseline", sequence: 2,
    stateChecksum: F.H("state"), checksum: F.H("wrong") })]) await migrated(root => {
    fs.writeFileSync(path.join(root, Core.DIRECTORY, "selection.json"), body, { mode: 0o600 });
    const loaded = Reader.createReader(root).load(); assert.equal(loaded.status, "corrupt"); assert.equal(loaded.record, null);
  });
});
test("a selected generation symlink cannot hide behind the fixed pointer", () => migrated(root => {
  const parent = path.join(root, Core.DIRECTORY, "extended"), moved = path.join(root, Core.DIRECTORY, "moved");
  fs.renameSync(parent, moved); fs.symlinkSync(moved, parent);
  assert.equal(Reader.createReader(root).load().reason, "safety_directory_invalid");
}));
test("legacy missing checkpoint is corrupt, not a missing safety state", () => Native.withSeed(root => {
  fs.unlinkSync(path.join(root, "market-calendar-writer-safety", "sequence.json"));
  assert.equal(Reader.createReader(root).load().status, "corrupt");
}));
test("duplicate migration from fresh adapter is rejected and cannot rewrite extended state", () => migrated(async (root, old) => {
  const a = adapterFor(root), before = fs.readFileSync(fileFor(root, "extended", "safety.json"));
  try { assert.equal((await a.migrateSourceSet(E.requestFor(old, F.GATE))).saved, false); assert.equal(a.audit().generations.length, 0); }
  finally { a.close(); }
  assert.deepEqual(fs.readFileSync(fileFor(root, "extended", "safety.json")), before);
}));
test("ownership conflict on retained pair blocks migration and never selects schema3", () => Native.withSeed(async (root, old) => {
  const Atomic = require("../js/marketCalendarHistory/writerSafetyAtomicCore.js"), owner = Atomic.create(path.join(root, Atomic.DIRECTORY));
  owner.acquire(); const a = adapterFor(root);
  try { assert.equal((await a.migrateSourceSet(E.requestFor(old, F.GATE))).saved, false); assert.equal(a.audit().generations.length, 0); }
  finally { a.close(); owner.close(); }
  assert.equal(Reader.createReader(root).load().envelopeVersion, 2);
}));
test("migration prep race cannot publish against changed legacy pair", () => Native.withSeed(async (root, old) => {
  const a = adapterFor(root), promise = a.migrateSourceSet(E.requestFor(old, F.GATE));
  const changed = F.historical({ cycles: 1 }), directory = path.join(root, "market-calendar-writer-safety");
  fs.writeFileSync(path.join(directory, "safety.json"), JSON.stringify(changed), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "sequence.json"), JSON.stringify(File.seal({ schemaVersion: 2,
    sequence: changed.safety.sequence, stateChecksum: changed.checksum })), { mode: 0o600 });
  try { const r = await promise; assert.equal(r.saved, false); assert.equal(r.reason, "source_set_precondition_stale");
    assert.equal(fs.existsSync(path.join(root, Core.DIRECTORY, "extended")), false);
  } finally { a.close(); }
  assert.equal(Reader.createReader(root).load().reason, "safety_retained_baseline_changed");
}));
test("retained legacy drift rejects instead of silently accepting stale generation", () => migrated(root => {
  const file = path.join(root, Reader.RELATIVE_PATH), changed = F.historical({ cycles: 1 });
  fs.writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
  fs.writeFileSync(path.join(path.dirname(file), "sequence.json"), JSON.stringify(File.seal({ schemaVersion: 2,
    sequence: changed.safety.sequence, stateChecksum: changed.checksum })), { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().reason, "safety_retained_baseline_changed");
}));
test("retained pair update intent remains blocked; only migration ownership lock is tolerated", () => migrated(root => {
  fs.writeFileSync(path.join(root, "market-calendar-writer-safety", "update.intent"), "{}", { mode: 0o600 });
  assert.equal(Reader.createReader(root).load().reason, "safety_io_interrupted_or_owned");
}));
test("selected generation sequence rollback rejects in same reader", () => migrated((root, old) => {
  const reader = Reader.createReader(root); assert.equal(reader.load().status, "valid");
  const pointer = path.join(root, Core.DIRECTORY, "selection.json");
  fs.writeFileSync(pointer, JSON.stringify(File.seal({ schemaVersion: 1, generation: "baseline", sequence: old.safety.sequence,
    stateChecksum: old.checksum })), { mode: 0o600 });
  assert.equal(reader.load().reason, "safety_sequence_invalid");
}));
test("native adapter crash/restart eight migration plus eight adoption points select only valid old/new", async () => {
  const r = await Native.nativeAcceptance(); assert.equal(r.status, "PASS"); assert.equal(r.crashes.length, 16);
  assert.equal(r.crashes.filter(c => c.selected === "extended").length, 1);
  assert.equal(r.cleanup.tempProfiles, 0); assert.equal(r.cleanup.handles, 0); assert.equal(r.cleanup.children, 0);
});
