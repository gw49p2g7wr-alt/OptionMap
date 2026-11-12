"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Fixture = require("./fixtures/weeklySemanticEvidenceFixture.js");
const Authority = require("../js/weeklyAcquisitionAuthorityContract.js");
const Binding = require("../js/weeklySemanticEvidenceBinding.js");
const SetStore = require("../js/storage/weeklyEvidenceSetStore.js");
const BindingStore = require("../js/storage/weeklySemanticEvidenceBindingStore.js");
const Promotion = require("../js/weeklySemanticEvidencePromotionShadow.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const FuturesHistory = require("../js/weeklyFuturesHistory.js");
const OptionsHistory = require("../js/weeklyOptionsHistory.js");

const CONFIRMED = "2026-11-12T06:05:00.000Z";
const LATER = "2026-11-12T06:10:00.000Z";

function empty(role) {
  return role === "weekly_futures_workbook" ? FuturesHistory.createEmptyHistory() :
    OptionsHistory.createEmptyWeeklyOptionsHistory();
}

function domainData(capture, role) {
  const futures = role === "weekly_futures_workbook";
  return { candidate: futures ? capture.futuresCandidate : capture.optionsCandidate,
    evidenceSetId: (futures ? capture.run.futures : capture.run.options).evidenceSet.evidenceSetId };
}

function promote(h, capture, role, history = empty(role), confirmedAt = CONFIRMED) {
  return h.promotion.promote({ domainRole: role, history,
    ...domainData(capture, role), confirmedAt });
}

function active(history, sourceDate) {
  const entry = history.entries.find(value => value.sourceDate === sourceDate);
  return entry?.revisions.find(value => value.versionKey === entry.activeVersionKey) || null;
}

function setFile(h, evidenceSetId) {
  return path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    SetStore.DIRECTORY_NAME, `${SetStore.setDigest(evidenceSetId)}.json`);
}

function objectFile(h, digest) {
  return path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY, "objects",
    digest.slice(0, 2), digest);
}

function bindingFile(h, role, sourceDate, versionKey) {
  return path.join(h.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
    BindingStore.DIRECTORY_NAME, `${Binding.revisionIdentity(role, sourceDate, versionKey)}.json`);
}

test("WF4-1 Evidence-backed new Futures revision", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), result = await promote(h,
    capture, "weekly_futures_workbook");
  assert.deepEqual([result.status, result.diagnostics.semanticRevisionWriteCount,
    result.diagnostics.bindingWriteCount], ["available", 1, 1]);
  assert.equal(result.binding.semanticVersionKey, capture.futuresCandidate.versionKey);
});

test("WF4-2 revision resolves through set and listing/workbook occurrences", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), saved = await promote(h,
    capture, "weekly_futures_workbook"), revision = active(saved.history, "2026-11-06"),
    resolved = await h.promotion.resolveRevision({ domainRole: "weekly_futures_workbook",
      sourceDate: "2026-11-06", versionKey: revision.versionKey, revision });
  assert.equal(resolved.status, "available");
  assert.deepEqual(resolved.documents.map(value => value.role),
    ["official_listing", "weekly_futures_workbook"]);
  assert.equal(Object.hasOwn(resolved.documents[0], "bytes"), false);
});

test("WF4-3 missing Evidence Set rejects Futures promotion", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), input =
    domainData(capture, "weekly_futures_workbook");
  input.evidenceSetId = input.evidenceSetId.replace(/[0-9a-f]$/, "0");
  const result = await h.promotion.promote({ domainRole: "weekly_futures_workbook",
    history: empty("weekly_futures_workbook"), ...input, confirmedAt: CONFIRMED });
  assert.deepEqual([result.status, result.reason], ["unavailable", "evidence_set_invalid"]);
});

test("WF4-4 wrong Futures sourceId rejects", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), set = structuredClone(
    capture.run.futures.evidenceSet);
  set.sourceId = "jpx-weekly-nikkei225-options-open-interest";
  assert.equal(await Binding.validateSemanticCandidate(capture.futuresCandidate, set, h.vault,
    h.main), false);
});

