"use strict";

// Main-owned, database-absent-only Calendar bootstrap. The normal acquisition
// runtime remains writer-free; this composition accepts only its complete,
// fixed 13-source canonical cycle and creates the fixed Formal database once.
const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Routes = require("./calendarRouteAuthority.js");
const Network = require("./calendarNetworkPolicy.js");
const MofRoute = require("../marketCalendarIsolated/mofJgbVariableAdapter.js");
const Comparison = require("./formalExactComparison.js").createNormal13Comparison();
const Transition = require("../marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../marketCalendarHistory/storageRecordMapper.js");
const Integrity = require("../marketCalendarHistory/historyIntegrity.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../marketCalendarHistory/bootstrapSchemaV1.js");
const FormalReader = require("./formalShadowElectronRead.js");
const HiddenWindow = require("./mofHiddenRendererWindow.js");

const SOURCE_IDS = Object.freeze([...Registry.getSourceSet(2).sourceIds]);
const FIELDS = Object.freeze(BootstrapSchema.STORE_ORDER.map(([field]) => field));
const clone = value => structuredClone(value);
const emptySnapshot = () => Object.fromEntries(FIELDS.map(field => [field, []]));
const counts = snapshot => Object.fromEntries(FIELDS.map(field => [field, snapshot[field].length]));
const keyFor = Object.fromEntries(BootstrapSchema.STORE_ORDER.map(([field, name]) =>
  [field, Schema.STORES[name].keyPath]));
function sortSnapshot(snapshot) {
  for (const field of FIELDS) snapshot[field].sort((left, right) =>
    String(left[keyFor[field]]).localeCompare(String(right[keyFor[field]])));
  return snapshot;
}
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function expectedRouteIdentity(sourceId) {
  if (sourceId === MofRoute.SOURCE_ID) return MofRoute.routeIdentity;
  const selected = Routes.selectRoute({ sourceId, operation: Network.OPERATION },
    Routes.PRODUCTION_AUTHORITY);
  return selected.valid && selected.acquisitionAllowed ? selected.routeIdentity : null;
}
function applyInitialPlan(snapshot, mapped) {
  if (mapped.closeRevisions.length || mapped.updateEntries.length)
    throw new Error("bootstrap_non_initial_transition");
  snapshot.entries.push(...clone(mapped.appendEntries));
  snapshot.revisions.push(...clone(mapped.appendRevisions));
  snapshot.evidence.push(...clone(mapped.appendEvidence));
  snapshot.observations.push(...clone(mapped.appendObservations));
  snapshot.runs.push(...clone(mapped.appendRuns));
  snapshot.cursors.push(...clone(mapped.updateCursors));
}
async function prepare({ sourceResults, checkedAt } = {}) {
  if (!Array.isArray(sourceResults) || !Number.isFinite(Date.parse(checkedAt || "")) ||
      sourceResults.length !== SOURCE_IDS.length ||
      new Set(sourceResults.map(value => value?.sourceId)).size !== SOURCE_IDS.length ||
      sourceResults.some(value => !SOURCE_IDS.includes(value?.sourceId)))
    return freeze({ status: "rejected", reason: "bootstrap_source_set_incomplete" });
  const ordered = SOURCE_IDS.map(sourceId => sourceResults.find(value => value.sourceId === sourceId));
  for (const source of ordered) {
    if (source.acquisitionOutcome !== "complete" || source.candidateStatus !== "available" ||
        !Array.isArray(source.failedRoles) || source.failedRoles.length ||
        !source.canonicalRecords?.length || source.routeIdentity !== expectedRouteIdentity(source.sourceId) ||
        !/^[a-f0-9]{64}$/.test(source.candidateIdentity || ""))
      return freeze({ status: "rejected", reason: "bootstrap_source_not_eligible",
        sourceId: source.sourceId });
    const fetchedAt = source.canonicalRecords.map(value => value?.acquisitionEvidence?.fetchedAt);
    if (fetchedAt.some(value => !Number.isFinite(Date.parse(value)) || Date.parse(value) > Date.parse(checkedAt)))
      return freeze({ status: "rejected", reason: "bootstrap_acquisition_time_invalid",
        sourceId: source.sourceId });
  }
  const empty = emptySnapshot(), comparison = await Comparison.compare({ sourceResults: ordered,
    formalSnapshot: empty });
  if (comparison.status !== "compared" || comparison.ambiguityCount !== 0 ||
      comparison.summaries.some(value => value.changed || value.ambiguity ||
        value.new !== value.candidate || value.candidate < 1))
    return freeze({ status: "rejected", reason: comparison.reason || "bootstrap_candidate_invalid" });
  const snapshot = emptySnapshot();
  for (const source of ordered) {
    const revisionKeys = source.canonicalRecords.map(value => value.revisionKey).sort(),
      semanticSetHash = await Canonicalizer.sha256(revisionKeys), runIdentity =
      await Canonicalizer.sha256({ sourceId: source.sourceId,
        candidateIdentity: source.candidateIdentity, acceptedAt: checkedAt });
    const planned = Transition.planTransition({ snapshot, run: { sourceId: source.sourceId,
      runId: `normal-bootstrap-${runIdentity}`, acceptedAt: checkedAt,
      fetchedAt: [...new Set(source.canonicalRecords.map(value =>
        value.acquisitionEvidence.fetchedAt))].sort(), status: "accepted", semanticSetHash },
    canonicalSet: source.canonicalRecords, coverage: null, parserChanged: false });
    if (!planned.ok || planned.outcome !== "planned" || !planned.plan)
      return freeze({ status: "rejected", reason: planned.errors?.[0] ||
        "bootstrap_plan_invalid", sourceId: source.sourceId });
    applyInitialPlan(snapshot, Mapper.mapPlan(planned.plan));
  }
  sortSnapshot(snapshot);
  const semantic = await Integrity.audit(snapshot), storage = Integrity.auditStorageSnapshot(snapshot);
  if (!semantic.valid || !storage.valid) return freeze({ status: "rejected",
    reason: "bootstrap_integrity_invalid" });
  const snapshotIdentity = await Canonicalizer.sha256(snapshot);
  return freeze({ status: "prepared", reason: null, material: { schemaVersion: Schema.VERSION,
    sourceIds: [...SOURCE_IDS], checkedAt, snapshotIdentity, counts: counts(snapshot), snapshot } });
}

