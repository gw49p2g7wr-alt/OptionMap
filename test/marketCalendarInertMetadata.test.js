"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const path = require("node:path"), os = require("node:os"), cp = require("node:child_process");
const { createHash } = require("node:crypto");
const V = require("../js/marketCalendarRuntime/freshDayCanaryApproval.js");
const repo = path.resolve(__dirname, ".."), sha = b => createHash("sha256").update(b).digest("hex");
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-inert-metadata-"));
  const write = (p, content = "not trusted or parsed Finder bytes") => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), content);
  };
  try { return fn({ root, write }); }
  finally { fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}
for (const [id, p] of [["M1", "js/.DS_Store"], ["M2", ".DS_Store"], ["M3", "any/nested/directory/.DS_Store"]])
  test(id + " regular " + p + " is inert without reading/trusting content", () => fixture(({ root, write }) => {
    write(p, "throw new Error('must never execute'); invalid Finder format");
    const bytes = fs.readFileSync(path.join(root, p));
    assert.deepEqual(V.classifyRuntimeFiles(root, [p]), { inertMetadata: [p], runtimeOverrides: [] });
    assert.deepEqual(fs.readFileSync(path.join(root, p)), bytes);
  }));
for (const [id, p] of [["M4", "js/.ds_store"], ["M5", "js/.DS_Store.js"], ["alias", "js/foo.DS_Store"]])
  test(id + " nonexact basename rejected: " + p, () => fixture(({ root, write }) => {
    write(p); assert.deepEqual(V.classifyRuntimeFiles(root, [p]), { inertMetadata: [], runtimeOverrides: [p] });
  }));
