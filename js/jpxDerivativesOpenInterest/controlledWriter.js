(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const schema = common ? require("./historySchemaV1.js") : root?.OptionMapJpxDerivativesOpenInterestHistorySchemaV1;
    const history = common ? require("./historyContract.js") : root?.OptionMapJpxDerivativesOpenInterestHistoryContract;
    const identity = common ? require("./identity.js") : root?.OptionMapJpxDerivativesOpenInterestIdentity;
    const api = factory(schema, history, identity); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestControlledWriter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (schema, history, identity) {
    "use strict";
    const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error || new Error("indexeddb_request_failed")); });
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("transaction_aborted")); tx.onerror = () => undefined; });
    const names = Object.values(history.stores);
    async function snapshot(tx) { const result = {}; await Promise.all(Object.entries(history.stores)
        .map(async ([field, name]) => { result[field] = await request(tx.objectStore(name).getAll()); })); return result; }
    function create(configuration = {}) {
        const indexedDB = configuration.indexedDB, databaseName = configuration.databaseName || schema.DATABASE_NAME,
            enabled = configuration.enabled === true, authorizationToken = configuration.authorizationToken,
            allowCreate = configuration.allowCreate === true;
        async function open() { const catalog = await indexedDB.databases(), exists = catalog.some(item => item.name === databaseName);
            if (!exists && !allowCreate) throw new Error("database_absent");
            return new Promise((resolve, reject) => { const value = indexedDB.open(databaseName, schema.VERSION);
                value.onupgradeneeded = () => { if (exists || !allowCreate) { try { value.transaction.abort(); } catch (_error) {} return; }
                    schema.createInUpgrade(value.result); };
                value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error || new Error("open_failed")); }); }
        async function write({ authorization, plan, expectedPreconditionIdentity, injectBeforeTransaction,
            injectFailureAfter = null } = {}) {
            if (!enabled || !authorizationToken || authorization !== authorizationToken) return { saved: false, outcome: "write_disabled" };
            if (await identity.storageMutationIdentity({ ...plan, storageMutationIdentity: undefined }) !== plan.storageMutationIdentity)
                return { saved: false, outcome: "plan_identity_mismatch" };
            let db; try { db = await open(); if (!schema.matches(db)) throw new Error("schema_mismatch");
                const beforeTx = db.transaction(names, "readonly"), beforeDone = done(beforeTx), before = await snapshot(beforeTx); await beforeDone;
                const beforeMaterial = identity.preconditionMaterial(before);
                if (await identity.preconditionIdentity(before) !== expectedPreconditionIdentity) throw new Error("stale_precondition");
                if (injectBeforeTransaction) await injectBeforeTransaction(db);
                const tx = db.transaction(names, "readwrite"), completed = done(tx);
                try { const inside = await snapshot(tx);
                    // Only IndexedDB request chains may yield inside this transaction. WebCrypto can
                    // outlive its request queue and let it auto-commit before the first write.
                    if (identity.preconditionMaterial(inside) !== beforeMaterial) throw new Error("stale_precondition_inside_transaction");
                    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
                    if (plan.appendDay) stores[history.stores.days].add(plan.appendDay);
                    if (plan.updateDay) { const current = await request(stores[history.stores.days].get(plan.updateDay.logicalKey));
                        if (!current || current.activeRevisionKey !== plan.updateDay.expectedActiveRevisionKey) throw new Error("day_precondition_failed");
                        stores[history.stores.days].put({ ...current, activeRevisionKey: plan.updateDay.activeRevisionKey,
                            lastObservedAt: plan.updateDay.lastObservedAt }); }
                    if (plan.closeRevision) { const current = await request(stores[history.stores.revisions].get(plan.closeRevision.revisionKey));
                        if (!current || current.closedAt !== plan.closeRevision.expectedClosedAt) throw new Error("revision_precondition_failed");
                        stores[history.stores.revisions].put({ ...current, closedAt: plan.closeRevision.closedAt }); }
                    if (plan.appendRevision) stores[history.stores.revisions].add(plan.appendRevision);
                    if (injectFailureAfter === "revision") throw new Error("injected_failure_after_revision");
                    stores[history.stores.evidence].add(plan.appendEvidence); stores[history.stores.observations].add(plan.appendObservation);
                    stores[history.stores.runs].add(plan.appendRun); stores[history.stores.cursors].put(plan.updateCursor);
                    if (injectFailureAfter === "evidence") throw new Error("injected_failure_after_evidence");
                } catch (error) { try { tx.abort(); } catch (_error) {} try { await completed; } catch (_error) {} throw error; }
                await completed; return { saved: true, outcome: "committed" };
            } catch (error) { return { saved: false, outcome: "rolled_back", error: error.message }; }
            finally { db?.close(); } }
        return Object.freeze({ write, diagnostics: Object.freeze({ enabled, allowCreate, sixStoreAtomic: true }) });
    }
    return Object.freeze({ create });
});
