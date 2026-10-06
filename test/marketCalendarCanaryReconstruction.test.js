"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const R = require("../js/marketCalendarRuntime/freshDayCanaryReconstruction.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js"), Old = require("../js/marketCalendarHistory/writerSafetyFileSchema.js");
const Auth = require("../js/marketCalendarHistory/formalWriterAuthorizationV2.js"), Core = require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js"), Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Shadow = require("../js/marketCalendarRuntime/automaticFormalShadow.js"), Fixture = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const H = label => A.hash({ label });
async function fixture() {
  const f = await Fixture.fixture({ perSource: 4 }), evaluated = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  const plan = evaluated.plans.find(p => p.sourceId === E.SOURCE), snapshot = Core.applyToMemory(f.snapshot, plan, Core.expectedWrites(plan, f.snapshot)), identity = await Canon.sha256(snapshot);
  const gate = H("gate"), legacy = Old.build(null, S.createMemorySafety(), null, "provision_disabled", A.PRODUCTION_POLICY);
  let record = E.append(E.migrate(legacy, gate), { type: "authority_transition", expectedAuthorityVersion: 2, nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE], suspendedSourceSet: [] }, gate);
  const cycleIdentity = H("cycle"), input = { policy: E.policyFor(3), safety: E.safetyInput(record.safety), sourceId: E.SOURCE, operation: "startup", cycleIdentity,
    context: A.createMainContextCandidate({ operation: "startup", cycleIdentity, attemptIdentity: H("attempt") }), acquisition: { outcome: "complete", failedRoles: [] },
    routeIdentity: H("route"), expectedRouteIdentity: H("route"), schemaFingerprint: Schema.EXPECTED_FINGERPRINT, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: H("acquisition"), candidateIdentity: H("candidate"), comparisonIdentity: H("comparison"),
    formalPrecondition: H("before"), planIdentity: plan.planIdentity, mutationCeiling: E.COUNTS };
  const issued = Auth.issueAuthorizationCandidate(input); assert.equal(issued.valid, true);
  record = E.append(record, { type: "fence_created", binding: issued.binding }, gate);
  const binding = issued.binding, base = { sourceId: E.SOURCE, attemptIdentity: binding.pendingAttemptIdentity, authorizationIdentity: binding.authorizationIdentity, committed: true, mutationCounts: E.COUNTS };
  const advance = (phase, proof) => { record = E.append(record, { type: "fence_advanced", attemptIdentity: base.attemptIdentity, authorizationIdentity: base.authorizationIdentity, phase, proof }, gate); };
  advance("formal_write_started", null); advance("commit_observed", { ...base, kind: "commit" });
  const proof = { ...base, kind: "readback", freshReadonly: true, integrityValid: true, otherSourcesUnchanged: true, expectedIdentity: identity, observedIdentity: identity };
  advance("readback_verified", proof); record = E.append(record, { type: "fence_completed", attemptIdentity: base.attemptIdentity, authorizationIdentity: base.authorizationIdentity, proof }, gate);
  const counts = { entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 };
  return { record, snapshot, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, executionReceipt: { saved: true, finalSequence: 7, pendingCleared: true,
    result: { status: "verified", committed: true, audit: { opens: 2, readonly: 4, readwrite: 1, committed: 1, aborted: 0, create: 0, upgrade: 0, delete: 0,
      openHandles: 0, readbackReopens: 1, committedWrites: counts, attemptedWrites: counts }, verification: { valid: true, expectedIdentity: identity, observedIdentity: identity }, transactionMs: 1, readbackMs: 2 } } };
}
test("Q1 complete durable proof + exact current Formal snapshot reconstructs A without telemetry fabrication", async () => {
  const result = await R.reconstruct(await fixture()); assert.equal(result.valid, true, result.reason); assert.equal(result.classification, "A");
  assert.equal(result.durableAcceptance, "COMPLETE"); assert.equal(result.currentRun.evidence, 4); assert.equal(result.writerExecution, 0);
  assert(result.unrecoverableTelemetry.includes("network_total")); assert.equal(result.other11Unchanged.independentBeforeBytesAvailable, false);
});
test("Q2 missing original exact mutation audit is safety-critical B", async () => { const f = await fixture(); delete f.executionReceipt; assert.equal((await R.reconstruct(f)).classification, "B"); });
test("Q3 current Formal drift rejects B", async () => { const f = await fixture(); f.snapshot.entries[0].lastObservedAt = "2026-10-05T00:00:00.000Z"; assert.equal((await R.reconstruct(f)).reason, "current_formal_proof_mismatch"); });
test("Q4 schema mismatch rejects B", async () => { const f = await fixture(); f.schemaFingerprint = H("wrong"); assert.equal((await R.reconstruct(f)).reason, "schema_fingerprint_mismatch"); });
test("Q5 incomplete or tampered safety chain rejects B", async () => { const f = await fixture(); f.record = structuredClone(f.record); f.record.safety.sequence = 6; assert.equal((await R.reconstruct(f)).classification, "B"); });
test("Q6 no evidence is C, not synthesized success", async () => assert.equal((await R.reconstruct()).classification, "C"));
test("Q7 exact mutation mismatch rejects B", async () => { const f = await fixture(); f.executionReceipt.result.audit.committedWrites.evidence = 3; assert.equal((await R.reconstruct(f)).classification, "B"); });
test("Q8 complete fragment extraction handles escaped braces; truncated fragment remains missing", () => {
  const value = { saved: true, text: 'escaped \\" braces } [', result: { committed: true } }, encoded = JSON.stringify(value);
  assert.deepEqual(R.extractExecution('{"receipt":{"runtime":{"execution":' + encoded + ',"missing":'), value);
  assert.equal(R.extractExecution('{"execution":' + encoded.slice(0, -1)), null); assert.equal(R.extractExecution('{}'), null);
});
test("Q9 orphan evidence fails current integrity", async () => { const f = await fixture(); f.snapshot.evidence[0].revisionKey = "missing"; assert.equal((await R.reconstruct(f)).reason, "current_formal_integrity_invalid"); });
test("Q10 duplicate active event fails current integrity", async () => { const f = await fixture(); f.snapshot.entries.push(structuredClone(f.snapshot.entries[0])); assert.equal((await R.reconstruct(f)).reason, "current_formal_integrity_invalid"); });
