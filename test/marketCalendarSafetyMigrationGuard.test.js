"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const Guard = require("../scripts/marketCalendarG14bFilesystemGuard.js");
const REPO = path.resolve(__dirname, "..");
function fixture(action) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-g14bg-fixture-"));
  try {
    const policy = Guard.createIsolatedPolicy({ targetEnvironment: "isolated_test", fixtureRoot: root });
    fs.mkdirSync(policy.profile, { recursive: true, mode: 0o700 });
    fs.mkdirSync(policy.parents[1] + "/SiblingApp", { mode: 0o700 });
    fs.writeFileSync(policy.parents[1] + "/unrelated.json", "{}", { mode: 0o600 });
    return action(policy, root);
  } finally { fs.rmSync(root, { recursive: true }); }
}
function mockedAdapter(policy, action, useGuard = true) {
  const Module = require("node:module"), Adapter = require("../js/marketCalendarHistory/writerSafetyProductionMigration.js");
  const metadata = policy.scopedMetadataFs(), old = { load: Module._load, type: process.type, version: Object.getOwnPropertyDescriptor(process.versions, "electron"),
    lstat: fs.lstatSync, stat: fs.statSync, realpath: fs.realpathSync };
  let adapter;
  try {
    if (useGuard) { fs.lstatSync = metadata.lstatSync; fs.statSync = metadata.statSync; fs.realpathSync = metadata.realpathSync; }
    process.type = "browser"; Object.defineProperty(process.versions, "electron", { value: "isolated-fixture", configurable: true });
    Module._load = function(id, ...args) { return id === "electron" ? { app: { getPath: name => name === "appData" ? policy.parents[1] : policy.profile } } : old.load.call(this, id, ...args); };
    adapter = Adapter.createProductionAdapter(); return action(adapter, metadata);
  } finally {
    adapter?.close(); Module._load = old.load; fs.lstatSync = old.lstat; fs.statSync = old.stat; fs.realpathSync = old.realpath;
    if (old.type === undefined) delete process.type; else process.type = old.type;
    if (old.version) Object.defineProperty(process.versions, "electron", old.version); else delete process.versions.electron;
  }
}
test("G1 exact fixed production parent identities; policy construction has no filesystem probe", () => {
  const p = Guard.createProductionPolicy(); assert.deepEqual(p.parents, Guard.PRODUCTION_PARENTS); assert.deepEqual(p.parentOperations, ["lstatSync"]);
  assert.equal(p.profile, Guard.PRODUCTION_PROFILE);
});
test("G2 parent lstat permitted; unmeasured parent stat/realpath are not broadened", () => {
  const p = Guard.createProductionPolicy(); for (const parent of p.parents) {
    assert(p.permits(parent, "lstatSync")); assert(!p.permits(parent, "statSync")); assert(!p.permits(parent, "realpathSync"));
  }
});
test("G3 parent enumeration/read/open/glob/find/watch are denied", () => {
  const p = Guard.createProductionPolicy(); for (const parent of p.parents) for (const op of ["readdirSync", "opendirSync", "readFileSync", "openSync", "globSync", "find", "watch"])
    assert.throws(() => p.assertAccess(parent, op), /migration_guard_access_denied/);
});
test("G4 sibling app metadata and content are denied", () => {
  const p = Guard.createProductionPolicy(); for (const suffix of ["SiblingApp", "SiblingApp/safety.json"]) for (const op of ["lstatSync", "realpathSync", "readFileSync", "openSync"])
    assert(!p.permits(p.parents[1] + "/" + suffix, op));
});
test("G5 unrelated Application Support file remains denied", () => {
  const p = Guard.createProductionPolicy(); assert(!p.permits(p.parents[1] + "/unrelated.json", "readFileSync"));
});
test("G6 home root, arbitrary path, URL, relative and traversal aliases reject", () => {
  const p = Guard.createProductionPolicy(); for (const target of ["/Users/natsu", "/arbitrary/path", "relative", "file://" + p.profile, p.profile + "/../SiblingApp", p.profile + "/./market-calendar-writer-safety/safety.json", p.profile + "\0"])
    for (const op of ["lstatSync", "readFileSync", "openSync"]) assert(!p.permits(target, op));
});
test("G7 production factory cannot receive path/scope override", () => {
  for (const value of [undefined, "/tmp", {}, { profile: "/tmp" }]) assert.throws(() => Guard.createProductionPolicy(value), /production_override_rejected/);
});
test("G8 fixed safety files only; arbitrary child and Runtime/Formal data denied", () => {
  const p = Guard.createProductionPolicy(); assert(p.permits(p.profile + "/market-calendar-writer-safety/safety.json", "readFileSync"));
  for (const suffix of ["IndexedDB", "Local Storage", "market-calendar-runtime-state/state.json", "market-calendar-writer-safety/extra.json", "market-calendar-source-set-safety/arbitrary/safety.json"])
    assert(!p.permits(p.profile + "/" + suffix, "readFileSync"));
});
test("G9 parent writes and retained legacy state replacement denied", () => {
  const p = Guard.createProductionPolicy(); for (const parent of p.parents) assert(!p.permits(parent, "mkdirSync", true));
  for (const name of ["safety.json", "sequence.json"]) assert(!p.permits(p.profile + "/market-calendar-writer-safety/" + name, "writeFileSync", true));
});
test("G10 fixture factory rejects production/non-temp/symlink input before content read", () => {
  for (const value of [{ targetEnvironment: "production", fixtureRoot: Guard.PRODUCTION_PROFILE }, { targetEnvironment: "isolated_test", fixtureRoot: Guard.PRODUCTION_PROFILE },
    { targetEnvironment: "isolated_test", fixtureRoot: "/unrelated" }, { targetEnvironment: "isolated_test", fixtureRoot: "/tmp", extra: true }])
    assert.throws(() => Guard.createIsolatedPolicy(value), /migration_guard_fixture_invalid/);
});
test("G11 isolated resolver/adapter factory succeeds, with migration/read/write zero", () => fixture(p => mockedAdapter(p, (a, m) => {
  const audit = a.audit(); assert.equal(audit.attempted, false); assert.equal(audit.reader.loads, 0); assert.equal(audit.reader.reads, 0);
  assert.equal(audit.reader.writes, 0); assert.equal(audit.writerExecution, 0); assert.deepEqual(audit.generations, []);
  assert(m.audit().some(x => x.path === p.profile && x.operation === "realpathSync"));
})));
test("G12 Library symlink escape rejects before target resolution", () => fixture(p => {
  fs.renameSync(p.parents[0], p.parents[0] + "-retained"); fs.symlinkSync(p.parents[0] + "-retained", p.parents[0]);
  assert.throws(() => mockedAdapter(p, () => assert.fail()), /migration_guard_symlink_rejected/);
}));
test("G13 Application Support symlink escape rejects", () => fixture(p => {
  fs.renameSync(p.parents[1], p.parents[1] + "-retained"); fs.symlinkSync(p.parents[1] + "-retained", p.parents[1]);
  assert.throws(() => mockedAdapter(p, () => assert.fail()), /migration_guard_symlink_rejected/);
}));
test("G14 profile symlink escape rejects", () => fixture(p => {
  fs.renameSync(p.profile, p.profile + "-retained"); fs.symlinkSync(p.profile + "-retained", p.profile);
  assert.throws(() => mockedAdapter(p, () => assert.fail()), /migration_guard_symlink_rejected/);
}));
test("G15 safety child symlink rejects before content read", () => fixture(p => {
  const d = p.profile + "/market-calendar-writer-safety"; fs.mkdirSync(d, { mode: 0o700 });
  fs.symlinkSync(p.parents[1] + "/unrelated.json", d + "/safety.json");
  assert.throws(() => p.scopedMetadataFs().statSync(d + "/safety.json"), /migration_guard_symlink_rejected/);
}));
test("G16 fake resolved target mismatch rejects", () => fixture(p => {
  const facade = p.scopedMetadataFs({ lstatSync: fs.lstatSync, statSync: fs.statSync, realpathSync: () => p.parents[1] + "/SiblingApp" });
  assert.throws(() => facade.realpathSync(p.profile), /migration_guard_resolved_path_mismatch/);
}));
test("G17 measured Node realpath internals need lstat on exactly both parents, not data/enumeration", () => fixture(p => {
  const binding = process.binding("fs"), original = Object.fromEntries(["lstat", "stat", "readlink", "readdir", "open"].map(k => [k, binding[k]])), touches = [];
  try {
    for (const k of Object.keys(original)) binding[k] = function(target, ...args) { if (p.parents.includes(String(target))) touches.push({ operation: k, path: String(target) }); return original[k].call(this, target, ...args); };
    // Trace the unchanged resolver without our additional symlink checks, so
    // the measured parent operations are the actual resolver's own demand.
    mockedAdapter(p, a => assert.equal(a.audit().attempted, false), false);
  } finally { for (const [k, fn] of Object.entries(original)) binding[k] = fn; }
  assert.deepEqual([...new Set(touches.map(x => x.path))].sort(), [...p.parents].sort()); assert(touches.length >= 2);
  assert(touches.every(x => x.operation === "lstat"));
}));
test("G18 scoped metadata facade rejects enumeration/arbitrary access without calling underlying IO", () => fixture(p => {
  let calls = 0; const fake = { lstatSync: () => { calls++; }, statSync: () => { calls++; }, realpathSync: () => { calls++; } };
  const m = p.scopedMetadataFs(fake); assert.throws(() => m.lstatSync(p.parents[1] + "/SiblingApp"), /access_denied/);
  assert.throws(() => m.statSync(p.parents[0]), /access_denied/); assert.equal(calls, 0); assert.equal(m.readdirSync, undefined);
}));
test("G19 generated OS rules separate exact metadata parents from data permissions", () => {
  const p = Guard.createProductionPolicy(), profile = p.seatbeltProfile();
  assert(profile.includes("(deny file-read-data")); assert(profile.includes("(deny file-read-metadata"));
  const data = profile.slice(profile.indexOf("(deny file-read-data (require-all"), profile.indexOf("(deny file-read-metadata"));
  for (const parent of p.parents) assert(!data.includes(`(require-not (literal ${JSON.stringify(parent)}))`));
  assert(!profile.includes(`(allow file-read* (subpath ${JSON.stringify(p.parents[0])}))`));
});
test("G20 actual macOS sandbox: isolated resolver works; raw parent enumeration/sibling data remain blocked", { skip: process.platform !== "darwin" }, () => fixture((p, root) => {
  const sandbox = root + "/scope.sb", entry = root + "/entry.cjs"; fs.writeFileSync(sandbox, p.seatbeltProfile(), { mode: 0o600 });
  const code = `"use strict";
const fs=require("node:fs"),Module=require("node:module"),assert=require("node:assert/strict");
const Guard=require(${JSON.stringify(REPO + "/scripts/marketCalendarG14bFilesystemGuard.js")});
const Adapter=require(${JSON.stringify(REPO + "/js/marketCalendarHistory/writerSafetyProductionMigration.js")});
const p=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:${JSON.stringify(root)}});
const m=p.scopedMetadataFs(),old={lstat:fs.lstatSync,stat:fs.statSync,realpath:fs.realpathSync,load:Module._load};
const binding=process.binding("fs"),original=binding.lstat,observed=[];
binding.lstat=function(target,...args){if(p.parents.includes(String(target)))observed.push({path:String(target),operation:"lstat"});return original.call(this,target,...args);};
fs.lstatSync=m.lstatSync;fs.statSync=m.statSync;fs.realpathSync=m.realpathSync;
process.type="browser";Object.defineProperty(process.versions,"electron",{value:"isolated",configurable:true});
Module._load=function(id,...args){return id==="electron"?{app:{getPath:n=>n==="appData"?p.parents[1]:p.profile}}:old.load.call(this,id,...args);};
const a=Adapter.createProductionAdapter();assert.equal(a.audit().attempted,false);assert.equal(a.audit().reader.loads,0);a.close();
fs.lstatSync=old.lstat;fs.statSync=old.stat;fs.realpathSync=old.realpath;binding.lstat=original;Module._load=old.load;
for(const parent of p.parents)assert.throws(()=>fs.readdirSync(parent),e=>["EPERM","EACCES"].includes(e.code));
assert.throws(()=>fs.lstatSync(p.parents[1]+"/SiblingApp"),e=>["EPERM","EACCES"].includes(e.code));
assert.throws(()=>fs.readFileSync(p.parents[1]+"/unrelated.json"),e=>["EPERM","EACCES"].includes(e.code));
assert.deepEqual([...new Set(observed.map(x=>x.path))].sort(),[...p.parents].sort());
console.log(JSON.stringify({adapterCreation:"PASS",parentOperations:[...new Set(observed.map(x=>x.operation))],parentCount:2,migration:0,readerLoads:0,productionAccess:0,enumerationRejected:2,siblingRejected:true}));
`;
  fs.writeFileSync(entry, code, { mode: 0o600 });
  const child = cp.spawnSync("/usr/bin/sandbox-exec", ["-f", sandbox, process.execPath, entry], { cwd: REPO, encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || String(child.error)); const result = JSON.parse(child.stdout.trim());
  assert.equal(result.adapterCreation, "PASS"); assert.deepEqual(result.parentOperations, ["lstat"]); assert.equal(result.migration, 0);
}));
test("G21 original parent-metadata denial reproduces resolver EPERM in isolated OS sandbox", { skip: process.platform !== "darwin" }, () => fixture((p, root) => {
  const sandbox = root + "/old-scope.sb", entry = root + "/old-entry.cjs";
  fs.writeFileSync(sandbox, p.seatbeltProfile().replace(`(require-not (literal ${JSON.stringify(p.parents[0])}))\n`, ""), { mode: 0o600 });
  fs.writeFileSync(entry, `const fs=require("node:fs"),Module=require("node:module"),assert=require("node:assert/strict");
const resolve=require(${JSON.stringify(REPO + "/js/marketCalendarHistory/writerSafetyInitialProvisioning.js")}).resolveProductionProfile;
const old=Module._load;process.type="browser";Object.defineProperty(process.versions,"electron",{value:"fixture",configurable:true});
Module._load=function(id,...args){return id==="electron"?{app:{getPath:n=>n==="appData"?${JSON.stringify(p.parents[1])}:${JSON.stringify(p.profile)}}}:old.call(this,id,...args);};
assert.throws(()=>resolve(),e=>["EPERM","EACCES"].includes(e.code)&&e.path===${JSON.stringify(p.parents[0])});
console.log("isolated-parent-metadata-rejection-confirmed");`, { mode: 0o600 });
  const child = cp.spawnSync("/usr/bin/sandbox-exec", ["-f", sandbox, process.execPath, entry], { cwd: REPO, encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || String(child.error)); assert.match(child.stdout, /parent-metadata-rejection-confirmed/);
}));
test("G22 ancestor symlink cannot redirect fixed parent checks into another tree", () => fixture((p, root) => {
  fs.renameSync(root + "/Users", root + "/Users-retained"); fs.symlinkSync(root + "/Users-retained", root + "/Users");
  assert.throws(() => mockedAdapter(p, () => assert.fail()), /migration_guard_symlink_rejected/);
}));
