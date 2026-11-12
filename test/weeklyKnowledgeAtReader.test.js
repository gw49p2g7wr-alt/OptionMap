"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Reader = require("../js/weeklyKnowledgeAtReader.js");
const FuturesHistory = require("../js/weeklyFuturesHistory.js");
const OptionsHistory = require("../js/weeklyOptionsHistory.js");
const SetStore = require("../js/storage/weeklyEvidenceSetStore.js");
const Vault = require("../js/sourceEvidence/sourceEvidenceVault.js");
const Fixture = require("./fixtures/weeklySemanticEvidenceFixture.js");
const ProductionFixture = require("./fixtures/weeklyProductionAcquisitionFixture.js");

const ROOT = path.resolve(__dirname, "..");
const D1 = "2026-10-30", D2 = "2026-11-06";
const T1 = "2026-11-10T10:00:00.000Z", T2 = "2026-11-10T12:00:00.000Z";
const unavailableEvidence = { verifyRevision: async () => ({
  state: "unavailable_pre_activation", reason: "pre_activation", evidenceSetId: null,
  verification: "not_applicable" }) };

async function buildHistory(domain, specifications) {
  let history = domain === "futures" ? FuturesHistory.createEmptyHistory() :
    OptionsHistory.createEmptyWeeklyOptionsHistory();
  for (const specification of specifications) {
    const candidate = domain === "futures" ? await Fixture.futuresCandidate(
      specification.sourceDate, specification.value) : await Fixture.optionsCandidate(
      specification.sourceDate, specification.value);
    if (domain === "futures") {
      const result = await FuturesHistory.mergeCandidates(history, [candidate],
        specification.confirmedAt);
      assert.equal(result.changed, true); history = result.history;
    } else {
      const result = await OptionsHistory.mergeWeeklyOptionsHistory(history, candidate,
        { confirmedAt: specification.confirmedAt });
      assert.equal(result.changed, true); history = result.history;
    }
  }
  return history;
}

function service(histories, evidenceVerifier = unavailableEvidence, counters = null) {
  return Reader.createWeeklyKnowledgeAtReader({ historyReader: {
    async readHistory(domain) {
      if (counters) counters.history += 1;
      return { status: "available", history: structuredClone(histories[domain]) };
    }
  }, evidenceVerifier: counters ? { async verifyRevision(input) {
    counters.evidence += 1; return evidenceVerifier.verifyRevision(input);
  } } : evidenceVerifier });
}

function request(domain, sourceDate, knowledgeAt) {
  return { domain, mode: "exact_source_date", knowledgeAt, sourceDate };
}

async function correction(domain) {
  return buildHistory(domain, [
    { sourceDate: D1, value: 100, confirmedAt: T1 },
    { sourceDate: D1, value: 200, confirmedAt: T2 }
  ]);
}

async function twoDates(domain) {
  return buildHistory(domain, [
    { sourceDate: D1, value: 100, confirmedAt: T1 },
    { sourceDate: D2, value: 200, confirmedAt: "2026-11-11T10:00:00.000Z" }
  ]);
}

test("WF6-1 before first confirmedAt returns no Futures revision", async () => {
  const history = await buildHistory("futures", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ futures: history }).read(request("futures", D1,
      "2026-11-10T09:59:59.999Z"));
  assert.deepEqual([result.status, result.reason], ["unavailable", "no_revision_known_at_time"]);
});

test("WF6-2 exact confirmedAt exposes the Futures revision", async () => {
  const history = await buildHistory("futures", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ futures: history }).read(request("futures", D1, T1));
  assert.deepEqual([result.status, result.records[0].confirmedAt], ["available", T1]);
});

test("WF6-3 one millisecond before replacedAt retains old Futures", async () => {
  const history = await correction("futures"), result = await service({ futures: history }).read(
    request("futures", D1, "2026-11-10T11:59:59.999Z"));
  assert.equal(result.records[0].semanticSignature, history.entries[0].revisions[0].signature);
});

test("WF6-4 exact replacedAt belongs to replacement Futures", async () => {
  const history = await correction("futures"), result = await service({ futures: history }).read(
    request("futures", D1, T2));
  assert.equal(result.records[0].versionKey, history.entries[0].activeVersionKey);
});

