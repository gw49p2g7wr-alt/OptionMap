"use strict";

const { test } = require("node:test");
const A = require("node:assert/strict");
const Fixture = require("./fixtures/marketCalendar/bojCoverageFixture.js");
const Parser = require("../js/marketCalendarRuntime/bojCoverageParser.js");
const Coverage = require("../js/marketCalendarRuntime/bojCoverageAcquisition.js");
const Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Identity = require("../js/marketCalendar/marketEventIdentity.js");
const Legacy = require("../js/marketCalendarShadow/representativeParsers.js");
const context = { sourceId: "jp-boj-calendar", sourceUrl: "https://www.boj.or.jp/about/press/index.htm",
  fetchedAt: "2026-10-13T01:00:00.000Z", parserId: "boj-calendar-v1", parserVersion: 1, rawContentHash: "a".repeat(64) };
const speech = () => Parser.parseSpeeches(Fixture.speeches(), context);
test("B1 existing BOJ event bytes/identity regression", () => A.deepEqual(Parser.parseExisting(Fixture.primary, context), Legacy.parseBoj(Fixture.primary, context)));
for (const [id, role] of [["B2", "governor"], ["B3", "deputy_governor"], ["B4", "policy_board_member"]])
  test(`${id} ${role} captured`, () => A.ok(speech().records.some(r => r.speechIdentity.speakerRole === role)));
