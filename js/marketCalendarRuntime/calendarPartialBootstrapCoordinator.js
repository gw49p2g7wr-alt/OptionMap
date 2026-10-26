"use strict";

// Main-owned CAL-PB-B4 coordinator. Acquisition stays with the existing normal
// runtime; this layer only admits independently eligible, currently missing
// sources and never enables existing-source revision execution.
const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const Coverage = require("../marketCalendarHistory/calendarPartialCoverage.js");
const Preparation = require("../marketCalendarHistory/calendarPartialSourcePreparation.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");

const clone = value => value == null ? value : structuredClone(value);
const freeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const emptySnapshot = () => Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field => [field, []]));
async function descriptor(read) {
  if (read?.status === "unavailable" && read.reason === "formal_database_absent") {
    const value = { databaseStatus: "absent", schemaVersion: Schema.VERSION,
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, snapshotFingerprint: null,
      ...emptySnapshot() };
    value.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(value);
    return { valid: true, value, reason: null };
  }
  if (read?.status !== "ok" || read.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      !read.snapshot) return { valid: false, value: null,
    reason: read?.reason || "formal_read_failed" };
  const value = { databaseStatus: "present", schemaVersion: Schema.VERSION,
    schemaFingerprint: read.schemaFingerprint, snapshotFingerprint: null,
    ...Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
      [field, clone(read.snapshot[field])])) };
  value.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(value);
  return { valid: true, value, reason: null };
}
function compactCoverage(value, failedSourceIds) {
  const projected = Coverage.projectPartialCoverage({ formalSnapshot: value,
    schemaVersion: value.schemaVersion });
  return freeze({ expectedSourceCount: projected.expectedCount,
    formalPersistedSourceCount: projected.coverageCount,
    persistedSourceIds: projected.persistedSourceIds,
    absentSourceIds: projected.absentSourceIds,
    invalidSourceIds: projected.invalidSourceIds,
    failedSourceIds: [...failedSourceIds] });
}
function createCalendarPartialBootstrapCoordinator({ readFormal, executionAuthority, executor,
  notify = async () => undefined } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document)
    throw new Error("main_side_only");
  if (typeof readFormal !== "function" || typeof executionAuthority?.issueGrant !== "function" ||
      typeof executor?.executeCalendarFormalSourceMutation !== "function" ||
      typeof notify !== "function") throw new TypeError("partial_bootstrap_runtime_invalid");
  let serial = Promise.resolve(), last = null, lastGeneration = null;
  async function perform({ sourceResults, acceptedAt, generationIdentity } = {}) {
    const validTime = Number.isFinite(Date.parse(acceptedAt || "")), validGeneration =
      /^[0-9a-f]{64}$/.test(generationIdentity || "");
    if (!Array.isArray(sourceResults) || !validTime || !validGeneration)
      return freeze({ status: "rejected", reason: "acquisition_generation_invalid",
        writerExecution: 0, eligibleSourceCount: 0, committedSourceIds: [], sourceResults: [],
        legacyBootstrapEligible: false, coverage: null, ownershipBySource: {} });
    if (lastGeneration === generationIdentity) return freeze({ status: "duplicate_generation",
      reason: null, writerExecution: 0, eligibleSourceCount: 0, committedSourceIds: [],
      sourceResults: [], legacyBootstrapEligible: false,
      coverage: last?.coverage || null, ownershipBySource: {} });
    lastGeneration = generationIdentity;
    const bound = sourceResults.map(clone), evaluated =
      await Contract.evaluateAcquisitionGeneration({ sourceResults: bound, acceptedAt,
        generationIdentity }), eligible = new Set(evaluated.eligibleSources), failed = [
        ...evaluated.failedSources, ...evaluated.invalidSources], initial = await descriptor(
        await readFormal());
    if (!initial.valid) return freeze({ status: "rejected", reason: initial.reason,
      writerExecution: 0, eligibleSourceCount: eligible.size, committedSourceIds: [],
      sourceResults: evaluated.results.map(value => ({ sourceId: value.sourceId,
        status: value.classification, reason: value.reason, owner: null })),
      legacyBootstrapEligible: false, coverage: null, ownershipBySource: {} });
    let current = initial.value, projected = compactCoverage(current, failed),
      initialAbsent = current.databaseStatus === "absent", writes = 0, stopped = false,
      committedSourceIds = [], rows = [], ownershipBySource = {};
    const acquisitions = new Map(bound.map(value => [value.sourceId, value]));
    for (const sourceId of Contract.EXPECTED_SOURCE_IDS) {
      const eligibility = evaluated.results.find(value => value.sourceId === sourceId),
        present = projected.persistedSourceIds.includes(sourceId);
      if (present) { rows.push({ sourceId, status: "existing_source_skipped",
        reason: "existing_source_revision_wiring_disabled", owner: null }); continue; }
      if (!eligible.has(sourceId)) { rows.push({ sourceId, status: eligibility?.classification ||
        "not_attempted", reason: eligibility?.reason || "source_not_attempted", owner: null });
        continue; }
      ownershipBySource[sourceId] = "partial_bootstrap";
      if (stopped) { rows.push({ sourceId, status: "not_attempted",
        reason: "first_source_failure_generation_stopped", owner: "partial_bootstrap" }); continue; }
      const plan = await Preparation.prepareCalendarFormalSourceMutation({ sourceId,
        acquisition: acquisitions.get(sourceId), formalSnapshot: current, acceptedAt,
        generation: generationIdentity, authority: clone(Preparation.AUTHORITY) });
      if (!["ready_first_source", "ready_append_source"].includes(plan.status)) {
        rows.push({ sourceId, status: "rejected", reason: plan.status === "ready_new_revision" ||
          plan.status === "no_semantic_change" ? "existing_source_revision_wiring_disabled" :
          plan.reason || "source_preparation_failed", owner: "partial_bootstrap" });
        if (current.databaseStatus === "absent") stopped = true;
        continue;
      }
      const issued = await executionAuthority.issueGrant(plan);
      if (!issued.valid) { rows.push({ sourceId, status: "rejected",
        reason: issued.reason || "grant_rejected", owner: "partial_bootstrap" });
        if (current.databaseStatus === "absent") stopped = true;
        continue;
      }
      const outcome = await executor.executeCalendarFormalSourceMutation({ plan,
        grant: issued.grant });
      if (outcome.status !== "committed" || outcome.committed !== true ||
          outcome.durableReceipt?.verified !== true) {
        rows.push({ sourceId, status: outcome.status || "rejected",
          reason: outcome.reason || "durable_receipt_invalid", owner: "partial_bootstrap" });
        if (current.databaseStatus === "absent") stopped = true;
        continue;
      }
      writes++; committedSourceIds.push(sourceId);
      rows.push({ sourceId, status: "committed", reason: null, owner: "partial_bootstrap",
        operation: outcome.operation, planIdentity: plan.planIdentity,
        snapshotFingerprint: outcome.durableReceipt.snapshotFingerprint });
      const fresh = await descriptor(await readFormal());
      if (!fresh.valid || fresh.value.databaseStatus !== "present") {
        stopped = true; rows.at(-1).status = "readback_unavailable";
        rows.at(-1).reason = fresh.reason || "formal_read_failed"; break;
      }
      current = fresh.value; projected = compactCoverage(current, failed);
    }
    projected = compactCoverage(current, failed);
    if (writes) await notify();
    const status = stopped ? "partial_failure" : writes ? "committed" : "write0",
      legacyBootstrapEligible = initialAbsent && eligible.size === 0 && writes === 0 && !stopped;
    return freeze({ status, reason: stopped ? "source_execution_failed" : null,
      writerExecution: writes, eligibleSourceCount: eligible.size, committedSourceIds,
      sourceResults: rows, legacyBootstrapEligible, coverage: projected,
      ownershipBySource, generationIdentity });
  }
  function processGeneration(input) {
    const task = serial.then(() => perform(input));
    serial = task.then(value => { last = value; return undefined; }, () => undefined);
    return task;
  }
  return Object.freeze({ processGeneration, diagnostics: () => clone(last),
    close: () => { lastGeneration = "closed"; } });
}

module.exports = Object.freeze({ descriptor, createCalendarPartialBootstrapCoordinator });
