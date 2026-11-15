"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const Rewrap = require("../js/productionAuthorityRewrap.js");
const QriStore = require("../js/qriProductionAuthority.js");
const ParticipantStore = require("../js/participantProductionAuthority.js");
const WeeklyStore = require("../js/weeklyProductionAuthority.js");
const Qri = require("../js/qriAcquisitionAuthorityContract.js");
const Participants = require("../js/participantAcquisitionAuthorityContract.js");
const Parser = require("../js/qriOptions.js");
const { rawQriHtml } = require("./fixtures/qri/rawQriPageFixture.js");

const ROOT = path.resolve(__dirname, "..");
const SECRET = Buffer.alloc(32, 37);
const legacy = Object.freeze({
  protect: bytes => Buffer.concat([Buffer.from("legacy:"), Buffer.from(bytes)]),
  unprotect: bytes => {
    const value = Buffer.from(bytes), prefix = Buffer.from("legacy:");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("legacy_only");
    return value.subarray(prefix.length);
  }
});
const canonical = Object.freeze({
  protect: bytes => Buffer.concat([Buffer.from("canonical:"), Buffer.from(bytes)]),
  unprotect: bytes => {
    const value = Buffer.from(bytes), prefix = Buffer.from("canonical:");
    if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("canonical_only");
    return value.subarray(prefix.length);
  }
});

