"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const os = require("node:os"), path = require("node:path"), cp = require("node:child_process"), vm = require("node:vm");
const { createHash } = require("node:crypto");
const V = require("../js/marketCalendarRuntime/freshDayCanaryApproval.js");
const P = require("../js/marketCalendarRuntime/freshDayCanaryPreflight.js");
const repo = path.resolve(__dirname, ".."), sha = b => createHash("sha256").update(b).digest("hex");
const A = sha("memory implementation A").slice(0, 40), B = sha("memory approval B").slice(0, 40);
function manifest(parent, artifacts) {
  return { schemaVersion: 1, gateId: V.GATE_ID, approvedImplementationCommit: parent,
    approvedOperation: V.OPERATION, approvedSourceId: V.SOURCE, authorityVersion: 3, expectedSafetySequence: 2,
    criticalArtifactDigests: Object.fromEntries(V.CRITICAL_ARTIFACTS.map(p => [p, sha(artifacts[p])])) };
}
function evidence(mutate = null) {
  const artifacts = Object.fromEntries(V.CRITICAL_ARTIFACTS.map(p => [p, fs.readFileSync(path.join(repo, p))]));
  const m = manifest(A, artifacts); if (mutate) mutate(m);
  const bytes = Buffer.from(JSON.stringify(m));
  return { head: B, branch: "main", parents: [A], stagedDiff: "", trackedDiff: "", untrackedFiles: [], ignoredRuntimeFiles: [],
    changes: [{ status: "A", path: V.MANIFEST_PATH }], parentManifestExists: false, manifestMode: "100644",
    manifestText: bytes.toString(), currentManifest: bytes, workingManifest: Buffer.from(bytes),
    parentArtifacts: artifacts, currentArtifacts: { ...artifacts }, workingArtifacts: { ...artifacts } };
}
function changeText(e, text) { e.manifestText = text; e.currentManifest = Buffer.from(text); e.workingManifest = Buffer.from(text); return e; }
function isolatedGit(fn, patch = null) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-canary-approval-"));
  const git = args => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      GIT_AUTHOR_NAME: "Isolated fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Isolated fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
  const write = (p, bytes) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), bytes); };
  try {
    git(["init", "-b", "main"]);
    const artifacts = Object.fromEntries(V.CRITICAL_ARTIFACTS.map(p => [p, fs.readFileSync(path.join(repo, p))]));
    for (const p of V.CRITICAL_ARTIFACTS) write(p, artifacts[p]);
    git(["add", "--", ...V.CRITICAL_ARTIFACTS]); git(["commit", "-m", "isolated implementation A"]);
    const parent = git(["rev-parse", "HEAD"]), m = manifest(parent, artifacts);
    // B is deliberately unknown here. There is no future/current HEAD field.
    write(V.MANIFEST_PATH, JSON.stringify(m));
    if (patch) patch({ root, git, write, m });
    git(["add", "--", V.MANIFEST_PATH]); git(["commit", "-m", "isolated manifest-only approval B"]);
    const head = git(["rev-parse", "HEAD"]);
    return fn({ root, git, write, m, parent, head });
  } finally { fs.rmSync(root, { recursive: true }); assert.equal(fs.existsSync(root), false); }
}

