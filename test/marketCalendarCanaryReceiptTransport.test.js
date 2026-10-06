"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const path = require("node:path"), os = require("node:os"), cp = require("node:child_process"), { createHash } = require("node:crypto");
const Entry = require("../scripts/marketCalendarE4fFreshDayCanaryEntry.js");
const ROOT = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-writer-safety-receipt-test-"));
const FILE = "fresh-day-canary-receipt.json", MARKER = "fresh-day-canary-receipt.complete.json";
const sha = b => createHash("sha256").update(b).digest("hex");
const message = () => ({ type: Entry.TYPE, entryReached: true, controllerReached: true, controllerInvocations: 1,
  receiptReceived: true, receipt: { valid: true, status: "HOLD", reason: "already_succeeded_today",
    sourceId: "jp-esri-machinery-orders-calendar", startupInvocations: 1, retryCount: 0, migrationCalls: 0,
    transitionCalls: 0, authorizationCount: 0, fenceCount: 0, completionCount: 0, formalWrite: 0,
    isolatedLargeEvidence: "日本語🫡".repeat(100000) } });
function withRoot(fn) { const root = ROOT(); try { return fn(root); } finally { fs.rmSync(root, { recursive: true }); } }
function mutate(root, key, value) { const p = path.join(root, MARKER), m = JSON.parse(fs.readFileSync(p)); m[key] = value; fs.writeFileSync(p, JSON.stringify(m) + "\n"); }
test("T1 large UTF-8 receipt >40960 bytes has exact length/hash/JSON after atomic completion", () => withRoot(root => {
  const input = message(), bytes = Buffer.from(JSON.stringify(input) + "\n"), marker = Entry.writeReceipt(root, input);
  assert(bytes.length > 40960); assert.equal(marker.byteLength, bytes.length); assert.equal(marker.sha256, sha(bytes));
  const received = Entry.readReceipt(root, 0); assert.deepEqual(received.message, input);
  assert.equal(received.delivery.status, "HOLD"); assert.equal(received.byteLength, bytes.length);
  assert.equal(received.sha256, sha(bytes)); assert.equal(fs.existsSync(path.join(root, MARKER + ".tmp")), false);
}));
test("T2 exactly one receipt; same or different second publication is rejected", () => withRoot(root => {
  const marker = Entry.writeReceipt(root, message());
  assert.throws(() => Entry.writeReceipt(root, message()), /receipt_already_exists/);
  assert.equal(Entry.readReceipt(root, 0).sha256, marker.sha256);
}));
test("T3 absent completion marker rejects partial receipt", () => withRoot(root => {
  fs.writeFileSync(path.join(root, FILE), '{"type":', { mode: 0o600 });
  assert.throws(() => Entry.readReceipt(root, 0)); assert.throws(() => Entry.writeReceipt(root, message()), /receipt_already_exists/);
}));
test("T4 truncated bytes are rejected, never repaired", () => withRoot(root => {
  Entry.writeReceipt(root, message()); fs.truncateSync(path.join(root, FILE), 40960);
  assert.throws(() => Entry.readReceipt(root, 0), /receipt_length_or_hash_mismatch/);
}));
test("T5 same-length corruption rejects hash", () => withRoot(root => {
  Entry.writeReceipt(root, message()); const p = path.join(root, FILE), b = fs.readFileSync(p); b[20] ^= 1; fs.writeFileSync(p, b);
  assert.throws(() => Entry.readReceipt(root, 0), /receipt_length_or_hash_mismatch/);
}));
test("T6 invalid marker schema and over-limit sizes reject", () => withRoot(root => {
  Entry.writeReceipt(root, message()); mutate(root, "unknown", true); assert.throws(() => Entry.readReceipt(root, 0), /receipt_marker_invalid/);
  const p = path.join(root, MARKER), m = JSON.parse(fs.readFileSync(p)); delete m.unknown; m.byteLength = 8 * 1024 * 1024 + 1;
  fs.writeFileSync(p, JSON.stringify(m) + "\n"); assert.throws(() => Entry.readReceipt(root, 0), /receipt_marker_invalid/);
}));
test("T7 symlink file/root and hardlink receipt reject", () => withRoot(root => {
  Entry.writeReceipt(root, message()); const p = path.join(root, FILE); fs.renameSync(p, p + ".data"); fs.symlinkSync(p + ".data", p);
  assert.throws(() => Entry.readReceipt(root, 0), /receipt_file_invalid/); fs.unlinkSync(p); fs.linkSync(p + ".data", p);
  assert.throws(() => Entry.readReceipt(root, 0), /receipt_file_invalid/);
  const alias = root + "-alias"; try { fs.symlinkSync(root, alias); assert.throws(() => Entry.readReceipt(alias, 0), /receipt_root_invalid/); }
  finally { fs.unlinkSync(alias); }
}));
test("T8 duplicate JSON keys with recomputed length/hash still reject canonical schema", () => withRoot(root => {
  Entry.writeReceipt(root, message()); const p = path.join(root, FILE), s = fs.readFileSync(p, "utf8").replace('"entryReached":true', '"entryReached":false,"entryReached":true');
  fs.writeFileSync(p, s); mutate(root, "byteLength", Buffer.byteLength(s)); mutate(root, "sha256", sha(s));
  assert.throws(() => Entry.readReceipt(root, 0), /receipt_noncanonical/);
}));
test("T9 unknown envelope field and missing reached marker reject before persistence", () => withRoot(root => {
  const m = message(); m.unknown = true; assert.throws(() => Entry.writeReceipt(root, m), /receipt_schema_invalid/); delete m.unknown;
  m.controllerReached = false; assert.throws(() => Entry.writeReceipt(root, m), /receipt_schema_invalid/);
  assert.deepEqual(fs.readdirSync(root), []);
}));
test("T10 oversize receipt rejects without creating artifacts", () => withRoot(root => {
  const m = message(); m.receipt.isolatedLargeEvidence = "x".repeat(8 * 1024 * 1024);
  assert.throws(() => Entry.writeReceipt(root, m), /receipt_too_large/); assert.deepEqual(fs.readdirSync(root), []);
}));
test("T11 fresh parent process validates full large receipt, no stdout authority", () => withRoot(root => {
  const m = message(), marker = Entry.writeReceipt(root, m), entry = require.resolve("../scripts/marketCalendarE4fFreshDayCanaryEntry.js");
  const child = cp.spawnSync(process.execPath, ["-e", `const x=require(${JSON.stringify(entry)}).readReceipt(process.argv[1],0);console.log(JSON.stringify({bytes:x.byteLength,sha:x.sha256,status:x.delivery.status}));`, root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); const out = JSON.parse(child.stdout);
  assert.deepEqual(out, { bytes: marker.byteLength, sha: marker.sha256, status: "HOLD" });
}));
test("T12 failing controller receipt is delivered losslessly but never accepted as PASS", () => withRoot(root => {
  const m = message(); m.receipt = { status: "FAIL", reason: "fixture_reject" };
  Entry.writeReceipt(root, m); assert.equal(Entry.readReceipt(root, 1).delivery.valid, false);
  assert.equal(Entry.readReceipt(root, 0).delivery.valid, false);
}));
