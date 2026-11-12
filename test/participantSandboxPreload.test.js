"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Native = require("../scripts/participantSandboxPreloadNative.js");
const Builder = require("../scripts/buildPreloadBundle.js");

const ROOT = path.resolve(__dirname, "..");
const EXPECTED_KEYS = Object.freeze([
  "acquireParticipants", "acquireQriPage", "acquireWeekly", "checkCalendarSources",
  "evaluateMorningV5Formal", "evaluateOverallV2Trace",
  "finalizeQriPage", "getRuntimeMetadata",
  "readMorningV5Formal", "readOverallV2Trace", "requestCalendarSource",
  "saveCalendarExportJson", "saveFullExportJson"
].sort());

test("FIX1 generated preload artifact is deterministic and contains only fixed dependencies", () => {
  const output = fs.readFileSync(path.join(ROOT, "preload.bundle.js"), "utf8");
  assert.equal(output, Builder.buildBundle());
  assert.deepEqual(Builder.MODULE_FILES, ["preload.js",
    "js/participantFormalBridgeContract.js", "js/participantFormalProductionWriter.js",
    "js/formalArchive/participantFormalArchiveSchema.js", "js/participantData.js"]);
  assert.doesNotMatch(output, /exposeInMainWorld\([^)]*(?:ipcRenderer|require|process)/s);
});

test("FIX1 real sandboxed preload publishes bridge and completes startup/IPC/Formal round trips", () => {
  const result = Native.nativeCase();
  assert.deepEqual(result.bridge.keys, EXPECTED_KEYS);
  assert.equal(result.bridge.frozen, true);
  assert.deepEqual([result.bridge.startupRefresh, result.bridge.refresh, result.bridge.node],
    ["function", "function", "undefined"]);
  assert.deepEqual(result.security, { sandbox: true, nodeIntegration: false,
    contextIsolation: true });
  assert.equal(result.consoleErrors.length, 0);
  assert.equal(result.startup.state.phase, "complete");
  assert.deepEqual(result.startup.phases, ["refreshing", "idle"]);
  assert.equal(result.acquireCount, 3);
  assert.deepEqual([result.successDuring, result.successResult.disabled,
    result.successResult.value.status], [true, false, "available"]);
  assert.deepEqual([result.failureDuring, result.failureResult.disabled,
    result.failureResult.value, result.failureResult.errors],
  [true, false, null, ["Error invoking remote method 'acquire-participants': Error: fixture_acquisition_failed"]]);
  assert.deepEqual([result.formal.status, result.formal.classification,
    result.formal.revisionWriteCount, result.formal.transactionCount],
  ["accepted", "new_revision", 1, 1]);
});
