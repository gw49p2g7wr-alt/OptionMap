"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const Filesystem = require("./marketCalendarHistory/crossPlatformFilesystemSafety.js");

const REWRAP_VERSION = "production-authority-rewrap-v1";
const LEGACY_IDENTITY = "optionmap";
const CANONICAL_IDENTITY = "OptionMap";
const HELPER_FLAG = "--optionmap-authority-legacy-decrypt=";
const TEST_PROFILE_ENV = "OPTIONMAP_AUTHORITY_REWRAP_TEST_PROFILE";
const TEST_PROFILE_PREFIX = "optionmap-authority-rewrap-";
const HELPER_TIMEOUT_MS = 15_000;
const SECRET_BYTES = 32;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));

function contract(domain) {
  const api = domain === "qri" ? require("./qriProductionAuthority.js") :
    domain === "participants" ? require("./participantProductionAuthority.js") : null;
  if (!api || typeof api.recordFor !== "function" || typeof api.validateRecord !== "function")
    throw error("authority_rewrap_invalid_record");
  return Object.freeze({ domain, fileName: api.FILE_NAME, recordVersion: api.RECORD_VERSION,
    keyId: api.KEY_ID, maxBytes: api.MAX_BYTES, recordFor: api.recordFor,
    validateRecord: api.validateRecord });
}

function error(reason, cause = null) {
  const value = new Error(reason);
  value.code = reason;
  if (cause) value.causeCode = cause;
  return value;
}

function helperDomain(argv) {
  const flags = argv.filter(value => typeof value === "string" && value.startsWith(HELPER_FLAG));
  if (flags.length !== 1) return null;
  const domain = flags[0].slice(HELPER_FLAG.length);
  return ["qri", "participants"].includes(domain) ? domain : "invalid";
}

function canonicalProfile(root) {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw error("authority_rewrap_invalid_record");
  let profile;
  try { profile = Filesystem.canonical(root); }
  catch (_error) { throw error("authority_rewrap_invalid_record"); }
  return profile;
}

function helperProfile(app, env = process.env) {
  const testProfile = env[TEST_PROFILE_ENV];
  if (testProfile !== undefined) {
    if (app.isPackaged || typeof testProfile !== "string" || !path.isAbsolute(testProfile))
      throw error("authority_rewrap_invalid_record");
    const profile = canonicalProfile(testProfile), temporaryRoots =
      [fs.realpathSync(os.tmpdir()), fs.realpathSync("/private/tmp")];
    if (!temporaryRoots.includes(path.dirname(profile)) ||
        !path.basename(profile).startsWith(TEST_PROFILE_PREFIX))
      throw error("authority_rewrap_invalid_record");
    return profile;
  }
  return canonicalProfile(path.join(app.getPath("appData"), CANONICAL_IDENTITY));
}

function secureRecord(profile, descriptor, fsApi = fs) {
  const file = path.join(profile, descriptor.fileName);
  if (!Filesystem.contains(profile, file)) throw error("authority_rewrap_invalid_record");
  let stat;
  try { stat = fsApi.lstatSync(file); }
  catch (failure) {
    if (failure?.code === "ENOENT") return Object.freeze({ file, absent: true });
    throw error("authority_rewrap_invalid_record");
  }
  if (!Filesystem.secureFileStat(stat, { maxBytes: descriptor.maxBytes }) ||
      !Filesystem.samePath(fsApi.realpathSync(file), file))
    throw error("authority_rewrap_invalid_record");
  const fd = fsApi.openSync(file, fs.constants.O_RDONLY | Filesystem.noFollowFlag());
  try {
    const opened = fsApi.fstatSync(fd);
    if (!Filesystem.secureFileStat(opened, { maxBytes: descriptor.maxBytes }) ||
        opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw error("authority_rewrap_invalid_record");
    const bytes = fsApi.readFileSync(fd), after = fsApi.lstatSync(file);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size)
      throw error("authority_rewrap_invalid_record");
    let record;
    try { record = JSON.parse(bytes.toString("utf8")); }
    catch (_error) { throw error("authority_rewrap_invalid_record"); }
    if (!descriptor.validateRecord(record)) throw error("authority_rewrap_invalid_record");
    return Object.freeze({ file, absent: false, bytes: Buffer.from(bytes), record,
      stat: Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size }) });
  } finally { fsApi.closeSync(fd); }
}