test("WF4-5 wrong Futures sourceDate rejects", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), candidate =
    await Fixture.futuresCandidate("2026-10-30", 100);
  assert.equal(await Binding.validateSemanticCandidate(candidate,
    capture.run.futures.evidenceSet, h.vault, h.main), false);
});

test("WF4-6 wrong runId rejects against Vault occurrences", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), original =
    Binding.createBinding({ domainRole: "weekly_futures_workbook",
      candidate: capture.futuresCandidate, evidenceSet: capture.run.futures.evidenceSet,
      boundAt: CONFIRMED }, h.main), forged = structuredClone(original), domain =
      Binding.DOMAIN.weekly_futures_workbook;
  forged.runId = `weekly-run-v1|sha256:${"0".repeat(64)}`;
  const material = Object.fromEntries(Binding.FIELDS.filter(field =>
    !["bindingId", "bindingHash", "authoritySignature"].includes(field))
    .map(field => [field, structuredClone(forged[field])]));
  forged.bindingHash = Authority.sha256(material);
  forged.bindingId = `${domain.bindingPrefix}|sha256:${forged.bindingHash}`;
  forged.authoritySignature = h.main.sign(domain.signatureKind, forged.bindingHash);
  assert.equal(Binding.validateBinding(forged, h.main), true);
  assert.equal(Binding.validateBindingAgainstEvidence(forged,
    capture.run.futures.evidenceSet, h.vault, h.main), false);
});

test("WF4-7 raw-only Futures workbook change is semantic write0", async t => {
  const h = Fixture.createHarness(t), firstCapture = await h.capture(), first = await promote(h,
    firstCapture, "weekly_futures_workbook"), secondCapture = await h.capture({
      futuresTag: "raw-only", requestId: "weekly-w4-request-2" }), second = await promote(h,
        secondCapture, "weekly_futures_workbook", first.history, LATER);
  assert.notEqual(firstCapture.run.futures.evidenceSet.evidenceSetId,
    secondCapture.run.futures.evidenceSet.evidenceSetId);
  assert.deepEqual([second.diagnostics.semanticRevisionWriteCount,
    second.diagnostics.bindingWriteCount, second.history.entries[0].revisions.length], [0, 0, 1]);
});

test("WF4-8 listing-only raw change is semantic write0", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_futures_workbook"), b = await h.capture({ listingTag: "changed",
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_futures_workbook", first.history, LATER);
  assert.notEqual(a.run.futures.evidenceSet.evidenceSetId, b.run.futures.evidenceSet.evidenceSetId);
  assert.equal(second.diagnostics.semanticRevisionWriteCount, 0);
});

test("WF4-9 same raw reacquisition is semantic write0", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_futures_workbook"), b = await h.capture({ requestId: "weekly-w4-request-2" }),
    second = await promote(h, b, "weekly_futures_workbook", first.history, LATER);
  assert.deepEqual([second.reason, second.diagnostics.semanticRevisionWriteCount],
    ["semantic_duplicate", 0]);
});

test("WF4-10 same-week Futures correction creates immutable revision", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_futures_workbook"), b = await h.capture({ futuresValue: 101,
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_futures_workbook", first.history, LATER), entry = second.history.entries[0];
  assert.deepEqual([second.diagnostics.semanticRevisionWriteCount, entry.revisions.length,
    entry.revisions[0].replacedAt, entry.activeVersionKey],
    [1, 2, LATER, b.futuresCandidate.versionKey]);
});

test("WF4-11 old Futures revision remains queryable", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_futures_workbook"), b = await h.capture({ futuresValue: 101,
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_futures_workbook", first.history, LATER), old = second.history.entries[0].revisions[0],
    resolved = await h.promotion.resolveRevision({ domainRole: "weekly_futures_workbook",
      sourceDate: "2026-11-06", versionKey: old.versionKey, revision: old });
  assert.equal(resolved.status, "available");
});

test("WF4-12 Futures current/previous stay distinct source dates", async t => {
  const h = Fixture.createHarness(t), oldCapture = await h.capture({ sourceDate: "2026-10-30",
    requestId: "weekly-w4-old" }), old = await promote(h, oldCapture,
      "weekly_futures_workbook"), currentCapture = await h.capture({ requestId: "weekly-w4-new" }),
    current = await promote(h, currentCapture, "weekly_futures_workbook", old.history, LATER),
    versions = await FuturesHistory.getActiveVersions(current.history);
  assert.deepEqual(versions.map(value => value.sourceDate), ["2026-10-30", "2026-11-06"]);
});

