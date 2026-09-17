(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const inventory = commonJs ? require("./readOnlyProductionInventory.js") :
        root?.OptionMapMarketCalendarReadOnlyProductionInventory;
    const schema = commonJs ? require("./productionSchemaV1.js") :
        root?.OptionMapMarketCalendarProductionSchemaV1;
    const authorization = commonJs ? require("./planAuthorization.js") :
        root?.OptionMapMarketCalendarPlanAuthorization;
    const integrity = commonJs ? require("./historyIntegrity.js") :
        root?.OptionMapMarketCalendarHistoryIntegrity;
    const virtualManifest = commonJs ? require("./virtualRunManifestV1.js") :
        root?.OptionMapMarketCalendarVirtualRunManifestV1;
    const canonicalizer = commonJs ? require("../marketCalendar/marketEventCanonicalizer.js") :
        root?.OptionMapMarketEventCanonicalizer;
    const api = factory(inventory, schema, authorization, integrity, virtualManifest, canonicalizer);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarReadOnlyGateTools = api;
})(typeof window !== "undefined" ? window : globalThis, function (inventory, schema, authorization,
    integrity, virtualManifest, canonicalizer) {
    "use strict";
    const STORE_MAP = Object.freeze({ entries: "marketCalendarEventEntries",
        revisions: "marketCalendarSemanticRevisions", evidence: "marketCalendarAcquisitionEvidence",
        observations: "marketCalendarEventObservations", runs: "marketCalendarSourceRuns",
        cursors: "marketCalendarSourceCursors" }), STORE_NAMES = Object.freeze(Object.values(STORE_MAP));
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const freeze = value => { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); };
    const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error || new Error("readonly_request_failed")); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("readonly_transaction_aborted"));
        tx.onerror = () => undefined; });
    const validId = value => typeof value === "string" && value.length > 0;
    async function openExisting(indexedDB, databaseName) {
        const catalog = await indexedDB.databases();
        if (!catalog.some(value => value.name === databaseName)) throw new Error("database_absent");
        return new Promise((resolve, reject) => { const value = indexedDB.open(databaseName); let upgrade = false;
            value.onupgradeneeded = () => { upgrade = true; try { value.transaction.abort(); } catch (_error) {} };
            value.onsuccess = () => upgrade ? (value.result.close(), reject(new Error("upgrade_forbidden"))) :
                resolve(value.result); value.onerror = () => reject(value.error || new Error("readonly_open_failed"));
            value.onblocked = () => reject(new Error("readonly_open_blocked")); });
    }
    async function loadSnapshot(database) { const tx = database.transaction(STORE_NAMES, "readonly"), done =
        complete(tx), result = {}; await Promise.all(Object.entries(STORE_MAP).map(async ([field, name]) => {
            result[field] = await request(tx.objectStore(name).getAll()); })); await done; return result; }
    const storeCounts = snapshot => Object.fromEntries(Object.entries(STORE_MAP).map(([field, name]) =>
        [name, snapshot[field].length]));
    const eventKeyOf = value => typeof value === "string" ? value : value?.eventKey;
    function auditRunReferences(snapshot, sourceId, runId) {
        const runByKey = new Map(snapshot.runs.map(value => [value.runKey, value])), revisionByKey = new Map(
            snapshot.revisions.map(value => [value.revisionKey, value])), entryByKey = new Map(snapshot.entries.map(
            value => [value.eventKey, value])), errors = [];
        for (const cursor of snapshot.cursors) { const linked = runByKey.get(cursor.runKey);
            if (!linked) errors.push(`cursor_run_missing:${cursor.sourceId}`);
            else if (linked.sourceId !== cursor.sourceId || linked.runId !== cursor.runId ||
                linked.acceptedAt !== cursor.acceptedAt) errors.push(`cursor_run_mismatch:${cursor.sourceId}`); }
        for (const evidence of snapshot.evidence) { const linkedRun = runByKey.get(
            `${evidence.sourceId}|${evidence.runId}`), linkedRevision =
            revisionByKey.get(evidence.revisionKey);
            if (!linkedRun) errors.push(`evidence_run_missing:${evidence.acquisitionEvidenceKey}`);
            else if (linkedRun.sourceId !== evidence.sourceId || linkedRun.runId !== evidence.runId)
                errors.push(`evidence_run_mismatch:${evidence.acquisitionEvidenceKey}`);
            if (!linkedRevision) errors.push(`evidence_revision_missing:${evidence.acquisitionEvidenceKey}`);
            else if (linkedRevision.sourceId !== evidence.sourceId || linkedRevision.eventKey !== evidence.eventKey)
                errors.push(`evidence_revision_mismatch:${evidence.acquisitionEvidenceKey}`); }
        for (const observation of snapshot.observations) { const linkedRun = runByKey.get(
            `${observation.sourceId}|${observation.runId}`),
            linkedEntry = entryByKey.get(observation.eventKey);
            if (!linkedRun) errors.push(`observation_run_missing:${observation.observationKey}`);
            else if (linkedRun.sourceId !== observation.sourceId || linkedRun.runId !== observation.runId)
                errors.push(`observation_run_mismatch:${observation.observationKey}`);
            if (!linkedEntry) errors.push(`observation_entry_missing:${observation.observationKey}`);
            else if (linkedEntry.sourceId !== observation.sourceId)
                errors.push(`observation_entry_mismatch:${observation.observationKey}`); }
        const targetRuns = snapshot.runs.filter(value => value.sourceId === sourceId && value.runId === runId);
        return freeze({ valid: errors.length === 0, targetRunCount: targetRuns.length,
            cursorCount: snapshot.cursors.length, runCount: snapshot.runs.length,
            evidenceCount: snapshot.evidence.length, observationCount: snapshot.observations.length, errors });
    }
    async function externalHistoryFingerprint(snapshot, sourceId) {
        const sourceRunKeys = new Set(snapshot.runs.filter(value => value.sourceId === sourceId)
            .map(value => value.runKey)), sourceRevisionKeys = new Set(snapshot.revisions.filter(
                value => value.sourceId === sourceId).map(value => value.revisionKey));
        const projection = {
            entries: snapshot.entries.filter(value => value.sourceId !== sourceId),
            revisions: snapshot.revisions.filter(value => value.sourceId !== sourceId),
            evidence: snapshot.evidence.filter(value => value.sourceId !== sourceId &&
                !sourceRevisionKeys.has(value.revisionKey)),
            observations: snapshot.observations.filter(value => value.sourceId !== sourceId),
            runs: snapshot.runs.filter(value => value.sourceId !== sourceId),
            cursors: snapshot.cursors.filter(value => value.sourceId !== sourceId &&
                !sourceRunKeys.has(value.runKey)) };
        return canonicalizer.sha256(projection);
    }
    async function withSnapshot(configuration, callback) {
        const indexedDB = configuration?.indexedDB, databaseName = configuration?.databaseName ||
            schema.DATABASE_NAME, inspected = await inventory.inspect({ indexedDB, databaseName,
                expectedStores: STORE_NAMES });
        if (inspected.status !== "compatible" || inspected.extraStores?.length)
            return freeze({ ok: false, outcome: "production_inventory_rejected", inventory: clone(inspected) });
        let database;
        try { database = await openExisting(indexedDB, databaseName); const snapshot = await loadSnapshot(database);
            return await callback({ database, snapshot, inventory: inspected }); }
        catch (error) { return freeze({ ok: false, outcome: "readonly_audit_failed",
            error: error?.message || String(error), inventory: clone(inspected) }); }
        finally { database?.close(); }
    }
    async function preflight(configuration = {}) {
        const sourceId = configuration.sourceId;
        if (!validId(sourceId)) return freeze({ ok: false, outcome: "source_id_invalid" });
        return withSnapshot(configuration, async ({ database, snapshot, inventory: inspected }) => {
            const schemaFingerprint = await schema.fingerprint({ ...schema.inspect(database),
                databaseName: schema.DATABASE_NAME }), cursor = snapshot.cursors.find(
                    value => value.sourceId === sourceId) || null, counts = storeCounts(snapshot),
                productionSnapshotFingerprint = await authorization.productionSnapshotFingerprint(snapshot),
                productionPrecondition = { productionSnapshotFingerprint, storeCounts: counts,
                    schemaFingerprint, sourceCursor: clone(cursor) }, activeEntries = snapshot.entries.filter(
                    value => value.sourceId === sourceId), revisionByKey = new Map(snapshot.revisions.map(
                    value => [value.revisionKey, value])), activeRevisions = activeEntries.map(value =>
                    revisionByKey.get(value.activeRevisionKey)).filter(Boolean).sort((a, b) =>
                    a.revisionKey.localeCompare(b.revisionKey)), semanticSetHash = activeRevisions.length ?
                    await canonicalizer.sha256(activeRevisions.map(value => value.revisionKey).sort()) : null,
                candidateKeys = (configuration.canonicalSet || configuration.candidateEventKeys || [])
                    .map(eventKeyOf), existingByKey = new Map(snapshot.entries.map(value => [value.eventKey, value])),
                collisions = candidateKeys.map(eventKey => ({ eventKey, existing: existingByKey.get(eventKey) }))
                    .filter(value => value.existing && value.existing.sourceId !== sourceId).map(value => ({
                        eventKey: value.eventKey, existingSourceId: value.existing.sourceId }));
            return freeze({ ok: true, outcome: "read_only_preflight_complete", sourceId,
                inventory: clone(inspected), snapshot: clone(snapshot), counts, productionSnapshotFingerprint,
                schemaFingerprint, sourceCursor: clone(cursor), productionPrecondition,
                productionPreconditionIdentityHash: await authorization.productionPreconditionIdentity(
                    productionPrecondition), active: { entryCount: activeEntries.length,
                    revisionCount: activeRevisions.length, eventKeys: activeEntries.map(value => value.eventKey).sort(),
                    revisionKeys: activeRevisions.map(value => value.revisionKey), semanticSetHash },
                crossSourceCollisions: collisions, crossSourceCollisionCount: collisions.length,
                externalHistoryFingerprint: await externalHistoryFingerprint(snapshot, sourceId) });
        });
    }
    async function acceptance(configuration = {}) {
        const sourceId = configuration.sourceId, runId = configuration.runId;
        if (!validId(sourceId) || !validId(runId)) return freeze({ ok: false,
            outcome: !validId(sourceId) ? "source_id_invalid" : "run_id_invalid" });
        return withSnapshot(configuration, async ({ snapshot, inventory: inspected }) => {
            const semantic = await integrity.audit(snapshot), storage = integrity.auditStorageSnapshot(snapshot),
                crossStore = auditRunReferences(snapshot, sourceId, runId),
                runs = snapshot.runs.filter(value => value.sourceId === sourceId && value.runId === runId), run =
                runs.length === 1 ? runs[0] : null, cursor = snapshot.cursors.find(
                    value => value.sourceId === sourceId) || null, manifest = run ? await virtualManifest.build({
                        run, runs: snapshot.runs, evidence: snapshot.evidence,
                        observations: snapshot.observations, revisions: snapshot.revisions }) :
                    freeze({ ok: false, manifest: null, errors: [runs.length ? "source_run_conflict" :
                        "source_run_missing"] }), ownEvidence = snapshot.evidence.filter(value =>
                    value.sourceId === sourceId && value.runId === runId), revisionKeys = new Set(
                    ownEvidence.map(value => value.revisionKey)), ownRevisions = snapshot.revisions.filter(
                    value => revisionKeys.has(value.revisionKey)), dates = [...new Set(ownRevisions.flatMap(
                    value => [value.calendarDateStart, value.calendarDateEnd]).filter(Boolean))].sort(),
                reconstruction = [];
            for (const calendarDate of dates) { const first = await integrity.queryAsKnownAt(snapshot, {
                calendarDate, knowledgeAt: run?.acceptedAt, displayTimeZone:
                    configuration.displayTimeZone || "Asia/Tokyo" }), second = await integrity.queryAsKnownAt(snapshot,
                    { calendarDate, knowledgeAt: run?.acceptedAt, displayTimeZone:
                        configuration.displayTimeZone || "Asia/Tokyo" });
                reconstruction.push({ calendarDate, status: first.status, eventCount: first.events.length,
                    revisionKeys: first.events.map(value => value.revision.revisionKey).sort(),
                    deterministic: JSON.stringify(first) === JSON.stringify(second) }); }
            const externalFingerprint = await externalHistoryFingerprint(snapshot, sourceId), expectedExternal =
                configuration.expectedExternalHistoryFingerprint, externalUnchanged = expectedExternal === undefined ?
                    null : externalFingerprint === expectedExternal, errors = [];
            if (!semantic.valid) errors.push("semantic_integrity_failed");
            if (!storage.valid) errors.push("storage_integrity_failed");
            if (!crossStore.valid) errors.push(...crossStore.errors.map(value => `cross_store:${value}`));
            if (!run) errors.push(runs.length ? "source_run_conflict" : "source_run_missing");
            if (!manifest.ok) errors.push(...manifest.errors.map(value => `manifest:${value}`));
            if (reconstruction.some(value => !value.deterministic)) errors.push("reconstruction_nondeterministic");
            if (externalUnchanged === false) errors.push("external_history_changed");
            return freeze({ ok: errors.length === 0, outcome: errors.length ? "acceptance_rejected" :
                "read_only_acceptance_complete", sourceId, runId, inventory: clone(inspected),
                run: clone(run), cursor: clone(cursor), cursorMatchesRun: Boolean(run && cursor?.runId === runId &&
                    cursor?.acceptedAt === run.acceptedAt), counts: storeCounts(snapshot), semanticIntegrity: semantic,
                storageIntegrity: storage, crossStoreIntegrity: crossStore, virtualRunManifest: clone(manifest),
                reconstructedSemanticSetHash: manifest.manifest?.semanticSetHash || null,
                semanticSetHashMatches: Boolean(run && manifest.manifest?.semanticSetHash === run.semanticSetHash),
                asKnownAt: reconstruction, deterministicReconstruction: reconstruction.every(
                    value => value.deterministic), externalHistoryFingerprint: externalFingerprint,
                expectedExternalHistoryFingerprint: expectedExternal ?? null,
                externalHistoryUnchanged: externalUnchanged, errors });
        });
    }
    return Object.freeze({ STORE_MAP, STORE_NAMES, storeCounts, externalHistoryFingerprint,
        preflight, acceptance });
});
