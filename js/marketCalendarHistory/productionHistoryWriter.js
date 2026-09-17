(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("./productionSchemaV1.js") : root?.OptionMapMarketCalendarProductionSchemaV1;
    const mapper = commonJs ? require("./storageRecordMapper.js") : root?.OptionMapMarketCalendarStorageRecordMapper;
    const integrity = commonJs ? require("./historyIntegrity.js") : root?.OptionMapMarketCalendarHistoryIntegrity;
    const planCanonicalizer = commonJs ? require("./planCanonicalizer.js") :
        root?.OptionMapMarketCalendarPlanCanonicalizer;
    const authorization = commonJs ? require("./planAuthorization.js") :
        root?.OptionMapMarketCalendarPlanAuthorization;
    const api = factory(schema, mapper, integrity, planCanonicalizer, authorization);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarProductionHistoryWriter = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, mapper, integrity, planCanonicalizer,
    authorizationApi) {
    "use strict";
    const names = Object.keys(schema.STORES), request = value => new Promise((resolve, reject) => {
        value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("transaction_aborted")); tx.onerror = () => undefined; });
    const counts = async tx => Object.fromEntries(await Promise.all(names.map(async name =>
        [name, await request(tx.objectStore(name).count())])));
    const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === "object" ?
        Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
    const equal = (a, b) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
    const snapshotMap = Object.freeze({ entries: "marketCalendarEventEntries",
        revisions: "marketCalendarSemanticRevisions", evidence: "marketCalendarAcquisitionEvidence",
        observations: "marketCalendarEventObservations", runs: "marketCalendarSourceRuns",
        cursors: "marketCalendarSourceCursors" });
    async function snapshotFrom(tx) { const result = {};
        await Promise.all(Object.entries(snapshotMap).map(async ([field, name]) => { result[field] =
            await request(tx.objectStore(name).getAll()); })); return result; }
    const countsFrom = snapshot => Object.fromEntries(Object.entries(snapshotMap).map(([field, name]) =>
        [name, snapshot[field].length]));
    function keepTransactionAlive(transaction) { let active = true; const store = transaction.objectStore(names[0]);
        const pump = () => { if (!active) return; const value = store.count(); value.onsuccess = pump;
            value.onerror = () => undefined; }; pump(); return () => { active = false; }; }
    function createProductionHistoryWriter(configuration = {}) {
        const indexedDB = configuration.indexedDB, databaseName = configuration.databaseName || schema.DATABASE_NAME,
            enabled = configuration.enabled === true, authorizationToken = configuration.authorizationToken,
            beforeWriteTransaction = configuration.beforeWriteTransaction;
        async function openExisting() { const catalog = await indexedDB.databases();
            if (!catalog.some(item => item.name === databaseName)) throw new Error("database_absent");
            return new Promise((resolve, reject) => { const value = indexedDB.open(databaseName); let upgrade = false;
                value.onupgradeneeded = () => { upgrade = true; try { value.transaction.abort(); } catch (_error) {} };
                value.onsuccess = () => upgrade ? (value.result.close(), reject(new Error("upgrade_forbidden"))) :
                    resolve(value.result); value.onerror = () => reject(value.error || new Error("open_failed"));
                value.onblocked = () => reject(new Error("open_blocked")); }); }
        async function load(database) { const tx = database.transaction(names, "readonly"), completed = done(tx),
            result = await snapshotFrom(tx); await completed; return result; }
        function inspectTransaction(database, transaction) { const stores = {};
            for (const [name, expected] of Object.entries(schema.STORES)) { const store = transaction.objectStore(name),
                indexes = expected.indexes.map(([indexName]) => { const index = store.index(indexName);
                    return [index.name, Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
                        index.unique]; }); stores[name] = { keyPath: Array.isArray(store.keyPath) ?
                    [...store.keyPath] : store.keyPath, indexes }; }
            return { databaseName: database.name, version: database.version, stores }; }
        async function actualPrecondition(database, snapshot, sourceId, transaction = null) { const inspected =
            transaction ? inspectTransaction(database, transaction) : schema.inspect(database),
            schemaFingerprint = await schema.fingerprint({ ...inspected, databaseName: schema.DATABASE_NAME });
            return { productionSnapshotFingerprint: await authorizationApi.productionSnapshotFingerprint(snapshot),
                storeCounts: countsFrom(snapshot), schemaFingerprint,
                sourceCursor: snapshot.cursors.find(value => value.sourceId === sourceId) || null }; }
        async function requireV2Precondition(database, snapshot, sourceId, approved, transaction = null) {
            const actual = await actualPrecondition(database, snapshot, sourceId, transaction), actualIdentity =
            await authorizationApi.productionPreconditionIdentity(actual);
            if (actualIdentity !== approved.productionPreconditionIdentityHash ||
                !equal(authorizationApi.canonicalizeProductionPrecondition(actual),
                    authorizationApi.canonicalizeProductionPrecondition(approved.productionPrecondition)))
                throw new Error("production_precondition_failed"); return actual; }
        async function write({ authorization, plan, expectedPlanHash, expectedStoreCounts,
            expectedCursor = null, injectFailureAfter = null, approvalArtifact = null,
            expectedArtifactDigest = null, expectedAuthorizationIdentityHash = null } = {}) {
            if (!enabled || !authorizationToken || authorization !== authorizationToken)
                return { saved: false, outcome: "production_write_disabled", opened: false };
            let approvedV2 = null;
            if (approvalArtifact !== null) { const digest = await authorizationApi.artifactDigest(approvalArtifact),
                verified = await authorizationApi.verify(approvalArtifact, {
                    contractVersion: authorizationApi.CONTRACT_VERSION_V2,
                    ...(expectedAuthorizationIdentityHash ? { authorizationIdentityHash:
                        expectedAuthorizationIdentityHash } : {}) });
                if (!verified.ok || digest !== expectedArtifactDigest) return { saved: false,
                    outcome: "approval_artifact_mismatch", opened: false };
                approvedV2 = { productionPrecondition: verified.productionPrecondition,
                    productionPreconditionIdentityHash: verified.identities.productionPreconditionIdentityHash };
                plan = verified.plan; expectedPlanHash = verified.identities.storageMutationHash;
                expectedStoreCounts = verified.productionPrecondition.storeCounts;
                expectedCursor = verified.productionPrecondition.sourceCursor; }
            const planHash = await planCanonicalizer.planHash(plan);
            if (planHash !== expectedPlanHash) return { saved: false, outcome: "plan_hash_mismatch", opened: false };
            let database;
            try { database = await openExisting(); let fingerprint;
                try { const inspected = schema.inspect(database); fingerprint = await schema.fingerprint({
                    ...inspected, databaseName: schema.DATABASE_NAME }); }
                catch (_error) { throw new Error("schema_fingerprint_mismatch"); }
                if (database.version !== schema.VERSION || fingerprint !== schema.EXPECTED_FINGERPRINT)
                    throw new Error("schema_fingerprint_mismatch");
                const beforeTx = database.transaction(names, "readonly"), beforeDone = done(beforeTx),
                    beforeSnapshot = await snapshotFrom(beforeTx); await beforeDone;
                const beforeCounts = countsFrom(beforeSnapshot), cursor = beforeSnapshot.cursors.find(
                    value => value.sourceId === plan.sourceId) || null;
                if (!equal(beforeCounts, expectedStoreCounts)) throw new Error("store_counts_precondition_failed");
                if (!equal(cursor || null, expectedCursor)) throw new Error("cursor_precondition_failed");
                if (approvedV2) await requireV2Precondition(database, beforeSnapshot, plan.sourceId, approvedV2);
                if (typeof beforeWriteTransaction === "function") await beforeWriteTransaction(database);
                const mapped = mapper.mapPlan(plan), tx = database.transaction(names, "readwrite"), completed = done(tx),
                    stopKeepAlive = keepTransactionAlive(tx);
                try { const insideSnapshot = await snapshotFrom(tx), insideCounts = countsFrom(insideSnapshot),
                    insideCursor = insideSnapshot.cursors.find(value => value.sourceId === plan.sourceId) || null;
                    if (!equal(insideCounts, expectedStoreCounts)) throw new Error("store_counts_precondition_failed");
                    if (!equal(insideCursor || null, expectedCursor)) throw new Error("cursor_precondition_failed");
                    if (approvedV2) await requireV2Precondition(database, insideSnapshot, plan.sourceId, approvedV2, tx);
                    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
                    for (const value of mapped.closeRevisions) { const current = await request(stores.marketCalendarSemanticRevisions.get(value.revisionKey));
                        if (!current || current.validTo !== value.expectedValidTo) throw new Error("close_revision_precondition_failed");
                        stores.marketCalendarSemanticRevisions.put({ ...current, validTo: value.validTo }); }
                    for (const value of mapped.appendRevisions) stores.marketCalendarSemanticRevisions.add(value);
                    for (const value of mapped.appendEntries) stores.marketCalendarEventEntries.add(value);
                    for (const value of mapped.updateEntries) { const current = await request(stores.marketCalendarEventEntries.get(value.eventKey));
                        if (!current || current.activeRevisionKey !== value.expectedActiveRevisionKey)
                            throw new Error("entry_precondition_failed"); const next = { ...current, ...value };
                        delete next.expectedActiveRevisionKey; stores.marketCalendarEventEntries.put(next); }
                    if (injectFailureAfter === "semantic") throw new Error("injected_failure_after_semantic");
                    for (const value of mapped.appendEvidence) stores.marketCalendarAcquisitionEvidence.add(value);
                    for (const value of mapped.appendObservations) stores.marketCalendarEventObservations.add(value);
                    for (const value of mapped.appendRuns) stores.marketCalendarSourceRuns.add(value);
                    for (const value of mapped.updateCursors) stores.marketCalendarSourceCursors.put(value);
                    if (injectFailureAfter === "evidence" || injectFailureAfter === "quota")
                        throw new Error(injectFailureAfter === "quota" ? "QuotaExceededError" : "injected_failure_after_evidence");
                    stopKeepAlive();
                } catch (error) { try { tx.abort(); } catch (_error) {} try { await completed; } catch (_error) {}
                    stopKeepAlive();
                    throw error; }
                await completed; const snapshot = await load(database), semantic = await integrity.audit(snapshot),
                    storage = integrity.auditStorageSnapshot(snapshot);
                if (!semantic.valid || !storage.valid) return { saved: true, outcome: "committed_integrity_failed",
                    requiresManualIntervention: true, planHash, snapshot, semantic, storage };
                return { saved: true, outcome: "committed", planHash, snapshot, semantic, storage };
            } catch (error) { return { saved: false, outcome: "rolled_back", error: error.message }; }
            finally { database?.close(); }
        }
        return Object.freeze({ write, diagnostics: Object.freeze({ enabled, defaultDisabled: !enabled,
            createsDatabase: false, upgradesDatabase: false, transactionStores: Object.freeze([...names]) }) });
    }
    return Object.freeze({ createProductionHistoryWriter });
});