test("WF6-5 same-week Futures correction reconstructs both states", async () => {
  const history = await correction("futures"), reader = service({ futures: history }),
    before = await reader.read(request("futures", D1, T1)), after = await reader.read(
      request("futures", D1, T2));
  assert.notEqual(before.records[0].versionKey, after.records[0].versionKey);
});

test("WF6-6 raw-only Futures reacquisition creates no semantic transition", async t => {
  const harness = ProductionFixture.createHarness(t), first = await harness.service.acquire({
    requestKind: "latest_available" }); harness.commit(first);
  harness.configure({ futuresTag: "raw-only-change" });
  const second = await harness.service.acquire({ requestKind: "latest_available" });
  assert.equal(second.runs[0].futures.semanticRevisionWriteCount, 0);
  const history = second.runs[0].futures.history, reader = service({ futures: history }),
    at = history.entries[0].revisions[0].confirmedAt,
    later = new Date(Date.parse(at) + 60_000).toISOString();
  assert.equal((await reader.read(request("futures", history.entries[0].sourceDate, at)))
    .records[0].versionKey, (await reader.read(request("futures", history.entries[0].sourceDate,
      later))).records[0].versionKey);
});

test("WF6-7 latest_known chooses greatest Futures sourceDate known at T", async () => {
  const history = await twoDates("futures"), result = await service({ futures: history }).read({
    domain: "futures", mode: "latest_known", knowledgeAt: "2026-11-11T10:00:00.000Z" });
  assert.deepEqual(result.records.map(value => value.sourceDate), [D2]);
});

test("WF6-8 exact_source_date preserves requested Futures date", async () => {
  const history = await twoDates("futures"), result = await service({ futures: history }).read(
    request("futures", D1, "2026-11-12T00:00:00.000Z"));
  assert.equal(result.records[0].sourceDate, D1);
});

test("WF6-9 Futures range is deterministic source-date ascending", async () => {
  const history = await twoDates("futures"), result = await service({ futures: history }).read({
    domain: "futures", mode: "range", knowledgeAt: "2026-11-12T00:00:00.000Z",
    fromSourceDate: D1, toSourceDate: D2 });
  assert.deepEqual([result.order, ...result.records.map(value => value.sourceDate)],
    ["source_date_ascending", D1, D2]);
});

test("WF6-10 pre-activation Futures remains valid and explicit", async () => {
  const history = await buildHistory("futures", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ futures: history }).read(request("futures", D1, T1));
  assert.deepEqual(result.records[0].evidence, { state: "unavailable_pre_activation",
    reason: "pre_activation", evidenceSetId: null, verification: "not_applicable" });
});

async function evidenceHarness(t) {
  const harness = ProductionFixture.createHarness(t), acquired = await harness.service.acquire({
    requestKind: "latest_available" }), run = acquired.runs[0], histories = {
      futures: run.futures.history, options: run.options.history }, verifier =
      Reader.createMetadataEvidenceVerifier({ bindingStore: harness.bindingStore,
        setStore: harness.setStore, vault: { verifyOccurrenceMetadata: id =>
          harness.vault.verifyOccurrenceMetadata(id) }, authority: harness.authority });
  return { harness, run, histories, verifier };
}

test("WF6-11 post-activation Futures Evidence verifies metadata-only", async t => {
  const h = await evidenceHarness(t), entry = h.histories.futures.entries[0], result =
    await service(h.histories, h.verifier).read(request("futures", entry.sourceDate,
      entry.revisions[0].confirmedAt));
  assert.deepEqual([result.records[0].evidence.state,
    result.records[0].evidence.verificationScope], ["verified", "metadata_and_file_size"]);
  assert.doesNotMatch(JSON.stringify(result), /rawBytes|vaultPath|storagePath|occurrenceId/);
});

test("WF6-12 tampered Futures Evidence fails closed", async t => {
  const h = await evidenceHarness(t), revision = h.histories.futures.entries[0].revisions[0],
    binding = h.harness.bindingStore.readForRevision("weekly_futures_workbook",
      h.histories.futures.entries[0].sourceDate, revision.versionKey, h.harness.authority),
    file = path.join(h.harness.root, Vault.VAULT_DIRECTORY, Vault.VAULT_VERSION_DIRECTORY,
      SetStore.DIRECTORY_NAME, `${SetStore.setDigest(binding.evidenceSetId)}.json`), value =
      JSON.parse(fs.readFileSync(file, "utf8"));
  value.setHash = "0".repeat(64); fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  const result = await service(h.histories, h.verifier).read(request("futures",
    h.histories.futures.entries[0].sourceDate, revision.confirmedAt));
  assert.deepEqual([result.status, result.reason], ["invalid", "evidence_verification_failed"]);
});

