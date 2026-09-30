"use strict";

// Explicit E3b harness only. No startup/IPC/renderer public capability is added.
const fs = require("node:fs");
const Boundaries = require("./firstProductionWriteBoundary.js");
const Schema = require("./productionSchemaV1.js");
const Bootstrap = require("./bootstrapSchemaV1.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");

// Executed in the existing sandboxed read-only probe window. The transaction
// algorithm is the actual shared core, not a second production writer.
async function executeInProbe(context, Core, Schema, inspect, fingerprint, approvedSource, approvedMode, approvedCount) {
  const { binding, before, plan, expectedAfter, expiresAt } = context;
  const stores = Core.STORE_ORDER, names = Core.STORE_NAMES;
  const audit = { opens: 0, readonly: 0, readwrite: 0, create: 0, upgrade: 0,
    committed: 0, aborted: 0, attemptedWrites: Core.emptyCounts(),
    committedWrites: Core.emptyCounts(), delete: 0, openHandles: 0, readbackReopens: 0 };
  const metrics = { readwriteTransactions: 0, committedTransactions: 0,
    abortedTransactions: 0, committedWrites: Core.emptyCounts() };
  const observation = { status: "failed", reason: null, committed: false, audit, metrics,
    writerResult: null, readback: null, phase: "authorization" };
  globalThis.__e3bExecution = observation;
  let db;
  try {
    const seen = globalThis.__e3bConsumedInvocations || new Set();
    globalThis.__e3bConsumedInvocations = seen;
    if (seen.has(binding.invocationId)) throw Error("authorization_invalid_or_reused");
    seen.add(binding.invocationId);
    if (Date.now() > expiresAt) throw Error("authorization_expired");
    if (binding.databaseName !== "optionMapMarketCalendarHistory" ||
        binding.sourceId !== approvedSource ||
        binding.authorityMode !== approvedMode || binding.plannedReadwriteTransactions !== 1 ||
        binding.identities.schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
        binding.identities.plan !== plan.planIdentity || plan.writeAllowed !== false)
      throw Error("fixed_authorization_required");
    const updates = Core.expectedWrites(plan, before);
    const expectedOperations = [
      ...updates.entries.map(value => ["entries", "put", value]),
      ...plan.mutations.appendEvidence.map(value => ["evidence", "add", value]),
      ...plan.mutations.appendObservations.map(value => ["observations", "add", value]),
      ...plan.mutations.appendRuns.map(value => ["runs", "add", value]),
      ...plan.mutations.updateCursors.map(value => ["cursors", "put", value])
    ];
    const exactCounts = { entries: approvedCount, revisions: 0, evidence: approvedCount,
      observations: approvedCount, runs: 1, cursors: 1 };
    if (expectedOperations.length !== 3 * approvedCount + 2 || !Core.same(
      Object.fromEntries(stores.map(([field]) => [field, expectedOperations.filter(op => op[0] === field).length])),
      exactCounts))
      throw Error("exact_mutation_set_required");
    const catalog = await indexedDB.databases();
    const item = catalog.find(value => value.name === binding.databaseName);
    if (!item || item.version !== 1) throw Error("existing_schema_v1_required");
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(binding.databaseName); audit.opens++;
      request.onupgradeneeded = event => { audit.upgrade++; if (event.oldVersion === 0) audit.create++;
        request.transaction.abort();
        reject(Error("upgrade_forbidden")); };
      request.onblocked = () => reject(Error("open_blocked"));
      request.onerror = () => reject(request.error || Error("open_failed"));
      request.onsuccess = () => { audit.openHandles++; resolve(request.result); };
    });
    const finish = tx => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || Error("readonly_aborted"));
      tx.onerror = () => undefined;
    });
    const read = async connection => {
      const schemaTx = connection.transaction(names, "readonly"); audit.readonly++;
      const schema = inspect(connection, schemaTx), done = finish(schemaTx);
      await done;
      if (await fingerprint(schema) !== Schema.EXPECTED_FINGERPRINT)
        throw Error("schema_fingerprint_mismatch");
      const tx = connection.transaction(names, "readonly"); audit.readonly++;
      const completed = finish(tx), snapshot = {};
      for (const [field, name] of stores) {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => { snapshot[field] = request.result; };
      }
      await completed;
      return Core.sorted(snapshot);
    };
    observation.phase = "immediate_precondition";
    db = await open();
    const current = await read(db);
    if (!Core.same(current, Core.sorted(before))) throw Error("stale_precondition_before_transaction");
    if (Date.now() > expiresAt) throw Error("authorization_expired");
    // All hashing/normalization finishes before opening the readwrite transaction.
    const prepared = Core.prepareExecution(plan, before, binding.exactMutationCeiling);
    globalThis.__e3bStorageAuthorized = binding.invocationId;
    const guarded = { transaction(requestedStores, mode) {
      if (mode !== "readwrite" || !Core.same(requestedStores, names) || audit.readwrite !== 0)
        throw Error("exactly_one_fixed_transaction_required");
      const tx = db.transaction(names, mode); audit.readwrite++;
      let operationIndex = 0, readCallbacks = 0;
      tx.addEventListener("complete", () => { audit.committed++;
        audit.committedWrites = structuredClone(audit.attemptedWrites); });
      tx.addEventListener("abort", () => { audit.aborted++; });
      return new Proxy(tx, { get(target, key) {
        if (key === "objectStore") return name => {
          const pair = stores.find(([, storeName]) => storeName === name);
          if (!pair) throw Error("unexpected_store_operation");
          const store = target.objectStore(name);
          return new Proxy(store, { get(objectStore, operation) {
            if (operation === "add" || operation === "put") return value => {
              const expected = expectedOperations[operationIndex];
              if (!expected || expected[0] !== pair[0] || expected[1] !== operation ||
                  value.sourceId !== binding.sourceId || !Core.same(expected[2], value))
                throw Error("exact_mutation_set_violation");
              const request = objectStore[operation](value);
              operationIndex++; audit.attemptedWrites[pair[0]]++;
              return request;
            };
            if (operation === "delete" || operation === "clear" || operation === "openCursor")
              return () => { throw Error("delete_or_cursor_operation_forbidden"); };
            if (operation === "getAll") return (...args) => {
              const request = objectStore.getAll(...args);
              return new Proxy(request, { get(requestTarget, property) {
                return Reflect.get(requestTarget, property, requestTarget);
              }, set(requestTarget, property, callback) {
                if (property !== "onsuccess") return Reflect.set(requestTarget, property, callback, requestTarget);
                requestTarget.onsuccess = event => {
                  readCallbacks++;
                  callback(event);
                  // Still in the last IDB success callback: forbid a smaller-than-exact
                  // set as well as extras, before auto-commit can happen.
                  if (readCallbacks === stores.length && operationIndex !== expectedOperations.length) {
                    try { tx.abort(); } catch (_) {} // stale path may have aborted already.
                  }
                };
                return true;
              } });
            };
            const value = Reflect.get(objectStore, operation, objectStore);
            return typeof value === "function" ? value.bind(objectStore) : value;
          } });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
    } };
    observation.phase = "controlled_transaction";
    observation.writerResult = await Core.executePrepared(guarded, prepared, null, metrics);
    observation.committed = observation.writerResult.committed === true;
    if (!observation.committed) throw Error(observation.writerResult.reason || "write_not_committed");
    if (audit.readwrite !== 1 || audit.committed !== 1 || audit.aborted !== 0 ||
        !Core.same(audit.committedWrites, exactCounts)) throw Error("actual_mutation_count_mismatch");
    db.close(); audit.openHandles--; db = null;
    observation.phase = "fresh_readback";
    db = await open(); audit.readbackReopens++;
    observation.readback = await read(db);
    if (!Core.same(observation.readback, Core.sorted(expectedAfter))) throw Error("exact_readback_mismatch");
    observation.status = "verified";
    observation.phase = "complete";
  } catch (error) {
    observation.reason = error?.message || "execution_failed";
    observation.errorClass = error?.name || "Error";
  } finally {
    if (db) { db.close(); audit.openHandles--; }
  }
  return observation;
}

// Only these five code-fixed closures exist. No arbitrary boundary/source API.
function fixedExecutor(Boundary, approvedMode) {
function prepareProbeProgram(authorization, binding) {
  const context = Boundary.consumeFirstProductionAuthorization(authorization, binding);
  const coreSource = fs.readFileSync(require.resolve("./formalControlledWriterCore.js"), "utf8");
  const program = `(async () => {
    const Schema = ${JSON.stringify({ STORES: Schema.STORES, EXPECTED_FINGERPRINT: Schema.EXPECTED_FINGERPRINT })};
    const stable = (${Canonical.stable.toString()});
    const dependencies = { "./productionSchemaV1.js": Schema,
      "./bootstrapSchemaV1.js": { STORE_ORDER: ${JSON.stringify(Bootstrap.STORE_ORDER)} },
      "../marketCalendar/marketEventCanonicalizer.js": { stable } };
    const module = { exports: {} };
    ((module, require) => { ${coreSource}\n })(module, name => {
      if (!Object.hasOwn(dependencies, name)) throw Error("unexpected_core_dependency");
      return dependencies[name];
    });
    return (${executeInProbe.toString()})(${JSON.stringify(context)}, module.exports, Schema,
      (${Bootstrap.inspect.toString()}), (${Schema.fingerprint.toString()}),
      ${JSON.stringify(Boundary.SOURCE_ID)}, ${JSON.stringify(approvedMode)},
      ${JSON.stringify(Boundary.EXPECTED_COUNTS.eventEntryUpdate)});
  })()`;
  return { program, ticket: context.ticket };
}
async function executeFirstProductionWrite(probe, authorization, binding) {
  const prepared = prepareProbeProgram(authorization, binding);
  let observation;
  try { observation = await probe.executeJavaScript(prepared.program, true); }
  catch (error) {
    // Preserve reached commit/audit information even if controller delivery fails.
    let reached = null;
    try { reached = await probe.executeJavaScript("globalThis.__e3bExecution || null", true); } catch (_) {}
    observation = { ...reached, status: "failed", reason: "execution_delivery_failed",
      errorClass: error?.name || "Error", auditComplete: !!reached };
  }
  const verification = observation.readback
    ? await Boundary.verifyReadback(prepared.ticket, observation.readback) : { valid: false };
  const { readback: _snapshot, ...safe } = observation;
  if (!verification.valid || observation.status !== "verified")
    return { ...safe, status: "failed", verification };
  return { ...safe, verification, writerAuthorityState: "disabled" };
}
return Object.freeze({ prepareProbeProgram, executeFirstProductionWrite });
}
const first = fixedExecutor(Boundaries, "E3b_explicit_one_shot");
const sna = fixedExecutor(Boundaries.sna, "E4a_sna_explicit_one_shot");
const bea = fixedExecutor(Boundaries.bea, "E4b1_bea_explicit_one_shot");
const census = fixedExecutor(Boundaries.census, "E4b2_census_explicit_one_shot");
const fomc = fixedExecutor(Boundaries.fomc, "E4b3_fomc_explicit_one_shot");
module.exports = Object.freeze({ ...first, sna, bea, census, fomc });
