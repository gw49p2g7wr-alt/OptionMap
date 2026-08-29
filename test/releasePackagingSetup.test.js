const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/build.yml"),
  "utf8"
);

test("private beta package metadata preserves application identity", () => {
  assert.equal(packageJson.name, "optionmap");
  assert.equal(packageJson.version, "1.1.0-beta.1");
  assert.equal(packageJson.main, "main.js");
  assert.equal(packageJson.build.appId, "com.natsu.optionmap");
  assert.equal(packageJson.build.productName, "OptionMap");
  assert.equal(packageJson.build.nsis.oneClick, true);
  assert.equal(packageJson.build.nsis.perMachine, false);
});

test("Windows packaging is pinned to x64 NSIS", () => {
  assert.deepEqual(packageJson.build.win.target, [
    { target: "nsis", arch: ["x64"] }
  ]);
  assert.match(
    workflow,
    /npm run dist -- --win nsis --x64 --publish never/
  );
});

test("runtime files are included and development data is excluded", () => {
  const files = packageJson.build.files;
  for (const required of ["index.html", "main.js", "style.css", "js/**/*"]) {
    assert.ok(files.includes(required), `missing runtime pattern: ${required}`);
  }
  for (const excluded of [
    "!js/script2026807.js",
    "!js/script_v0.92.js",
    "!.env",
    "!.env.*",
    "!test{,/**/*}",
    "!.github{,/**/*}",
    "!docs{,/**/*}",
    "!README*",
    "!ROADMAP*",
    "!IDEAS*",
    "!OptionMap.code-workspace",
    "!data{,/**/*}",
    "!dist{,/**/*}",
    "!**/.DS_Store"
  ]) {
    assert.ok(files.includes(excluded), `missing exclusion: ${excluded}`);
  }
});

test("manual artifact workflow uses reproducible install without publishing", () => {
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /- run: npm ci/);
  assert.match(workflow, /name: OptionMap-Windows/);
  assert.match(workflow, /path: dist\/\*\.exe/);
  assert.doesNotMatch(workflow, /GH_TOKEN|npm install|\bpush:/);
});
