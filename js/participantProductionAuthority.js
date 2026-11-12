"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Filesystem = require("./marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Participants = require("./participantAcquisitionAuthorityContract.js");

const RECORD_VERSION = "participants-production-authority-v1";
const KEY_ID = "participants-main-production-v1";
const FILE_NAME = "participants-main-authority-v1.json";
const MAX_BYTES = 16 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

function recordFor(ciphertext) {
  const material = { contractVersion: RECORD_VERSION, keyId: KEY_ID, ciphertext };
  return { ...material, integritySha256: digest(stable(material)) };
}

function validateRecord(value) {
  if (!exact(value, ["contractVersion", "keyId", "ciphertext", "integritySha256"]) ||
      value.contractVersion !== RECORD_VERSION || value.keyId !== KEY_ID ||
      typeof value.ciphertext !== "string" || !/^[A-Za-z0-9+/=]+$/.test(value.ciphertext) ||
      !/^[0-9a-f]{64}$/.test(value.integritySha256)) return false;
  return value.integritySha256 === digest(stable({ contractVersion: value.contractVersion,
    keyId: value.keyId, ciphertext: value.ciphertext }));
}

function createProductionAuthority(options) {
  if (!exact(options, ["getUserDataPath", "protector", "randomBytes"]) ||
      typeof options.getUserDataPath !== "function" ||
      typeof options.protector?.protect !== "function" ||
      typeof options.protector?.unprotect !== "function" ||
      typeof options.randomBytes !== "function") {
    throw new TypeError("participants_production_authority_options_invalid");
  }
  const root = options.getUserDataPath();
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new Error("participants_production_authority_profile_invalid");
  let profile;
  try { profile = Filesystem.canonical(root); }
  catch (_error) { throw new Error("participants_production_authority_profile_invalid"); }
  const file = path.join(profile, FILE_NAME);
  if (!Filesystem.contains(profile, file))
    throw new Error("participants_production_authority_path_invalid");

  function readSecret() {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (!Filesystem.secureFileStat(stat, { maxBytes: MAX_BYTES }) ||
        !Filesystem.samePath(fs.realpathSync(file), file))
      throw new Error("participants_production_authority_file_unsafe");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | Filesystem.noFollowFlag());
    try {
      const opened = fs.fstatSync(descriptor);
      if (!Filesystem.secureFileStat(opened, { maxBytes: MAX_BYTES }) ||
          opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("participants_production_authority_file_unsafe");
      let record;
      try { record = JSON.parse(fs.readFileSync(descriptor, "utf8")); }
      catch (_error) { throw new Error("participants_production_authority_record_invalid"); }
      if (!validateRecord(record))
        throw new Error("participants_production_authority_record_invalid");
      const secret = options.protector.unprotect(Buffer.from(record.ciphertext, "base64"));
      if (!Buffer.isBuffer(secret) || secret.byteLength !== 32)
        throw new Error("participants_production_authority_secret_invalid");
      return Buffer.from(secret);
    } finally { fs.closeSync(descriptor); }
  }

  function createSecret() {
    const secret = options.randomBytes(32);
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32)
      throw new Error("participants_production_authority_random_invalid");
    const encrypted = options.protector.protect(Buffer.from(secret));
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0)
      throw new Error("participants_production_authority_protection_failed");
    const bytes = Buffer.from(`${JSON.stringify(recordFor(encrypted.toString("base64")))}\n`);
    const temporary = path.join(profile, `.${FILE_NAME}.${crypto.randomUUID()}.tmp`);
    let published = false;
    try {
      const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | Filesystem.noFollowFlag(), 0o600);
      try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file); published = true; Filesystem.syncDirectory(profile);
    } finally {
      if (!published) { try { fs.unlinkSync(temporary); }
        catch (error) { if (error?.code !== "ENOENT") throw error; } }
    }
    return Buffer.from(secret);
  }

  const secret = readSecret() || createSecret();
  return Object.freeze({ authority: Participants.createMainAuthority({ keyId: KEY_ID, secret }),
    keyId: KEY_ID, recordVersion: RECORD_VERSION });
}

module.exports = Object.freeze({ RECORD_VERSION, KEY_ID, FILE_NAME, MAX_BYTES,
  validateRecord, createProductionAuthority });