test("P1/P3 exact parent + manifest-only child is accepted in real isolated Git", () => isolatedGit(({ root, parent, head }) => {
  const result = P.revision(root); assert.equal(result.valid, true, result.reason);
  assert.equal(result.approvedImplementationCommit, parent); assert.equal(result.approvalCommit, head);
  assert.equal(result.artifactCount, 17); assert.equal(result.expectedSafetySequence, 2);
}));
test("P2 wrong parent rejects (no prefix/ancestry match)", () => {
  for (const parent of [B, A.slice(0, 8), sha("other").slice(0, 40)]) {
    const e = evidence(); e.parents = [parent]; assert.equal(V.verifyEvidence(e).reason, "approval_parent_mismatch");
  }
});
test("merge / root commits are not a one-child approval", () => {
  for (const parents of [[], [A, B]]) { const e = evidence(); e.parents = parents; assert.equal(V.verifyEvidence(e).valid, false); }
});
test("P4 manifest + executable JS change rejects in real Git", () => isolatedGit(({ root }) => {
  assert.equal(V.verifyRepository(root).reason, "approval_commit_diff_invalid");
}, ({ write, git }) => { write("extra.js", "// forbidden executable\n"); git(["add", "--", "extra.js"]); }));
test("test/config changes, manifest rename/update/deletion are rejected", () => {
  for (const patch of [[{ status: "A", path: "test/extra.test.js" }], [{ status: "A", path: "package.json" }],
    [{ status: "M", path: V.MANIFEST_PATH }], [{ status: "D", path: V.MANIFEST_PATH }], [{ status: "A", path: "other.json" }]]) {
    const e = evidence(); e.changes = patch; assert.equal(V.verifyEvidence(e).valid, false);
  }
  const e = evidence(); e.parentManifestExists = true; assert.equal(V.verifyEvidence(e).valid, false);
});
test("P5 dirty tracked or staged tree rejects before any execution", () => {
  for (const field of ["trackedDiff", "stagedDiff"]) { const e = evidence(); e[field] = "main.js";
    assert.equal(V.verifyEvidence(e).reason, "uncommitted_implementation"); }
});
test("real Git dirty tracked tree rejects", () => isolatedGit(({ root, write }) => {
  write(V.CRITICAL_ARTIFACTS[0], "// dirty\n"); assert.equal(V.verifyRepository(root).reason, "uncommitted_implementation");
}));
test("Git assume-unchanged cannot conceal executable drift", () => isolatedGit(({ root, write, git }) => {
  const p = V.CRITICAL_ARTIFACTS[0]; git(["update-index", "--assume-unchanged", "--", p]);
  write(p, "// hidden drift\n"); assert.equal(git(["diff", "--name-only"]), "");
  assert.equal(V.verifyRepository(root).reason, "tracked_index_mask_forbidden");
}));
test("untracked and ignored runtime overrides reject; known exclusions are preserved", () => {
  const e = evidence(); e.untrackedFiles = ["override.js"]; assert.equal(V.verifyEvidence(e).reason, "untracked_runtime_override");
  e.untrackedFiles = ["finalgate-audit-reports/report.json", "scripts/marketCalendarFedGateDPreflight.js"];
  assert.equal(V.verifyEvidence(e).valid, true);
  e.ignoredRuntimeFiles = ["js/override.js"]; assert.equal(V.verifyEvidence(e).valid, false);
});
test("real Git detects untracked override (including ignored runtime paths)", () => isolatedGit(({ root, write, git }) => {
  write("js/override.js", "// untracked\n"); assert.equal(V.verifyRepository(root).reason, "untracked_runtime_override");
  write(".git/info/exclude", "js/override.js\n");
  assert.equal(git(["ls-files", "--others", "--exclude-standard"]), "");
  assert.equal(V.verifyRepository(root).reason, "untracked_runtime_override");
}));
test("P6 malformed JSON / unknown fields / missing fields / unsupported schema reject", () => {
  for (const raw of ["{", "null", "[]", "{}", "{\"x\":1,}", "true", "\ufeff{}", "[".repeat(12)])
    assert.equal(V.parseManifest(raw).valid, false);
  for (const mutate of [m => { m.command = "arbitrary"; }, m => { delete m.gateId; }, m => { m.schemaVersion = 2; },
    m => { m.manifestPath = "arbitrary.json"; }, m => { m.approvedImplementationCommit = A.slice(0, 8); }])
    assert.equal(V.verifyEvidence(evidence(mutate)).valid, false);
});
test("duplicate top-level / escaped fields are rejected, never silently overwritten", () => {
  const e = evidence();
  for (const prefix of ['"schemaVersion":1,', '"schema\\u0056ersion":1,']) {
    const raw = "{" + prefix + e.manifestText.slice(1);
    assert.equal(V.parseManifest(raw).reason, "manifest_duplicate_field");
  }
});
test("duplicate digest-map key is rejected", () => {
  const e = evidence(), p = V.CRITICAL_ARTIFACTS[0];
  const raw = e.manifestText.replace('"criticalArtifactDigests":{', '"criticalArtifactDigests":{' + JSON.stringify(p) + ':"' + "0".repeat(64) + '",');
  assert.equal(V.parseManifest(raw).reason, "manifest_duplicate_field");
});
for (const [id, field, value] of [["P7", "approvedSourceId", "us-bls-calendar"], ["P8", "approvedOperation", "manual"],
  ["P9", "authorityVersion", 2], ["P10", "expectedSafetySequence", 7]])
  test(id + " fixed scope rejects " + field, () => assert.equal(V.verifyEvidence(evidence(m => { m[field] = value; })).reason, "manifest_scope_invalid"));
