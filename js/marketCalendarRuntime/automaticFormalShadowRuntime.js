"use strict";

// One main-only composition for both startup and manual. No writer, schema mutation,
// Runtime State write or additional transport is owned by the shadow pipeline.
const Shadow = require("./automaticFormalShadow.js");
const Reader = require("./formalShadowElectronRead.js");
const Acquisition = require("./calendarAcquisitionService.js");
const Manual = require("./calendarManualCheckService.js");
const Labor = require("./laborProductionCheck.js");
const Cpi = require("./cpiProductionCheck.js");
const Bls = require("./blsProductionCheck.js");
const LaborStore = require("./laborRuntimeStateElectron.js");
const CpiStore = require("./cpiRuntimeStateElectron.js");
const BlsStore = require("./blsRuntimeStateElectron.js");
const Routes = require("./calendarRouteAuthority.js");
const Network = require("./calendarNetworkPolicy.js");
const safeReason = value => typeof value === "string" && /^[a-z0-9_:-]{1,120}$/.test(value) ? value : null;
function coverageDiagnostic(coverage) {
  if (!coverage) return null;
  return { coverageState: coverage.coverageState || null, absenceAuthority: "none",
    operationalRequiredFrom: coverage.operationalRequiredFrom || null,
    operationalRequiredThrough: coverage.operationalRequiredThrough || null,
    roleCoverage: (coverage.roleCoverage || []).map(c => ({ role: c.role, state: c.state,
      reason: safeReason(c.reason), earliestReleaseDate: c.earliestReleaseDate || null,
      latestReleaseDate: c.latestReleaseDate || null, windowEventCount: c.windowEvents?.length ?? null })),
    laneAssessments: (coverage.laneAssessments || []).map(c => ({ lane: c.lane, coverageState: c.coverageState })) };
}
function acquisitionDiagnostic(result) {
  return { sourceId: result.sourceId, acquisition: result.acquisitionOutcome,
    candidateCount: result.candidateEnvelope?.canonicalRecords?.length || 0,
    diagnostics: (result.diagnostics || []).map(safeReason).filter(Boolean),
    failedRoles: (result.failedRoles || []).map(safeReason).filter(Boolean),
    documentHealth: (result.documentHealth || []).map(d => ({ role: d.role,
      httpStatus: d.httpStatus ?? null, mime: d.mime ?? null, byteCount: d.byteCount ?? null,
      redirectCount: d.redirectCount ?? 0, fetchOutcome: d.fetchOutcome, parseOutcome: d.parseOutcome,
      candidateCount: d.candidateCount ?? null, encodingEvidence: d.encodingEvidence || null,
      diagnostics: (d.diagnostics || []).map(safeReason).filter(Boolean) })),
    coverage: coverageDiagnostic(result.coverage), absenceAuthority: "none" };
}

function createRuntime({ webContents, fetchImpl, readFormal, stores, acquire,
  now, builder, simulator, adapterFactory } = {}) {
  if (typeof fetchImpl !== "function") throw TypeError("runtime_transport_required");
  let lastRead = null, sources = new Map(), captureMs = 0, lastReadEnd = null, metrics = null;
  const read = readFormal || Reader.createReader(webContents);
  const pipeline = Shadow.createPipeline({ readFormal: async () => {
    const start = performance.now();
    let result;
    try { result = await read(); return result; }
    finally { lastReadEnd = performance.now();
      lastRead = { latencyMs: lastReadEnd - start, status: result?.status || "threw",
        reason: safeReason(result?.reason) || (result ? null : "formal_read_threw"), audit: result?.audit || null }; }
  } });
  const onAcquisition = result => {
    const start = performance.now();
    try { sources.set(result.sourceId, acquisitionDiagnostic(result)); pipeline.capture(result); }
    finally { captureMs += performance.now() - start; }
  };
  const legacy = Manual.createCalendarManualCheckService({
    acquire: acquire || Acquisition.createCalendarAcquisitionService({ fetchImpl }).acquire,
    onAcquisition: result => {
      // Identity binding belongs to the trusted main-side composition, not B1 or the IPC result.
      const selected = Routes.selectRoute({ sourceId: result.sourceId, operation: Network.OPERATION }, Routes.PRODUCTION_AUTHORITY);
      onAcquisition({ ...result, routeIdentity: selected.routeKind === "legacy" ? selected.routeIdentity : null });
    }, now, builder, simulator });
  const common = { fetchImpl, now, adapterFactory, onAcquisition };
  const labor = Labor.createLaborProductionCheck({ ...common, legacyService: legacy,
    store: stores?.labor || LaborStore.createLaborRuntimeStateElectron({ webContents }) });
  const cpi = Cpi.createCpiProductionCheck({ ...common, legacyService: labor,
    store: stores?.cpi || CpiStore.createCpiRuntimeStateElectron({ webContents }) });
  const bls = Bls.createBlsProductionCheck({ ...common, legacyService: cpi,
    store: stores?.bls || BlsStore.createBlsRuntimeStateElectron({ webContents }) });
  let active = null, cycleCompleted = false;
  function check(request = {}) {
    if (active) return active;
    lastRead = null; lastReadEnd = null; sources = new Map(); captureMs = 0; metrics = null; cycleCompleted = false;
    active = pipeline.check(request, () => bls.check(request)).then(result => {
      cycleCompleted = true; return result;
    }).finally(() => {
      const planningMs = lastReadEnd === null ? 0 : performance.now() - lastReadEnd;
      metrics = { readonlyMs: lastRead?.latencyMs || 0, planningMs, captureMs,
        totalShadowMs: (lastRead?.latencyMs || 0) + planningMs + captureMs,
        readonlyAttempted: lastRead !== null, planningAttempted: lastRead?.status === "ok",
        basis: "monotonic_elapsed_reached_phases", complete: true };
      active = null;
    });
    return active;
  }
  return Object.freeze({ check, diagnostics: () => ({ shadow: cycleCompleted ? pipeline.diagnostics() :
    { status: "unsafe", reason: active ? "cycle_pending" : "acquisition_cycle_failed", sourceRows: [],
      writerExecution: 0, writeAllowed: false },
    formalRead: structuredClone(lastRead), sourceDiagnostics: structuredClone([...sources.values()]),
    metrics: structuredClone(metrics), activeCycles: active ? 1 : 0 }) });
}
module.exports = Object.freeze({ createRuntime, acquisitionDiagnostic });