test("WF6-13 Futures retention boundary explicitly reports the 52-sourceDate limit", async () => {
  const specifications = [], date = new Date("2025-11-14T00:00:00.000Z");
  for (let index = 0; index < 52; index += 1) {
    specifications.push({ sourceDate: date.toISOString().slice(0, 10), value: 100 + index,
      confirmedAt: new Date(Date.parse(T1) + index * 1000).toISOString() });
    date.setUTCDate(date.getUTCDate() + 7);
  }
  const history = await buildHistory("futures", specifications), result = await service({
    futures: history }).read(request("futures", "2025-11-07", "2026-11-12T00:00:00.000Z"));
  assert.deepEqual([result.reason, result.diagnostics.retention.maxSourceDates,
    result.diagnostics.retention.boundaryLimited], ["history_retention_boundary", 52, true]);
});

test("WO6-1 before confirmedAt returns no Options revision", async () => {
  const history = await buildHistory("options", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ options: history }).read(request("options", D1,
      "2026-11-10T09:59:59.999Z"));
  assert.equal(result.reason, "no_revision_known_at_time");
});

test("WO6-2 Options confirmedAt boundary is inclusive", async () => {
  const history = await buildHistory("options", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ options: history }).read(request("options", D1, T1));
  assert.equal(result.status, "available");
});

test("WO6-3 Options replacedAt boundary selects replacement", async () => {
  const history = await correction("options"), result = await service({ options: history }).read(
    request("options", D1, T2));
  assert.equal(result.records[0].versionKey, history.entries[0].activeVersionKey);
});

test("WO6-4 same-week Options correction reconstructs exactly", async () => {
  const history = await correction("options"), reader = service({ options: history }),
    before = await reader.read(request("options", D1, T1)), after = await reader.read(
      request("options", D1, T2));
  assert.notEqual(before.records[0].semanticSignature, after.records[0].semanticSignature);
});

test("WO6-5 raw-only Options reacquisition creates no semantic transition", async t => {
  const harness = ProductionFixture.createHarness(t), first = await harness.service.acquire({
    requestKind: "latest_available" }); harness.commit(first); harness.configure({
      optionsTag: "raw-only-change" }); const second = await harness.service.acquire({
        requestKind: "latest_available" });
  assert.equal(second.runs[0].options.semanticRevisionWriteCount, 0);
  assert.equal(second.runs[0].options.history.entries[0].revisions.length, 1);
});

test("WO6-6 latest_known chooses greatest Options sourceDate", async () => {
  const history = await twoDates("options"), result = await service({ options: history }).read({
    domain: "options", mode: "latest_known", knowledgeAt: "2026-11-11T10:00:00.000Z" });
  assert.equal(result.records[0].sourceDate, D2);
});

test("WO6-7 exact_source_date preserves requested Options date", async () => {
  const history = await twoDates("options"), result = await service({ options: history }).read(
    request("options", D1, "2026-11-12T00:00:00.000Z"));
  assert.equal(result.records[0].sourceDate, D1);
});

test("WO6-8 Options range is deterministic", async () => {
  const history = await twoDates("options"), result = await service({ options: history }).read({
    domain: "options", mode: "range", knowledgeAt: "2026-11-12T00:00:00.000Z",
    fromSourceDate: D1, toSourceDate: D2 });
  assert.deepEqual(result.records.map(value => value.sourceDate), [D1, D2]);
});

test("WO6-9 pre-activation Options remains valid", async () => {
  const history = await buildHistory("options", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), result = await service({ options: history }).read(request("options", D1, T1));
  assert.equal(result.records[0].evidence.state, "unavailable_pre_activation");
});

test("WO6-10 post-activation Options Evidence verifies", async t => {
  const h = await evidenceHarness(t), entry = h.histories.options.entries[0], result =
    await service(h.histories, h.verifier).read(request("options", entry.sourceDate,
      entry.revisions[0].confirmedAt));
  assert.deepEqual([result.status, result.records[0].evidence.state], ["available", "verified"]);
});

