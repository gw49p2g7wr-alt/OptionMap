(function (root, factory) {
    const storageApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../morningBaselineV4Storage.js") : root?.OptionMapMorningBaselineV4StorageFoundation;
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("../marketCalendarHistory/historyIntegrity.js") :
        root?.OptionMapMarketCalendarHistoryIntegrity;
    const calendarSchema = commonJs ? require("../marketCalendarHistory/productionSchemaV1.js") :
        root?.OptionMapMarketCalendarProductionSchemaV1;
    const api = factory(storageApi, historyApi, calendarSchema, root);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapHistoricalReadModel = api;
})(typeof window !== "undefined" ? window : globalThis, function (morningStorage, historyApi, calendarSchema, root) {
    "use strict";
    const DATABASES = Object.freeze({
        observations: Object.freeze({ name: "optionMapMarketObservations", version: 1,
            stores: Object.freeze(["observations"]) }),
        prices: Object.freeze({ name: "optionMapPriceSnapshots", version: 1,
            stores: Object.freeze(["snapshots"]) }),
        qri: Object.freeze({ name: "optionMapQriOptionsHistory", version: 1,
            stores: Object.freeze(["qriOptionsHistoryMeta", "qriOptionsEntries", "qriOptionsRevisions"]) }),
        calendar: Object.freeze({ name: calendarSchema.DATABASE_NAME, version: calendarSchema.VERSION,
            stores: Object.freeze(["marketCalendarEventEntries", "marketCalendarSemanticRevisions",
                "marketCalendarAcquisitionEvidence", "marketCalendarEventObservations"]) })
    });
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const order = (field, id) => (a, b) => Date.parse(a[field]) - Date.parse(b[field]) ||
        String(a[id]).localeCompare(String(b[id]));
    const knowledgeAtFor = date => new Date(Date.parse(`${date}T00:00:00+09:00`) +
        24 * 60 * 60 * 1000 - 1).toISOString();
    const requestValue = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => undefined; });
    async function catalog(indexedDB) {
        if (typeof indexedDB?.databases !== "function") throw new Error("database_catalog_unavailable");
        return indexedDB.databases();
    }
    async function readDatabase(indexedDB, descriptor, reader) {
        let database = null;
        try {
            const available = await catalog(indexedDB), found = available.find(item => item.name === descriptor.name);
            if (!found) return { status: "absent", value: null };
            if (found.version !== descriptor.version) return { status: "schema_mismatch", value: null };
            database = await new Promise((resolve, reject) => {
                const open = indexedDB.open(descriptor.name, descriptor.version);
                open.onupgradeneeded = () => { open.transaction?.abort();
                    reject(new Error("database_upgrade_forbidden")); };
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error || new Error("database_open_failed"));
                open.onblocked = () => reject(new Error("database_open_blocked"));
            });
            if (descriptor.stores.some(name => !database.objectStoreNames.contains(name)))
                return { status: "schema_mismatch", value: null };
            return { status: "available", value: await reader(database) };
        } catch (_error) { return { status: "unavailable", value: null }; }
        finally { database?.close(); }
    }
    async function observationsFor(indexedDB, calendarDate) {
        return readDatabase(indexedDB, DATABASES.observations, async database => {
            const transaction = database.transaction("observations", "readonly"), done = transactionDone(transaction);
            const records = await requestValue(transaction.objectStore("observations")
                .index("byObservedAt").getAll());
            await done;
            return clone(records).filter(record => observedOn(record, calendarDate))
                .sort(order("observedAt", "observationId"));
        });
    }
    // The Calendar selects a JST observation day, not the source's trading day.
    // Keep marketDate and QRI/morning trading-date contracts untouched. Parse
    // timestamps rather than compare ISO strings: stored offsets may differ.
    function observedOn(record, calendarDate) {
        const instant = Date.parse(record?.observedAt);
        return validDate(calendarDate) && Number.isFinite(instant) &&
            new Date(instant + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) === calendarDate;
    }
    async function qriFor(indexedDB, calendarDate) {
        return readDatabase(indexedDB, DATABASES.qri, async database => {
            const transaction = database.transaction(["qriOptionsEntries", "qriOptionsRevisions"], "readonly"),
                done = transactionDone(transaction), [entries, revisions] = await Promise.all([
                    requestValue(transaction.objectStore("qriOptionsEntries").getAll()),
                    requestValue(transaction.objectStore("qriOptionsRevisions").getAll())]);
            await done;
            // confirmedAt is the persisted observation identity; sourceDateKey is
            // retained as metadata. Do not select today's activeVersionKey.
            const byEntry = new Map(entries.map(entry => [entry.entryKey, entry]));
            return clone(revisions).flatMap(revision => {
                const entry = byEntry.get(revision.entryKey);
                if (!entry || !Number.isFinite(Date.parse(revision.confirmedAt)) ||
                    typeof revision.versionKey !== "string" || !revision.versionKey ||
                    revision.revisionKey !== `${entry.entryKey}|${revision.versionKey}`)
                    throw new Error("qri_revision_identity_invalid");
                return observedOn({ observedAt: revision.confirmedAt }, calendarDate) ? [{
                    entryKey: entry.entryKey, contract: entry.contract, sourceDateKey: entry.sourceDateKey,
                    revision }] : [];
            }).sort((a, b) => order("confirmedAt", "versionKey")(a.revision, b.revision) ||
                        a.entryKey.localeCompare(b.entryKey));
        });
    }
    async function priceSnapshotsFor(indexedDB, calendarDate) {
        return readDatabase(indexedDB, DATABASES.prices, async database => {
            const transaction = database.transaction("snapshots", "readonly"), done = transactionDone(transaction);
            const records = await requestValue(transaction.objectStore("snapshots")
                .index("byObservedAt").getAll());
            await done;
            return clone(records).filter(record => observedOn(record, calendarDate))
                .sort(order("observedAt", "snapshotId"));
        });
    }
    async function morningFor(storage, calendarDate) {
        let raw = null;
        try { raw = storage?.getItem?.(morningStorage.STORAGE_KEY) ?? null; }
        catch (_error) { return { status: "unavailable", value: null }; }
        if (raw === null) return { status: "absent", value: null };
        const restored = await morningStorage.restoreMorningBaselineV4Storage(raw);
        if (!restored?.success) return { status: "schema_mismatch", value: null };
        const values = restored.container.series.flatMap(item => item.revisions.filter(revision =>
            observedOn({ observedAt: revision.capturedAt }, calendarDate)).map(revision => ({
                scopeId: item.scopeId, contract: item.contract, formalTradingDate: item.formalTradingDate,
                baselineId: revision.baselineId, baseline: clone(revision.snapshot) })))
            .sort((a, b) => order("capturedAt", "baselineId")(a.baseline, b.baseline));
        return { status: "available", value: values };
    }
    async function calendarFor(indexedDB, calendarDate) {
        const loaded = await readDatabase(indexedDB, DATABASES.calendar, async database => {
            const tx = database.transaction(DATABASES.calendar.stores, "readonly"), done = transactionDone(tx);
            const values = await Promise.all(DATABASES.calendar.stores.map(name =>
                requestValue(tx.objectStore(name).getAll())));
            await done;
            return { entries: values[0], revisions: values[1], evidence: values[2], observations: values[3] };
        });
        if (loaded.status !== "available") return loaded;
        try {
            const projected = await historyApi.queryAsKnownAt(loaded.value, { calendarDate,
                knowledgeAt: knowledgeAtFor(calendarDate), displayTimeZone: "Asia/Tokyo" });
            return projected.status === "available" ? { status: "available", value: clone(projected.events) } :
                { status: "unavailable", reason: projected.status, value: null };
        } catch (_error) { return { status: "unavailable", reason: "historical_projection_failed", value: null }; }
    }
    function section(part, count) {
        return { status: part.status !== "available" && part.status !== "absent" ? "unavailable" :
            count ? "saved" : "missing", storageStatus: part.status, count,
        reason: part.reason || (part.status === "schema_mismatch" ? "schema_mismatch" : null) };
    }
    async function read({ calendarDate, indexedDB = root?.indexedDB,
        localStorage = root?.localStorage } = {}) {
        if (!validDate(calendarDate)) return Object.freeze({ status: "invalid", calendarDate,
            available: false });
        const [observations, morning, qri, prices, calendar] = await Promise.all([
            observationsFor(indexedDB, calendarDate), morningFor(localStorage, calendarDate),
            qriFor(indexedDB, calendarDate), priceSnapshotsFor(indexedDB, calendarDate),
            calendarFor(indexedDB, calendarDate)
        ]);
        const observationList = observations.value || [], morningList = morning.value || [],
            qriEntries = qri.value || [], priceSnapshots = prices.value || [],
            calendarEvents = calendar.value || [], latestObservation = observationList.at(-1) || null,
            contracts = [...new Set(qriEntries.map(item => item.contract))].sort();
        const sections = { observation: section(observations, observationList.length),
            morning: section(morning, morningList.length), qri: section(qri, qriEntries.length),
            priceSnapshots: section(prices, priceSnapshots.length), calendar: section(calendar, calendarEvents.length) };
        const available = Object.values(sections).some(item => item.status === "saved"),
            incomplete = Object.values(sections).some(item => item.status !== "saved");
        return Object.freeze({ status: available ? incomplete ? "partial" : "available" :
            Object.values(sections).some(item => item.status === "unavailable") ? "unavailable" : "empty",
            calendarDate, knowledgeAt: knowledgeAtFor(calendarDate), available, sections: clone(sections),
            observations: clone(observationList), latestPriceSnapshot: clone(priceSnapshots.at(-1) || null),
            latestObservation: clone(latestObservation), observationCount: observationList.length,
            morningBaselines: clone(morningList), priceSnapshots: clone(priceSnapshots), calendarEvents: clone(calendarEvents),
            qri: Object.freeze({ available: contracts.length > 0,
                contracts, selectedContract: contracts[0] || null, revisions: clone(qriEntries) }),
            availability: Object.freeze({ observation: observations.status, morning: morning.status,
                qri: qri.status, priceSnapshots: prices.status, calendar: calendar.status,
                weeklyOptions: "not_queried", weeklyFutures: "not_queried",
                participant: "not_queried", jpxSnapshot: "not_queried" }) });
    }
    return Object.freeze({ DATABASES, read, observationsFor, priceSnapshotsFor, qriFor, morningFor,
        calendarFor, observedOn, knowledgeAtFor });
});
