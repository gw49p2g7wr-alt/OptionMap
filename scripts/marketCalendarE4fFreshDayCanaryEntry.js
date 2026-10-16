"use strict";

// Dedicated acceptance entry, not main/startup/IPC integration. The controller
// owns approval, state, opaque startup and write authority; this owns delivery.
const fs = require("node:fs"), path = require("node:path");
const os = require("node:os"), { createHash } = require("node:crypto"), { TextDecoder } = require("node:util");
const Controller = require("./marketCalendarE4fFreshDayCanary.js");
const Approval = require("../js/marketCalendarRuntime/freshDayCanaryApproval.js");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const TYPE = "fresh_day_canary_entry_receipt";
const LATCH = Symbol.for("optionmap.fresh-day-canary.package-entry.v1");
const safe = reason => typeof reason === "string" && /^[a-z_]+$/.test(reason) ? reason : "controller_rejected";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const RECEIPT_FILE = "fresh-day-canary-receipt.json", COMPLETION_FILE = "fresh-day-canary-receipt.complete.json";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function mainOnly() {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
}
function receiptRoot(root) {
  mainOnly();
  if (typeof root !== "string" || !Filesystem.samePath(fs.realpathSync(root), root) ||
      !Filesystem.samePath(path.dirname(root), fs.realpathSync(os.tmpdir())) || !path.basename(root).startsWith("optionmap-writer-safety-") ||
      !Filesystem.secureDirectoryStat(fs.lstatSync(root))) throw Error("receipt_root_invalid");
}
function messageShape(message) {
  const keys = ["type", "entryReached", "controllerReached", "controllerInvocations", "receiptReceived", "receipt"];
  if (!message || Object.keys(message).length !== keys.length || keys.some(k => !Object.hasOwn(message, k)) ||
      message.type !== TYPE || message.entryReached !== true || message.controllerReached !== true ||
      message.controllerInvocations !== 1 || typeof message.receiptReceived !== "boolean" ||
      !message.receipt || !["PASS", "HOLD", "FAIL"].includes(message.receipt.status) || controllerReceipt(message.receipt))
    throw Error("receipt_schema_invalid");
}
function readBounded(root, name, limit) {
  const target = path.join(root, name);
  if (!Filesystem.samePath(fs.realpathSync(target), target)) throw Error("receipt_file_invalid");
  const fd = fs.openSync(target, fs.constants.O_RDONLY | Filesystem.noFollowFlag());
  try {
    const stat = fs.fstatSync(fd);
    if (!Filesystem.secureFileStat(stat, { maxBytes: limit }))
      throw Error("receipt_file_invalid");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > limit) throw Error("receipt_length_invalid");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function syncDirectory(root) { Filesystem.syncDirectory(root); }
function writeReceipt(root, message) {
  receiptRoot(root); messageShape(message);
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  if (bytes.length > MAX_RECEIPT_BYTES) throw Error("receipt_too_large");
  const temporary = COMPLETION_FILE + ".tmp";
  if ([RECEIPT_FILE, COMPLETION_FILE, temporary].some(name => fs.existsSync(path.join(root, name))))
    throw Error("receipt_already_exists");
  function writeNew(name, data) {
    const fd = fs.openSync(path.join(root, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  // The receipt's exclusive creation is the one-writer claim. A partial file
  // without a completion marker is never adopted, overwritten or repaired.
  writeNew(RECEIPT_FILE, bytes); syncDirectory(root);
  const marker = { schemaVersion: 1, type: TYPE, byteLength: bytes.length, sha256: hash(bytes) };
  writeNew(temporary, JSON.stringify(marker) + "\n");
  fs.renameSync(path.join(root, temporary), path.join(root, COMPLETION_FILE)); syncDirectory(root);
  const verified = readReceipt(root, message.receipt.status === "FAIL" ? 1 : 0);
  if (verified.byteLength !== marker.byteLength || verified.sha256 !== marker.sha256) throw Error("receipt_handoff_failed");
  return marker;
}
function readReceipt(root, exitCode) {
  receiptRoot(root);
  const markerBytes = readBounded(root, COMPLETION_FILE, 1024);
  const marker = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(markerBytes));
  const keys = ["schemaVersion", "type", "byteLength", "sha256"];
  if (!marker || Object.keys(marker).length !== keys.length || keys.some(k => !Object.hasOwn(marker, k)) ||
      marker.schemaVersion !== 1 || marker.type !== TYPE || !Number.isSafeInteger(marker.byteLength) ||
      marker.byteLength <= 0 || marker.byteLength > MAX_RECEIPT_BYTES || !/^[a-f0-9]{64}$/.test(marker.sha256))
    throw Error("receipt_marker_invalid");
  if (!markerBytes.equals(Buffer.from(JSON.stringify(marker) + "\n"))) throw Error("receipt_marker_noncanonical");
  const bytes = readBounded(root, RECEIPT_FILE, MAX_RECEIPT_BYTES);
  if (bytes.length !== marker.byteLength || hash(bytes) !== marker.sha256) throw Error("receipt_length_or_hash_mismatch");
  const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!bytes.equals(Buffer.from(JSON.stringify(message) + "\n"))) throw Error("receipt_noncanonical");
  messageShape(message);
  return { message, byteLength: bytes.length, sha256: marker.sha256, delivery: validateDelivery(message, exitCode) };
}
function controllerReceipt(value) {
  if (!value || !["PASS", "HOLD", "FAIL"].includes(value.status)) return "controller_receipt_missing";
  if (value.status === "FAIL") return null;
  if (value.valid !== true || value.sourceId !== Approval.SOURCE || value.startupInvocations !== 1 ||
      value.retryCount !== 0 || value.migrationCalls !== 0 || value.transitionCalls !== 0)
    return "controller_receipt_invalid";
  if (value.status === "PASS" && (value.reason !== null || value.authorizationCount !== 1 ||
      value.fenceCount !== 1 || value.completionCount !== 1 || value.freshReadonlyReadback !== true))
    return "controller_receipt_invalid";
  if (value.status === "HOLD" && (value.reason !== "already_succeeded_today" || value.authorizationCount !== 0 ||
      value.fenceCount !== 0 || value.completionCount !== 0 || value.formalWrite !== 0))
    return "controller_receipt_invalid";
  return null;
}
function validateDelivery(message, exitCode) {
  if (!message || message.type !== TYPE || message.entryReached !== true || message.controllerReached !== true ||
      message.controllerInvocations !== 1 || message.receiptReceived !== true)
    return { valid: false, status: "FAIL", reason: "entry_receipt_missing" };
  const reason = controllerReceipt(message.receipt);
  if (reason || message.receipt.status === "FAIL" || exitCode !== 0)
    return { valid: false, status: "FAIL", reason: reason || safe(message.receipt.reason) };
  return { valid: true, status: message.receipt.status, reason: message.receipt.reason };
}
function createEntryAdapter(options) {
  mainOnly();
  if (!options || Object.keys(options).length !== 3 ||
      ["runController", "handoff", "quit"].some(k => typeof options[k] !== "function")) throw Error("entry_dependencies_invalid");
  const { runController, handoff, quit } = options;
  let attempt = null;
  return Object.freeze({ run: (...args) => {
    mainOnly(); if (args.length) throw Error("entry_arguments_forbidden");
    if (attempt) return attempt;
    attempt = Promise.resolve().then(async () => {
      let receipt, received = false;
      try {
        receipt = await runController(); received = !!receipt;
        const reason = controllerReceipt(receipt);
        if (reason) receipt = { status: "FAIL", reason };
      } catch (e) { receipt = { status: "FAIL", reason: safe(e?.message) }; }
      const message = { type: TYPE, entryReached: true, controllerReached: true,
        controllerInvocations: 1, receiptReceived: received, receipt };
      try { await handoff(message); }
      catch (_) {
        const failed = { ...message, receipt: { status: "FAIL", reason: "receipt_handoff_failed" } };
        await quit(1); return failed;
      }
      await quit(receipt.status === "FAIL" ? 1 : 0);
      return message;
    });
    return attempt;
  } });
}
function isDedicatedPackageEntry() {
  if (process.type !== "browser" || !process.versions.electron) return false;
  try {
    const root = require("electron").app.getAppPath();
    const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof metadata.main === "string" && Filesystem.samePath(fs.realpathSync(path.resolve(root, metadata.main)), __filename);
  } catch (_) { return false; }
}
if (isDedicatedPackageEntry() && !Object.hasOwn(globalThis, LATCH)) {
  // The global latch also covers a second module evaluation/import. No lifecycle
  // callback is an issuer and the entry accepts no source/operation/worker input.
  const adapter = createEntryAdapter({ runController: () => Controller.runProductionAcceptance(),
    handoff: message => {
      const marker = writeReceipt(require("electron").app.getAppPath(), message);
      // stdout is optional telemetry, never the large receipt authority. The
      // complete, fsynced local artifact exists before app exit is permitted.
      process.stdout.write(JSON.stringify({ type: "fresh_day_canary_transport_summary", status: message.receipt.status,
        byteLength: marker.byteLength, sha256: marker.sha256 }) + "\n");
    },
    quit: code => {
      // Electron app.quit() does not propagate Node's process.exitCode. All
      // controller cleanup and stdout handoff have finished before this point.
      const app = require("electron").app;
      if (code === 0) app.quit(); else app.exit(code);
    } });
  Object.defineProperty(globalThis, LATCH, { value: adapter.run(), configurable: false, writable: false });
}
module.exports = Object.freeze({ TYPE, createEntryAdapter, validateDelivery, writeReceipt, readReceipt });
