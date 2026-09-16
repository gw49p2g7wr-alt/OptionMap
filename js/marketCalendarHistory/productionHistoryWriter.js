(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const schema = commonJs ? require("./productionSchemaV1.js") : root?.OptionMapMarketCalendarProductionSchemaV1;
    const mapper = commonJs ? require("./storageRecordMapper.js") : root?.OptionMapMarketCalendarStorageRecordMapper;
    const integrity = commonJs ? require("./historyIntegrity.js") : root?.OptionMapMarketCalendarHistoryIntegrity;
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") : root?.OptionMapMarketEventCanonicalizer;
    const api = factory(schema, mapper, integrity, canonicalizer);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarProductionHistoryWriter = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, mapper, integrity, canonicalizer) {
    "use strict";
    const names = Object.keys(schema.STORES), request = value => new Promise((resolve, reject) => {
        value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("transaction_aborted")); tx.onerror = () => undefined; });
    const counts = async tx => Object.fromEntries(await Promise.all(names.map(async name =>
        [name, await request(tx.objectStore(name).count())])));
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function createProductionHistoryWriter(configuration = {}) {
        const indexedDB = configuration.indexedDB, databaseName = configuration.databaseName || schema.DATABASE_NAME,
            enabled = configuration.enabled === true, authorizationToken = configuration.authorizationToken;
        async function openExisting() { const catalog = await indexedDB.databases();
            if (!catalog.some(item => item.name === databaseName)) throw new Error("database_absent");
            return new Promise((resolve, reject) => { const value = indexedDB.open(databaseName); let upgrade = false;
                value.onupgradeneeded = () => { upgrade = true; try { value.transaction.abort(); } catch (_error) {} };
                value.onsuccess = () => upgrade ? (value.result.close(), reject(new Error("upgrade_forbidden"))) :
                    resolve(value.result); value.onerror = () => reject(value.error || new Error("open_failed"));
                value.onblocked = () => reject(new Error("open_blocked")); }); }
        async function load(database) { const tx = database.transaction(names, "readonly"), completed = done(tx), map = {
            entries: "marketCalendarEventEntries", revisions: "marketCalendarSemanticRevisions",
            evidence: "marketCalendarAcquisitionEvidence", observations: "marketCalendarEventObservations",
            runs: "marketCalendarSourceRuns", cursors: "marketCalendarSourceCursors" }, result = {};
            await Promise.all(Object.entries(map).map(async ([field, name]) => { result[field] = await request(
                tx.objectStore(name).getAll()); })); await completed; return result; }
        async function write({ authorization, plan, expectedPlanHash, expectedStoreCounts,
            expectedCursor = null, injectFailureAfter = null } = {}) {
            if (!enabled || !authorizationToken || authorization !== authorizationToken)
                return { saved: false, outcome: "production_write_disabled", opened: false };
            const planHash = await canonicalizer.sha256(plan);
            if (planHash !== expectedPlanHash) return { saved: false, outcome: "plan_hash_mismatch", opened: false };
            let database;
            try { database = await openExisting(); let fingerprint;
                try { const inspected = schema.inspect(database); fingerprint = await schema.fingerprint({
                    ...inspected, databaseName: schema.DATABASE_NAME }); }
                catch (_error) { throw new Error("schema_fingerprint_mismatch"); }
                if (database.version !== schema.VERSION || fingerprint !== schema.EXPECTED_FINGERPRINT)
                    throw new Error("schema_fingerprint_mismatch");
                const beforeTx = database.transaction(names, "readonly"), beforeDone = done(beforeTx),
                    beforeCountsPromise = counts(beforeTx), beforeCursorPromise = request(beforeTx.objectStore(
                        "marketCalendarSourceCursors").get(plan.sourceId)), [beforeCounts, cursor] =
                        await Promise.all([beforeCountsPromise, beforeCursorPromise]); await beforeDone;
                if (!equal(beforeCounts, expectedStoreCounts)) throw new Error("store_counts_precondition_failed");
                if (!equal(cursor || null, expectedCursor)) throw new Error("cursor_precondition_failed");
                const mapped = mapper.mapPlan(plan), tx = database.transaction(names, "readwrite"), completed = done(tx);
                try { const insideCountsPromise = counts(tx), insideCursorPromise = request(tx.objectStore(
                    "marketCalendarSourceCursors").get(plan.sourceId)), [insideCounts, insideCursor] =
                        await Promise.all([insideCountsPromise, insideCursorPromise]);
                    if (!equal(insideCounts, expectedStoreCounts)) throw new Error("store_counts_precondition_failed");
                    if (!equal(insideCursor || null, expectedCursor)) throw new Error("cursor_precondition_failed");
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
                } catch (error) { try { tx.abort(); } catch (_error) {} try { await completed; } catch (_error) {}
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