async function executeBootstrapInRenderer(material, schemaDefinition, storeOrder) {
  const stable = value => { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); };
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(stable(value))))].map(value => value.toString(16).padStart(2, "0")).join("");
  const fields = storeOrder.map(value => value[0]), names = storeOrder.map(value => value[1]);
  if (globalThis.__calendarFormalBootstrapAttempt) throw Error("calendar_bootstrap_replayed");
  globalThis.__calendarFormalBootstrapAttempt = true;
  if (!material || material.schemaVersion !== schemaDefinition.version ||
      !Array.isArray(material.sourceIds) || material.sourceIds.length !== 13 ||
      new Set(material.sourceIds).size !== 13 || !material.snapshot ||
      fields.some(field => !Array.isArray(material.snapshot[field]) ||
        material.counts[field] !== material.snapshot[field].length) ||
      await hash(material.snapshot) !== material.snapshotIdentity)
    throw Error("calendar_bootstrap_material_invalid");
  const catalog = await indexedDB.databases();
  if (catalog.some(value => value.name === schemaDefinition.databaseName))
    return { status: "skipped", reason: "database_exists", created: 0,
      transactions: 0, snapshot: null, snapshotIdentity: null, counts: null };
  let created = false, database;
  try {
    database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open(schemaDefinition.databaseName, schemaDefinition.version);
      opening.onupgradeneeded = () => {
        created = true;
        try {
          for (const [name, specification] of Object.entries(schemaDefinition.stores)) {
            const store = opening.result.createObjectStore(name, { keyPath: specification.keyPath });
            for (const [indexName, keyPath, unique] of specification.indexes)
              store.createIndex(indexName, keyPath, { unique });
          }
          for (const [field, name] of storeOrder)
            for (const record of material.snapshot[field]) opening.transaction.objectStore(name).add(record);
        } catch (error) { try { opening.transaction.abort(); } catch (_) {} reject(error); }
      };
      opening.onsuccess = () => created ? resolve(opening.result) :
        (opening.result.close(), reject(Error("calendar_bootstrap_race_existing")));
      opening.onerror = () => reject(opening.error || Error("calendar_bootstrap_open_failed"));
      opening.onblocked = () => reject(Error("calendar_bootstrap_open_blocked"));
    });
    database.close(); database = null;
    database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open(schemaDefinition.databaseName);
      opening.onupgradeneeded = () => { try { opening.transaction.abort(); } catch (_) {}
        reject(Error("calendar_bootstrap_readback_upgrade")); };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error || Error("calendar_bootstrap_readback_open_failed"));
      opening.onblocked = () => reject(Error("calendar_bootstrap_readback_blocked"));
    });
    if (database.version !== schemaDefinition.version ||
        JSON.stringify([...database.objectStoreNames].sort()) !== JSON.stringify(names.slice().sort()))
      throw Error("calendar_bootstrap_schema_mismatch");
    const snapshot = {}, tx = database.transaction(names, "readonly");
    for (const [name, specification] of Object.entries(schemaDefinition.stores)) {
      const store = tx.objectStore(name), actualIndexes = [...store.indexNames].sort();
      if (JSON.stringify(store.keyPath) !== JSON.stringify(specification.keyPath) ||
          JSON.stringify(actualIndexes) !== JSON.stringify(specification.indexes.map(value => value[0]).sort()))
        throw Error("calendar_bootstrap_schema_mismatch");
      for (const [indexName, keyPath, unique] of specification.indexes) {
        const index = store.index(indexName);
        if (JSON.stringify(index.keyPath) !== JSON.stringify(keyPath) || index.unique !== unique)
          throw Error("calendar_bootstrap_schema_mismatch");
      }
    }
    await new Promise((resolve, reject) => {
      for (const [field, name] of storeOrder) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { snapshot[field] = request.result; };
        request.onerror = () => reject(request.error || Error("calendar_bootstrap_readback_failed"));
      }
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error("calendar_bootstrap_readback_failed"));
      tx.onerror = () => undefined;
    });
    const keyFor = Object.fromEntries(storeOrder.map(([field, name]) =>
      [field, schemaDefinition.stores[name].keyPath]));
    for (const field of fields) snapshot[field].sort((left, right) =>
      String(left[keyFor[field]]).localeCompare(String(right[keyFor[field]])));
    const snapshotIdentity = await hash(snapshot);
    if (snapshotIdentity !== material.snapshotIdentity) throw Error("calendar_bootstrap_readback_mismatch");
    return { status: "committed", reason: null, created: 1, transactions: 1,
      snapshot, snapshotIdentity, counts: Object.fromEntries(fields.map(field =>
        [field, snapshot[field].length])) };
  } finally { database?.close(); }
}