test("WF4-13 raw-only change preserves Overall pair identity", async t => {
  const h = Fixture.createHarness(t), oldCapture = await h.capture({ sourceDate: "2026-10-30",
    requestId: "old" }), old = await promote(h, oldCapture, "weekly_futures_workbook"),
    currentCapture = await h.capture({ requestId: "current" }), current = await promote(h,
      currentCapture, "weekly_futures_workbook", old.history, LATER), before =
      (await FuturesHistory.getActiveVersions(current.history)).map(value => value.versionKey),
    raw = await h.capture({ futuresTag: "raw", requestId: "raw" }), duplicate = await promote(h,
      raw, "weekly_futures_workbook", current.history, "2026-11-12T06:15:00.000Z"), after =
      (await FuturesHistory.getActiveVersions(duplicate.history)).map(value => value.versionKey);
  assert.deepEqual(after, before);
});

test("WF4-14 semantic correction updates only active Overall pair member", async t => {
  const h = Fixture.createHarness(t), oldCapture = await h.capture({ sourceDate: "2026-10-30",
    requestId: "old" }), old = await promote(h, oldCapture, "weekly_futures_workbook"),
    currentCapture = await h.capture({ requestId: "current" }), current = await promote(h,
      currentCapture, "weekly_futures_workbook", old.history, LATER), correction = await h.capture({
        futuresValue: 101, requestId: "correction" }), changed = await promote(h, correction,
          "weekly_futures_workbook", current.history, "2026-11-12T06:15:00.000Z"), versions =
      await FuturesHistory.getActiveVersions(changed.history);
  assert.equal(versions[0].versionKey, oldCapture.futuresCandidate.versionKey);
  assert.equal(versions[1].versionKey, correction.futuresCandidate.versionKey);
});

test("WF4-15 pre-activation Futures revision stays valid and unavailable", async t => {
  const h = Fixture.createHarness(t), candidate = await Fixture.futuresCandidate("2026-11-06"),
    legacy = await FuturesHistory.mergeCandidates(FuturesHistory.createEmptyHistory(), [candidate],
      CONFIRMED), revision = active(legacy.history, "2026-11-06"), resolved =
      await h.promotion.resolveRevision({ domainRole: "weekly_futures_workbook",
        sourceDate: "2026-11-06", versionKey: revision.versionKey, revision });
  assert.equal(await FuturesHistory.validateHistory(legacy.history), true);
  assert.deepEqual([resolved.status, resolved.reason], ["unavailable", "pre_activation"]);
});

test("WO4-1 Evidence-backed new Options revision", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), result = await promote(h,
    capture, "weekly_options_workbook");
  assert.deepEqual([result.status, result.diagnostics.semanticRevisionWriteCount,
    result.diagnostics.bindingWriteCount], ["available", 1, 1]);
});

test("WO4-2 Options revision resolves through both Evidence occurrences", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), saved = await promote(h,
    capture, "weekly_options_workbook"), revision = active(saved.history, "2026-11-06"),
    resolved = await h.promotion.resolveRevision({ domainRole: "weekly_options_workbook",
      sourceDate: "2026-11-06", versionKey: revision.versionKey, revision });
  assert.deepEqual([resolved.status, resolved.documents.length], ["available", 2]);
});

test("WO4-3 missing Evidence Set rejects Options promotion", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), input =
    domainData(capture, "weekly_options_workbook");
  input.evidenceSetId = input.evidenceSetId.replace(/[0-9a-f]$/, "0");
  const result = await h.promotion.promote({ domainRole: "weekly_options_workbook",
    history: empty("weekly_options_workbook"), ...input, confirmedAt: CONFIRMED });
  assert.equal(result.status, "unavailable");
});

