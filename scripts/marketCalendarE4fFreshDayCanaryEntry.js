"use strict";

// Dedicated acceptance entry, not main/startup/IPC integration. The controller
// owns approval, state, opaque startup and write authority; this owns delivery.
const fs = require("node:fs"), path = require("node:path");
const Controller = require("./marketCalendarE4fFreshDayCanary.js");
const Approval = require("../js/marketCalendarRuntime/freshDayCanaryApproval.js");
const TYPE = "fresh_day_canary_entry_receipt";
const LATCH = Symbol.for("optionmap.fresh-day-canary.package-entry.v1");
const safe = reason => typeof reason === "string" && /^[a-z_]+$/.test(reason) ? reason : "controller_rejected";
function mainOnly() {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
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
    return typeof metadata.main === "string" && fs.realpathSync(path.resolve(root, metadata.main)) === __filename;
  } catch (_) { return false; }
}
if (isDedicatedPackageEntry() && !Object.hasOwn(globalThis, LATCH)) {
  // The global latch also covers a second module evaluation/import. No lifecycle
  // callback is an issuer and the entry accepts no source/operation/worker input.
  const adapter = createEntryAdapter({ runController: () => Controller.runProductionAcceptance(),
    handoff: message => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(message) + "\n",
      error => error ? reject(error) : resolve())),
    quit: code => {
      // Electron app.quit() does not propagate Node's process.exitCode. All
      // controller cleanup and stdout handoff have finished before this point.
      const app = require("electron").app;
      if (code === 0) app.quit(); else app.exit(code);
    } });
  Object.defineProperty(globalThis, LATCH, { value: adapter.run(), configurable: false, writable: false });
}
module.exports = Object.freeze({ TYPE, createEntryAdapter, validateDelivery });