function create({ readFormal, execute, notify = async () => undefined } = {}) {
  if (typeof readFormal !== "function" || typeof execute !== "function" || typeof notify !== "function")
    throw new TypeError("calendar_bootstrap_runtime_invalid");
  let active = null, attempted = false, last = null;
  async function bootstrap(input) {
    if (active) return active;
    active = (async () => {
      const before = await readFormal();
      if (before.status === "ok") return last = freeze({ status: "skipped",
        reason: "database_exists", writerExecution: 0 });
      if (before.reason !== "formal_database_absent") return last = freeze({ status: "rejected",
        reason: before.reason || "formal_read_failed", writerExecution: 0 });
      if (attempted) return last = freeze({ status: "rejected", reason: "bootstrap_attempt_spent",
        writerExecution: 0 });
      const prepared = await prepare(input);
      if (prepared.status !== "prepared") return last = freeze({ ...prepared, writerExecution: 0 });
      attempted = true;
      const result = await execute(prepared.material);
      if (result.status !== "committed" || result.created !== 1 || result.transactions !== 1 ||
          result.snapshotIdentity !== prepared.material.snapshotIdentity ||
          JSON.stringify(result.counts) !== JSON.stringify(prepared.material.counts))
        return last = freeze({ status: "rejected", reason: result.reason ||
          "bootstrap_receipt_invalid", writerExecution: result.transactions || 0 });
      const semantic = await Integrity.audit(result.snapshot), storage =
        Integrity.auditStorageSnapshot(result.snapshot);
      if (!semantic.valid || !storage.valid) return last = freeze({ status: "rejected",
        reason: "bootstrap_readback_integrity_invalid", writerExecution: 1 });
      await notify();
      return last = freeze({ status: "committed", reason: null, writerExecution: 1,
        snapshotIdentity: result.snapshotIdentity, counts: result.counts });
    })().catch(error => last = freeze({ status: "rejected",
      reason: /^[a-z0-9_]+$/.test(error?.message || "") ? error.message : "bootstrap_failed",
      writerExecution: 0 })).finally(() => { active = null; });
    return active;
  }
  return Object.freeze({ bootstrap, diagnostics: () => clone(last), close: () => { attempted = true; } });
}

function createProductionRuntime(webContents) {
  if (process.type !== "browser" || !process.versions.electron || !webContents)
    throw new Error("native_main_required");
  const readFormal = FormalReader.createReader(webContents);
  return create({ readFormal, execute: async material => {
    const window = await HiddenWindow.createProductionWindow();
    try {
      const code = `(${executeBootstrapInRenderer.toString()})(${JSON.stringify(material)},${JSON.stringify(
        Schema.definition())},${JSON.stringify(BootstrapSchema.STORE_ORDER)})`;
      return await window.run(code);
    } finally { await window.close(); }
  }, notify: () => webContents.executeJavaScript(
    "document.dispatchEvent(new CustomEvent('optionmap:calendar-formal-updated'))") });
}

function wrapNormalRuntime(normal, bootstrapRuntime) {
  if (!normal?.check || !normal?.diagnostics || !bootstrapRuntime?.bootstrap)
    throw new TypeError("calendar_bootstrap_composition_invalid");
  let active = null;
  function check(request = {}) {
    if (active) return active;
    active = Promise.resolve(normal.check(request)).then(async result => {
      const diagnostic = normal.diagnostics().comparison, sources = diagnostic?.sourceResults;
      let formalPersistence = { status: "not_attempted", reason: "source_cycle_incomplete" };
      if (result?.state === "success" && Array.isArray(sources) && sources.length === SOURCE_IDS.length)
        formalPersistence = await bootstrapRuntime.bootstrap({ sourceResults: sources,
          checkedAt: result.checkedAt });
      return { ...result, formalPersistence: { status: formalPersistence.status,
        reason: formalPersistence.reason || null } };
    }).finally(() => { active = null; });
    return active;
  }
  return Object.freeze({ check, restore: normal.restore,
    diagnostics: () => ({ ...normal.diagnostics(), formalBootstrap: bootstrapRuntime.diagnostics() }) });
}

module.exports = Object.freeze({ SOURCE_IDS, prepare, executeBootstrapInRenderer, create,
  createProductionRuntime, wrapNormalRuntime });
