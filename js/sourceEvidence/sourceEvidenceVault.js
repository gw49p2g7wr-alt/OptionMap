"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Contract = require("./sourceEvidenceContract.js");
const Filesystem = require("../marketCalendarHistory/crossPlatformFilesystemSafety.js");

const VAULT_DIRECTORY = "source-evidence-vault";
const VAULT_VERSION_DIRECTORY = "v1";
const VAULT_SCHEMA_VERSION = 1;
const CONTENT_RECORD_TYPE = "source_evidence_content_metadata";
const OCCURRENCE_RECORD_TYPE = "source_evidence_acquisition_occurrence";
const MAX_METADATA_BYTES = 1_000_000;
const DIRECTORY_NAMES = Object.freeze({ objects: "objects", metadata: "metadata",
  occurrences: "occurrences", temporary: "temp" });
const CRASH_POINTS = Object.freeze([null, "after_object_temp", "before_object_rename",
  "before_metadata_rename", "after_object_promotion", "before_occurrence_persistence",
  "after_occurrence_temp", "before_occurrence_rename", "after_occurrence_promotion"]);
const INTEGRITY_STATUSES = Object.freeze(["valid", "missing", "hash_mismatch",
  "length_mismatch", "metadata_mismatch", "unsupported_version", "path_unsafe"]);
const CONTENT_METADATA_FIELDS = Object.freeze(["vaultSchemaVersion", "recordType",
  "contentObject", "createdAt", "integrityStatus", "metadataSha256"]);
const OCCURRENCE_RECORD_FIELDS = Object.freeze(["vaultSchemaVersion", "recordType",
  "occurrence", "sourcePolicy", "recordSha256"]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = value => typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze); return Object.freeze(value); }
