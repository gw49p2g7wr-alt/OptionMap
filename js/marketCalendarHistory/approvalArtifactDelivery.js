"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Authorization = require("./planAuthorization.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");

const CONTRACT_VERSION = 1;
const sha256Bytes = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const jsonBytes = artifact => Buffer.from(JSON.stringify(artifact), "utf8");
const operationIdentity = values => Canonicalizer.sha256({ contractVersion: CONTRACT_VERSION,
    operationId: values.operationId, sourceId: values.sourceId, runId: values.runId,
    authorizationIdentityHash: values.authorizationIdentityHash,
    artifactDigest: values.artifactDigest, byteSha256: values.byteSha256,
    byteLength: values.byteLength, artifactPath: values.artifactPath });
const validOperationId = value => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
async function stage({ artifactBytes, expected, operationId, tempRoot = os.tmpdir(), fsApi = fs } = {}) {
    const bytes = Buffer.isBuffer(artifactBytes) ? Buffer.from(artifactBytes) :
        artifactBytes instanceof Uint8Array ? Buffer.from(artifactBytes) : null;
    if (!bytes || !validOperationId(operationId)) throw new TypeError("artifact_delivery_input_invalid");
    let artifact;
    try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("noncanonical_utf8");
        artifact = JSON.parse(text); }
    catch (_error) { throw new Error("artifact_bytes_invalid"); }
    const verified = await Authorization.verify(artifact, expected), artifactDigest =
        await Canonicalizer.sha256(artifact);
    if (!verified.ok || artifactDigest !== expected.artifactDigest)
        throw new Error("artifact_authorization_mismatch");
    const directory = fsApi.mkdtempSync(path.join(tempRoot, "optionmap-gate-"));
    fsApi.chmodSync(directory, 0o700);
    const artifactPath = path.join(directory, "approval-artifact.json"), descriptor = {
        contractVersion: CONTRACT_VERSION, operationId, sourceId: artifact.sourceId,
        runId: artifact.runId, authorizationIdentityHash: artifact.authorizationIdentityHash,
        artifactDigest, byteSha256: sha256Bytes(bytes), byteLength: bytes.length, artifactPath };
    descriptor.operationIdentity = await operationIdentity(descriptor);
    const handle = fsApi.openSync(artifactPath, fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_WRONLY, 0o600);
    try { fsApi.writeFileSync(handle, bytes); fsApi.fsyncSync(handle); }
    finally { fsApi.closeSync(handle); }
    return Object.freeze(descriptor);
}
function secureFile(stat) { return stat.isFile() && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || stat.uid === process.getuid()); }
function cleanup(descriptor, fsApi = fs) { const errors = [];
    for (const target of [descriptor.artifactPath, `${descriptor.artifactPath}.claim`]) try {
        fsApi.unlinkSync(target); } catch (error) { if (error?.code !== "ENOENT") errors.push(
            `${path.basename(target)}:${error?.code || error?.message}`); }
    try { fsApi.rmdirSync(path.dirname(descriptor.artifactPath)); }
    catch (error) { if (error?.code !== "ENOENT") errors.push(`directory:${error?.code || error?.message}`); }
    return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) }); }
async function consume({ descriptor, expected, openDatabase, fsApi = fs } = {}) {
    let claimHandle = null, databaseOpened = false;
    const fail = (reason, cleanupResult = null) => Object.freeze({ ok: false, reason,
        databaseOpened, cleanup: cleanupResult });
    try {
        if (descriptor?.contractVersion !== CONTRACT_VERSION || !validOperationId(descriptor?.operationId) ||
            typeof openDatabase !== "function") return fail("delivery_descriptor_invalid");
        const expectedOperationIdentity = await operationIdentity(descriptor);
        if (descriptor.operationIdentity !== expectedOperationIdentity ||
            descriptor.authorizationIdentityHash !== expected.authorizationIdentityHash ||
            descriptor.artifactDigest !== expected.artifactDigest) return fail("operation_identity_mismatch");
        try { claimHandle = fsApi.openSync(`${descriptor.artifactPath}.claim`, fs.constants.O_CREAT |
            fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); }
        catch (error) { return fail(error?.code === "EEXIST" ? "duplicate_invocation" : "claim_failed"); }
        let stat, bytes;
        try { stat = fsApi.lstatSync(descriptor.artifactPath);
            if (!secureFile(stat)) return fail("artifact_permission_invalid");
            bytes = fsApi.readFileSync(descriptor.artifactPath); }
        catch (_error) { return fail("artifact_missing"); }
        if (bytes.length !== descriptor.byteLength || sha256Bytes(bytes) !== descriptor.byteSha256)
            return fail("artifact_bytes_mismatch");
        let artifact;
        try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("noncanonical_utf8");
            artifact = JSON.parse(text); }
        catch (_error) { return fail("artifact_bytes_invalid"); }
        const digest = await Canonicalizer.sha256(artifact), verified = await Authorization.verify(
            artifact, expected);
        if (digest !== expected.artifactDigest || !verified.ok) return fail("artifact_authorization_mismatch");
        databaseOpened = true;
        const value = await openDatabase(verified.plan);
        const cleanupResult = cleanup(descriptor, fsApi);
        return Object.freeze({ ok: true, databaseOpened, value, cleanup: cleanupResult });
    } finally { if (claimHandle !== null) try { fsApi.closeSync(claimHandle); } catch (_error) {} }
}
module.exports = Object.freeze({ CONTRACT_VERSION, jsonBytes, sha256Bytes, operationIdentity,
    stage, consume, cleanup });
