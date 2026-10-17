"use strict";
const assert = require("node:assert/strict");
const Old = require("./automaticShadowFixture.js"), Accepted = require("./mofControlledFixture.js");
const Html = require("./mofJgbFixture.js"), Routes = require("../../../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Reevaluation = require("../../../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const Transition = require("../../../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../../../js/marketCalendarHistory/storageRecordMapper.js");
const Runtime = require("../../../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js");
const Canonical = require("../../../js/marketCalendar/marketEventCanonicalizer.js");
const Schema = require("../../../js/marketCalendarHistory/productionSchemaV1.js");
const Registry = require("../../../js/marketCalendar/sourceRegistry.js");
const MOF = "jp-mof-jgb-auction-calendar", AT = "2026-10-13T00:00:00.000Z";
function completed(id) {
  const at = Old.OLD, state = { sourceId: id, lastAttemptAt: at, lastSuccessAt: null,
    lastOutcome: "failure", retryAfter: id === "us-bls-calendar" ? new Date(Date.parse(at) + 3600000).toISOString() : null,
    lastHttpStatus: id === "us-bls-calendar" ? null : 404,
    lastDiagnosticClass: Reevaluation.APPROVALS[id].allowedDiagnostic, coordinatorVersion: 1 };
  const evaluation = Reevaluation.evaluate({ sourceId: id, state, authority: Routes.PRODUCTION_AUTHORITY, requestedAt: at });
  assert(evaluation.eligible);
  const reserved = Reevaluation.reserveState(state, evaluation, at);
  const done = Reevaluation.completeState({ state: reserved, token: Reevaluation.reservationToken(reserved),
    authority: Routes.PRODUCTION_AUTHORITY, result: { lastAttemptAt: at, lastOutcome: "success",
      lastHttpStatus: 200, lastDiagnosticClass: null }, completedAt: at });
  assert(done.valid); return done.state;
}
async function setup({ store, patch = {}, readFormal, compose = Runtime.create } = {}) {
  const f = await Old.fixture(), accepted = await Accepted.source("normal-seed");
  const run = { sourceId: MOF, runId: "normal-seed", acceptedAt: "2026-10-09T00:02:00.000Z",
    fetchedAt: [...new Set(accepted.canonicalRecords.map(r => r.acquisitionEvidence.fetchedAt))],
    semanticSetHash: await Canonical.sha256(accepted.canonicalRecords.map(r => r.revisionKey).sort()), status: "accepted" };
  const plan = Transition.planTransition({ snapshot: f.snapshot, run, canonicalSet: accepted.canonicalRecords });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  const m = Mapper.mapPlan(plan.plan);
  for (const [k, a] of [["entries", "appendEntries"], ["revisions", "appendRevisions"], ["evidence", "appendEvidence"],
    ["observations", "appendObservations"], ["runs", "appendRuns"]]) f.snapshot[k].push(...m[a]);
  f.snapshot.cursors.push(...m.updateCursors);
  const documents = { "https://www.mof.go.jp/jgbs/auction/calendar/index.htm": Html.index() };
  for (const month of ["2610", "2611", "2612"]) {
    const dateMonth = `20${month.slice(0, 2)}-${month.slice(2)}`;
    documents[`https://www.mof.go.jp/jgbs/auction/calendar/${month}.htm`] = Html.month(month,
      accepted.canonicalRecords.filter(r => r.logical.auctionIdentity.auctionDate.startsWith(dateMonth)).map(r => {
        const a = r.logical.auctionIdentity, d = Number(a.auctionDate.slice(8));
        return Html.row(`${Number(month.slice(2))}月${d}日`, `${parseInt(a.maturity)}年利付国債`);
      }));
  }
  Object.assign(documents, patch);
  let clock = AT, requests = [], legacyCalls = [], formalReads = 0;
  const states = new Map(), stores = {};
  for (const [name, id] of [["labor", "jp-stat-labor"], ["cpi", "jp-stat-cpi"], ["bls", "us-bls-calendar"]]) {
    states.set(id, completed(id));
    stores[name] = { read: async () => ({ status: "ok", value: structuredClone(states.get(id)) }),
      reserveReevaluation: async () => { throw Error("unexpected_reservation"); },
      completeReevaluation: async () => { throw Error("unexpected_reservation"); },
      completeInitialAcquisition: async () => { throw Error("unexpected_initial_acquisition"); },
      completeActiveAcquisition: async input => {
        const result = Reevaluation.normalStateUpdate({ ...input, state: states.get(id), authority: Routes.PRODUCTION_AUTHORITY });
        assert.equal(result.valid, true, result.reason); states.set(id, result.state); return { status: "ok", state: result.state };
      } };
  }
  const candidate = async s => {
    const source = Registry.getSource(s.sourceId), revisionKeys = s.canonicalRecords.map(r => r.revisionKey).sort();
    const sourceIdentity = { sourceId: s.sourceId, parserId: source.parserId, parserVersion: source.parserVersion,
      candidateSchemaVersion: 1, semanticSetHash: await Canonical.sha256(revisionKeys) };
    return { sourceId: s.sourceId, candidateStatus: "available", formalEligible: true, canonicalRecords: s.canonicalRecords,
      candidateIdentity: await Canonical.sha256({ sourceId: s.sourceId, parserId: source.parserId,
        parserVersion: source.parserVersion, candidateSchemaVersion: 1, revisionKeys }),
      recordCount: s.canonicalRecords.length, parserStatus: "success", canonicalizationStatus: "success",
      parserDiagnostics: [], canonicalDiagnostics: [], sourceIdentity };
  };
  const runtime = compose({ store, stores, targetEnvironment: "isolated_test", now: () => clock,
    fetchImpl: async (url, opts) => { requests.push({ url, method: opts.method, redirect: opts.redirect, credentials: opts.credentials });
      assert(url in documents); const d = documents[url];
      return typeof d === "function" ? d(url, opts) : new Response(d, { headers: { "content-type": "text/html; charset=UTF-8" } }); },
    acquire: async ({ sourceId }) => { legacyCalls.push(sourceId);
      await new Promise(resolve => setTimeout(resolve, 1));
      return { success: true, sourceId, documents: [{ role: "primary", httpStatus: 200, redirects: [] }] }; },
    builder: { buildCalendarCandidate: async ({ sourceId }) => candidate(f.sources.find(s => s.sourceId === sourceId)) },
    adapterFactory: () => ({ acquire: async ({ sourceId }) => {
      legacyCalls.push(sourceId); const s = f.sources.find(s => s.sourceId === sourceId);
      let c = await candidate(s);
      if (sourceId === "jp-stat-cpi") {
        const tokyo = await Old.event(sourceId, AT, { referencePeriod: s.canonicalRecords[0].logical.referencePeriod,
          eventType: "JP_TOKYO_CPI", scope: "tokyo", edition: "preliminary" });
        c = { ...c, canonicalRecords: [...c.canonicalRecords, tokyo], recordCount: c.recordCount + 1 };
      }
      return { ...Old.envelope(s), candidateEnvelope: c,
        documentHealth: s.documentHealth.map(d => ({ ...d, candidateCount: 1 })),
        coverage: { coverageState: "sufficient", laneAssessments: ["national", "tokyo"].map(lane => ({ lane, coverageState: "sufficient" })),
          roleCoverage: ["cpi", "ppi", "employment_situation", "jolts"].map(role => ({ role, state: "sufficient" })) } };
    } }),
    readFormal: readFormal || (async () => { formalReads++; return { status: "ok", snapshot: structuredClone(f.snapshot),
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, audit: { readonly: 1, readwrite: 0, create: 0, upgrade: 0, handles: 0 } }; }) });
  return { runtime, snapshot: f.snapshot, states, requests, legacyCalls, documents,
    setClock: value => { clock = value; }, reads: () => formalReads };
}
module.exports = { MOF, AT, completed, setup };
