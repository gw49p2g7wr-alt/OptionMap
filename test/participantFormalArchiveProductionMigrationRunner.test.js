"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const crypto = require("node:crypto"); const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
const fs = require("node:fs"); const path = require("node:path");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const Runner = require("../js/formalArchive/participantFormalArchiveProductionMigrationRunner.js");
const unique = label => `${label}-${Date.now()}-${Math.random()}`;
function canonical(value) { return Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
    value && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value); }
const hash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
function projected() { const sourceDate = "2026-09-14", entryKey = Schema.entryKeyFor(sourceDate),
    versionKey = `participant-set|${sourceDate}|sha256:${"a".repeat(64)}`,
    revisionKey = `${entryKey}|${versionKey}`, time = `${sourceDate}T12:00:00.000Z`,
    metadata = { id: Schema.META_KEY, archiveSchemaVersion: 1, dataset: "participant",
        authorityClass: "formal", retentionPolicy: "preserve_formal_revisions", createdAt: time,
        updatedAt: time, integrityAlgorithm: "sha256", entryCount: 1, revisionCount: 1 },
    entries = [{ entryKey, sourceDate, activeRevisionKey: revisionKey, firstSeenAt: time,
        lastSeenAt: time }], revisions = [{ revisionKey, entryKey, sourceDate, versionKey,
        contentSignature: "a".repeat(64), signatureAlgorithm: "sha256", signature: "a".repeat(64),
        confirmedAt: time, replacedAt: null, revisionState: "active",
        completeSet: { sourceDate, versionKey, signature: "a".repeat(64) } }];
    return { metadata, entries, revisions }; }
function setup(overrides = {}) { const archive = projected(), source = { version: 1, entries: [1] },
    sourceFingerprint = hash(source), projectedArchiveFingerprint = hash(archive), state = { raw:
        JSON.stringify(source) }, databaseName = unique("production-runner"), preview = {
        semanticEquivalence: true, sourceFingerprint, projectedArchiveFingerprint,
        projectedArchive: archive, counts: { projectedActiveRevisionCount: 1 } },
    runtimeProbe = overrides.runtimeProbe || (async () => ({ stopped: true, snapshotId: "stopped" })),
    runner = Runner.createProductionMigrationRunner({ indexedDB, IDBKeyRange, databaseName,
        sourceStorage: { getItem: () => state.raw }, runtimeProbe,
        storageManager: { estimate: async () => ({ usage: 1000, quota: 10000000 }) },
        previewApi: { previewMigration: async () => preview }, ...overrides.configuration }),
    approval = { approved: true, operation: Runner.OPERATION,
        approvalNonce: "approval_nonce_123456", sourceFingerprint, projectedArchiveFingerprint };
    return { runner, approval, state, preview, databaseName }; }
test("explicit approved runner writes once and completes read-back acceptance", async () => {
    const value = setup(), result = await value.runner.run(value.approval);
    assert.equal(result.status, "ACCEPTED"); assert.equal(result.sourceUnchanged, true);
    assert.equal(result.countsMatch, true); assert.equal(result.signaturesMatch, true);
    assert.equal(result.fingerprintMatched, true); assert.equal(result.entryCount, 1);
    assert.equal(result.activeRevisionCount, 1);
    assert.equal((await value.runner.run(value.approval)).reason, "runner_already_consumed");
});
test("running OptionMap is rejected before source or target mutation", async () => {
    const value = setup({ runtimeProbe: async () => ({ stopped: false, processes: ["OptionMap"] }) });
    const result = await value.runner.run(value.approval);
    assert.equal(result.reason, "optionmap_runtime_running");
    assert.equal((await indexedDB.databases()).some(item => item.name === value.databaseName), false);
});
test("source and projected fingerprint mismatches are rejected", async () => {
    const source = setup(); source.approval.sourceFingerprint = "0".repeat(64);
    assert.equal((await source.runner.run(source.approval)).reason, "source_fingerprint_mismatch");
    const projection = setup(); projection.approval.projectedArchiveFingerprint = "0".repeat(64);
    assert.equal((await projection.runner.run(projection.approval)).reason,
        "projected_fingerprint_mismatch");
});
test("a new runner rejects a non-empty target after successful migration", async () => {
    const first = setup(); assert.equal((await first.runner.run(first.approval)).status, "ACCEPTED");
    const second = Runner.createProductionMigrationRunner({ indexedDB, IDBKeyRange,
        databaseName: first.databaseName, sourceStorage: { getItem: () => first.state.raw },
        runtimeProbe: async () => ({ stopped: true }), storageManager: { estimate: async () =>
            ({ usage: 1000, quota: 10000000 }) }, previewApi: { previewMigration: async () => first.preview } });
    assert.equal((await second.run(first.approval)).reason, "target_non_empty");
});
test("runtime restart and source mutation during the gate are rejected", async () => {
    let calls = 0; const runtime = setup({ runtimeProbe: async () => ({ stopped: ++calls === 1 }) });
    assert.equal((await runtime.runner.run(runtime.approval)).reason,
        "optionmap_runtime_started_during_gate");
    const source = setup({ runtimeProbe: async () => ({ stopped: true }) });
    const original = source.state.raw; let reads = 0;
    const runner = Runner.createProductionMigrationRunner({ indexedDB, IDBKeyRange,
        databaseName: unique("source-change"), sourceStorage: { getItem: () =>
            ++reads === 1 ? original : `${original} ` }, runtimeProbe: async () => ({ stopped: true }),
        storageManager: { estimate: async () => ({ usage: 1000, quota: 10000000 }) },
        previewApi: { previewMigration: async () => source.preview } });
    assert.equal((await runner.run(source.approval)).reason, "source_changed_during_gate");
});
test("production runner is unconnected and does not weaken the Phase 4 writer", () => {
    const runner = fs.readFileSync(path.join(__dirname,
        "../js/formalArchive/participantFormalArchiveProductionMigrationRunner.js"), "utf8"),
        writer = fs.readFileSync(path.join(__dirname,
            "../js/formalArchive/participantFormalArchiveMigrationWriter.js"), "utf8"),
        html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.doesNotMatch(runner, /ParticipantFormalArchiveMigrationWriter|profile_copy|targetEnvironment/);
    assert.match(writer, /new Set\(\["test", "profile_copy"\]\)/);
    assert.equal(html.includes("participantFormalArchiveProductionMigrationRunner.js"), false);
});
