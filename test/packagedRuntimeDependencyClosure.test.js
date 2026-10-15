"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { listPackage } = require("@electron/asar");
const { minimatch } = require("minimatch");

const root = path.resolve(__dirname, "..");
const metadata = require("../package.json");
const tracked = new Set(childProcess.execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8"
}).split("\0").filter(Boolean));

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function resolveLocal(from, request) {
  if (!request.startsWith(".")) return null;
  const target = path.resolve(path.dirname(from), request);
  for (const candidate of [target, `${target}.js`, `${target}.json`, path.join(target, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw Error(`unresolved runtime dependency: ${relative(from)} -> ${request}`);
}

function runtimeClosure() {
  const pending = [path.join(root, "main.js"), path.join(root, "preload.js")];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
    if (!/^(?:https?:|data:)/.test(match[1])) pending.push(path.resolve(root, match[1]));
  }
  const visited = new Set(), assets = new Set(["index.html"]);
  while (pending.length) {
    const file = pending.pop();
    const name = relative(file);
    if (visited.has(name)) continue;
    assert.ok(tracked.has(name), `runtime dependency is not tracked: ${name}`);
    visited.add(name);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const dependency = resolveLocal(file, match[1]);
      if (dependency) pending.push(dependency);
    }
    for (const match of source.matchAll(/["']((?:scripts\/|js\/)[^"']+\.(?:html|json|wasm))["']/g)) {
      const asset = match[1];
      if (tracked.has(asset)) assets.add(asset);
    }
  }
  return new Set([...visited, ...assets]);
}

function configured(file) {
  let included = false;
  for (const pattern of metadata.build.files) {
    const excluded = pattern.startsWith("!");
    if (minimatch(file, excluded ? pattern.slice(1) : pattern, { dot: true })) included = !excluded;
  }
  return included;
}

test("production runtime dependency closure is covered by the narrow package allowlist", () => {
  const closure = runtimeClosure();
  const missing = [...closure].filter(file => !configured(file)).sort();
  assert.deepEqual(missing, []);
  assert.equal(metadata.build.files.includes("scripts/**/*"), false);
  assert.equal(configured("scripts/marketCalendarG15b1FilesystemGuard.js"), false);
});

test("built asar contains the same production dependency closure when package verification is requested", () => {
  if (process.env.OPTIONMAP_VERIFY_PACKAGED_ASAR !== "1") return;
  const archive = process.env.OPTIONMAP_PACKAGED_ASAR || path.join(root,
    "dist/mac-arm64/OptionMap.app/Contents/Resources/app.asar");
  assert.ok(fs.existsSync(archive), `packaged asar missing: ${archive}`);
  const inventory = new Set(listPackage(archive).map(file => file.replace(/^\//, "")));
  const missing = [...runtimeClosure()].filter(file => !inventory.has(file)).sort();
  assert.deepEqual(missing, []);
  for (const excluded of [
    "scripts/marketCalendarG15b1FilesystemGuard.js",
    "scripts/marketCalendarFedGateDAcceptance.browser.js",
    "scripts/marketCalendarFedGateDApprovedArtifact.js",
    "scripts/marketCalendarFedGateDControlledProduction.browser.js",
    "scripts/marketCalendarFedGateDPreflight.js"
  ]) assert.equal(inventory.has(excluded), false, `unexpected packaged asset: ${excluded}`);
  assert.equal([...inventory].some(file => /(?:^|\/)audit-reports\//.test(file)), false);
});