test("gate identity is code-fixed", () => assert.equal(V.verifyEvidence(evidence(m => { m.gateId = "other-gate"; })).valid, false));
test("P11 Git parent artifact digest mismatch rejects", () => {
  const e = evidence(); e.parentArtifacts = { ...e.parentArtifacts, [V.CRITICAL_ARTIFACTS[0]]: Buffer.from("other bytes") };
  assert.equal(V.verifyEvidence(e).reason, "artifact_digest_mismatch");
});
test("digest set exactness/format rejects unknown, missing, invalid hash", () => {
  for (const mutate of [m => { m.criticalArtifactDigests.extra = "0".repeat(64); },
    m => { delete m.criticalArtifactDigests[V.CRITICAL_ARTIFACTS[0]]; },
    m => { m.criticalArtifactDigests[V.CRITICAL_ARTIFACTS[0]] = "invalid"; }])
    assert.equal(V.verifyEvidence(evidence(mutate)).reason, "manifest_digests_invalid");
});
test("B critical artifact and physical working bytes must equal A, not only the digest", () => {
  for (const key of ["currentArtifacts", "workingArtifacts"]) {
    const e = evidence(); e[key] = { ...e[key], [V.CRITICAL_ARTIFACTS[0]]: Buffer.from("drift") };
    assert.equal(V.verifyEvidence(e).reason, "artifact_tree_mismatch");
  }
});
test("manifest physical tamper / symlink mode rejected", () => {
  const e = evidence(); e.workingManifest = Buffer.from(e.manifestText + " ");
  assert.equal(V.verifyEvidence(e).reason, "manifest_worktree_mismatch");
  e.workingManifest = e.currentManifest; e.manifestMode = "120000";
  assert.equal(V.verifyEvidence(e).reason, "approval_commit_diff_invalid");
});
test("P12 no B hash embedded; real Git child verifies without knowing its future identity", () => isolatedGit(({ root, head, m }) => {
  assert.equal(JSON.stringify(m).includes(head), false);
  for (const p of V.CRITICAL_ARTIFACTS) assert.equal(fs.readFileSync(path.join(root, p), "utf8").includes(head), false);
  assert.equal(V.verifyRepository(root).valid, true);
}));
test("canonical content bytes are hashed without whitespace/line-ending normalization", () => {
  const e = evidence(), p = V.CRITICAL_ARTIFACTS[0];
  const bytes = Buffer.concat([e.parentArtifacts[p], Buffer.from("\r\n")]);
  e.parentArtifacts[p] = bytes; e.currentArtifacts[p] = bytes; e.workingArtifacts[p] = bytes;
  assert.equal(V.verifyEvidence(e).reason, "artifact_digest_mismatch");
});
test("missing approval / implementation-only A cannot authorize production", () => {
  assert.equal(V.verifyEvidence({}).valid, false);
  assert.equal(P.revision(repo).valid, false);
  // The previous approval remains history, but lacks the dedicated entry digest.
  assert.equal(V.parseManifest(fs.readFileSync(path.join(repo, V.MANIFEST_PATH), "utf8")).reason, "manifest_digests_invalid");
});
test("P13/P14 no migration/authority transition calls or production imports", () => {
  const source = fs.readFileSync(require.resolve("../js/marketCalendarRuntime/freshDayCanaryApproval.js"), "utf8");
  assert.doesNotMatch(source, /\.migrate\s*\(|\.transition\s*\(|\.append\s*\(|\.startup\s*\(/);
  assert.doesNotMatch(source, /require\(["'][^"']*(?:writerSafety|ControlledWriter|electron|https|http)[^"']*["']\)/);
  const controller = fs.readFileSync(require.resolve("../scripts/marketCalendarE4fFreshDayCanary.js"), "utf8");
  assert.doesNotMatch(controller, /\.migrate\s*\(|\.transition\s*\(/);
});
test("P15 production execution is mocked only; invalid gates invoke zero callbacks", () => {
  let mockedStartup = 0;
  const mock = e => { const r = V.verifyEvidence(e); if (r.valid) mockedStartup++; return r; };
  const e = evidence(); e.parents = [B]; assert.equal(mock(e).valid, false); assert.equal(mockedStartup, 0);
  assert.equal(mock(evidence()).valid, true); assert.equal(mockedStartup, 1);
  assert.deepEqual(Object.keys(require("../scripts/marketCalendarE4fFreshDayCanary.js")), ["createIsolatedController", "runProductionAcceptance"]);
});
test("renderer cannot invoke repository verifier; arbitrary manifest path not an API", () => {
  const source = fs.readFileSync(require.resolve("../js/marketCalendarRuntime/freshDayCanaryApproval.js"), "utf8"), module = { exports: {} };
  vm.runInNewContext(source, { module, require, Buffer, process: { type: "renderer" } });
  assert.equal(module.exports.verifyRepository(repo).reason, "main_side_only");
  assert.equal(Object.isFrozen(V.CRITICAL_ARTIFACTS), true);
  assert.equal(V.parseManifest(changeText(evidence(), '{"path":"elsewhere"}').manifestText).valid, false);
});
