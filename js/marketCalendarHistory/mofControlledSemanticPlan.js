"use strict";

// Code-fixed G1.5a semantic approval. Observation timestamps/identities are not approval.
const A = require("./formalWriterAuthorityV2.js");
const C = require("../marketCalendar/marketEventCanonicalizer.js");
const PC = require("./planCanonicalizer.js");
const Gate = require("../marketCalendarRuntime/formalShadowReadOnlyGate.js");
const Shadow = require("./formalShadowWritePlan.js");
const Transition = require("./transitionPlanner.js"), Mapper = require("./storageRecordMapper.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js");
const Compare = require("../marketCalendarRuntime/formalExactComparison.js").createIsolated13Comparison();
const Schema = require("./productionSchemaV1.js"), Core = require("./formalControlledWriterCore.js");
const Integrity = require("./historyIntegrity.js");
const Writer = require("./formalWriterAuthority.js");
const Mof = require("../marketCalendarIsolated/mofJgbVariableAdapter.js");
const MofSource = require("../marketCalendarIsolated/mofJgbSource.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const SOURCE = "jp-mof-jgb-auction-calendar", OPERATION = "controlled-first-formal-write";
// The accepted observation itself is not fresh execution material. Document-set
// content identity may legitimately remain equal, but its old Evidence may not.
const PREVIOUS_EVIDENCE = Object.freeze(["jp-mof-jgb-auction-calendar|sha256:3c14dfb190154287de34f243b79d709ad8dea375bb4959eee500c3be38271288","jp-mof-jgb-auction-calendar|sha256:47a49a2456ebec3a241b4e1e22c6c76b69bc4fe822074320bdcf18c404eef625","jp-mof-jgb-auction-calendar|sha256:f5d2b8df45ca0b6cc1991f5d32a3467d87d3e8919635455e1ca6dc2670acf1f2"]);
const ACCEPTED_EVENTS = A.freeze([
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|10Y|2026-10-06",
    "03dc6d2bf364ef8a10990f84a50e6a0016b40d5606913ebb0599cf2418efe9f2"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|10Y|2026-11-05",
    "f83fc5af14c3e5c4058704cace0aee4a3451bba3bb7b83fe79938ef985f6b5cc"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|10Y|2026-12-03",
    "1d2dcd06d6f232fb7caab62e0e85a3aa43af8c0081753ddc8f4eb078d1918cc2"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|20Y|2026-10-20",
    "543ff523826edf3ec2e05c575c6799d2ce31abdfdfe907beaab650b91753c9b7"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|20Y|2026-11-18",
    "346fb5c0090b2bc573b0d5f204dfc63ad2491e5e18fcbe2520e932518b9b4e65"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|20Y|2026-12-17",
    "923c8565216240307c7f70b77c2f82031232f101a1234d71752e216e5cafba49"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|2Y|2026-10-29",
    "cc1bd532dab2acfc3409c0f9033c2d3fc59454a7da62cf33c26c2b856923a72a"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|2Y|2026-11-30",
    "1ed33f03d20bea99e63a77651bccb45c232fdaa389b90d01dfdab364e52dfe76"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|2Y|2026-12-24",
    "77ead59e0771e5ec07a9955c8e3041e852b12960f9c12938db2e19e35530ba27"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|30Y|2026-10-08",
    "29bd6b474d8611bce09fb354030a1992db06105614acaa8c4f92579f7229c391"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|30Y|2026-11-10",
    "ebe9e94dbf24a67fcede10a1689d4587c5c5fe3ef48b0800d59c97f68a5f8da8"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|30Y|2026-12-08",
    "f9edec64379869f7313fdc0f89d07ddde692e36eea13aa57b6706adcf7acd001"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|40Y|2026-11-25",
    "dd65f20fcdba46322897ce210f6734a37d3eed0706c69571663668a0ac220c60"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|5Y|2026-10-14",
    "f0963f3254a8c02c4bb446e66ae8149a21618c7eb8fd20666ec40c5b5fa557b3"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|5Y|2026-11-12",
    "8626f9ae432d6afbdb1a284b3c4b570b6ca1ad797cf0fc6bc7fd939d8934e8ee"
  ],
  [
    "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|5Y|2026-12-10",
    "c9ba469d270d74862cf1891d40e5f08a8240b3b29d874db0034d0ff6d990d7cf"
  ]
]);
const COUNTS = A.freeze({ eventEntryCreate: 16, eventEntryUpdate: 0, semanticRevisionCreate: 16,
  semanticRevisionClose: 0, evidenceCreate: 16, observationCreate: 16, sourceRunCreate: 1, sourceCursorUpdate: 1 });
