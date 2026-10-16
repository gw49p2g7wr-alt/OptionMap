"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Authorization = require("../js/marketCalendarHistory/planAuthorization.js");
const Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Delivery = require("../js/marketCalendarHistory/approvalArtifactDelivery.js");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");

const HASH = "a".repeat(64), TIME = "2026-09-16T22:24:26.053Z";
const plan = () => ({ sourceId: "source", runId: "run-1", acceptedAt: TIME,
    appendRuns: [{ sourceId: "source", runId: "run-1", acceptedAt: TIME, fetchedAt: [TIME],
        status: "accepted", semanticSetHash: HASH }], appendEntries: [], updateEntries: [],
    closeRevisions: [], appendRevisions: [], appendEvidence: [], appendObservations: [],
    updateCursors: [{ sourceId: "source", runId: "run-1", acceptedAt: TIME }] });
async function fixture() { const artifact = await Authorization.create(plan()); return { artifact,
    bytes: Delivery.jsonBytes(artifact), expected: { sourceId: artifact.sourceId,
        acceptedAt: artifact.acceptedAt, runId: artifact.runId,
        semanticPlanHash: artifact.semanticPlanHash,
        acquisitionEvidenceIdentityHash: artifact.acquisitionEvidenceIdentityHash,
        storageMutationHash: artifact.storageMutationHash,
        authorizationIdentityHash: artifact.authorizationIdentityHash,
        artifactDigest: await Canon.sha256(artifact) } }; }
const operationId = () => crypto.randomUUID();
const v2Precondition = () => ({ productionSnapshotFingerprint: "b".repeat(64), storeCounts: {
    marketCalendarSourceRuns: 7, marketCalendarEventEntries: 102,
    marketCalendarSemanticRevisions: 102, marketCalendarAcquisitionEvidence: 170,
    marketCalendarEventObservations: 170, marketCalendarSourceCursors: 4 },
    schemaFingerprint: "c".repeat(64), sourceCursor: null });

test("secure file deliveryはartifact bytesをbyte-equivalentに渡しdigest/identity後だけDBを開く", async () => {
    const value = await fixture(), descriptor = await Delivery.stage({ artifactBytes: value.bytes,
        expected: value.expected, operationId: operationId() }); let opened = 0;
    const result = await Delivery.consume({ descriptor, expected: value.expected,
        openDatabase: async received => { opened += 1; assert.equal(JSON.stringify(received),
            value.artifact.canonicalPayload); return "accepted"; } });
    assert.deepEqual([result.ok, result.databaseOpened, result.value, opened], [true, true, "accepted", 1]);
    assert.equal(result.cleanup.ok, true); assert.equal(fs.existsSync(descriptor.artifactPath), false);
});

for (const [label, mutate, reason] of [
    ["truncation", bytes => bytes.subarray(0, bytes.length - 1), "artifact_bytes_mismatch"],
    ["one-byte mutation", bytes => { const next = Buffer.from(bytes); next[next.length - 2] ^= 1; return next; },
        "artifact_bytes_mismatch"],
    ["wrong artifact", async (_bytes, value) => Delivery.jsonBytes(await Authorization.create({
        ...plan(), runId: "run-2", appendRuns: [{ ...plan().appendRuns[0], runId: "run-2" }] })),
        "artifact_bytes_mismatch"]]) test(`${label}はDB open前にfail-closed`, async () => {
            const value = await fixture(), descriptor = await Delivery.stage({ artifactBytes: value.bytes,
                expected: value.expected, operationId: operationId() }), changed = await mutate(value.bytes, value);
            fs.writeFileSync(descriptor.artifactPath, changed); let opened = 0;
            const result = await Delivery.consume({ descriptor, expected: value.expected,
                openDatabase: async () => { opened += 1; } });
            assert.deepEqual([result.ok, result.reason, result.databaseOpened, opened],
                [false, reason, false, 0]); Delivery.cleanup(descriptor);
        });

test("missing artifactはDBを開かない", async () => { const value = await fixture(), descriptor =
    await Delivery.stage({ artifactBytes: value.bytes, expected: value.expected, operationId: operationId() });
    fs.unlinkSync(descriptor.artifactPath); let opened = 0; const result = await Delivery.consume({ descriptor,
        expected: value.expected, openDatabase: async () => { opened += 1; } });
    assert.deepEqual([result.ok, result.reason, opened], [false, "artifact_missing", 0]);
    Delivery.cleanup(descriptor);
});

