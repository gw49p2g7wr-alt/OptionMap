"use strict";

// Data-only one-child Git approval, not a developer signature or startup token.
// No production state, writer, migration or network imports.
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { createHash } = require("node:crypto"), { TextDecoder } = require("node:util");
const MANIFEST_PATH = "approvals/marketCalendarFreshDayCanary.json";
const GATE_ID = "market-calendar-parent-bound-fresh-day-canary-v1";
const OPERATION = "fresh-day-startup-canary", SOURCE = "jp-esri-machinery-orders-calendar";
const CRITICAL_ARTIFACTS = Object.freeze([
  "scripts/marketCalendarE4fFreshDayCanary.js",
  "js/marketCalendarRuntime/freshDayCanaryApproval.js",
  "js/marketCalendarRuntime/freshDayCanaryPreflight.js",
  "js/marketCalendarRuntime/freshDayCanaryReceipt.js",
  "js/marketCalendarRuntime/machineryStartupCanary.js",
  "js/marketCalendarHistory/writerSafetyCanaryStore.js",
  "js/marketCalendarHistory/writerSafetyVersionedEnvelope.js",
  "js/marketCalendarHistory/writerSafetyVersionedStore.js",
  "js/marketCalendarRuntime/automaticFormalSafetyRuntime.js",
  "js/marketCalendarRuntime/automaticFormalShadowRuntime.js",
  "js/marketCalendarRuntime/writerSafetyReadOnly.js",
  "js/marketCalendarHistory/formalWriterAuthorityV2.js",
  "js/marketCalendarHistory/formalWriterAuthorizationV2.js",
  "js/marketCalendarHistory/formalWriterSafetyEvaluator.js",
  "js/marketCalendarHistory/firstProductionWriteExecutor.js",
  "js/marketCalendarHistory/formalControlledWriterCore.js"
]);
const FIELDS = Object.freeze(["schemaVersion", "gateId", "approvedImplementationCommit", "approvedOperation",
  "approvedSourceId", "authorityVersion", "expectedSafetySequence", "criticalArtifactDigests"]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reject = reason => { throw Error(reason); };
const hash = s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const commit = s => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const exactKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o) &&
  Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
function freeze(o) {
  if (o && typeof o === "object") { Object.values(o).forEach(freeze); Object.freeze(o); }
  return o;
}

// JSON.parse alone silently accepts duplicate keys. Decode keys before duplicate
// detection, including escaped spellings and nested digest-map fields.
function parseJson(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 32768) reject("manifest_malformed");
  let at = 0;
  const ws = () => { while (/[\t\n\r ]/.test(text[at] || "x")) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") { at++; continue; }
      if (c === '"') return JSON.parse(text.slice(start, at));
    }
    reject("manifest_malformed");
  }
  function value(depth) {
    if (depth > 8) reject("manifest_malformed");
    ws(); const c = text[at];
    if (c === '"') return string();
    if (c === "{") {
      at++; ws(); const object = Object.create(null), seen = new Set();
      if (text[at] === "}") { at++; return object; }
      while (at < text.length) {
        ws(); if (text[at] !== '"') reject("manifest_malformed");
        const key = string(); if (seen.has(key)) reject("manifest_duplicate_field"); seen.add(key);
        ws(); if (text[at++] !== ":") reject("manifest_malformed");
        object[key] = value(depth + 1); ws();
        if (text[at] === "}") { at++; return object; }
        if (text[at++] !== ",") reject("manifest_malformed");
      }
    } else if (c === "[") {
      at++; ws(); const array = [];
      if (text[at] === "]") { at++; return array; }
      while (at < text.length) {
        array.push(value(depth + 1)); ws(); if (text[at] === "]") { at++; return array; }
        if (text[at++] !== ",") reject("manifest_malformed");
      }
    } else {
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
      if (token) { at += token[0].length; return JSON.parse(token[0]); }
    }
    reject("manifest_malformed");
  }
  const parsed = value(0); ws(); if (at !== text.length) reject("manifest_malformed"); return parsed;
}
function failure(e) {
  return Object.freeze({ valid: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "approval_verification_failed" });
}
function parseManifest(text) {
  try {
    const m = parseJson(text);
    if (!exactKeys(m, FIELDS)) reject("manifest_fields_invalid");
    if (m.schemaVersion !== 1) reject("manifest_schema_unsupported");
    if (m.gateId !== GATE_ID || m.approvedOperation !== OPERATION || m.approvedSourceId !== SOURCE ||
        m.authorityVersion !== 3 || m.expectedSafetySequence !== 2) reject("manifest_scope_invalid");
    if (!commit(m.approvedImplementationCommit)) reject("manifest_commit_invalid");
    if (!exactKeys(m.criticalArtifactDigests, CRITICAL_ARTIFACTS) ||
        !CRITICAL_ARTIFACTS.every(p => hash(m.criticalArtifactDigests[p]))) reject("manifest_digests_invalid");
    return freeze({ valid: true, reason: null, manifest: m });
  } catch (e) { return failure(e); }
}
function excluded(p) {
  return ["finalgate-audit-reports/", "gatef-audit-reports/", "phase4-audit-reports/", "phase5-audit-reports/"].some(d => p.startsWith(d)) ||
    ["scripts/marketCalendarFedGateDAcceptance.browser.js", "scripts/marketCalendarFedGateDApprovedArtifact.js",
      "scripts/marketCalendarFedGateDControlledProduction.browser.js", "scripts/marketCalendarFedGateDPreflight.js"].includes(p);
}