test("WO4-4 wrong source/date/run reject", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), wrongDate =
    await Fixture.optionsCandidate("2026-10-30");
  assert.equal(await Binding.validateSemanticCandidate(wrongDate,
    capture.run.options.evidenceSet, h.vault, h.main), false);
  assert.equal(await Binding.validateSemanticCandidate(capture.optionsCandidate,
    capture.run.futures.evidenceSet, h.vault, h.main), false);
});

test("WO4-5 raw-only Options workbook change is write0", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_options_workbook"), b = await h.capture({ optionsTag: "raw",
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_options_workbook", first.history, LATER);
  assert.notEqual(a.run.options.evidenceSet.evidenceSetId, b.run.options.evidenceSet.evidenceSetId);
  assert.equal(second.diagnostics.semanticRevisionWriteCount, 0);
});

test("WO4-6 listing-only raw change is write0", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_options_workbook"), b = await h.capture({ listingTag: "raw",
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_options_workbook", first.history, LATER);
  assert.equal(second.diagnostics.semanticRevisionWriteCount, 0);
});

test("WO4-7 same raw Options reacquisition is write0", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_options_workbook"), b = await h.capture({ requestId: "weekly-w4-request-2" }),
    second = await promote(h, b, "weekly_options_workbook", first.history, LATER);
  assert.deepEqual([second.reason, second.diagnostics.semanticRevisionWriteCount],
    ["semantic_duplicate", 0]);
});

test("WO4-8 same-week Options correction creates immutable revision", async t => {
  const h = Fixture.createHarness(t), a = await h.capture(), first = await promote(h, a,
    "weekly_options_workbook"), b = await h.capture({ optionsValue: 101,
      requestId: "weekly-w4-request-2" }), second = await promote(h, b,
        "weekly_options_workbook", first.history, LATER), entry = second.history.entries[0];
  assert.deepEqual([second.diagnostics.semanticRevisionWriteCount, entry.revisions.length,
    entry.revisions[0].replacedAt], [1, 2, LATER]);
});

test("WO4-9 previous calendar helper is unchanged", async t => {
  const h = Fixture.createHarness(t), oldCapture = await h.capture({ sourceDate: "2026-10-30",
    requestId: "old" }), old = await promote(h, oldCapture, "weekly_options_workbook"),
    currentCapture = await h.capture({ requestId: "current" }), current = await promote(h,
      currentCapture, "weekly_options_workbook", old.history, LATER), previous =
      await OptionsHistory.findPreviousWeeklyOptionsRevision(current.history, "2026-11-06");
  assert.equal(previous.previousCalendar.sourceDate, "2026-10-30");
});

test("WO4-10 previous same-expiry helper is unchanged", async t => {
  const h = Fixture.createHarness(t), oldCapture = await h.capture({ sourceDate: "2026-10-30",
    requestId: "old" }), old = await promote(h, oldCapture, "weekly_options_workbook"),
    currentCapture = await h.capture({ requestId: "current" }), current = await promote(h,
      currentCapture, "weekly_options_workbook", old.history, LATER), previous =
      await OptionsHistory.findPreviousWeeklyOptionsRevision(current.history, "2026-11-06");
  assert.equal(previous.previousSameExpiry.sourceDate, "2026-10-30");
});

test("WO4-11 pre-activation Options revision stays valid and unavailable", async t => {
  const h = Fixture.createHarness(t), candidate = await Fixture.optionsCandidate("2026-11-06"),
    legacy = await OptionsHistory.mergeWeeklyOptionsHistory(
      OptionsHistory.createEmptyWeeklyOptionsHistory(), candidate, { confirmedAt: CONFIRMED }),
    revision = active(legacy.history, "2026-11-06"), resolved =
      await h.promotion.resolveRevision({ domainRole: "weekly_options_workbook",
        sourceDate: "2026-11-06", versionKey: revision.versionKey, revision });
  assert.equal((await OptionsHistory.validateWeeklyOptionsHistory(legacy.history)).valid, true);
  assert.equal(resolved.reason, "pre_activation");
});

