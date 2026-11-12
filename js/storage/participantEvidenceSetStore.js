"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Vault = require("../sourceEvidence/sourceEvidenceVault.js");
const Filesystem = require("../marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Contract = require("../participantEvidenceSetContract.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");

const DIRECTORY_NAME = "participants-fixed-four-sets";
const MAX_SET_BYTES = 256_000;

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const absent = error => error?.code === "ENOENT";

function fail(reason) { throw new Error(reason); }

function setDigest(value) {
  const match = /^participants-evidence-set-v1\|sha256:([0-9a-f]{64})$/.exec(value || "");
  if (!match) fail("participants_evidence_set_id_invalid");
  return match[1];
}

function createParticipantEvidenceSetStore(options = {}) {
  if (!exact(options, ["root", "targetEnvironment"]) ||
      !["isolated_test", "production"].includes(options.targetEnvironment) ||
      typeof options.root !== "string" || !path.isAbsolute(options.root))
    fail("participants_evidence_set_store_options_invalid");
  let profile;
  try { profile = fs.realpathSync(options.root); }
  catch (_error) { fail("participants_evidence_set_profile_invalid"); }
  const stat = fs.lstatSync(profile);
  if (!Filesystem.samePath(profile, options.root) ||
      !Filesystem.secureDirectoryStat(stat) || stat.isSymbolicLink() ||
      (options.targetEnvironment === "isolated_test" &&
        !Filesystem.samePath(path.dirname(profile), fs.realpathSync(os.tmpdir()))))
    fail("participants_evidence_set_profile_invalid");
  const vaultParent = path.join(profile, Vault.VAULT_DIRECTORY),
    vaultRoot = path.join(vaultParent, Vault.VAULT_VERSION_DIRECTORY),
    directory = path.join(vaultRoot, DIRECTORY_NAME);

  function directoryState(target) {
    let value;
    try { value = fs.lstatSync(target); } catch (error) { if (absent(error)) return "missing"; throw error; }
    if (!Filesystem.secureDirectoryStat(value) || value.isSymbolicLink() ||
        !Filesystem.samePath(fs.realpathSync(target), target) || !Filesystem.contains(profile, target))
      fail("participants_evidence_set_path_unsafe");
    return "valid";
  }

  function ensureDirectory(target, parent) {
    if (directoryState(target) === "valid") return;
    if (directoryState(parent) !== "valid" || !Filesystem.samePath(path.dirname(target), parent))
      fail("participants_evidence_set_path_unsafe");
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
    if (directoryState(target) !== "valid") fail("participants_evidence_set_path_unsafe");
  }

  function ensureStructure() {
    if (directoryState(vaultParent) !== "valid" || directoryState(vaultRoot) !== "valid")
      fail("participants_evidence_vault_unavailable");
    ensureDirectory(directory, vaultRoot);
  }

  function fileFor(evidenceSetId) {
    const digest = setDigest(evidenceSetId), file = path.join(directory, `${digest}.json`);
    if (!Filesystem.contains(directory, file)) fail("participants_evidence_set_path_unsafe");
    return file;
  }

  function secureRead(file) {
    let before;
    try { before = fs.lstatSync(file); } catch (error) { if (absent(error)) return null; throw error; }
    if (!Filesystem.secureFileStat(before, { maxBytes: MAX_SET_BYTES }) ||
        !Filesystem.samePath(fs.realpathSync(file), file) || !Filesystem.contains(directory, file))
      fail("participants_evidence_set_path_unsafe");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | Filesystem.noFollowFlag());
    try {
      const opened = fs.fstatSync(descriptor);
      if (!Filesystem.secureFileStat(opened, { maxBytes: MAX_SET_BYTES }) ||
          opened.dev !== before.dev || opened.ino !== before.ino)
        fail("participants_evidence_set_path_unsafe");
      const bytes = fs.readFileSync(descriptor), after = fs.lstatSync(file);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size)
        fail("participants_evidence_set_path_unsafe");
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }

  function decode(bytes, authority) {
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch (_error) { fail("participants_evidence_set_record_invalid"); }
    if (!Contract.validateEvidenceSet(value, authority))
      fail("participants_evidence_set_record_invalid");
    return Object.freeze(structuredClone(value));
  }

  function read(evidenceSetId, authority) {
    const file = fileFor(evidenceSetId);
    if (directoryState(directory) === "missing") return null;
    const bytes = secureRead(file);
    return bytes === null ? null : decode(bytes, authority);
  }

  function store(value, authority) {
    if (!Contract.validateEvidenceSet(value, authority))
      fail("participants_evidence_set_contract_invalid");
    ensureStructure();
    const finalFile = fileFor(value.evidenceSetId), existing = secureRead(finalFile);
    if (existing !== null) {
      const current = decode(existing, authority);
      if (Evidence.stable(current) !== Evidence.stable(value))
        fail("participants_evidence_set_existing_mismatch");
      return Object.freeze({ classification: "exact_duplicate", writeCount: 0,
        evidenceSetId: value.evidenceSetId });
    }
    const encoded = Buffer.from(`${Evidence.stable(value)}\n`, "utf8");
    if (encoded.byteLength > MAX_SET_BYTES) fail("participants_evidence_set_record_oversize");
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    let promoted = false;
    try {
      const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | Filesystem.noFollowFlag(), 0o600);
      try { fs.writeFileSync(descriptor, encoded); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      const fresh = secureRead(temporary);
      if (!fresh || Evidence.stable(decode(fresh, authority)) !== Evidence.stable(value))
        fail("participants_evidence_set_temp_readback_invalid");
      if (fs.existsSync(finalFile)) fail("participants_evidence_set_immutable_target_exists");
      fs.renameSync(temporary, finalFile); promoted = true;
      Filesystem.syncDirectory(directory);
      const published = secureRead(finalFile);
      if (!published || Evidence.stable(decode(published, authority)) !== Evidence.stable(value))
        fail("participants_evidence_set_publish_readback_invalid");
      return Object.freeze({ classification: "created", writeCount: 1,
        evidenceSetId: value.evidenceSetId });
    } finally {
      if (!promoted) { try { fs.unlinkSync(temporary); } catch (error) { if (!absent(error)) throw error; } }
    }
  }

  return Object.freeze({ store, read, directoryName: DIRECTORY_NAME });
}

function createIsolatedParticipantEvidenceSetStore(options = {}) {
  if (!exact(options, ["root", "targetEnvironment"]) ||
      options.targetEnvironment !== "isolated_test")
    fail("participants_evidence_set_store_options_invalid");
  return createParticipantEvidenceSetStore(options);
}

function createProductionParticipantEvidenceSetStore(authority = {}) {
  if (!exact(authority, ["getUserDataPath"]) || typeof authority.getUserDataPath !== "function")
    fail("participants_evidence_set_production_authority_invalid");
  return createParticipantEvidenceSetStore({ root: authority.getUserDataPath(),
    targetEnvironment: "production" });
}

module.exports = Object.freeze({ DIRECTORY_NAME, MAX_SET_BYTES, setDigest,
  createIsolatedParticipantEvidenceSetStore, createProductionParticipantEvidenceSetStore });
