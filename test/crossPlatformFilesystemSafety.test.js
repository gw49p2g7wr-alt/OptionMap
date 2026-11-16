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

function fileStat({ dev = 0, ino = 41, size = 8, nlink = 1, regular = true,
  symbolic = false, mode = 0o100600 } = {}) {
  return { dev, ino, size, nlink, mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    isFile: () => regular, isDirectory: () => false, isSymbolicLink: () => symbolic };
}

function windowsValidationFs(file, { after = fileStat(), reopened = fileStat({ dev: 91 }),
  final = fileStat(), realpath = file } = {}) {
  const pathStats = [after, final];
  let opens = 0, closes = 0;
  return {
    realpathSync: () => realpath,
    lstatSync: () => pathStats.shift(),
    openSync: () => { opens++; return 73; },
    fstatSync: descriptor => { assert.equal(descriptor, 73); return reopened; },
    closeSync: descriptor => { assert.equal(descriptor, 73); closes++; },
    counts: () => ({ opens, closes })
  };
}

test("WFS-3/WFS-4 platform identity keeps POSIX dev+ino strict and accepts Windows path dev zero", () => {
  const posixFile = "/OptionMap/vault/record.json", posixRoot = "/OptionMap/vault";
  assert.equal(Safety.validateSameOpenedFile({ file: posixFile, root: posixRoot,
    pathStatBefore: fileStat({ dev: 12 }), fdStat: fileStat({ dev: 12 }),
    fsApi: windowsValidationFs(posixFile, { after: fileStat({ dev: 12 }) }),
    platform: "darwin" }), true);
  assert.equal(Safety.validateSameOpenedFile({ file: posixFile, root: posixRoot,
    pathStatBefore: fileStat({ dev: 0 }), fdStat: fileStat({ dev: 12 }),
    fsApi: windowsValidationFs(posixFile, { after: fileStat({ dev: 0 }) }),
    platform: "darwin" }), false);
  const windowsFile = "C:\\OptionMap\\vault\\record.json", windowsRoot = "C:\\OptionMap\\vault";
  assert.equal(Safety.validateSameOpenedFile({ file: windowsFile, root: windowsRoot,
    pathStatBefore: fileStat({ dev: 13 }), fdStat: fileStat({ dev: 12 }),
    fsApi: windowsValidationFs(windowsFile, { reopened: fileStat({ dev: 12 }) }),
    platform: "win32" }), false);
});

test("WFS-1/WFS-2/WFS-4 Windows normal file uses a matching reopened handle identity", () => {
  const file = "C:\\OptionMap\\vault\\record.json", root = "c:\\optionmap\\vault",
    before = fileStat(), opened = fileStat({ dev: 91 }), fsApi = windowsValidationFs(file);
  assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: before,
    fdStat: opened, fsApi, platform: "win32", maxBytes: 16 }), true);
  assert.deepEqual(fsApi.counts(), { opens: 1, closes: 1 });
});

test("WFS-5/WFS-6 Windows inode mismatch or path swap rejects before acceptance", () => {
  const file = "C:\\OptionMap\\vault\\record.json", root = "C:\\OptionMap\\vault",
    opened = fileStat({ dev: 91 });
  assert.equal(Safety.validateSameOpenedFile({ file, root,
    pathStatBefore: fileStat({ ino: 40 }), fdStat: opened,
    fsApi: windowsValidationFs(file), platform: "win32" }), false);
  const swapped = windowsValidationFs(file, { after: fileStat({ ino: 42 }) });
  assert.equal(Safety.validateSameOpenedFile({ file, root,
    pathStatBefore: fileStat(), fdStat: opened, fsApi: swapped, platform: "win32" }), false);
  assert.deepEqual(swapped.counts(), { opens: 0, closes: 0 });
});

test("WFS-7/WFS-9/WFS-10/WFS-11 unsafe file facts and containment remain fail-closed", () => {
  const file = "C:\\OptionMap\\vault\\record.json", root = "C:\\OptionMap\\vault",
    opened = fileStat({ dev: 91 });
  for (const before of [fileStat({ symbolic: true }), fileStat({ nlink: 2 }),
    fileStat({ regular: false })]) assert.equal(Safety.validateSameOpenedFile({ file, root,
      pathStatBefore: before, fdStat: opened, fsApi: windowsValidationFs(file), platform: "win32" }), false);
  for (const fdStat of [fileStat({ dev: 91, nlink: 2 }), fileStat({ dev: 91, regular: false })])
    assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: fileStat(),
      fdStat, fsApi: windowsValidationFs(file), platform: "win32" }), false);
  assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: fileStat(),
    fdStat: opened, fsApi: windowsValidationFs(file, { after: fileStat({ size: 9 }) }),
    platform: "win32" }), false);
  assert.equal(Safety.validateSameOpenedFile({ file: "C:\\Other\\record.json", root,
    pathStatBefore: fileStat(), fdStat: opened,
    fsApi: windowsValidationFs("C:\\Other\\record.json"), platform: "win32" }), false);
});

test("WFS-8/WFS-4 canonical alias and reopened-handle volume mismatch reject", () => {
  const file = "C:\\OptionMap\\vault\\record.json", root = "C:\\OptionMap\\vault",
    opened = fileStat({ dev: 91 });
  assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: fileStat(),
    fdStat: opened, fsApi: windowsValidationFs(file, { realpath: "C:\\Elsewhere\\record.json" }),
    platform: "win32" }), false);
  const differentHandle = windowsValidationFs(file, { reopened: fileStat({ dev: 92 }) });
  assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: fileStat(),
    fdStat: opened, fsApi: differentHandle, platform: "win32" }), false);
  assert.deepEqual(differentHandle.counts(), { opens: 1, closes: 1 });
});

test("WFS-19 Windows reopened-handle contention fails closed without retry", () => {
  const file = "C:\\OptionMap\\vault\\record.json", root = "C:\\OptionMap\\vault";
  let attempts = 0;
  const fsApi = { realpathSync: () => file, lstatSync: () => fileStat(),
    openSync: () => { attempts++; const error = new Error("locked"); error.code = "EBUSY"; throw error; },
    fstatSync: () => { throw new Error("unreachable"); }, closeSync: () => {} };
  assert.equal(Safety.validateSameOpenedFile({ file, root, pathStatBefore: fileStat(),
    fdStat: fileStat({ dev: 91 }), fsApi, platform: "win32" }), false);
  assert.equal(attempts, 1);
});

test("canonical identity rejects aliases and directory sync has explicit platform strategies", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-fs-policy-"));
  try {
    assert.equal(Safety.canonical(root), root);
    let opened = 0, synced = 0, closed = 0;
    const posixFs = { openSync(target, flags) { assert.equal(target, "/safe"); assert.ok(flags >= 0); opened++; return 7; },
      fsyncSync(fd) { assert.equal(fd, 7); synced++; }, closeSync(fd) { assert.equal(fd, 7); closed++; } };
    const posix = Safety.syncDirectory("/safe", posixFs, "darwin");
    assert.equal(posix.strategy, "directory_fsync"); assert.equal(posix.synced, true);
    assert.deepEqual({ opened, synced, closed }, { opened: 1, synced: 1, closed: 1 });
    opened = 0; synced = 0;
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
