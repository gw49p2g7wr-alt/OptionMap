"use strict";

const Canonicalizer = require("../../../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../../../js/marketCalendar/sourceRegistry.js");
const Contract = require("../../../js/marketCalendarHistory/calendarPartialBootstrapContract.js");
const Existing = require("./automaticShadowFixture.js");
const SourceFixtures = require("./sourceFixtures.js");
const Estat = require("../../../js/marketCalendarIsolated/estatRoute.js");
const Bls = require("../../../js/marketCalendarIsolated/blsFixedRoute.js");
const MofParser = require("../../../js/marketCalendarIsolated/mofJgbParser.js");
const MofFixture = require("./mofJgbFixture.js");

const ACCEPTED_AT = "2026-10-02T00:00:00.000Z";
const FETCHED_AT = "2026-10-01T00:00:00.000Z";
const GENERATION = "b".repeat(64);
const STALE_GENERATION = "c".repeat(64);
const clone = value => structuredClone(value);
function sourceUrl(sourceId) {
  if (Object.hasOwn(Estat.ROUTES, sourceId)) return Estat.ROUTES[sourceId].url;
  if (sourceId === Bls.SOURCE_ID) return Bls.ROLES[0].url;
  if (sourceId === "jp-mof-jgb-auction-calendar")
    return "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm";
  return Registry.getSource(sourceId).canonicalUrl;
}
function roles(sourceId) {
  const group = Contract.SOURCES[sourceId].sameSourceDocumentGroup;
  return group.mode === "exact" ? [...group.requiredRoles] :
    [...group.requiredRoles, `${group.discoveredRolePrefix}2026-10`];
}
async function validSource(sourceId) {
  let record;
  if (sourceId === "jp-mof-jgb-auction-calendar") {
    const parsed = MofParser.parseMonth(MofFixture.current, { sourceUrl: sourceUrl(sourceId),
      fetchedAt: FETCHED_AT, rawContentHash: "a".repeat(64) });
    if (!parsed.ok) throw new Error(parsed.reason);
    const canonical = await Canonicalizer.canonicalize(
      Canonicalizer.toTypedJgbRecord(parsed.records[0]));
    if (!canonical.ok) throw new Error(canonical.reason);
    record = structuredClone(canonical.event);
  } else if (Object.hasOwn(Estat.ROUTES, sourceId)) {
    const source = Estat.shadowRegistry.getSource(sourceId), canonical =
      await Canonicalizer.createCanonicalizer(Estat.shadowRegistry).canonicalize({
        ...SourceFixtures.record(sourceId), sourceId, fetchedAt: FETCHED_AT,
        sourceUrl: sourceUrl(sourceId), parserId: source.parserId,
        parserVersion: source.parserVersion, rawContentHash: "a".repeat(64) });
    if (!canonical.ok) throw new Error(canonical.reason);
    record = structuredClone(canonical.event);
  } else record = await Existing.event(sourceId, FETCHED_AT, { sourceUrl: sourceUrl(sourceId) });
  const
    records = [record], candidateIdentity = await Canonicalizer.sha256({ sourceId,
      generationIdentity: GENERATION, revisionKeys: records.map(value => value.revisionKey) });
  return { sourceId, routeIdentity: Contract.expectedRouteIdentity(sourceId),
    generationIdentity: GENERATION, acquisitionOutcome: "complete", candidateStatus: "available",
    formalEligible: true, candidateIdentity, canonicalRecords: records, parserStatus: "success",
    structureGuardStatus: "passed", canonicalizationStatus: "success", parserDiagnostics: [],
    canonicalDiagnostics: [], failedRoles: [], ambiguityCount: 0, duplicateCount: 0,
    identityCollisionCount: 0, absenceAuthority: "none", documentHealth: roles(sourceId).map(role => ({
      role, fetchOutcome: "success", parseOutcome: "success", httpStatus: 200, redirectCount: 0 })) };
}
async function allSuccess() {
  return Promise.all(Contract.EXPECTED_SOURCE_IDS.map(validSource));
}
function notAttempted(sourceId) {
  return { sourceId, generationIdentity: GENERATION, acquisitionOutcome: "not_attempted" };
}
function parserFailure(source) {
  const value = clone(source);
  value.acquisitionOutcome = "failed"; value.candidateStatus = "unavailable";
  value.formalEligible = false; value.candidateIdentity = null; value.canonicalRecords = [];
  value.parserStatus = "structure_change"; value.structureGuardStatus = "failed";
  value.canonicalizationStatus = "not_attempted"; value.parserDiagnostics = ["structure_change"];
  value.failedRoles = [value.documentHealth[0].role];
  value.documentHealth[0].parseOutcome = "failure";
  return value;
}
function transportFailure(source) {
  const value = clone(source);
  value.acquisitionOutcome = "failed"; value.candidateStatus = "unavailable";
  value.formalEligible = false; value.candidateIdentity = null; value.canonicalRecords = [];
  value.parserStatus = "not_attempted"; value.structureGuardStatus = "failed";
  value.canonicalizationStatus = "not_attempted"; value.failedRoles = [value.documentHealth[0].role];
  value.documentHealth[0].fetchOutcome = "failure";
  value.documentHealth[0].parseOutcome = "not_attempted";
  return value;
}
async function rebindEvidence(record, sourceId) {
  const source = Registry.getSource(sourceId), acquisitionEvidence = { ...record.acquisitionEvidence,
    sourceId, authority: source.authority, sourceUrl: sourceUrl(sourceId), parserId: source.parserId,
    parserVersion: source.parserVersion }, acquisitionEvidenceHash =
    await Canonicalizer.sha256(acquisitionEvidence);
  return { ...clone(record), source: acquisitionEvidence, acquisitionEvidence,
    acquisitionEvidenceHash, acquisitionEvidenceKey: `${sourceId}|sha256:${acquisitionEvidenceHash}` };
}
async function scenarios() {
  const base = await allSuccess(), byId = values => new Map(values.map(value => [value.sourceId, value])),
    F1 = clone(base), F2 = clone(base), F3 = clone(base), F4 = Contract.EXPECTED_SOURCE_IDS.map(notAttempted),
    F5 = clone(base).map(transportFailure), F6 = clone(base), F7 = clone(base), F8 = clone(base),
    F9 = clone(base), F10 = clone(base);
  const f2 = byId(F2); f2.set("us-bls-calendar", parserFailure(f2.get("us-bls-calendar")));
  const f3 = byId(F3); f3.set("us-bea-calendar", transportFailure(f3.get("us-bea-calendar")));
  const only = clone(base[0]); F4[F4.findIndex(value => value.sourceId === only.sourceId)] = only;
  byId(F6).get("jp-jpx-derivatives-calendar").documentHealth.pop();
  byId(F7).get("us-fed-fomc-calendar").ambiguityCount = 1;
  byId(F8).get("jp-jpx-market-holidays").generationIdentity = STALE_GENERATION;
  const duplicate = byId(F9).get("us-census-calendar");
  duplicate.canonicalRecords.push(clone(duplicate.canonicalRecords[0]));
  duplicate.candidateIdentity = await Canonicalizer.sha256({ sourceId: duplicate.sourceId,
    generationIdentity: GENERATION, revisionKeys: duplicate.canonicalRecords.map(value => value.revisionKey) });
  const f10 = byId(F10), left = f10.get("jp-esri-sna-calendar"),
    right = f10.get("us-census-calendar");
  right.canonicalRecords = [await rebindEvidence(left.canonicalRecords[0], right.sourceId)];
  right.candidateIdentity = await Canonicalizer.sha256({ sourceId: right.sourceId,
    generationIdentity: GENERATION, revisionKeys: right.canonicalRecords.map(value => value.revisionKey) });
  return { F1, F2: [...f2.values()], F3: [...f3.values()], F4, F5, F6, F7, F8, F9,
    F10, acceptedAt: ACCEPTED_AT, generationIdentity: GENERATION };
}

function formalSnapshot(sourceIds) {
  const snapshot = { entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] };
  for (const [index, sourceId] of sourceIds.entries()) {
    const acceptedAt = `2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      eventKey = `${sourceId}|fixture-event`, revisionKey = `${eventKey}|sha256:${"d".repeat(64)}`,
      runId = `partial-fixture-${index}`, runKey = `${sourceId}|${runId}`;
    snapshot.entries.push({ sourceId, eventKey, activeRevisionKey: revisionKey });
    snapshot.revisions.push({ sourceId, eventKey, revisionKey, validTo: null });
    snapshot.runs.push({ sourceId, runId, runKey, acceptedAt });
    snapshot.cursors.push({ sourceId, runId, runKey, acceptedAt });
  }
  return snapshot;
}

module.exports = Object.freeze({ ACCEPTED_AT, FETCHED_AT, GENERATION, STALE_GENERATION,
  validSource, allSuccess, notAttempted, parserFailure, transportFailure, scenarios,
  formalSnapshot });
