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
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

test("private beta package metadata preserves application identity", () => {
  assert.equal(packageJson.name, "optionmap");
  assert.equal(packageJson.version, "1.1.0-beta.2");
  assert.equal(packageJson.main, "main.js");
  assert.equal(packageJson.build.appId, "com.natsu.optionmap");
  assert.equal(packageJson.build.productName, "OptionMap");
  assert.equal(packageJson.build.nsis.oneClick, true);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.match(html, new RegExp(`OptionMap v${packageJson.version.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(html, /OptionMap v1\.0(?:<|\s)/);
});

test("Windows packaging is pinned to x64 NSIS", () => {
  assert.deepEqual(packageJson.build.win.target, [
    { target: "nsis", arch: ["x64"] }
  ]);
  assert.match(
    workflow,
    /npm run dist -- --win nsis --x64 --publish never/
  );
  assert.equal(
    packageJson.build.artifactName,
    "OptionMap-${version}-win-${arch}.${ext}"
  );
});

test("runtime files are included and development data is excluded", () => {
  const files = packageJson.build.files;
  for (const required of [
    "index.html", "main.js", "preload.js", "style.css", "js/**/*"
  ]) {
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

test("manual artifact workflow validates source before building without publishing", () => {
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  for (const command of [
    "npm ci",
    "npm test",
    "node --check main.js",
    "node --check preload.js"
  ]) {
    assert.ok(workflow.includes(`run: ${command}`), `missing check: ${command}`);
  }
  assert.match(workflow, /^permissions:\s*\n\s+contents: read$/m);
  assert.doesNotMatch(workflow, /GH_TOKEN|npm install|\bpush:/);
});

test("workflow gives the RC bundle an exact version arch and source identity", () => {
  assert.match(workflow,
    /name: OptionMap-\$\{\{ env\.APP_VERSION \}\}-win-x64-\$\{\{ env\.SHORT_SHA \}\}/);
  assert.doesNotMatch(workflow, /name: OptionMap-Windows\s*$/m);
  assert.match(workflow, /node -p "require\('\.\/package\.json'\)\.version"/);
  assert.match(workflow, /\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /retention-days: 30/);
});

test("workflow uploads only the exact installer checksum and manifest", () => {
  assert.match(workflow, /Get-FileHash[^\n]+-Algorithm SHA256/);
  for (const field of [
    "product", "version", "architecture", "commitSha", "shortSha",
    "workflowRunId", "workflowAttempt", "buildUtc", "installerFilename",
    "installerSizeBytes", "sha256", "signingStatus", "runnerOs", "nodeVersion"
  ]) {
    assert.match(workflow, new RegExp(`\\b${field}\\s*=`), `missing manifest field: ${field}`);
  }
  assert.match(workflow, /signingStatus = "unsigned"/);
  assert.match(workflow, /dist\/\$\{\{ env\.RC_INSTALLER_FILENAME \}\}/);
  assert.match(workflow, /dist\/\$\{\{ env\.RC_CHECKSUM_FILENAME \}\}/);
  assert.match(workflow, /dist\/release-manifest\.json/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, /dist\/\*\.exe/);
});

test("Security 0E5 main renderer flags remain unchanged", () => {
  const start = main.indexOf("function createWindow()");
  const end = main.indexOf("app.whenReady()", start);
  const block = main.slice(start, end);
  assert.match(block, /nodeIntegration:\s*false/);
  assert.match(block, /contextIsolation:\s*true/);
  assert.match(block, /preload:\s*path\.join\(__dirname, "preload\.js"\)/);
});
