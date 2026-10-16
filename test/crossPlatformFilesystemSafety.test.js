"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Safety = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Profile = require("../js/marketCalendarHistory/writerSafetyInitialProvisioning.js");
const G14b = require("../scripts/marketCalendarG14bFilesystemGuard.js");
const G15b1 = require("../scripts/marketCalendarG15b1FilesystemGuard.js");

test("platform path identity is case-sensitive on POSIX and Windows-normalized on win32", () => {
  assert.equal(Safety.samePath("/A/file", "/a/file", "darwin"), false);
  assert.equal(Safety.samePath("C:\\Users\\Name\\FILE", "c:\\users\\name\\file", "win32"), true);
  assert.equal(Safety.contains("C:\\Users\\Name", "c:\\users\\name\\store\\x", "win32"), true);
  assert.equal(Safety.contains("C:\\Users\\Name", "D:\\Users\\Name\\store", "win32"), false);
  assert.equal(Safety.contains("C:\\Users\\Name", "C:\\Users\\Other", "win32"), false);
});

test("POSIX permission checks remain strict while Windows does not use synthetic mode as proof", () => {
  const file = mode => ({ mode, uid: typeof process.getuid === "function" ? process.getuid() : 0, nlink: 1,
    size: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
  assert.equal(Safety.secureFileStat(file(0o100600), { platform: "darwin" }), true);
  assert.equal(Safety.secureFileStat(file(0o100666), { platform: "darwin" }), false);
  assert.equal(Safety.secureFileStat(file(0o100666), { platform: "win32" }), true);
  assert.equal(Safety.secureFileStat({ ...file(0o100600), nlink: 2 }, { platform: "win32" }), false);
});

test("canonical identity rejects aliases and directory sync has explicit platform strategies", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-fs-policy-"));
  try {
    assert.equal(Safety.canonical(root), root);
    const posix = Safety.syncDirectory(root, fs, "darwin");
    assert.equal(posix.strategy, "directory_fsync"); assert.equal(posix.synced, true);
    let opened = 0, synced = 0;
    const windowsFs = { openSync() { opened++; }, fsyncSync() { synced++; }, closeSync() {} };
    assert.deepEqual(Safety.syncDirectory("C:\\safe", windowsFs, "win32"),
      { strategy: "file_sync_publish_readback", synced: false });
    assert.equal(opened, 0); assert.equal(synced, 0);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("Windows production profile authority accepts only the direct main-owned OptionMap userData", () => {
  const valid = { getPath: name => name === "appData" ? "C:\\Users\\Natsu\\AppData\\Roaming" :
    "c:\\users\\natsu\\appdata\\roaming\\optionmap" };
  assert.deepEqual(Profile.productionProfileAuthority(valid, "win32"), {
    fixed: "c:\\users\\natsu\\appdata\\roaming\\optionmap",
    userData: "c:\\users\\natsu\\appdata\\roaming\\optionmap"
  });
  for (const userData of ["D:\\OptionMap", "C:\\Users\\Natsu\\AppData\\Other\\OptionMap",
    "C:\\Users\\Natsu\\AppData\\Roaming\\OtherApp", "relative\\OptionMap"]) {
    const app = { getPath: name => name === "appData" ? "C:\\Users\\Natsu\\AppData\\Roaming" : userData };
    assert.throws(() => Profile.productionProfileAuthority(app, "win32"), /production_profile_identity_invalid/);
  }
});

test("G14b Windows authority derives the same canonical main-owned profile without Seatbelt substitution", () => {
  const app = { getPath: name => name === "appData" ? "C:\\Users\\Natsu\\AppData\\Roaming" :
    "C:\\Users\\Natsu\\AppData\\Roaming\\OptionMap" };
  assert.deepEqual(G14b.windowsMainAuthority(app), {
    profile: "C:\\Users\\Natsu\\AppData\\Roaming\\OptionMap",
    parents: ["C:\\Users\\Natsu\\AppData", "C:\\Users\\Natsu\\AppData\\Roaming"]
  });
  assert.throws(() => G14b.windowsMainAuthority({ getPath: name => name === "appData" ?
    "C:\\Users\\Natsu\\AppData\\Roaming" : "D:\\OptionMap" }), /migration_guard_windows_profile_invalid/);
  assert.throws(() => G14b.createWindowsMainPolicy(), /migration_guard_windows_main_required/);
});

test("G15b1 fixture applies the shared canonical Windows path contract without package authority", () => {
  const root = "C:\\Users\\Natsu\\AppData\\Roaming\\OptionMap";
  const policy = G15b1.bindResolvedProfile(root);
  assert.equal(policy.profile, root);
  assert.deepEqual(policy.parents, ["C:\\Users\\Natsu\\AppData", "C:\\Users\\Natsu\\AppData\\Roaming"]);
  assert.equal(policy.permits(`${root}\\market-calendar-writer-safety\\safety.json`, "readFileSync"), true);
  assert.equal(policy.permits(`${root}\\market-calendar-mof-startup-canary`, "lstatSync"), true);
  assert.equal(policy.permits(`${root}\\..\\OtherApp`, "lstatSync"), false);
});