test("W4-S1 Futures binding failure does not block Options", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), result =
    await h.promotion.promoteDomains({ futures: { history: empty("weekly_futures_workbook"),
      candidate: capture.futuresCandidate,
      evidenceSetId: capture.run.options.evidenceSet.evidenceSetId, confirmedAt: CONFIRMED },
    options: { history: empty("weekly_options_workbook"), candidate: capture.optionsCandidate,
      evidenceSetId: capture.run.options.evidenceSet.evidenceSetId, confirmedAt: CONFIRMED } });
  assert.deepEqual([result.futures.status, result.options.status], ["unavailable", "available"]);
});

test("W4-S2 Options binding failure does not block Futures", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), result =
    await h.promotion.promoteDomains({ futures: { history: empty("weekly_futures_workbook"),
      candidate: capture.futuresCandidate,
      evidenceSetId: capture.run.futures.evidenceSet.evidenceSetId, confirmedAt: CONFIRMED },
    options: { history: empty("weekly_options_workbook"), candidate: capture.optionsCandidate,
      evidenceSetId: capture.run.futures.evidenceSet.evidenceSetId, confirmedAt: CONFIRMED } });
  assert.deepEqual([result.futures.status, result.options.status], ["available", "unavailable"]);
});

test("W4-S3 shared listing invalid rejects both domains", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), entry =
    capture.run.futures.evidenceSet.roles[0];
  fs.writeFileSync(objectFile(h, entry.contentSha256), Buffer.from("tampered"));
  const futures = await promote(h, capture, "weekly_futures_workbook"), options =
    await promote(h, capture, "weekly_options_workbook");
  assert.deepEqual([futures.status, options.status], ["unavailable", "unavailable"]);
});

test("W4-S4 Evidence binding tamper fails closed", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), saved = await promote(h,
    capture, "weekly_futures_workbook"), revision = active(saved.history, "2026-11-06"), file =
      bindingFile(h, "weekly_futures_workbook", "2026-11-06", revision.versionKey), record =
      JSON.parse(fs.readFileSync(file, "utf8"));
  record.evidenceSetHash = "0".repeat(64);
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  const resolved = await h.promotion.resolveRevision({ domainRole: "weekly_futures_workbook",
    sourceDate: "2026-11-06", versionKey: revision.versionKey, revision });
  assert.equal(resolved.status, "unavailable");
});

test("W4-S5 binding and metadata survive restart", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), saved = await promote(h,
    capture, "weekly_options_workbook"), revision = active(saved.history, "2026-11-06"),
    vault = Vault.createIsolatedVault({ root: h.root, targetEnvironment: "isolated_test",
      crashAt: null }), evidenceSetStore = SetStore.createIsolatedWeeklyEvidenceSetStore({
      root: h.root, targetEnvironment: "isolated_test" }), bindingStore =
      BindingStore.createIsolatedWeeklySemanticEvidenceBindingStore({ root: h.root,
        targetEnvironment: "isolated_test" }), restarted =
      Promotion.createWeeklySemanticEvidencePromotionShadow({ vault, evidenceSetStore,
        bindingStore, authority: h.main }), resolved = await restarted.resolveRevision({
          domainRole: "weekly_options_workbook", sourceDate: "2026-11-06",
          versionKey: revision.versionKey, revision });
  assert.equal(resolved.status, "available");
});

test("W4-S6 metadata helper leaks no raw bytes path or secrets", async t => {
  const h = Fixture.createHarness(t), capture = await h.capture(), saved = await promote(h,
    capture, "weekly_futures_workbook"), revision = active(saved.history, "2026-11-06"),
    resolved = await h.promotion.resolveRevision({ domainRole: "weekly_futures_workbook",
      sourceDate: "2026-11-06", versionKey: revision.versionKey, revision }), serialized =
      JSON.stringify(resolved);
  assert.doesNotMatch(serialized, /rawBytes|storagePath|vaultPath|authorization|cookie/i);
  assert.equal(resolved.documents.some(value => Object.hasOwn(value, "bytes")), false);
});

test("W4-S7 production Weekly path uses W4 binding and remains package reachable", () => {
  const root = path.resolve(__dirname, ".."), production = ["main.js", "preload.js", "index.html"]
    .map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  assert.match(production, /weeklySemanticEvidencePromotionShadow/);
  assert.match(production, /weeklyProductionAcquisition/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("js/**/*"));
});
