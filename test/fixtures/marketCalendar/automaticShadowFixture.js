"use strict";
const assert = require("node:assert/strict");
const Canonical = require("../../../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../../../js/marketCalendar/sourceRegistry.js");
const Routes = require("../../../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Compare = require("../../../js/marketCalendarRuntime/formalExactComparison.js");
const Transition = require("../../../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../../../js/marketCalendarHistory/storageRecordMapper.js");
const Fixtures = require("./sourceFixtures.js");
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
const OLD = "2026-09-01T00:00:00.000Z", FRESH = "2026-10-01T00:00:00.000Z";
async function event(sourceId, fetchedAt = FRESH, overrides = {}) {
  const source = Registry.getSource(sourceId);
  const c = await Canonical.canonicalize({ ...Fixtures.record(sourceId), sourceId, fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion, rawContentHash: "a".repeat(64), ...overrides });
  assert.equal(c.ok, true, c.reason); return structuredClone(c.event);
}
async function fixture({ perSource = 1, historyRuns = 1 } = {}) {
  const snapshot = empty(), sources = [];
  for (const sourceId of Compare.SOURCE_IDS) {
    const month = Fixtures.record(sourceId).referencePeriod;
    const overrides = index => ({ referencePeriod: /Q/.test(month) ? `${2000 + Math.floor(index / 4)}-Q${index % 4 + 1}` :
      /meeting/.test(month) ? `${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}-meeting` :
      month.length === 10 ? new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10) :
      `${2000 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}` });
    const canonicalSet = await Promise.all(Array.from({ length: perSource }, (_, i) => event(sourceId, OLD, overrides(i))));
    let own = empty();
    for (let n = 0; n < historyRuns; n++) {
      const at = new Date(Date.parse(OLD) + (n - historyRuns + 1) * 86400000).toISOString();
      const records = await Promise.all(canonicalSet.map(async r => {
        const acquisitionEvidence = { ...r.acquisitionEvidence, fetchedAt: at };
        const acquisitionEvidenceHash = await Canonical.sha256(acquisitionEvidence);
        return { ...r, acquisitionEvidence, source: acquisitionEvidence, acquisitionEvidenceHash,
          acquisitionEvidenceKey: `${sourceId}|sha256:${acquisitionEvidenceHash}` };
      }));
      const run = { sourceId, runId: `history-${n}`, acceptedAt: at, fetchedAt: [at], status: "accepted",
        semanticSetHash: await Canonical.sha256(records.map(r => r.revisionKey).sort()) };
      const transition = Transition.planTransition({ snapshot: own, run, canonicalSet: records });
      assert.equal(transition.ok, true, transition.errors?.join(","));
      const m = Mapper.mapPlan(transition.plan);
      for (const [field, key] of [["entries", "appendEntries"], ["revisions", "appendRevisions"],
        ["evidence", "appendEvidence"], ["observations", "appendObservations"], ["runs", "appendRuns"]]) own[field].push(...m[key]);
      for (const update of m.updateEntries) {
        const index = own.entries.findIndex(e => e.eventKey === update.eventKey);
        own.entries[index] = { ...own.entries[index], activeRevisionKey: update.activeRevisionKey,
          lastObservedAt: update.lastObservedAt };
      }
      own.cursors = m.updateCursors;
    }
    for (const key of Object.keys(snapshot)) snapshot[key].push(...own[key]);
    sources.push({ sourceId, routeIdentity: Routes.PRODUCTION_AUTHORITY.entries.find(e => e.sourceId === sourceId).routeIdentity,
      canonicalRecords: await Promise.all(Array.from({ length: perSource }, (_, i) => event(sourceId, FRESH, overrides(i)))),
      candidateStatus: "available", candidateIdentity: "fixture-candidate", acquisitionOutcome: "complete", failedRoles: [],
      documentHealth: (sourceId === "us-bls-calendar" ? ["cpi", "ppi", "employment_situation", "jolts"] : ["primary"])
        .map(role => ({ role, fetchOutcome: "success", parseOutcome: "success", httpStatus: 200, redirectCount: 0 })),
      absenceAuthority: "none", coverage: null });
  }
  return { snapshot, sources };
}
const envelope = s => ({ ...s, candidateEnvelope: { canonicalRecords: s.canonicalRecords,
  candidateIdentity: s.candidateIdentity, candidateStatus: s.candidateStatus } });
module.exports = { event, fixture, envelope, empty, OLD, FRESH };
