"use strict";

const Canonicalizer = require("../../../js/marketCalendar/marketEventCanonicalizer.js");
const Integrity = require("../../../js/marketCalendarHistory/historyIntegrity.js");
const Transition = require("../../../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../../../js/marketCalendarHistory/storageRecordMapper.js");
const WriterCore = require("../../../js/marketCalendarHistory/formalControlledWriterCore.js");
const Schema = require("../../../js/marketCalendarHistory/productionSchemaV1.js");
const Preparation = require("../../../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Acquisition = require("./partialBootstrapFixture.js");

const clone = value => structuredClone(value);
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [],
  cursors: [] });
async function descriptor(snapshot = empty(), databaseStatus = "present") {
  const value = { databaseStatus, schemaVersion: Schema.VERSION,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, snapshotFingerprint: null,
    ...clone(snapshot) };
  value.snapshotFingerprint = await Preparation.fingerprintFormalSnapshot(value);
  return value;
}
async function absentDescriptor() {
  return descriptor(empty(), "absent");
}
async function snapshotWithSources(sourceIds) {
  let snapshot = empty();
  for (const [index, sourceId] of sourceIds.entries()) {
    const acquisition = await Acquisition.validSource(sourceId), records =
      acquisition.canonicalRecords.slice().sort((left, right) =>
        left.eventKey.localeCompare(right.eventKey)), acceptedAt =
      `2026-10-01T01:${String(index).padStart(2, "0")}:00.000Z`, run = {
        sourceId, runId: `baseline-${index}`, acceptedAt,
        fetchedAt: [...new Set(records.map(value => value.acquisitionEvidence.fetchedAt))].sort(),
        status: "accepted", semanticSetHash: await Canonicalizer.sha256(
          records.map(value => value.revisionKey).sort())
      }, transition = Transition.planTransition({ snapshot, run, canonicalSet: records });
    if (!transition.ok) throw new Error(transition.errors?.join(",") || transition.outcome);
    const mapped = Mapper.mapPlan(transition.plan), mutations = Object.fromEntries(
      Preparation.MUTATION_KEYS.map(key => [key, clone(mapped[key])])), plan = { sourceId, mutations },
      updates = WriterCore.expectedWrites(plan, snapshot);
    if (!updates || !WriterCore.planScopeValid(plan) || !WriterCore.linkageValid(plan, snapshot))
      throw new Error("fixture_plan_invalid");
    snapshot = WriterCore.applyToMemory(snapshot, plan, updates);
  }
  const audited = await Integrity.audit(snapshot);
  if (!audited.valid) throw new Error(audited.errors.join(","));
  return descriptor(snapshot);
}
async function input(sourceId, formalSnapshot = null, acquisition = null) {
  return { sourceId, acquisition: acquisition || await Acquisition.validSource(sourceId),
    formalSnapshot: formalSnapshot || await absentDescriptor(), acceptedAt: Acquisition.ACCEPTED_AT,
    generation: Acquisition.GENERATION, authority: clone(Preparation.AUTHORITY) };
}
async function replaceRecords(acquisition, records) {
  const value = clone(acquisition);
  value.canonicalRecords = clone(records);
  value.candidateIdentity = await Canonicalizer.sha256({ sourceId: value.sourceId,
    generationIdentity: value.generationIdentity,
    revisionKeys: value.canonicalRecords.map(record => record.revisionKey) });
  return value;
}
async function changedAcquisition(sourceId) {
  const acquisition = await Acquisition.validSource(sourceId), record =
    clone(acquisition.canonicalRecords[0]);
  record.title = { ...record.title, ja: `${record.title.ja}-変更` };
  record.canonicalContentHash = await Canonicalizer.sha256(Integrity.semanticContent(record));
  record.revisionKey = `${record.eventKey}|sha256:${record.canonicalContentHash}`;
  return replaceRecords(acquisition, [record]);
}
async function applyPrepared(formalSnapshot, plan) {
  const before = Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
    [field, clone(formalSnapshot[field])])), draft = { sourceId: plan.sourceId,
    mutations: clone(plan.mutations) }, updates = WriterCore.expectedWrites(draft, before);
  if (!updates) throw new Error("fixture_precondition_invalid");
  return descriptor(WriterCore.applyToMemory(before, draft, updates));
}

module.exports = Object.freeze({ empty, descriptor, absentDescriptor, snapshotWithSources, input,
  replaceRecords, changedAcquisition, applyPrepared });