// Finder metadata is never an approval/code input. Exempt only the exact name
// of an existing regular file under the canonical repository root. No content
// parsing/trust, deletion, .gitignore-based approval or symlink traversal.
function classifyRuntimeFiles(root, files) {
  const inertMetadata = [], runtimeOverrides = [];
  function inert(p) {
    try {
      if (typeof root !== "string" || root !== fs.realpathSync(root) || typeof p !== "string" ||
          path.posix.isAbsolute(p) || p.includes("\0") || p.split("/").some(s => !s || s === "." || s === "..") ||
          path.posix.basename(p) !== ".DS_Store") return false;
      const target = path.resolve(root, p);
      return target.startsWith(root + path.sep) && fs.lstatSync(target).isFile() && fs.realpathSync(target) === target;
    } catch (_) { return false; }
  }
  for (const p of files) (inert(p) ? inertMetadata : runtimeOverrides).push(p);
  return freeze({ inertMetadata, runtimeOverrides });
}

// Pure fixture evidence is not an execution capability. Production obtains all
// observations from Git/file bytes through verifyRepository, never IPC/CLI input.
function verifyEvidence(e) {
  try {
    if (!e || !commit(e.head) || e.branch !== "main") reject("approval_head_invalid");
    if (!Array.isArray(e.parents) || e.parents.length !== 1) reject("approval_parent_invalid");
    if (e.stagedDiff !== "" || e.trackedDiff !== "") reject("uncommitted_implementation");
    if (!Array.isArray(e.untrackedFiles) || !Array.isArray(e.ignoredRuntimeFiles) ||
        e.untrackedFiles.some(p => typeof p !== "string" || !excluded(p)) || e.ignoredRuntimeFiles.length)
      reject("untracked_runtime_override");
    const parsed = parseManifest(e.manifestText); if (!parsed.valid) reject(parsed.reason);
    const m = parsed.manifest;
    if (e.parents[0] !== m.approvedImplementationCommit || e.head === m.approvedImplementationCommit)
      reject("approval_parent_mismatch");
    if (!Array.isArray(e.changes) || e.changes.length !== 1 || e.changes[0].status !== "A" ||
        e.changes[0].path !== MANIFEST_PATH || e.parentManifestExists !== false || e.manifestMode !== "100644")
      reject("approval_commit_diff_invalid");
    if (!Buffer.isBuffer(e.currentManifest) || !Buffer.isBuffer(e.workingManifest) ||
        !e.currentManifest.equals(e.workingManifest) || e.currentManifest.toString("utf8") !== e.manifestText)
      reject("manifest_worktree_mismatch");
    for (const p of CRITICAL_ARTIFACTS) {
      const a = e.parentArtifacts?.[p], b = e.currentArtifacts?.[p], w = e.workingArtifacts?.[p];
      if (![a, b, w].every(Buffer.isBuffer)) reject("artifact_missing");
      if (sha(a) !== m.criticalArtifactDigests[p]) reject("artifact_digest_mismatch");
      if (!a.equals(b) || !b.equals(w)) reject("artifact_tree_mismatch");
    }
    return freeze({ valid: true, reason: null, approvedImplementationCommit: m.approvedImplementationCommit,
      approvalCommit: e.head, manifestPath: MANIFEST_PATH, sourceId: SOURCE, approvedOperation: OPERATION,
      authorityVersion: 3, expectedSafetySequence: 2, artifactCount: CRITICAL_ARTIFACTS.length });
  } catch (error) { return failure(error); }
}