test("M6 .DS_Store symlink rejected, even when target is a regular metadata file", () => fixture(({ root, write }) => {
  write("other/.DS_Store"); fs.mkdirSync(path.join(root, "js"));
  fs.symlinkSync("../other/.DS_Store", path.join(root, "js/.DS_Store"));
  assert.deepEqual(V.classifyRuntimeFiles(root, ["js/.DS_Store"]).runtimeOverrides, ["js/.DS_Store"]);
}));
test("metadata under a symlinked directory is rejected", () => fixture(({ root, write }) => {
  write("other/.DS_Store"); fs.symlinkSync("other", path.join(root, "alias"));
  assert.deepEqual(V.classifyRuntimeFiles(root, ["alias/.DS_Store"]).runtimeOverrides, ["alias/.DS_Store"]);
}));
test("directory / FIFO are not metadata regular files", () => fixture(({ root }) => {
  fs.mkdirSync(path.join(root, ".DS_Store"));
  assert.deepEqual(V.classifyRuntimeFiles(root, [".DS_Store"]).runtimeOverrides, [".DS_Store"]);
  fs.mkdirSync(path.join(root, "fifo"));
  cp.execFileSync("mkfifo", [path.join(root, "fifo/.DS_Store")]);
  assert.deepEqual(V.classifyRuntimeFiles(root, ["fifo/.DS_Store"]).runtimeOverrides, ["fifo/.DS_Store"]);
}));
test("outside root / traversal / absolute / missing paths reject", () => fixture(({ root, write }) => {
  write(".DS_Store");
  for (const p of ["../.DS_Store", "js/../.DS_Store", path.join(root, ".DS_Store"), "./.DS_Store", "missing/.DS_Store"])
    assert.deepEqual(V.classifyRuntimeFiles(root, [p]).runtimeOverrides, [p]);
}));
test("M7/M8 arbitrary executable/config files remain runtime overrides", () => fixture(({ root, write }) => {
  const files = ["js/override.js", "js/override.cjs", "js/override.mjs", "js/runtime.json", "preload.js", "runtime/config.json"];
  for (const p of files) write(p);
  assert.deepEqual(V.classifyRuntimeFiles(root, files), { inertMetadata: [], runtimeOverrides: files });
}));
function approvedGit(fn) {
  return fixture(({ root, write }) => {
    const git = (...args) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        GIT_AUTHOR_NAME: "Isolated fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Isolated fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
    git("init", "-b", "main");
    const criticalArtifactDigests = {};
    for (const p of V.CRITICAL_ARTIFACTS) {
      const bytes = fs.readFileSync(path.join(repo, p)); write(p, bytes); criticalArtifactDigests[p] = sha(bytes);
    }
    git("add", "--", ...V.CRITICAL_ARTIFACTS); git("commit", "-m", "isolated implementation");
    const parent = git("rev-parse", "HEAD");
    const manifest = { schemaVersion: 1, gateId: V.GATE_ID, approvedImplementationCommit: parent,
      approvedOperation: V.OPERATION, approvedSourceId: V.SOURCE, authorityVersion: 3, expectedSafetySequence: 2, criticalArtifactDigests };
    write(V.MANIFEST_PATH, JSON.stringify(manifest)); git("add", "--", V.MANIFEST_PATH); git("commit", "-m", "isolated approval");
    return fn({ root, write, git, parent });
  });
}
test("M9/M10 real approval verifier permits inert metadata and existing exclusions only", () => approvedGit(({ root, write, parent }) => {
  const before = V.verifyRepository(root); assert.equal(before.valid, true, before.reason);
  for (const p of [".DS_Store", "js/.DS_Store", "nested/.DS_Store"]) write(p);
  write(".git/info/exclude", "js/.DS_Store\n");
  write("finalgate-audit-reports/existing.json"); write("scripts/marketCalendarFedGateDPreflight.js");
  const after = V.verifyRepository(root); assert.equal(after.valid, true, after.reason);
  assert.deepEqual(after, before); assert.equal(after.approvedImplementationCommit, parent);
  write("js/override.js"); assert.equal(V.verifyRepository(root).reason, "untracked_runtime_override");
}));
test("ignored runtime JSON rejects even alongside allowed metadata", () => approvedGit(({ root, write }) => {
  write("js/.DS_Store"); write("js/runtime.json"); write(".git/info/exclude", "js/.DS_Store\njs/runtime.json\n");
  assert.equal(V.verifyRepository(root).reason, "untracked_runtime_override");
}));
test("ignored/untracked metadata symlink rejects in actual Git inventory", () => approvedGit(({ root, write }) => {
  write("js/target.json"); fs.symlinkSync("target.json", path.join(root, "js/.DS_Store"));
  write(".git/info/exclude", "js/.DS_Store\njs/target.json\n");
  assert.equal(V.verifyRepository(root).reason, "untracked_runtime_override");
}));
test("metadata does not exempt tracked modifications or expand approval scope", () => approvedGit(({ root, write }) => {
  write("js/.DS_Store"); write(V.CRITICAL_ARTIFACTS[0], "// forbidden tracked drift\n");
  assert.equal(V.verifyRepository(root).reason, "uncommitted_implementation");
}));
test("manifest schema/path/source/operation/16-artifact set are unchanged", () => {
  const old = cp.execFileSync("git", ["show", "HEAD:js/marketCalendarRuntime/freshDayCanaryApproval.js"], { cwd: repo, encoding: "utf8" });
  const module = { exports: {} };
  require("node:vm").runInNewContext(old, { module, require, Buffer, process });
  for (const key of ["MANIFEST_PATH", "GATE_ID", "OPERATION", "SOURCE", "CRITICAL_ARTIFACTS"])
    assert.equal(JSON.stringify(V[key]), JSON.stringify(module.exports[key]));
  assert.equal(V.CRITICAL_ARTIFACTS.length, 16);
  for (const p of ["scripts/marketCalendarE4fFreshDayCanary.js", "js/marketCalendarRuntime/freshDayCanaryPreflight.js",
    "js/marketCalendarRuntime/freshDayCanaryReceipt.js", "main.js", "preload.js", "js/marketCalendarHistory/formalControlledWriterCore.js"])
    assert.deepEqual(fs.readFileSync(path.join(repo, p)), cp.execFileSync("git", ["show", "HEAD:" + p], { cwd: repo }));
});