test("WO6-11 tampered Options Evidence fails closed", async t => {
  const h = await evidenceHarness(t), entry = h.histories.options.entries[0], revision =
    entry.revisions[0], original = h.harness.vault.verifyOccurrenceMetadata.bind(h.harness.vault),
    verifier = Reader.createMetadataEvidenceVerifier({ bindingStore: h.harness.bindingStore,
      setStore: h.harness.setStore, vault: { verifyOccurrenceMetadata(id) {
        const value = original(id); return value.status === "valid" ? { ...value,
          contentMetadata: { ...value.contentMetadata, contentObject: {
            ...value.contentMetadata.contentObject, byteLength:
              value.contentMetadata.contentObject.byteLength + 1 } } } : value;
      } }, authority: h.harness.authority }), result = await service(h.histories, verifier).read(
        request("options", entry.sourceDate, revision.confirmedAt));
  assert.equal(result.reason, "evidence_verification_failed");
});

test("W6-S1 overlapping intervals fail closed", async () => {
  const history = await correction("futures"), entry = history.entries[0];
  entry.revisions[0].replacedAt = "2026-11-10T13:00:00.000Z";
  const result = await service({ futures: history }).read(request("futures", D1,
    "2026-11-10T12:30:00.000Z"));
  assert.equal(result.reason, "overlapping_revision_interval");
});

test("W6-S2 malformed interval fails closed", async () => {
  const history = await correction("options"), entry = history.entries[0];
  entry.revisions[0].replacedAt = "2026-11-10T09:00:00.000Z";
  const result = await service({ options: history }).read(request("options", D1, T2));
  assert.equal(result.reason, "malformed_revision_interval");
});

test("W6-S3 interval gaps are not interpolated", async () => {
  const history = await correction("futures"), entry = history.entries[0];
  entry.revisions[0].replacedAt = "2026-11-10T11:00:00.000Z";
  const result = await service({ futures: history }).read(request("futures", D1,
    "2026-11-10T11:30:00.000Z"));
  assert.equal(result.reason, "no_revision_known_at_time");
});

test("W6-S4 invalid and ambiguous timestamps reject", async () => {
  const history = await buildHistory("futures", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), reader = service({ futures: history });
  for (const time of ["invalid", "2026-11-10", "2026-11-10T10:00:00+09:00",
    "2026-11-10T10:00:00Z"])
    assert.equal((await reader.read(request("futures", D1, time))).reason, "invalid_timestamp");
});

test("W6-S5 unknown domain rejects distinctly", async () => {
  const result = await service({}).read(request("combined", D1, T1));
  assert.equal(result.reason, "unknown_domain");
});

test("W6-S6 restart with the same persisted histories returns identical results", async () => {
  const history = await correction("options"), persisted = structuredClone(history), create = () =>
    service({ options: persisted }), before = await create().read(request("options", D1, T2)),
    after = await create().read(request("options", D1, T2));
  assert.deepEqual(after, before);
});

test("W6-S7 dedicated reader performs no writes or acquisition", async () => {
  const history = await buildHistory("futures", [{ sourceDate: D1, value: 100,
    confirmedAt: T1 }]), counters = { history: 0, evidence: 0 }, result = await service({
      futures: history }, unavailableEvidence, counters).read(request("futures", D1, T1)), source =
      fs.readFileSync(path.join(ROOT, "js/weeklyKnowledgeAtReader.js"), "utf8");
  assert.deepEqual([result.status, counters], ["available", { history: 1, evidence: 1 }]);
  assert.doesNotMatch(source, /fetch\(|\.put\(|\.add\(|readwrite|localStorage|readRawBytes/);
});

test("W6-S8 Overall and Morning contracts remain outside the reader", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/weeklyKnowledgeAtReader.js"), "utf8");
  assert.doesNotMatch(source, /overall|morning|score|readiness/i);
});

test("W6-S9 Full Export remains unchanged and package closure includes the reader", () => {
  const source = fs.readFileSync(path.join(ROOT, "js/weeklyKnowledgeAtReader.js"), "utf8"),
    pkg = require("../package.json");
  assert.doesNotMatch(source, /fullExport|changeSummary|topChanges/);
  assert.equal(pkg.build.files.includes("js/**/*"), true);
});