function verifyRepository(root) {
  try {
    if (process.type === "renderer" || typeof window !== "undefined" && window.document) reject("main_side_only");
    if (typeof root !== "string" || root !== fs.realpathSync(root)) reject("repository_root_invalid");
    const git = args => cp.execFileSync("git", ["--no-replace-objects", ...args],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
    const text = args => git(args).toString("utf8").trim();
    const paths = args => git(args).toString("utf8").split("\0").filter(Boolean);
    if (text(["rev-parse", "--show-toplevel"]) !== root) reject("repository_root_invalid");
    // Index flags must not conceal physical tracked drift from clean-tree checks.
    const masked = () => paths(["ls-files", "-v", "-z"]).some(p => /^[a-zS]/.test(p));
    if (masked()) reject("tracked_index_mask_forbidden");
    const stagedDiff = text(["diff", "--cached", "--name-only"]), trackedDiff = text(["diff", "--name-only"]);
    if (stagedDiff || trackedDiff) reject("uncommitted_implementation");
    const untracked = () => classifyRuntimeFiles(root, paths(["ls-files", "--others", "--exclude-standard", "-z"])).runtimeOverrides;
    const untrackedFiles = untracked();
    const runtimePaths = ["js", "scripts", "approvals", "main.js", "preload.js", "package.json"];
    const ignored = () => classifyRuntimeFiles(root,
      paths(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...runtimePaths])).runtimeOverrides.filter(p => !excluded(p));
    const ignoredRuntimeFiles = ignored();
    if (untrackedFiles.some(p => !excluded(p)) || ignoredRuntimeFiles.length) reject("untracked_runtime_override");
    const head = text(["rev-parse", "HEAD"]), branch = text(["branch", "--show-current"]);
    if (!commit(head)) reject("approval_head_invalid");
    const parents = text(["rev-list", "--parents", "-n", "1", head]).split(" ").slice(1);
    if (parents.length !== 1 || !commit(parents[0])) reject("approval_parent_invalid");
    // The actual parent, never a manifest/CLI-selected revision, is the Git input.
    const parent = parents[0];
    function treeEntry(revision, p) {
      const raw = paths(["ls-tree", "-z", revision, "--", p]);
      if (!raw.length) return null;
      if (raw.length !== 1) reject("artifact_tree_invalid");
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.*)$/.exec(raw[0]);
      if (!match || match[3] !== p || match[1] !== "100644") reject("artifact_tree_invalid");
      return { mode: match[1], bytes: git(["cat-file", "blob", match[2]]) };
    }
    function working(p) {
      const target = path.join(root, p);
      if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target) reject("artifact_worktree_invalid");
      return fs.readFileSync(target);
    }
    const manifest = treeEntry(head, MANIFEST_PATH); if (!manifest) reject("approval_manifest_missing");
    if (manifest.bytes.length > 32768) reject("manifest_malformed");
    const manifestText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifest.bytes);
    const names = paths(["diff-tree", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", parent, head]);
    const changes = [];
    for (let i = 0; i < names.length; i += 2) changes.push({ status: names[i], path: names[i + 1] });
    const parentArtifacts = {}, currentArtifacts = {}, workingArtifacts = {};
    for (const p of CRITICAL_ARTIFACTS) {
      parentArtifacts[p] = treeEntry(parent, p)?.bytes;
      currentArtifacts[p] = treeEntry(head, p)?.bytes;
      workingArtifacts[p] = working(p);
    }
    const evidence = { head, branch, parents, stagedDiff, trackedDiff, untrackedFiles, ignoredRuntimeFiles,
      changes, parentManifestExists: treeEntry(parent, MANIFEST_PATH) !== null, manifestMode: manifest.mode,
      manifestText, currentManifest: manifest.bytes, workingManifest: working(MANIFEST_PATH),
      parentArtifacts, currentArtifacts, workingArtifacts };
    const result = verifyEvidence(evidence); if (!result.valid) return result;
    // Recheck after reads, never cache across attempts. The owner also rechecks
    // immediately before any startup/state access.
    if (text(["rev-parse", "HEAD"]) !== head || text(["diff", "--name-only"]) || text(["diff", "--cached", "--name-only"]) ||
        JSON.stringify(untracked()) !== JSON.stringify(untrackedFiles) || ignored().length || masked())
      reject("approval_changed_during_verification");
    return result;
  } catch (error) { return failure(error); }
}
module.exports = Object.freeze({ MANIFEST_PATH, GATE_ID, OPERATION, SOURCE, CRITICAL_ARTIFACTS,
  parseManifest, verifyEvidence, verifyRepository, classifyRuntimeFiles });