function unprotect(protector, record) {
  try {
    const secret = protector.unprotect(Buffer.from(record.ciphertext, "base64"));
    return Buffer.isBuffer(secret) && secret.byteLength === SECRET_BYTES ? Buffer.from(secret) : null;
  } catch (_error) { return null; }
}

function writeExclusive(file, bytes, fsApi = fs) {
  const fd = fsApi.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT |
    fs.constants.O_EXCL | Filesystem.noFollowFlag(), 0o600);
  try { fsApi.writeFileSync(fd, bytes); fsApi.fsyncSync(fd); }
  finally { fsApi.closeSync(fd); }
}

function sameBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.byteLength === right.byteLength &&
    crypto.timingSafeEqual(left, right);
}

function restoreOriginal(file, rollback, fsApi) {
  try { fsApi.renameSync(rollback, file); return true; }
  catch (_error) {
    try { fsApi.unlinkSync(file); fsApi.renameSync(rollback, file); return true; }
    catch (_second) { return false; }
  }
}

function migrateAuthorityRecord(options) {
  const fields = ["domain", "profile", "protector", "legacyDecrypt"];
  const allowed = [...fields, "fsApi", "testHooks"];
  if (!object(options) || !fields.every(field => Object.hasOwn(options, field)) ||
      !Object.keys(options).every(field => allowed.includes(field)) ||
      typeof options.protector?.protect !== "function" ||
      typeof options.protector?.unprotect !== "function" ||
      typeof options.legacyDecrypt !== "function")
    throw new TypeError("authority_rewrap_options_invalid");
  const descriptor = contract(options.domain), profile = canonicalProfile(options.profile),
    fsApi = options.fsApi || fs, testHooks = options.testHooks || null;
  const first = secureRecord(profile, descriptor, fsApi);
  if (first.absent) return Object.freeze({ status: "absent", writeCount: 0,
    secretEqualityVerified: false, domain: descriptor.domain });
  const canonicalSecret = unprotect(options.protector, first.record);
  if (canonicalSecret) {
    canonicalSecret.fill(0);
    return Object.freeze({ status: "canonical", writeCount: 0,
      secretEqualityVerified: true, domain: descriptor.domain });
  }
  let legacySecret;
  try { legacySecret = options.legacyDecrypt(descriptor.domain); }
  catch (_error) { throw error("authority_rewrap_unavailable", "authority_legacy_decrypt_failed"); }
  if (!Buffer.isBuffer(legacySecret) || legacySecret.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(legacySecret)) legacySecret.fill(0);
    throw error("authority_rewrap_unavailable", "authority_legacy_decrypt_failed");
  }
  const secret = Buffer.from(legacySecret); legacySecret.fill(0);
  let encrypted, candidateSecret;
  try {
    encrypted = options.protector.protect(Buffer.from(secret));
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0)
      throw error("authority_rewrap_verify_failed");
    const record = descriptor.recordFor(encrypted.toString("base64"));
    if (!descriptor.validateRecord(record)) throw error("authority_rewrap_invalid_record");
    candidateSecret = unprotect(options.protector, record);
    if (!candidateSecret || !sameBytes(candidateSecret, secret))
      throw error("authority_rewrap_secret_mismatch");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), token = crypto.randomUUID(),
      temporary = path.join(profile, `.${descriptor.fileName}.${token}.rewrap.tmp`),
      rollback = path.join(profile, `.${descriptor.fileName}.${token}.rewrap.rollback`);
    let replaced = false, rollbackPresent = false;
    try {
      writeExclusive(temporary, bytes, fsApi);
      const staged = fsApi.readFileSync(temporary);
      if (!sameBytes(staged, bytes)) throw error("authority_rewrap_verify_failed");
      writeExclusive(rollback, first.bytes, fsApi); rollbackPresent = true;
      if (!sameBytes(fsApi.readFileSync(rollback), first.bytes))
        throw error("authority_rewrap_verify_failed");
      const current = secureRecord(profile, descriptor, fsApi);
      if (current.absent || !sameBytes(current.bytes, first.bytes) ||
          current.stat.dev !== first.stat.dev || current.stat.ino !== first.stat.ino)
        throw error("authority_rewrap_atomic_replace_failed");
      testHooks?.at?.("before_replace");
      fsApi.renameSync(temporary, first.file); replaced = true;
      Filesystem.syncDirectory(profile, fsApi);
      testHooks?.at?.("after_replace");
      const published = secureRecord(profile, descriptor, fsApi),
        publishedSecret = published.absent ? null : unprotect(options.protector, published.record);
      testHooks?.at?.("before_readback_verify");
      if (!publishedSecret || !sameBytes(publishedSecret, secret)) {
        publishedSecret?.fill(0);
        throw error("authority_rewrap_verify_failed");
      }
      publishedSecret.fill(0);
      fsApi.unlinkSync(rollback); rollbackPresent = false;
      Filesystem.syncDirectory(profile, fsApi);
      return Object.freeze({ status: "rewrapped", writeCount: 1,
        secretEqualityVerified: true, domain: descriptor.domain });
    } catch (failure) {
      if (replaced && rollbackPresent && !restoreOriginal(first.file, rollback, fsApi))
        throw error("authority_rewrap_atomic_replace_failed");
      if (rollbackPresent) { try { fsApi.unlinkSync(rollback); } catch (_) {} }
      const reason = failure?.code || failure?.message;
      if (["authority_rewrap_invalid_record", "authority_rewrap_secret_mismatch",
        "authority_rewrap_verify_failed", "authority_rewrap_atomic_replace_failed"].includes(reason))
        throw error(reason);
      throw error("authority_rewrap_atomic_replace_failed");
    } finally {
      try { fsApi.unlinkSync(temporary); } catch (failure) {
        if (failure?.code !== "ENOENT") throw failure;
      }
    }
  } finally {
    secret.fill(0); candidateSecret?.fill(0); encrypted?.fill(0);
  }
}