test("B5 official Ueda 2026-10-06 National Securities Convention", async () => {
  const r = speech().records.find(r => r.speechIdentity.eventDate === "2026-10-06");
  A.equal(r.sourceTitle, "【挨拶】（全国証券大会）"); A.equal(r.speechIdentity.speakerId, "植田");
  const c = await Canonical.canonicalize(r); A.equal(c.ok, true); A.equal(c.event.logical.speechIdentity.officialEventComponent, "venue:全国証券大会");
  A.equal(c.event.acquisitionEvidence.httpMetadata.speechPublicationUrl, "https://www.boj.or.jp/about/press/koen_2026/ko261006a.htm");
});
test("B6 Tankan explicit quarterly summary release cells only", () => {
  const p = Parser.parseTankan(Fixture.workbook(), { ...context, sourceUrl: Policy.BOJ_COVERAGE_V2.documents[2].url });
  A.deepEqual(p.diagnostics, []); A.equal(p.records.length, 4);
  A.equal(p.records[0].sourceLocalSchedule.startDate, "2026-07-01"); A.equal(p.records[0].referencePeriod, "2026-06");
  A.equal(p.records[2].sourceLocalSchedule.startDate, "2026-12-14");
  A.ok(p.records.every(r => r.sourceLocalSchedule.startTime === "08:50"));
});
test("B7 publication schedule is never speech date/time authority", async () => {
  const p = await Coverage.create({ fetchImpl: async url => Fixture.response(url) }).acquire({ sourceId: Coverage.SOURCE_ID, operation: Policy.OPERATION });
  A.equal(p.success, true); const r = p.candidate.canonicalRecords.find(r => r.logical.eventType === "BOJ_SPEECH" && r.logical.speechIdentity.eventDate === "2026-10-06");
  A.equal(r.schedule.sourceLocal.startTime, null); A.equal(r.schedule.sourceLocal.startDate, "2026-10-06");
});
test("B8 typed dedup across repeated notices / publication and upcoming", () => {
  const p = Parser.parseSpeeches(Fixture.speeches({ future: [...Fixture.upcoming,
    ["2026年10月6日", "植田総裁", "全国証券大会における挨拶"]] }), context);
  const d = Parser.dedupeSpeeches(p.records); A.equal(d.records.length, 7); A.equal(d.deduped, 1);
  const renamed = { ...p.records[0], sourceTitle: "changed title", titleJa: "changed title" };
  A.equal(Parser.dedupeSpeeches([p.records[0], renamed]).deduped, 1);
  const wrapped = Parser.parseSpeeches(Fixture.speeches().replace("（全国証券大会）", "（<span>全国証券大会</span>）"), context);
  A.deepEqual(wrapped.records[0].speechIdentity, p.records[0].speechIdentity);
  A.throws(() => Parser.dedupeSpeeches([p.records[0], { ...p.records[0],
    officialSpeechReference: "https://www.boj.or.jp/about/press/koen_2026/ko261006b.htm" }]), /publication_conflict/);
});
test("B9 changed/malformed HTML rejects, non-board publications excluded", () => {
  A.ok(Parser.parseSpeeches(Fixture.speeches().replace("開催日", "掲載日"), context).diagnostics.length);
  A.ok(Parser.parseSpeeches("<html>unknown</html>", context).diagnostics.length);
  const p = Parser.parseSpeeches(Fixture.speeches({ latest: [["2026年10月6日", "山田理事", "研究論文"]] }), context);
  A.equal(p.records.length, 4); A.equal(p.excluded, 1);
});
test("B10 workbook structure/formula/date/quarter fail closed", () => {
  for (const change of [b => { b.Sheets.統計データ.B230.v = "other"; }, b => { b.Sheets.統計データ.E231.f = "NOW()"; },
    b => { b.Sheets.統計データ.E231.v = 0; }, b => { b.SheetNames.push("unexpected"); b.Sheets.unexpected = {}; }])
    A.ok(Parser.parseTankan(Fixture.workbook(change), context).diagnostics.length);
  A.ok(Parser.parseTankan(new Uint8Array([1, 2]), context).diagnostics.length);
  A.ok(Parser.parseTankan(Fixture.workbook(b => { b.Workbook = { WBProps: { date1904: true } }; }), context).diagnostics.length);
});
test("B11 absence is none, observations do not synthesize cancellation", () => {
  A.ok(speech().records.every(r => r.absenceAuthority === "none" && r.sourceStatus === "scheduled"));
  A.equal(Parser.parseSpeeches(Fixture.speeches({ latest: [], future: [] }), context).records.length, 0);
});
test("B12 writer remains BOJ-ineligible", () => {
  const policy = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js").policyFor(3);
  A.equal(policy.permissions.entries.find(e => e.sourceId === Coverage.SOURCE_ID).permission, "writer_ineligible");
  A.deepEqual(policy.global.permittedSources, ["jp-esri-machinery-orders-calendar"]);
  const permission = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
  A.equal(permission.PERMISSIONS.entries.find(e => e.sourceId === Coverage.SOURCE_ID).permission, "writer_ineligible");
  A.equal(permission.PERMISSIONS.entries.find(e => e.sourceId === permission.MOF).permission, "not_approved");
});
test("fixed document contract; legacy and other source routes remain unchanged", () => {
  A.equal(Policy.getPolicy(Coverage.SOURCE_ID).documents.length, 1);
  A.equal(Policy.getPolicy(Coverage.SOURCE_ID, Policy.BOJ_COVERAGE_V2).documents.length, 3);
  A.equal(Policy.getPolicy("us-bls-calendar", Policy.BOJ_COVERAGE_V2), null);
  A.equal(Policy.getPolicy(Coverage.SOURCE_ID, { ...Policy.BOJ_COVERAGE_V2 }), null);
  for (const d of Policy.BOJ_COVERAGE_V2.documents) for (const url of [d.url + "?x=1", d.url.replace("https:", "http:"), "https://example.org/"])
    A.equal(Policy.validateUrl(Coverage.SOURCE_ID, d, url).valid, false);
});
test("one-shot transport redirects/credentials/MIME/bytes guards and no raw persistence envelope", async () => {
  let calls = 0;
  const p = await Coverage.create({ fetchImpl: async (u, o) => { calls++; A.equal(o.credentials, "omit"); A.equal(o.redirect, "manual"); return Fixture.response(u); } }).acquire({ sourceId: Coverage.SOURCE_ID, operation: Policy.OPERATION });
  A.equal(p.success, true); A.equal(calls, 3); A.equal(p.candidate.recordCount, 14);
  A.deepEqual(p.coverageAudit, { documentCount: 3, existingPolicyMeeting: 3, speechesRemarks: 7, tankan: 4, deduped: 0, excluded: 0, malformed: 0, unknown: 0, absenceAuthority: "none" });
  A.ok(p.documents.every(d => !Object.hasOwn(d, "parserInput")));
  for (const result of [new Response("bad", { headers: { "content-type": "text/plain" } }),
    new Response(null, { status: 302, headers: { location: "https://example.org/" } }),
    new Response("x", { headers: { "content-type": "text/html", "content-length": "2000001" } })]) {
    let n = 0; const f = await Coverage.create({ fetchImpl: async () => { n++; return result; } }).acquire({ sourceId: Coverage.SOURCE_ID, operation: Policy.OPERATION });
    A.equal(f.success, false); A.equal(n, 1);
  }
});
test("speech identity rejects title-only, wrong source/role/date; venue notices stable", () => {
  const v = speech().records[0].speechIdentity;
  A.equal(Identity.validateSpeechIdentity(v), true);
  for (const x of [{ ...v, sourceId: "us-bls-calendar" }, { ...v, speakerRole: "director" }, { ...v, eventDate: "2026-02-30" }, { ...v, officialEventComponent: "title:hello" }]) A.equal(Identity.validateSpeechIdentity(x), false);
});
test("expanded BOJ candidates retained for comparison, zero mutation plan / no absence cancellation", async () => {
  const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js"),
    Plan = require("../js/marketCalendarHistory/formalShadowWritePlan.js"),
    Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
  const acquired = await Coverage.create({ fetchImpl: async u => Fixture.response(u), now: () => context.fetchedAt })
    .acquire({ sourceId: Coverage.SOURCE_ID, operation: Policy.OPERATION });
  const records = acquired.candidate.canonicalRecords;
  const sourceResult = { sourceId: Coverage.SOURCE_ID, canonicalRecords: records, acquisitionOutcome: "complete",
    candidateStatus: "available", documentHealth: acquired.documents.map(d => ({ role: d.role,
      fetchOutcome: "success", parseOutcome: "success" })), failedRoles: [], absenceAuthority: "none" };
  const snapshot = { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] };
  const sourceResults = Compare.SOURCE_IDS.map(sourceId => sourceId === Coverage.SOURCE_ID ? sourceResult :
    { sourceId, canonicalRecords: [], acquisitionOutcome: "not_attempted", candidateStatus: "unavailable", absenceAuthority: "none" });
  const comparison = await Compare.compare({ sourceResults, formalSnapshot: snapshot });
  const plan = await Plan.buildSourceShadowPlan({ sourceId: Coverage.SOURCE_ID, sourceResult, comparison,
    formalSnapshot: snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
    run: { sourceId: Coverage.SOURCE_ID, runId: "g2-fixture", acceptedAt: "2026-10-13T01:00:01.000Z",
      fetchedAt: [context.fetchedAt], status: "accepted", semanticSetHash: await Canonical.sha256(records.map(r => r.revisionKey).sort()) } });
  A.equal(plan.reason, "writer_ineligible_identity_transition"); A.equal(plan.retainedCandidateKeys.length, 14);
  A.ok(Object.values(plan.counts).every(n => n === 0));
  A.ok(Object.values(plan.mutations).every(a => a.length === 0));
});
test("normal BOJ acquisition persists existing Runtime State once; same JST day skips; no writer/safety", async () => {
  const Runtime = require("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js"),
    Store = require("../js/storage/marketCalendarRuntimeStateStore.js"),
    Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"),
    { IDBFactory } = require("fake-indexeddb");
  const store = Store.createRuntimeStateStore({ indexedDB: new IDBFactory(), targetEnvironment: "isolated_test" });
  const snapshot = { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] };
  let requests = 0, reads = 0;
  const forbidden = async () => { throw Error("unexpected_managed_write"); };
  const managed = { read: async () => ({ status: "ok", value: null }), reserveReevaluation: forbidden,
    completeReevaluation: forbidden, completeActiveAcquisition: forbidden };
  const ShouldFixture = require("./fixtures/marketCalendar/bojShouldFixture.js");
  const runtime = Runtime.create({ fetchImpl: async url => { requests++; return ShouldFixture.response(url); },
    store, stores: { cpi: managed, labor: managed, bls: managed }, targetEnvironment: "isolated_test",
    now: () => context.fetchedAt, readFormal: async () => { reads++; return { status: "ok", snapshot: structuredClone(snapshot),
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, audit: { readonly: 1, readwrite: 0 } }; } });
  const r = await runtime.check({ trigger: "startup", sourceIds: [Coverage.SOURCE_ID] });
  A.equal(r.state, "success", JSON.stringify(r)); A.equal(r.sources[0].recordCount, ShouldFixture.totalCount);
  A.equal(requests, 4); A.equal((await store.read(Coverage.SOURCE_ID)).value.lastSuccessAt, context.fetchedAt);
  A.equal(store.diagnostics().successfulWrites, 1);
  const d = runtime.diagnostics(); A.equal(d.writerExecution, 0); A.equal(d.safetyWrites, 0);
  A.equal(d.comparison.formalAudit.readwrite, 0); A.equal(d.comparison.sourceResults[0].canonicalRecords.length, ShouldFixture.totalCount);
  const old = await Coverage.create({ fetchImpl: async url => Fixture.response(url) }).acquire({sourceId:Coverage.SOURCE_ID,operation:Policy.OPERATION});
  A.deepEqual(d.comparison.sourceResults[0].canonicalRecords.filter(x => !Object.hasOwn(x.logical,"bojPublicationIdentity"))
    .map(x=>[x.eventKey,x.canonicalContentHash]), old.candidate.canonicalRecords.map(x=>[x.eventKey,x.canonicalContentHash]));
  A.equal(d.comparison.sourceResults[0].routeIdentity, Coverage.shouldRouteIdentity);
  A.equal(d.comparison.writeAllowed, false); A.equal(d.comparison.absenceAuthority, "none");
  A.deepEqual(snapshot, { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
  const skipped = await runtime.check({ trigger: "startup", sourceIds: [Coverage.SOURCE_ID] });
  A.equal(skipped.sources[0].reasonClass, "already_succeeded_today");
  A.equal(requests, 4); A.equal(reads, 1); A.equal(store.diagnostics().successfulWrites, 1);
  A.doesNotMatch(JSON.stringify([r, await store.readAll(), d]), /parserInput|<tbody/);
});
test("isolated native BOJ fixed-document acquisition (public network forbidden)", () => {
  const r = require("../scripts/marketCalendarG2BojCoverageNative.js").run();
  A.equal(r.status, "PASS", JSON.stringify(r)); A.equal(r.requests, 3); A.equal(r.observer, 0);
  A.equal(r.candidateCount, 14); A.equal(r.guard.forbiddenAttempts, 0); A.equal(r.productionAccess, 0);
  for (const k of ["runtimeStateWrites", "formalReadwrite", "safetyWrites", "authorization", "grant", "token", "writer"]) A.equal(r[k], 0);
  A.equal(r.tempDeleted, true); A.equal(r.package.name, "optionmap");
});