test("同一operation duplicate invocationはclaimで拒否", async () => { const value = await fixture(), descriptor =
    await Delivery.stage({ artifactBytes: value.bytes, expected: value.expected, operationId: operationId() }), claim =
        fs.openSync(`${descriptor.artifactPath}.claim`, "wx", 0o600); let opened = 0;
    const result = await Delivery.consume({ descriptor, expected: value.expected,
        openDatabase: async () => { opened += 1; } }); fs.closeSync(claim);
    assert.deepEqual([result.ok, result.reason, opened], [false, "duplicate_invocation", 0]);
    Delivery.cleanup(descriptor);
});

test("operation identityはartifact path差し替えをDB open前に拒否", async () => {
    const value = await fixture(), descriptor = await Delivery.stage({ artifactBytes: value.bytes,
        expected: value.expected, operationId: operationId() }), changed = { ...descriptor,
        artifactPath: `${descriptor.artifactPath}.other` }; let opened = 0;
    const result = await Delivery.consume({ descriptor: changed, expected: value.expected,
        openDatabase: async () => { opened += 1; } });
    assert.deepEqual([result.ok, result.reason, result.databaseOpened, opened],
        [false, "operation_identity_mismatch", false, 0]); Delivery.cleanup(descriptor);
});

test("cleanup failureはcommit結果と分離しretryを要求しない", async () => { const value = await fixture(),
    descriptor = await Delivery.stage({ artifactBytes: value.bytes, expected: value.expected,
        operationId: operationId() }), failingFs = Object.create(fs); failingFs.unlinkSync = target => {
            if (target === descriptor.artifactPath) { const error = new Error("denied"); error.code = "EACCES"; throw error; }
            return fs.unlinkSync(target); };
    const result = await Delivery.consume({ descriptor, expected: value.expected,
        openDatabase: async () => "committed", fsApi: failingFs });
    assert.deepEqual([result.ok, result.value, result.cleanup.ok], [true, "committed", false]);
    assert.match(result.cleanup.errors.join(" "), /EACCES/); Delivery.cleanup(descriptor);
});

test("stagingは0700 directory・0600 file・small descriptor・Unicode/newline安全", async () => {
    const value = await fixture(), artifact = { ...value.artifact, note: "日本語\nline2" }, bytes =
        Buffer.from(JSON.stringify(artifact), "utf8"), expected = { ...value.expected,
            artifactDigest: await Canon.sha256(artifact) };
    const descriptor = await Delivery.stage({ artifactBytes: bytes, expected,
        operationId: operationId(), tempRoot: os.tmpdir() });
    assert.equal(fs.readFileSync(descriptor.artifactPath).equals(bytes), true);
    const directoryStat = fs.lstatSync(path.dirname(descriptor.artifactPath)), fileStat = fs.lstatSync(descriptor.artifactPath);
    assert.equal(Filesystem.secureDirectoryStat(directoryStat), true);
    assert.equal(Filesystem.secureFileStat(fileStat), true);
    if (process.platform !== "win32") {
        assert.equal(directoryStat.mode & 0o777, 0o700);
        assert.equal(fileStat.mode & 0o777, 0o600);
    }
    assert.equal("canonicalPayload" in descriptor, false); Delivery.cleanup(descriptor);
});

test("v2 delivery operation identityはproduction precondition identityを束縛する", async () => {
    const artifact = await Authorization.createV2(plan(), v2Precondition()), expected = {
        sourceId: artifact.sourceId, acceptedAt: artifact.acceptedAt, runId: artifact.runId,
        semanticPlanHash: artifact.semanticPlanHash,
        acquisitionEvidenceIdentityHash: artifact.acquisitionEvidenceIdentityHash,
        storageMutationHash: artifact.storageMutationHash,
        productionPreconditionIdentityHash: artifact.productionPreconditionIdentityHash,
        authorizationIdentityHash: artifact.authorizationIdentityHash,
        artifactDigest: await Canon.sha256(artifact) }, descriptor = await Delivery.stage({
            artifactBytes: Delivery.jsonBytes(artifact), expected, operationId: operationId() });
    assert.equal(descriptor.productionPreconditionIdentityHash,
        artifact.productionPreconditionIdentityHash); let opened = 0;
    const tampered = { ...descriptor, productionPreconditionIdentityHash: "d".repeat(64) }, rejected =
        await Delivery.consume({ descriptor: tampered, expected,
            openDatabase: async () => { opened += 1; } });
    assert.deepEqual([rejected.ok, rejected.reason, opened],
        [false, "operation_identity_mismatch", 0]);
    const accepted = await Delivery.consume({ descriptor, expected,
        openDatabase: async (_plan, context) => { opened += 1; assert.deepEqual(
            context.productionPrecondition, v2Precondition()); return "accepted"; } });
    assert.deepEqual([accepted.ok, accepted.value, opened], [true, "accepted", 1]);
});