function invokeLegacyHelper(options) {
  if (!exact(options, ["app", "domain", "profile", "env"]) ||
      !["qri", "participants"].includes(options.domain))
    throw new TypeError("authority_legacy_helper_options_invalid");
  const profile = canonicalProfile(options.profile), expected =
    canonicalProfile(path.join(options.app.getPath("appData"), CANONICAL_IDENTITY));
  const env = { ...options.env }, args = [];
  if (!Filesystem.samePath(profile, expected)) {
    if (options.app.isPackaged || ![fs.realpathSync(os.tmpdir()), fs.realpathSync("/private/tmp")]
      .includes(path.dirname(profile)) || !path.basename(profile).startsWith(TEST_PROFILE_PREFIX))
      throw error("authority_legacy_decrypt_failed");
    env[TEST_PROFILE_ENV] = profile;
  } else delete env[TEST_PROFILE_ENV];
  if (!options.app.isPackaged) args.push(options.app.getAppPath());
  args.push(`${HELPER_FLAG}${options.domain}`);
  const child = childProcess.spawnSync(process.execPath, args, { env, windowsHide: true,
    timeout: HELPER_TIMEOUT_MS, maxBuffer: 1024, stdio: ["ignore", "ignore", "pipe", "pipe"] });
  const secret = child.output?.[3];
  if (child.status !== 0 || child.signal || child.error || !Buffer.isBuffer(secret) ||
      secret.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(secret)) secret.fill(0);
    throw error("authority_legacy_decrypt_failed");
  }
  return Buffer.from(secret);
}

async function runLegacyHelper(options) {
  if (!exact(options, ["app", "safeStorage", "domain", "env", "outputFd"]) ||
      !["qri", "participants"].includes(options.domain) || options.outputFd !== 3)
    return 2;
  let secret = null;
  try {
    const descriptor = contract(options.domain), profile = helperProfile(options.app, options.env),
      source = secureRecord(profile, descriptor);
    if (source.absent || !options.safeStorage.isEncryptionAvailable()) return 3;
    secret = unprotect(Object.freeze({ unprotect: bytes => Buffer.from(
      options.safeStorage.decryptString(bytes), "base64") }), source.record);
    if (!secret) return 3;
    fs.writeSync(options.outputFd, secret);
    return 0;
  } catch (_error) { return 3; }
  finally { secret?.fill(0); }
}

module.exports = Object.freeze({ REWRAP_VERSION, LEGACY_IDENTITY, CANONICAL_IDENTITY,
  HELPER_FLAG, TEST_PROFILE_ENV, TEST_PROFILE_PREFIX, HELPER_TIMEOUT_MS, SECRET_BYTES,
  contract, helperDomain, helperProfile, secureRecord, migrateAuthorityRecord,
  invokeLegacyHelper, runLegacyHelper });