const COUNT_OPERATIONS = Object.freeze(["appendEntries", "updateEntries", "appendRevisions", "closeRevisions",
  "appendEvidence", "appendObservations", "appendRuns", "updateCursors"]);
const stableMaterial = A.freeze({ sourceId: SOURCE, operation: OPERATION, events: ACCEPTED_EVENTS,
  mutationClasses: [...PC.ARRAY_KEYS], counts: COUNTS });
const SEMANTIC_IDENTITY = A.hash(stableMaterial);
const preparations = new WeakMap();
const same = (a, b) => A.hash(a) === A.hash(b);
function count(mutations) {
  if (!A.exact(mutations, PC.ARRAY_KEYS) || PC.ARRAY_KEYS.some(k => !Array.isArray(mutations[k])))
    throw Error("controlled_operation_set_invalid");
  return Object.fromEntries(Gate.FIELDS.map((field, i) => [field, mutations[COUNT_OPERATIONS[i]].length]));
}
async function buildPreparation({ source, snapshot, attemptIdentity }, nativeMaterial) {
  source = structuredClone(source); // Freeze the acquisition epoch across asynchronous comparison.
  if (!A.isHash(attemptIdentity) || source?.sourceId !== SOURCE || source.routeIdentity !== Mof.routeIdentity || source.acquisitionOutcome !== "complete" ||
    source.candidateStatus !== "available" || source.failedRoles?.length || !Array.isArray(source.canonicalRecords))
    throw Error("controlled_acquisition_invalid");
  const records = structuredClone(source.canonicalRecords);
  if (records.some(r => PREVIOUS_EVIDENCE.includes(r.acquisitionEvidenceKey)))
    throw Error("controlled_old_observation_replay");
  if (!same(records.map(r => [r.eventKey, r.canonicalContentHash]).sort(), ACCEPTED_EVENTS))
    throw Error("controlled_semantic_ceiling_mismatch");
  const docs = source.documentHealth;
  if (!Array.isArray(docs) || !docs.length || new Set(docs.map(d => d.role)).size !== docs.length ||
    docs.filter(d => d.role === "index").length !== 1 || docs.some(d => d.httpStatus !== 200 || d.redirectCount !== 0 ||
      d.fetchOutcome !== "success" || d.parseOutcome !== "success" || d.requestedUrl !== d.finalUrl ||
      d.encodingEvidence?.resolvedEncoding !== "utf-8" || !MofSource.validateUrl(d.requestedUrl).valid ||
      !A.isHash(d.rawContentHash) || !Number.isSafeInteger(d.byteCount) || d.byteCount <= 0 || d.byteCount > MofSource.MAX_BYTES ||
      (d.role === "index" ? d.requestedUrl !== MofSource.INDEX_URL : d.role !== `month:${MofSource.pageMonth(d.requestedUrl)}`)))
    throw Error("controlled_documents_invalid");
  const setIdentity = A.hash(docs.map(d => ({ role: d.role, url: d.requestedUrl, hash: d.rawContentHash,
    encodingEvidence: d.encodingEvidence })));
  if (source.documentSetIdentity !== setIdentity || source.discovery?.months?.length !== docs.length - 1 ||
    !same(source.discovery.months.map(m => m.url).sort(), docs.filter(d => d.role !== "index").map(d => d.requestedUrl).sort()))
    throw Error("controlled_document_identity_invalid");
  for (const r of records) {
    const semantic = Integrity.semanticContent(r), evidence = r.acquisitionEvidence, registered = Registry.getSource(SOURCE),
      doc = docs.find(d => d.requestedUrl === evidence?.sourceUrl && d.role.startsWith("month:"));
    if (A.hash(semantic) !== r.canonicalContentHash || r.logical.eventKey !== r.eventKey ||
      r.revisionKey !== `${r.eventKey}|sha256:${r.canonicalContentHash}` ||
      !same(r.source, evidence) || evidence.sourceId !== SOURCE || evidence.authority !== registered.authority ||
      evidence.parserId !== registered.parserId || evidence.parserVersion !== registered.parserVersion ||
      !Number.isFinite(Date.parse(evidence.fetchedAt)) ||
      A.hash(evidence) !== r.acquisitionEvidenceHash || r.acquisitionEvidenceKey !== `${SOURCE}|sha256:${r.acquisitionEvidenceHash}` ||
      !doc || doc.rawContentHash !== evidence.rawContentHash || evidence.httpMetadata?.documentSetIdentity !== setIdentity ||
      evidence.httpMetadata?.role !== doc.role || r.absenceAuthority !== "none")
      throw Error("controlled_canonical_evidence_invalid");
  }
  if (!A.isHash(source.documentSetIdentity)) throw Error("controlled_document_identity_invalid");
  const inputSnapshot = structuredClone(snapshot);
  const cycle = Cycle.create(inputSnapshot, Schema.EXPECTED_FINGERPRINT);
  try {
    const context = Cycle.get(cycle, inputSnapshot), before = context.snapshot;
    if (Core.STORE_ORDER.some(([f]) => before[f].some(r => r.sourceId === SOURCE))) throw Error("controlled_first_write_only");
    const comparison = await Compare.compare({ sourceResults: Compare.SOURCE_IDS.map(id => id === SOURCE ?
      { ...source, canonicalRecords: records } : { sourceId: id, canonicalRecords: [], acquisitionOutcome: "not_attempted",
        candidateStatus: "unavailable", absenceAuthority: "none" }), formalSnapshot: before, cycleContext: cycle });
    const summary = comparison.summaries?.find(r => r.sourceId === SOURCE);
    if (comparison.status !== "compared" || !summary || summary.new !== 16 || summary.changed !== 0 ||
      summary.ambiguity !== 0 || comparison.ambiguityCount !== 0) throw Error("controlled_comparison_unsafe");
    const observations = records.map(r => ({ eventKey: r.eventKey, evidenceIdentity: r.acquisitionEvidenceKey,
      evidence: r.acquisitionEvidence })).sort((a, b) => a.eventKey.localeCompare(b.eventKey));
    const acquisitionIdentity = A.hash({ attemptIdentity, observations, documents: docs });
    const fetchedAt = [...new Set(records.map(r => r.acquisitionEvidence.fetchedAt))].sort();
    const run = { sourceId: SOURCE, runId: `controlled-${acquisitionIdentity}`, acceptedAt: fetchedAt.at(-1), fetchedAt,
      status: "accepted", semanticSetHash: A.hash(records.map(r => r.revisionKey).sort()) };
    const t = Transition.planTransition({ snapshot: before, run, canonicalSet: records });
    if (!t.ok) throw Error("controlled_transition_invalid");
    const mapped = Mapper.mapPlan(t.plan), mutations = Object.fromEntries(PC.ARRAY_KEYS.map(k => [k, mapped[k]]));
    const counts = count(mutations);
    if (!same(counts, COUNTS)) throw Error("controlled_mutation_ceiling_mismatch");
    const base = { planVersion: Shadow.PLAN_VERSION, planStatus: "planned", sourceId: SOURCE, sourceOutcome: "complete",
      writerState: "shadow", writeAllowed: false, authorityIdentity: Writer.SHADOW_AUTHORITY.identity,
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, preconditionIdentity: context.snapshotIdentity,
      activeFormalIdentity: A.hash(before.entries), candidateSetIdentity: A.hash(records), acquisitionIdentity,
      comparisonIdentity: A.hash(comparison), retainedCandidateKeys: records.map(r => r.eventKey).sort(),
      mutations, counts, transactionPreparation: "all_hashes_before_transaction" };
    const plan = A.freeze({ ...base, planIdentity: A.hash(base) });
    if (!(await Shadow.validateShadowPlan(plan)).valid) throw Error("controlled_shadow_plan_invalid");
    const execution = nativeMaterial ? null : Core.prepareExecution(plan, before, Object.fromEntries(PC.ARRAY_KEYS.map(k => [k, mutations[k].length])));
    const expected = Core.applyToMemory(before, plan, Core.expectedWrites(plan, before));
    const token = Object.freeze({});
    const data = A.freeze({ plan, before, expected, attemptIdentity, semanticPlanIdentity: SEMANTIC_IDENTITY,
      acquisitionIdentity, documentSetIdentity: source.documentSetIdentity,
      documentObservationIdentity: A.hash(docs), evidenceIdentities: observations.map(r => r.evidenceIdentity),
      comparisonIdentity: base.comparisonIdentity, formalPrecondition: base.preconditionIdentity, planIdentity: plan.planIdentity });
    preparations.set(token, { data, execution, nativeMaterial, consumed: false }); return token;
  } finally { Cycle.close(cycle); }
}
function inspect(token) { const p = preparations.get(token); if (!p || p.consumed) throw Error("controlled_preparation_invalid"); return p.data; }
function inspectNativeMaterial(token) { const p = preparations.get(token);
  if (!p?.nativeMaterial || p.execution !== null) throw Error("native_material_only_required"); return inspect(token); }
function take(token) { const p = preparations.get(token); inspect(token); p.consumed = true; return { data: p.data, execution: p.execution }; }
const prepare = input => buildPreparation(input, false);
const prepareNativeMaterial = input => buildPreparation(input, true);
module.exports = Object.freeze({ SOURCE, OPERATION, ACCEPTED_EVENTS, COUNTS, SEMANTIC_IDENTITY, count, prepare,
  prepareNativeMaterial, inspectNativeMaterial, inspect, take });
