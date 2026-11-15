"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Builder = require("../scripts/buildPreloadBundle.js");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "preload.bundle.js");
const EXPECTED_MODULES = Object.freeze([
  "preload.js",
  "js/participantFormalBridgeContract.js",
  "js/participantFormalProductionWriter.js",
  "js/formalArchive/participantFormalArchiveSchema.js",
  "js/participantData.js"
]);

function sourceMap(lineEnding) {
  return new Map(EXPECTED_MODULES.map(file => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n?/g, "\n");
    return [file, source.replace(/\n/g, lineEnding)];
  }));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function copyFixtureFile(fromRoot, toRoot, file) {
  const target = path.join(toRoot, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(fromRoot, file), target);
}

function run(command, args, cwd, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options
  });
}

test("PLF-1/2/3 logical LF, CRLF and CR sources produce byte-identical bundles", () => {
  const bundles = ["\n", "\r\n", "\r"].map(lineEnding => {
    const sources = sourceMap(lineEnding);
    return Builder.buildBundle(file => sources.get(file));
  });
  assert.equal(bundles[0], bundles[1]);
  assert.equal(bundles[0], bundles[2]);
  assert.equal(bundles[0], fs.readFileSync(OUTPUT, "utf8"));
});

test("PLF-4/5 generated artifact is UTF-8 without BOM, LF-only and trailing LF", () => {
  const output = fs.readFileSync(OUTPUT);
  assert.equal(output.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(output.includes(Buffer.from("\r")), false);
  assert.equal(output.at(-1), 0x0a);
  assert.equal(Buffer.from(output.toString("utf8"), "utf8").equals(output), true);
  assert.equal(sha256(output), sha256(Buffer.from(Builder.buildBundle(), "utf8")));
});

test("PLF-6/7 fixed module order and slash-normalized IDs remain unchanged", () => {
  assert.deepEqual(Builder.MODULE_FILES, EXPECTED_MODULES);
  assert.equal(Builder.moduleId("js\\participantData.js", "\\"), "./js/participantData.js");
  assert.equal(Builder.moduleId("js/participantData.js", "/"), "./js/participantData.js");
  const output = Builder.buildBundle();
  const moduleIds = [...output.matchAll(/^\s*"([^"]+)": function\(module, exports, require\)/gm)]
    .map(match => match[1]);
  assert.deepEqual(moduleIds, EXPECTED_MODULES.map(file => `./${file}`));
  assert.equal(moduleIds.some(id => id.includes("\\")), false);
  assert.doesNotMatch(output, /[A-Za-z]:\\/);
});

test("PLF-8/9 Windows-style checkout reproduces the artifact and rejects logical drift", t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "optionmap-preload-lf-"));
  const repository = path.join(fixtureRoot, "repository");
  const checkout = path.join(fixtureRoot, "checkout");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(repository);
  for (const file of [".gitattributes", "scripts/buildPreloadBundle.js", ...EXPECTED_MODULES])
    copyFixtureFile(ROOT, repository, file);

  assert.equal(run(process.execPath, ["scripts/buildPreloadBundle.js"], repository).status, 0);
  assert.equal(run("git", ["init", "--quiet"], repository).status, 0);
  assert.equal(run("git", ["config", "user.email", "fixture@optionmap.invalid"], repository).status, 0);
  assert.equal(run("git", ["config", "user.name", "OptionMap Fixture"], repository).status, 0);
  assert.equal(run("git", ["add", "."], repository).status, 0);
  assert.equal(run("git", ["commit", "--quiet", "-m", "fixture"], repository).status, 0);
  const clone = run("git", ["clone", "--quiet", "--no-hardlinks", "-c", "core.autocrlf=true",
    repository, checkout], fixtureRoot);
  assert.equal(clone.status, 0, clone.stderr);

  const checkedBundle = fs.readFileSync(path.join(checkout, "preload.bundle.js"));
  const checkedSource = fs.readFileSync(path.join(checkout, "preload.js"));
  assert.equal(checkedBundle.includes(Buffer.from("\r")), false);
  assert.equal(checkedSource.includes(Buffer.from("\r\n")), true);
  const check = run(process.execPath, ["scripts/buildPreloadBundle.js", "--check"], checkout);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(sha256(checkedBundle), sha256(fs.readFileSync(OUTPUT)));

  fs.appendFileSync(path.join(checkout, "preload.js"), "\r\n// logical drift\r\n");
  const stale = run(process.execPath, ["scripts/buildPreloadBundle.js", "--check"], checkout);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /preload\.bundle\.js is missing or stale/);
});

test("PLF-8 effective Git attributes force only the generated artifact to LF", () => {
  const result = childProcess.execFileSync("git", ["check-attr", "text", "eol", "--",
    "preload.bundle.js"], { cwd: ROOT, encoding: "utf8" });
  assert.match(result, /preload\.bundle\.js: text: set/);
  assert.match(result, /preload\.bundle\.js: eol: lf/);
});
