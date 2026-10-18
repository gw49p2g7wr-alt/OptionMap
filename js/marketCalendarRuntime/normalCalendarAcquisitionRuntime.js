"use strict";

// Explicit main-owned normal13 factory, reused by normal production composition.
// Acquires operational state only; no authorization/safety/writer dependency.
const Contracts = require("./normalAcquisitionContract.js");
const Manual = require("./calendarManualCheckService.js");
const Acquisition = require("./calendarAcquisitionService.js");
const Mof = require("./mofNormalAcquisition.js");
const Boj = require("./bojCoverageAcquisition.js");
const Labor = require("./laborProductionCheck.js");
const Cpi = require("./cpiProductionCheck.js");
const Bls = require("./blsProductionCheck.js");
const State = require("./calendarRuntimeStateIntegration.js");
const Projection = require("./automaticFormalShadow.js");
const Compare = require("./formalExactComparison.js").createNormal13Comparison();
const Cycle = require("./formalShadowCycle.js");
const Routes = require("./calendarRouteAuthority.js");
const Network = require("./calendarNetworkPolicy.js");
const Reader = require("./formalShadowElectronRead.js");
const LaborStore = require("./laborRuntimeStateElectron.js");
const CpiStore = require("./cpiRuntimeStateElectron.js");
const BlsStore = require("./blsRuntimeStateElectron.js");
function create({ fetchImpl, store, stores, readFormal, targetEnvironment, now,
  acquire, builder, simulator, adapterFactory, webContents, runtimeStateOwner = "main" } = {}) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (typeof fetchImpl !== "function" || !["main", "renderer"].includes(runtimeStateOwner)) throw TypeError("normal_runtime_configuration_invalid");
  const read = readFormal || Reader.createReader(webContents);
  if (typeof read !== "function") throw TypeError("normal_runtime_configuration_invalid");
  stores = stores || { labor: LaborStore.createLaborRuntimeStateElectron({ webContents }),
    cpi: CpiStore.createCpiRuntimeStateElectron({ webContents }), bls: BlsStore.createBlsRuntimeStateElectron({ webContents }) };
  const acquisitionContract = Contracts.NORMAL13, ids = Contracts.resolve(acquisitionContract);
  const mof = Mof.create({ acquisitionContract, fetchImpl, now });
  const boj = Boj.createShould({ fetchImpl, now });
  const legacyAcquire = acquire || Acquisition.createCalendarAcquisitionService({ fetchImpl }).acquire;
  let captures = new Map(), active = null, last = null, mofResult = null;
  const capture = result => captures.set(result.sourceId, Projection.projectAcquisition(result));
  const legacy = Manual.createCalendarManualCheckService({ acquisitionContract, now, simulator,
    builder: Mof.builder(Boj.builder(builder)), acquire: async request => {
      if (request.sourceId === Boj.SOURCE_ID && !acquire) return boj.acquire(request);
      if (request.sourceId !== Mof.SOURCE_ID) return legacyAcquire(request);
      mofResult = await mof.acquire(request); return mofResult;
    },
    onAcquisition: result => {
      const selection = Routes.selectRoute({ sourceId: result.sourceId, operation: Network.OPERATION }, Routes.PRODUCTION_AUTHORITY);
      capture({ ...(result.sourceId === Mof.SOURCE_ID ? { ...mofResult.normalProjection,
        acquisitionOutcome: result.acquisitionOutcome } : result), routeIdentity: result.sourceId === Mof.SOURCE_ID ? Mof.routeIdentity :
        result.sourceId === Boj.SOURCE_ID && !acquire ? Boj.shouldRouteIdentity :
        selection.routeKind === "legacy" ? selection.routeIdentity : null });
    } });
  const common = { acquisitionContract, fetchImpl, now, adapterFactory, onAcquisition: capture };
  const labor = Labor.createLaborProductionCheck({ ...common, legacyService: legacy, store: stores?.labor });
  const cpi = Cpi.createCpiProductionCheck({ ...common, legacyService: labor, store: stores?.cpi });
  const service = Bls.createBlsProductionCheck({ ...common, legacyService: cpi, store: stores?.bls });
  // Existing UI startup runtime owns legacy persistence/session counters. Never
  // wrap it a second time in main; managed Labor/CPI/BLS keep their own owners.
  const operational = runtimeStateOwner === "renderer" ? service :
    State.createRuntimeStateIntegration({ service, store, targetEnvironment, acquisitionContract });
  function check(request = {}) {
    if (active) return active;
    captures = new Map(); last = null; mofResult = null;
    active = (async () => {
      const result = await operational.check(request);
      if (!captures.size) { last = { status: "skipped", reason: "no_fresh_acquisition" }; return result; }
      let cycle;
      try {
        const sourceResults = ids.map(sourceId => captures.get(sourceId) || { sourceId,
          canonicalRecords: [], acquisitionOutcome: "not_attempted", candidateStatus: "unavailable",
          failedRoles: [], absenceAuthority: "none" });
        const before = await read();
        if (before.status !== "ok") { last = { status: "unsafe", reason: before.reason,
          sourceResults }; return result; }
        cycle = Cycle.create(before.snapshot, before.schemaFingerprint);
        const comparison = await Compare.compare({ sourceResults, formalSnapshot: before.snapshot, cycleContext: cycle });
        last = { comparison, sourceResults, formalAudit: before.audit,
          snapshotIdentity: Cycle.get(cycle, before.snapshot).snapshotIdentity,
          performance: structuredClone(Cycle.get(cycle, before.snapshot).metrics),
          writerExecution: 0, writeAllowed: false, permission: "not_approved", absenceAuthority: "none" };
      } catch (_) { last = { status: "unsafe", reason: "normal_comparison_failed" }; }
      finally { if (cycle) Cycle.close(cycle); }
      return result;
    })().finally(() => { active = null; captures = new Map(); mofResult = null; });
    return active;
  }
  return Object.freeze({ check, restore: operational.restore,
    diagnostics: () => ({ comparison: structuredClone(last), transport: mof.diagnostics(),
      activeCycles: active ? 1 : 0, writerExecution: 0, safetyWrites: 0 }) });
}
module.exports = Object.freeze({ create });
