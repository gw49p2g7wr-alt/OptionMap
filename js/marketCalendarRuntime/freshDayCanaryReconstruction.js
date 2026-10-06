"use strict";

// Pure post-commit evidence inspection. No DB/transport/state setter/startup or
// executor calls. This report is NOT a replacement execution receipt or approval.
const E = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Core = require("../marketCalendarHistory/formalControlledWriterCore.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Shadow = require("./automaticFormalShadow.js");
const COUNTS = Object.freeze({ entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 });
const fail = reason => { throw Error(reason); };
async function reconstruct({ record, snapshot, schemaFingerprint, executionReceipt } = {}) {
  if (!record || !snapshot) return { valid: false, classification: "C", durableAcceptance: "INCOMPLETE", reason: "reconstruction_input_missing" };
  try {
    if (!E.validateEnvelope(record).valid || record.schemaVersion !== 2 || record.safety.sequence !== 7 ||
        record.safety.persistedAuthorityVersion !== 3 || record.safety.pendingFence || record.safety.globalSuspend.suspended ||
        record.safety.sources.some(s => s.suspended)) fail("durable_safety_invalid");
    const events = record.transitionAudit.slice(2), expected = ["fence_created", "formal_write_started", "commit_observed", "readback_verified", "fence_completed"];
    if (record.transitionAudit.length !== 7 || record.transitionAudit[0].event.type !== "migration" ||
        record.transitionAudit[1].event.type !== "authority_transition" || events.some((row, i) =>
          row.previousSafetySequence !== 2 + i || row.nextSafetySequence !== 3 + i || (row.event.phase || row.event.type) !== expected[i]))
      fail("durable_chain_invalid");
    const binding = events[0].event.binding, proof = events.at(-1).event.proof;
    if (binding.sourceId !== E.SOURCE || binding.trustedOperation !== "startup" || binding.globalAuthorityVersion !== 3 ||
        binding.safetySequence !== 2 || !Core.same(binding.mutationCeiling, E.COUNTS) ||
        proof.freshReadonly !== true || proof.integrityValid !== true || proof.otherSourcesUnchanged !== true ||
        proof.committed !== true || !Core.same(proof.mutationCounts, E.COUNTS)) fail("durable_proof_invalid");
    if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT) fail("schema_fingerprint_mismatch");
    if (!await Shadow.integrity(snapshot)) fail("current_formal_integrity_invalid");
    const identity = await Canonical.sha256(Core.sorted(snapshot));
    if (identity !== proof.expectedIdentity || identity !== proof.observedIdentity) fail("current_formal_proof_mismatch");
    const result = executionReceipt?.result, audit = result?.audit;
    if (executionReceipt?.saved !== true || executionReceipt.finalSequence !== 7 || executionReceipt.pendingCleared !== true ||
        result?.status !== "verified" || result.committed !== true || !audit || audit.readwrite !== 1 || audit.committed !== 1 ||
        audit.aborted !== 0 || audit.create !== 0 || audit.upgrade !== 0 || audit.delete !== 0 || audit.openHandles !== 0 ||
        audit.readbackReopens !== 1 || !Core.same(audit.committedWrites, COUNTS) || !Core.same(audit.attemptedWrites, COUNTS) ||
        result.verification?.valid !== true || result.verification.expectedIdentity !== identity || result.verification.observedIdentity !== identity)
      fail("original_exact_mutation_evidence_missing_or_invalid");
    const own = field => snapshot[field].filter(r => r.sourceId === E.SOURCE);
    const cursor = own("cursors");
    if (own("entries").length !== 4 || own("revisions").length !== 4 || cursor.length !== 1) fail("machinery_current_count_mismatch");
    const run = own("runs").find(r => r.runKey === cursor[0].runKey);
    if (!run || run.runId !== cursor[0].runId || run.acceptedAt !== cursor[0].acceptedAt) fail("machinery_cursor_linkage_invalid");
    const evidence = own("evidence").filter(r => r.runId === run.runId), observations = own("observations").filter(r => r.runId === run.runId);
    if (evidence.length !== 4 || observations.length !== 4 || new Set(evidence.map(e => e.eventKey)).size !== 4 ||
        new Set(observations.map(o => o.eventKey)).size !== 4 || own("entries").some(entry =>
          entry.lastObservedAt !== run.acceptedAt || !evidence.some(e => e.eventKey === entry.eventKey && e.revisionKey === entry.activeRevisionKey) ||
          !observations.some(o => o.eventKey === entry.eventKey && o.state === "observed"))) fail("machinery_run_linkage_invalid");
    return { valid: true, classification: "A", durableAcceptance: "COMPLETE", reason: null,
      sequenceChain: [2, 3, 4, 5, 6, 7], sourceId: E.SOURCE, authorizationIdentity: binding.authorizationIdentity,
      formalIdentity: identity, currentCounts: Object.fromEntries(Core.STORE_ORDER.map(([f]) => [f, snapshot[f].length])),
      exactMutationCounts: proof.mutationCounts, originalTransactionAudit: audit,
      currentRun: { runId: run.runId, acceptedAt: run.acceptedAt, evidence: evidence.length, observations: observations.length },
      preservedHistoricalEvidence: own("evidence").length - evidence.length,
      activeCount: snapshot.entries.length, integrityValid: true, other11Unchanged: { durableProof: true, fullCurrentSnapshotMatchesOriginalReadback: true,
        independentBeforeBytesAvailable: false },
      originalLatencyRecovered: { transactionMs: result.transactionMs, readbackMs: result.readbackMs },
      unrecoverableTelemetry: ["network_total", "observer_total", "acquisition_latency", "formal_read_latency", "planning_latency", "fence_persist_latency", "completion_persist_latency"],
      writerExecution: 0, readwrite: 0 };
  } catch (e) { return { valid: false, classification: "B", durableAcceptance: "INCOMPLETE",
    reason: /^[a-z_]+$/.test(e.message) ? e.message : "reconstruction_invalid", writerExecution: 0, readwrite: 0 }; }
}
function extractExecution(text) {
  const key = '"execution":', found = text.indexOf(key);
  if (found < 0) return null;
  const start = found + key.length;
  if (text[start] !== "{") return null;
  let depth = 0, string = false, escaped = false;
  for (let at = start; at < text.length; at++) {
    const c = text[at];
    if (string) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') string = false; continue; }
    if (c === '"') string = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") if (--depth === 0) { try { return JSON.parse(text.slice(start, at + 1)); } catch (_) { return null; } }
  }
  return null; // Never append missing braces or synthesize the missing full receipt.
}
module.exports = Object.freeze({ reconstruct, extractExecution });