function fail(reason, details = {}) { const error = new Error(reason); Object.assign(error, details); throw error; }
function absent(error) { return error?.code === "ENOENT"; }
function bytesView(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function validateProfileRoot(root, targetEnvironment) {
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("vault_profile_invalid");
  let real, stat;
  try { real = fs.realpathSync(root); stat = fs.lstatSync(root); }
  catch (_error) { fail("vault_profile_invalid"); }
  if (!Filesystem.samePath(real, root) || !stat.isDirectory() || stat.isSymbolicLink())
    fail("vault_profile_invalid");
  if (targetEnvironment === "isolated_test" &&
      !Filesystem.samePath(path.dirname(real), fs.realpathSync(os.tmpdir())))
    fail("isolated_vault_profile_invalid");
  return real;
}

function contentAddressParts(value) {
  if (!hash(value)) fail("content_sha256_invalid");
  return Object.freeze([value.slice(0, 2), value]);
}

function occurrenceDigest(value) {
  const match = /^source-occurrence-v1\|sha256:([0-9a-f]{64})$/.exec(value || "");
  if (!match) fail("occurrence_id_invalid");
  return match[1];
}

function createVault({ profileRoot, targetEnvironment, crashAt }) {
  const profile = validateProfileRoot(profileRoot, targetEnvironment);
  if (!CRASH_POINTS.includes(crashAt)) fail("vault_crash_point_invalid");
  const parent = path.join(profile, VAULT_DIRECTORY);
  const root = path.join(parent, VAULT_VERSION_DIRECTORY);
  const directories = Object.freeze(Object.fromEntries(Object.entries(DIRECTORY_NAMES)
    .map(([key, name]) => [key, path.join(root, name)])));

  function point(name, details = {}) { if (crashAt === name)
    fail(name === "after_occurrence_promotion" ? "vault_commit_ambiguous" : "vault_transaction_aborted",
      { crashPoint: name, ...details }); }

  function directoryState(directory) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (absent(error)) return "missing"; throw error; }
    if (!Filesystem.secureDirectoryStat(stat) || !Filesystem.samePath(fs.realpathSync(directory), directory) ||
        !Filesystem.contains(profile, directory)) fail("vault_path_unsafe");
    return "valid";
  }

  function ensureDirectory(directory, parentDirectory, create) {
    const state = directoryState(directory);
    if (state === "valid") return true;
    if (!create) return false;
    if (!Filesystem.samePath(path.dirname(directory), parentDirectory) ||
        (parentDirectory !== profile && directoryState(parentDirectory) !== "valid"))
      fail("vault_path_unsafe");
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    if (directoryState(directory) !== "valid") fail("vault_path_unsafe");
    return true;
  }

  function structure(create = false) {
    if (!ensureDirectory(parent, profile, create)) return false;
    if (!ensureDirectory(root, parent, create)) return false;
    if (create) {
      for (const directory of Object.values(directories)) ensureDirectory(directory, root, true);
    } else {
      for (const directory of [directories.objects, directories.metadata, directories.occurrences])
        if (!ensureDirectory(directory, root, false)) fail("vault_structure_invalid");
      if (directoryState(directories.temporary) === "valid") return true;
    }
    return true;
  }

  function prefixDirectory(kind, sha256, create = false) {
    if (!Object.hasOwn(directories, kind) || !["objects", "metadata"].includes(kind))
      fail("vault_directory_kind_invalid");
    const [prefix] = contentAddressParts(sha256), directory = path.join(directories[kind], prefix);
    if (!Filesystem.contains(directories[kind], directory)) fail("vault_path_unsafe");
    if (!ensureDirectory(directory, directories[kind], create)) return null;
    return directory;
  }

  function objectFile(sha256, createPrefix = false) {
    const parts = contentAddressParts(sha256), directory = prefixDirectory("objects", sha256, createPrefix);
    return directory ? path.join(directory, parts[1]) : null;
  }

  function metadataFile(sha256, createPrefix = false) {
    const parts = contentAddressParts(sha256), directory = prefixDirectory("metadata", sha256, createPrefix);
    return directory ? path.join(directory, `${parts[1]}.json`) : null;
  }

  function occurrenceFile(occurrenceId) {
    const digest = occurrenceDigest(occurrenceId);
    return path.join(directories.occurrences, `${digest}.json`);
  }

  function secureStat(file, maximum = null) {
    let before;
    try { before = fs.lstatSync(file); } catch (error) { if (absent(error)) return null; throw error; }
    if (!Filesystem.secureFileStat(before, { maxBytes: maximum }) ||
        !Filesystem.samePath(fs.realpathSync(file), file) || !Filesystem.contains(root, file))
      fail("vault_path_unsafe");
    return before;
  }

  function secureRead(file, maximum = null) {
    const before = secureStat(file, maximum);
    if (before === null) return null;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | Filesystem.noFollowFlag());
    try {
      const opened = fs.fstatSync(descriptor);
      if (!Filesystem.secureFileStat(opened, { maxBytes: maximum }) ||
          before.dev !== opened.dev || before.ino !== opened.ino) fail("vault_path_unsafe");
      const bytes = fs.readFileSync(descriptor);
      const after = fs.lstatSync(file);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size)
        fail("vault_path_unsafe");
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }

  function exists(file) {
    try { fs.lstatSync(file); return true; } catch (error) { if (absent(error)) return false; throw error; }
  }

  function parseJson(file) {
    const bytes = secureRead(file, MAX_METADATA_BYTES);
    if (bytes === null) return null;
    try { return JSON.parse(bytes.toString("utf8")); }
    catch (_error) { fail("vault_metadata_invalid"); }
  }

  function atomicWrite(finalFile, bytes, phase, verify) {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) fail("vault_write_bytes_invalid");
    if (exists(finalFile)) fail("vault_immutable_target_exists");
    const temporary = path.join(directories.temporary, `.${phase}.${randomUUID()}.tmp`);
    let promoted = false;
    try {
      const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | Filesystem.noFollowFlag(), 0o600);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!Filesystem.secureFileStat(stat)) fail("vault_temp_invalid");
        fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
      } finally { fs.closeSync(descriptor); }
      const fresh = secureRead(temporary, bytes.byteLength);
      if (!fresh || !verify(fresh)) fail("vault_temp_readback_invalid");
      point(phase === "object" ? "after_object_temp" :
        phase === "occurrence" ? "after_occurrence_temp" : "never");
      point(phase === "object" ? "before_object_rename" :
        phase === "metadata" ? "before_metadata_rename" : "before_occurrence_rename");
      if (exists(finalFile)) fail("vault_immutable_target_exists");
      fs.renameSync(temporary, finalFile); promoted = true;
      Filesystem.syncDirectory(path.dirname(finalFile));
      const published = secureRead(finalFile, bytes.byteLength);
      if (!published || !verify(published)) fail("vault_publish_readback_invalid");
      if (phase === "occurrence") point("after_occurrence_promotion");
      return true;
    } finally {
      if (!promoted) { try { fs.unlinkSync(temporary); } catch (error) { if (!absent(error)) throw error; } }
    }
  }

  function contentMetadata(contentObject, createdAt) {
    const material = { vaultSchemaVersion: VAULT_SCHEMA_VERSION, recordType: CONTENT_RECORD_TYPE,
      contentObject: clone(contentObject), createdAt, integrityStatus: "verified" };
    return freeze({ ...material, metadataSha256: Contract.sha256Canonical(material) });
  }

  function occurrenceRecord(occurrence, policy) {
    const material = { vaultSchemaVersion: VAULT_SCHEMA_VERSION, recordType: OCCURRENCE_RECORD_TYPE,
      occurrence: clone(occurrence), sourcePolicy: clone(policy) };
    return freeze({ ...material, recordSha256: Contract.sha256Canonical(material) });
  }

  function validateContentMetadata(value) {
    if (!exact(value, CONTENT_METADATA_FIELDS)) return "metadata_mismatch";
    if (value.vaultSchemaVersion !== VAULT_SCHEMA_VERSION) return "unsupported_version";
    const material = { vaultSchemaVersion: value.vaultSchemaVersion, recordType: value.recordType,
      contentObject: value.contentObject, createdAt: value.createdAt,
      integrityStatus: value.integrityStatus };
    return value.recordType === CONTENT_RECORD_TYPE && Contract.validateContentObject(value.contentObject) &&
      timestamp(value.createdAt) && value.integrityStatus === "verified" &&
      value.metadataSha256 === Contract.sha256Canonical(material) ? "valid" : "metadata_mismatch";
  }

  function validateOccurrenceRecord(value) {
    if (!exact(value, OCCURRENCE_RECORD_FIELDS)) return "metadata_mismatch";
    if (value.vaultSchemaVersion !== VAULT_SCHEMA_VERSION) return "unsupported_version";
    const material = { vaultSchemaVersion: value.vaultSchemaVersion, recordType: value.recordType,
      occurrence: value.occurrence, sourcePolicy: value.sourcePolicy };
    return value.recordType === OCCURRENCE_RECORD_TYPE && Contract.validateSourcePolicy(value.sourcePolicy) &&
      Contract.validateAcquisitionOccurrence(value.occurrence, value.sourcePolicy) &&
      value.recordSha256 === Contract.sha256Canonical(material) ? "valid" : "metadata_mismatch";
  }

  function status(value, details = {}) {
    if (!INTEGRITY_STATUSES.includes(value)) fail("vault_integrity_status_invalid");
    return freeze({ status: value, ...details });
  }

  function verifyContent(sha256) {
    contentAddressParts(sha256);
    try {
      if (!structure(false)) return status("missing", { sha256 });
      const rawPath = objectFile(sha256), metaPath = metadataFile(sha256);
      const rawExists = rawPath && exists(rawPath), metaExists = metaPath && exists(metaPath);
      if (!rawExists && !metaExists) return status("missing", { sha256 });
      if (!rawExists || !metaExists) return status("metadata_mismatch", { sha256 });
      const metadata = parseJson(metaPath), metadataStatus = validateContentMetadata(metadata);
      if (metadataStatus !== "valid") return status(metadataStatus, { sha256 });
      if (metadata.contentObject.sha256 !== sha256) return status("metadata_mismatch", { sha256 });
      const rawStat = secureStat(rawPath);
      if (rawStat.size !== metadata.contentObject.byteLength)
        return status("length_mismatch", { sha256 });
      const bytes = secureRead(rawPath, metadata.contentObject.byteLength);
      if (bytes === null) return status("missing", { sha256 });
      const verification = Contract.verifyContentBytes(bytes, sha256, metadata.contentObject.byteLength);
      if (!verification.valid) return status(verification.reason === "hash_mismatch" ? "hash_mismatch" :
        verification.reason === "byte_length_mismatch" ? "length_mismatch" : "metadata_mismatch",
      { sha256 });
      return status("valid", { sha256, metadata: freeze(clone(metadata)) });
    } catch (error) {
      if (error.message === "vault_path_unsafe") return status("path_unsafe", { sha256 });
      throw error;
    }
  }

  function verifyOccurrence(occurrenceId) {
    occurrenceDigest(occurrenceId);
    try {
      if (!structure(false)) return status("missing", { occurrenceId });
      const file = occurrenceFile(occurrenceId), record = parseJson(file);
      if (record === null) return status("missing", { occurrenceId });
      const recordStatus = validateOccurrenceRecord(record);
      if (recordStatus !== "valid") return status(recordStatus, { occurrenceId });
      if (record.occurrence.occurrenceId !== occurrenceId)
        return status("metadata_mismatch", { occurrenceId });
      const content = verifyContent(record.occurrence.contentSha256);
      if (content.status !== "valid") return status(content.status, { occurrenceId });
      const objectValue = content.metadata.contentObject;
      if (objectValue.byteLength !== record.occurrence.byteLength)
        return status("metadata_mismatch", { occurrenceId });
      return status("valid", { occurrenceId, record: freeze(clone(record)) });
    } catch (error) {
      if (error.message === "vault_path_unsafe") return status("path_unsafe", { occurrenceId });
      if (error.message === "vault_metadata_invalid") return status("metadata_mismatch", { occurrenceId });
      throw error;
    }
  }

  function ensureContent(bytes, contentObject, createdAt) {
    const verification = Contract.verifyContentBytes(bytes, contentObject.sha256, contentObject.byteLength);
    if (!verification.valid) fail("content_input_integrity_invalid", { integrityStatus: verification.reason });
    const rawPath = objectFile(contentObject.sha256, true), metaPath = metadataFile(contentObject.sha256, true);
    const rawExists = exists(rawPath), metaExists = exists(metaPath);
    if (rawExists || metaExists) {
      if (!rawExists) fail("existing_content_integrity_failure", { integrityStatus: "metadata_mismatch" });
      const rawStat = secureStat(rawPath);
      if (rawStat.size !== contentObject.byteLength) fail("existing_content_integrity_failure",
        { integrityStatus: "length_mismatch" });
      const raw = secureRead(rawPath, contentObject.byteLength), checked = raw &&
        Contract.verifyContentBytes(raw, contentObject.sha256, contentObject.byteLength);
      if (!checked?.valid) fail("existing_content_integrity_failure",
        { integrityStatus: checked?.reason || "missing" });
      if (metaExists) {
        const current = verifyContent(contentObject.sha256);
        if (current.status !== "valid" || current.metadata.contentObject.sha256 !== contentObject.sha256 ||
            current.metadata.contentObject.byteLength !== contentObject.byteLength)
          fail("existing_content_integrity_failure",
          { integrityStatus: current.status });
        return freeze({ classification: "verified_reuse", contentWriteCount: 0,
          metadataWriteCount: 0 });
      }
    }
    let contentWriteCount = 0;
    if (!rawExists) {
      const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      atomicWrite(rawPath, input, "object", fresh =>
        Contract.verifyContentBytes(fresh, contentObject.sha256, contentObject.byteLength).valid);
      contentWriteCount = 1;
    }
    const metadata = contentMetadata(contentObject, createdAt), metadataBytes =
      Buffer.from(`${Contract.stable(metadata)}\n`, "utf8");
    atomicWrite(metaPath, metadataBytes, "metadata", fresh => {
      try { return validateContentMetadata(JSON.parse(fresh.toString("utf8"))) === "valid"; }
      catch (_error) { return false; }
    });
    const current = verifyContent(contentObject.sha256);
    if (current.status !== "valid") fail("content_publish_integrity_failure",
      { integrityStatus: current.status });
    point("after_object_promotion", { contentSha256: contentObject.sha256 });
    return freeze({ classification: "created", contentWriteCount, metadataWriteCount: 1 });
  }

  function storeAcceptedEvidence(input) {
    if (!exact(input, ["bytes", "contentObject", "occurrence", "policy"]))
      fail("vault_store_input_invalid");
    const received = bytesView(input.bytes), bytes = received ? Buffer.from(received) : null;
    if (!bytes || bytes.byteLength === 0 || !Contract.validateContentObject(input.contentObject) ||
        !Contract.validateSourcePolicy(input.policy) ||
        !Contract.validateAcquisitionOccurrence(input.occurrence, input.policy) ||
        input.occurrence.contentSha256 !== input.contentObject.sha256 ||
        input.occurrence.byteLength !== input.contentObject.byteLength ||
        input.occurrence.mediaType !== input.contentObject.mediaType ||
        input.occurrence.encoding !== input.contentObject.encoding)
      fail("vault_store_contract_invalid");
    const sizeMismatch = input.contentObject.byteLength > input.policy.maxBytes;
    const mediaTypeMismatch = !input.policy.allowedMediaTypes.includes(input.contentObject.mediaType);
    const encodingMismatch = input.policy.allowedEncodings.length === 0
      ? input.contentObject.encoding !== null
      : !input.policy.allowedEncodings.includes(input.contentObject.encoding);
    const policyFailure = sizeMismatch || mediaTypeMismatch || encodingMismatch;
    if (policyFailure) fail("vault_source_policy_mismatch");
    const initial = Contract.verifyContentBytes(bytes, input.contentObject.sha256,
      input.contentObject.byteLength);
    if (!initial.valid) fail("content_input_integrity_invalid", { integrityStatus: initial.reason });
    structure(true);
    const content = ensureContent(bytes, input.contentObject, input.occurrence.fetchedAt);
    point("before_occurrence_persistence", { contentSha256: input.contentObject.sha256 });
    const file = occurrenceFile(input.occurrence.occurrenceId);
    if (exists(file)) {
      const current = verifyOccurrence(input.occurrence.occurrenceId);
      if (current.status !== "valid" || Contract.stable(current.record.occurrence) !==
          Contract.stable(input.occurrence) || Contract.stable(current.record.sourcePolicy) !==
          Contract.stable(input.policy)) fail("existing_occurrence_integrity_failure",
        { integrityStatus: current.status });
      return freeze({ classification: "exact_duplicate", committed: false,
        contentClassification: content.classification, contentWriteCount: content.contentWriteCount,
        metadataWriteCount: content.metadataWriteCount, occurrenceWriteCount: 0,
        occurrenceId: input.occurrence.occurrenceId, contentSha256: input.contentObject.sha256 });
    }
    const record = occurrenceRecord(input.occurrence, input.policy), encoded =
      Buffer.from(`${Contract.stable(record)}\n`, "utf8");
    atomicWrite(file, encoded, "occurrence", fresh => {
      try { return validateOccurrenceRecord(JSON.parse(fresh.toString("utf8"))) === "valid"; }
      catch (_error) { return false; }
    });
    const readback = verifyOccurrence(input.occurrence.occurrenceId);
    if (readback.status !== "valid") fail("occurrence_publish_integrity_failure",
      { integrityStatus: readback.status });
    return freeze({ classification: "new_occurrence", committed: true,
      contentClassification: content.classification, contentWriteCount: content.contentWriteCount,
      metadataWriteCount: content.metadataWriteCount, occurrenceWriteCount: 1,
      occurrenceId: input.occurrence.occurrenceId, contentSha256: input.contentObject.sha256 });
  }

  function readContentMetadata(sha256) {
    const result = verifyContent(sha256);
    if (result.status === "missing") return null;
    if (result.status !== "valid") fail("evidence_integrity_invalid", { integrityStatus: result.status });
    return freeze(clone(result.metadata));
  }

  function readRawBytes(sha256) {
    const result = verifyContent(sha256);
    if (result.status === "missing") return null;
    if (result.status !== "valid") fail("evidence_integrity_invalid", { integrityStatus: result.status });
    return Buffer.from(secureRead(objectFile(sha256), result.metadata.contentObject.byteLength));
  }

  function readOccurrence(occurrenceId) {
    const result = verifyOccurrence(occurrenceId);
    if (result.status === "missing") return null;
    if (result.status !== "valid") fail("evidence_integrity_invalid", { integrityStatus: result.status });
    return freeze(clone(result.record.occurrence));
  }

  function readAllOccurrenceRecords() {
    if (!structure(false)) return [];
    const names = fs.readdirSync(directories.occurrences).sort(), records = [];
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) fail("vault_inventory_invalid");
      const occurrenceId = `source-occurrence-v1|sha256:${name.slice(0, 64)}`;
      const result = verifyOccurrence(occurrenceId);
      if (result.status !== "valid") fail("evidence_integrity_invalid",
        { integrityStatus: result.status, occurrenceId });
      records.push(result.record);
    }
    return records;
  }

  function occurrencesByContentSha256(sha256) {
    contentAddressParts(sha256);
    return freeze(readAllOccurrenceRecords().filter(record =>
      record.occurrence.contentSha256 === sha256).map(record => clone(record.occurrence)));
  }

  function listOrphanContentObjects() {
    if (!structure(false)) return freeze([]);
    const referenced = new Set(readAllOccurrenceRecords().map(record => record.occurrence.contentSha256));
    const results = [];
    for (const prefix of fs.readdirSync(directories.objects).sort()) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) fail("vault_inventory_invalid");
      const directory = path.join(directories.objects, prefix);
      if (directoryState(directory) !== "valid") fail("vault_path_unsafe");
      for (const sha256 of fs.readdirSync(directory).sort()) {
        if (!hash(sha256) || !sha256.startsWith(prefix)) fail("vault_inventory_invalid");
        if (!referenced.has(sha256)) results.push({ sha256, integrityStatus: verifyContent(sha256).status });
      }
    }
    return freeze(results);
  }

  function vaultStatus() {
    if (!structure(false)) return freeze({ status: "absent", occurrenceCount: 0 });
    const records = readAllOccurrenceRecords();
    return freeze({ status: records.length ? "active" : "empty", occurrenceCount: records.length });
  }

  return freeze({ vaultSchemaVersion: VAULT_SCHEMA_VERSION, storeAcceptedEvidence,
    readContentMetadata, readRawBytes, readOccurrence, occurrencesByContentSha256,
    verifyContent, verifyOccurrence, verifyEvidence: verifyOccurrence,
    listOrphanContentObjects, vaultStatus });
}

function createIsolatedVault(options = {}) {
  if (!exact(options, ["root", "targetEnvironment", "crashAt"]) ||
      options.targetEnvironment !== "isolated_test") fail("isolated_vault_options_invalid");
  return createVault({ profileRoot: options.root, targetEnvironment: options.targetEnvironment,
    crashAt: options.crashAt });
}

function createProductionVault(authority) {
  if (!exact(authority, ["getUserDataPath"]) || typeof authority.getUserDataPath !== "function")
    fail("production_vault_authority_invalid");
  return createVault({ profileRoot: authority.getUserDataPath(), targetEnvironment: "production",
    crashAt: null });
}

module.exports = freeze({ VAULT_DIRECTORY, VAULT_VERSION_DIRECTORY, VAULT_SCHEMA_VERSION,
  CONTENT_RECORD_TYPE, OCCURRENCE_RECORD_TYPE, MAX_METADATA_BYTES, DIRECTORY_NAMES,
  CRASH_POINTS, INTEGRITY_STATUSES, CONTENT_METADATA_FIELDS, OCCURRENCE_RECORD_FIELDS,
  contentAddressParts, createIsolatedVault, createProductionVault });