function root(t) {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    Rewrap.TEST_PROFILE_PREFIX)));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}
function record(profile, Store, secret = SECRET, protector = legacy) {
  const encrypted = protector.protect(secret), value = Store.recordFor(encrypted.toString("base64")),
    file = path.join(profile, Store.FILE_NAME);
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return { file, bytes: fs.readFileSync(file) };
}
function migrate(profile, domain, overrides = {}) {
  return Rewrap.migrateAuthorityRecord({ domain, profile,
    protector: overrides.protector || canonical,
    legacyDecrypt: overrides.legacyDecrypt || (() => Buffer.from(SECRET)),
    ...(overrides.testHooks ? { testHooks: overrides.testHooks } : {}) });
}
function digest(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

test("RW-1 canonical authority decrypts with write0", t => {
  const profile = root(t), source = record(profile, QriStore, SECRET, canonical), before = digest(source.file);
  assert.deepEqual(migrate(profile, "qri"), { status: "canonical", writeCount: 0,
    secretEqualityVerified: true, domain: "qri" });
  assert.equal(digest(source.file), before);
});

for (const [name, domain, Store] of [["RW-2", "qri", QriStore],
  ["RW-3", "participants", ParticipantStore]]) test(`${name} legacy authority rewraps`, t => {
  const profile = root(t), source = record(profile, Store), result = migrate(profile, domain),
    after = JSON.parse(fs.readFileSync(source.file, "utf8")), secret = canonical.unprotect(
      Buffer.from(after.ciphertext, "base64"));
  assert.deepEqual(result, { status: "rewrapped", writeCount: 1,
    secretEqualityVerified: true, domain });
  assert.equal(Store.validateRecord(after), true);
  assert.equal(secret.equals(SECRET), true); secret.fill(0);
});

test("RW-4 secret equality and RW-13/RW-14 signed artifact continuity", t => {
  const integrity = "b".repeat(64);
  for (const [domain, Store, Contract] of [["qri", QriStore, Qri],
    ["participants", ParticipantStore, Participants]]) {
    const profile = root(t), source = record(profile, Store), legacyAuthority =
      Contract.createMainAuthority({ keyId: Store.KEY_ID, secret: SECRET }),
      signature = legacyAuthority.sign("continuity", integrity);
    migrate(profile, domain);
    const authority = Store.createProductionAuthority({ getUserDataPath: () => profile,
      protector: canonical, randomBytes: () => { throw new Error("rotation_forbidden"); } }).authority;
    assert.equal(authority.verify("continuity", integrity, signature), true);
    assert.notEqual(digest(source.file), crypto.createHash("sha256").update(source.bytes).digest("hex"));
  }
});

test("RW-5/RW-6 exact 32-byte legacy secret required", t => {
  const profile = root(t), source = record(profile, QriStore), before = digest(source.file);
  assert.throws(() => migrate(profile, "qri", { legacyDecrypt: () => Buffer.alloc(31) }),
    error => error.code === "authority_rewrap_unavailable" &&
      error.causeCode === "authority_legacy_decrypt_failed");
  assert.equal(digest(source.file), before);
});

test("RW-7 wrong key/domain and RW-8 unsupported recordVersion reject without overwrite", t => {
  for (const mutate of [value => { value.keyId = "wrong"; },
    value => { value.contractVersion = "future"; }]) {
    const profile = root(t), source = record(profile, QriStore), value =
      JSON.parse(fs.readFileSync(source.file, "utf8"));
    mutate(value); fs.writeFileSync(source.file, JSON.stringify(value), { mode: 0o600 });
    const before = digest(source.file);
    assert.throws(() => migrate(profile, "qri"), { code: "authority_rewrap_invalid_record" });
    assert.equal(digest(source.file), before);
  }
});

test("RW-9 canonical and legacy decrypt failure is fail-closed", t => {
  const profile = root(t), source = record(profile, QriStore), before = digest(source.file);
  assert.throws(() => migrate(profile, "qri", { legacyDecrypt: () => {
    throw new Error("legacy_failed"); } }), error => error.code === "authority_rewrap_unavailable");
  assert.equal(digest(source.file), before);
});

for (const [name, stage, code] of [["RW-10", "before_replace", "authority_rewrap_atomic_replace_failed"],
  ["RW-11", "before_readback_verify", "authority_rewrap_verify_failed"]])
  test(`${name} failure preserves original authority`, t => {
    const profile = root(t), source = record(profile, QriStore), before = digest(source.file);
    assert.throws(() => migrate(profile, "qri", { testHooks: { at(value) { if (value === stage) {
      const failure = new Error(code); failure.code = code; throw failure; } } } }), { code });
    assert.equal(digest(source.file), before);
    assert.equal(fs.readdirSync(profile).some(file => file.includes("rewrap")), false);
  });

test("RW-12 second run is idempotent write0", t => {
  const profile = root(t); record(profile, ParticipantStore);
  assert.equal(migrate(profile, "participants").status, "rewrapped");
  const file = path.join(profile, ParticipantStore.FILE_NAME), before = digest(file);
  assert.deepEqual(migrate(profile, "participants"), { status: "canonical", writeCount: 0,
    secretEqualityVerified: true, domain: "participants" });
  assert.equal(digest(file), before);
});

test("RW-15 Weekly authority is never selected or modified", t => {
  const profile = root(t);
  WeeklyStore.createProductionAuthority({ getUserDataPath: () => profile,
    protector: canonical, randomBytes: () => Buffer.from(SECRET) });
  const weeklyFile = path.join(profile, WeeklyStore.FILE_NAME), before = digest(weeklyFile);
  record(profile, QriStore); migrate(profile, "qri");
  assert.equal(digest(weeklyFile), before);
  assert.throws(() => Rewrap.contract("weekly"), { code: "authority_rewrap_invalid_record" });
});

test("RW-16/RW-18 QRI canonical remains acquisition-ready and JPX-save eligible", t => {
  const profile = root(t); record(profile, QriStore); migrate(profile, "qri");
  const authority = QriStore.createProductionAuthority({ getUserDataPath: () => profile,
    protector: canonical, randomBytes: () => { throw new Error("rotation_forbidden"); } }).authority,
    canonicalQri = Parser.parseQriOptionsPage(rawQriHtml, Qri.ACTIVE_URL),
    labels = [...new Set(canonicalQri.records.map(item => item.strike))];
  assert.equal(authority.verify("ready", "c".repeat(64),
    authority.sign("ready", "c".repeat(64))), true);
  assert.equal(Parser.validateCanonical(canonicalQri, { allowUnresolvedContracts: true }), true);
  assert.deepEqual({ labelsPopulated: labels.length > 0, usingFallback: false,
    openInterestStatus: canonicalQri.openInterestStatus, saveEligible:
      labels.length > 0 && canonicalQri.openInterestStatus === "available" },
  { labelsPopulated: true, usingFallback: false, openInterestStatus: "available",
    saveEligible: true });
});

test("RW-17 Participants canonical authority remains acquisition-ready", t => {
  const profile = root(t); record(profile, ParticipantStore); migrate(profile, "participants");
  const authority = ParticipantStore.createProductionAuthority({ getUserDataPath: () => profile,
    protector: canonical, randomBytes: () => { throw new Error("rotation_forbidden"); } }).authority,
    integrity = "d".repeat(64), signature = authority.sign("manifest", integrity);
  assert.equal(authority.verify("manifest", integrity, signature), true);
});

test("RW-NATIVE legacy-only decrypt rewraps both domains under canonical identity", t => {
  const profile = root(t), executable = require("electron"), script =
    path.join(ROOT, "scripts/productionAuthorityRewrapNative.js"), run = mode =>
      childProcess.spawnSync(executable, [script, mode, profile], { cwd: ROOT,
        encoding: "utf8", timeout: 30_000, env: { ...process.env } });
  const seeded = run("seed");
  assert.equal(seeded.status, 0, seeded.stderr);
  const migrated = run("migrate");
  assert.equal(migrated.status, 0, migrated.stderr);
  const result = JSON.parse(migrated.stdout.trim());
  assert.deepEqual([result.qriResult.status, result.participantResult.status,
    result.qriResult.secretEqualityVerified, result.participantResult.secretEqualityVerified,
    result.qriSignatureValid, result.participantsSignatureValid,
    result.secondQri.writeCount, result.secondParticipants.writeCount,
    result.weeklyUnchanged], ["rewrapped", "rewrapped", true, true, true, true, 0, 0, true]);
});
