const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const weekly = require("../js/weeklyOptions.js");
const historyApi = require("../js/weeklyOptionsHistory.js");
const storeApi = require("../js/storage/weeklyOptionsHistoryStore.js");

const BLOCK_STARTS = [10, 25, 40, 55, 70];
const CONFIRMED_AT = "2026-08-10T07:05:00.000Z";
let databaseSequence = 0;

function fixture(sourceDate = "2026-08-07", expiry = "2026-08", value = 100) {
    const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    rows[0][0] = weekly.SOURCE_TITLE;
    rows[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    rows[2][0] = `${year}年${month}月10日`;
    rows[6][1] = `プット（${expiryYear}年${expiryMonth}月限月）`;
    rows[6][11] = `コール（${expiryYear}年${expiryMonth}月限月）`;
    BLOCK_STARTS.forEach((start, block) => {
        rows[start - 1][1] = 65000 + block * 125;
        rows[start - 1][11] = 65000 + block * 125;
        for (let rank = 1; rank <= 15; rank += 1) {
            rows[start + rank - 2][0] = rank;
            rows[start + rank - 2][10] = rank;
        }
    });
    rows[9][2] = "00123";
    rows[9][3] = "ＡＢＮクリアリン証券";
    rows[9][4] = value;
    rows[9][15] = "12800";
    rows[9][16] = "モルガンＭＵＦＧ証券";
    rows[9][17] = value + 1;
    return rows;
}

async function candidate(sourceDate = "2026-08-07", expiry = "2026-08", value = 100,
    currentOfficialRefetch = false) {
    const data = weekly.parseWeeklyOptionsRows(fixture(sourceDate, expiry, value));
    const signature = await weekly.createSignature(data);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/${sourceDate.slice(0, 4)}/` +
        `${compact}_nk225op_oi_by_tp.xlsx`;
    const cache = {
        version: 2, parserVersion: 2, schemaVersion: 2,
        source: "jpx-weekly-nikkei225-options-open-interest",
        sourceDate, sourceDateKind: "jpx_open_interest_as_of",
        publishedDate: data.publishedDate, publishedAt: null,
        listingUpdatedAt: "2026-08-10T15:31:00+09:00",
        listingUpdatedAtKind: "jpx_listing_updated_at",
        listingUrl: `https://www.jpx.co.jp/automation/markets/derivatives/` +
            `open-interest/json/open_interest_${sourceDate.slice(0, 4)}.json`,
        fetchedAt: "2026-08-10T07:00:00.000Z", sourceUrl,
        signatureAlgorithm: "sha256", signature,
        versionKey: `weekly-options-v2|${sourceDate}|sha256:${signature}`,
        dateEvidence: { excelAsOf: sourceDate, listingTradeDate: sourceDate,
            urlDate: sourceDate, consistent: true },
        versionAssessment: "confirmed", currentOfficialRefetch, data
    };
    const result = await historyApi.createWeeklyOptionsHistoryCandidate(cache);
    assert.equal(result.ok, true);
    return result.candidate;
}

function makeStore() {
    const databaseName = `${storeApi.DATABASE_NAME}-test-${++databaseSequence}`;
    return {
        databaseName,
        store: storeApi.createWeeklyOptionsHistoryStore({ indexedDB, databaseName })
    };
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
}

async function rawPut(databaseName, storeName, value) {
    const request = indexedDB.open(databaseName, storeApi.DB_VERSION);
    const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(storeName, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(storeName).put(structuredClone(value));
    await done;
    db.close();
}

async function persist(store, item, confirmedAt = CONFIRMED_AT, options = {}) {
    return store.persistWeeklyOptionsHistoryCandidate(item, {
        confirmedAt, ...options
    });
}

test("DB初回open・object store作成・empty読出し・再open", async () => {
    const { store } = makeStore();
    const db = await store.openWeeklyOptionsHistoryStore();
    assert.equal(db.version, 1);
    assert.deepEqual([...db.objectStoreNames], [
        storeApi.ENTRY_STORE, storeApi.META_STORE, storeApi.REVISION_STORE
    ]);
    assert.equal((await store.readWeeklyOptionsHistory()).status, "empty");
    store.closeWeeklyOptionsHistoryStore();
    assert.equal((await store.openWeeklyOptionsHistoryStore()).version, 1);
    store.closeWeeklyOptionsHistoryStore();
});

test("新規2週をsourceDate順に復元しcanonicalを完全保持", async () => {
    const { store } = makeStore();
    const current = await candidate("2026-08-07", "2026-08", 200);
    const previous = await candidate("2026-07-31", "2026-08", 100);
    await persist(store, current);
    await persist(store, previous, "2026-08-10T07:06:00.000Z");
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "ready");
    assert.deepEqual(result.history.entries.map(entry => entry.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
    const restored = result.history.entries[1].revisions[0].canonical;
    assert.deepEqual(restored, current.canonical);
    assert.deepEqual(restored.records.map(record => ({
        code: record.participantCode, broker: record.broker,
        rank: record.rank, value: record.value
    })), current.canonical.records.map(record => ({
        code: record.participantCode, broker: record.broker,
        rank: record.rank, value: record.value
    })));
    assert.equal(restored.records.some(record =>
        record.published === false || record.value === 0
    ), false);
    const serialized = JSON.stringify(result.history);
    for (const forbidden of ["signals", "changes", "bullish", "bearish",
        "directionScore"]) {
        assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    }
    store.closeWeeklyOptionsHistoryStore();
});

test("同一signature再保存はrevisionを増やさない", async () => {
    const { store } = makeStore();
    const item = await candidate();
    await persist(store, item);
    const second = await persist(store, item, "2026-08-11T07:00:00.000Z");
    const entry = (await store.readWeeklyOptionsHistory()).history.entries[0];
    assert.equal(second.outcome, "same_version");
    assert.equal(entry.revisions.length, 1);
    assert.equal(entry.lastSeenAt, "2026-08-11T07:00:00.000Z");
    store.closeWeeklyOptionsHistoryStore();
});

test("confirmed same-date revisionはactive切替とreplacedAtをatomic保存", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-08-07", "2026-08", 100));
    const revised = await candidate("2026-08-07", "2026-08", 101, true);
    const changedAt = "2026-08-11T07:00:00.000Z";
    const saved = await persist(store, revised, changedAt);
    const entry = (await store.getStoredWeeklyOptionsEntry("2026-08-07")).entry;
    assert.equal(saved.outcome, "revised");
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, changedAt);
    assert.equal(entry.activeVersionKey, revised.versionKey);
    assert.deepEqual(await store.getStoredWeeklyOptionsRevision(
        "2026-08-07", revised.versionKey
    ), entry.revisions[1]);
    store.closeWeeklyOptionsHistoryStore();
});

test("unconfirmed revision・cache v1・version不一致を保存しない", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-08-07", "2026-08", 100));
    const unconfirmed = await persist(store,
        await candidate("2026-08-07", "2026-08", 101));
    assert.equal(unconfirmed.outcome, "unconfirmed_revision");
    assert.equal((await persist(store, { version: 1 })).outcome, "invalid_candidate");
    const invalidVersion = await candidate("2026-08-14", "2026-08", 102);
    invalidVersion.parserVersion = 1;
    assert.equal((await persist(store, invalidVersion)).outcome, "invalid_candidate");
    assert.equal((await store.readWeeklyOptionsHistory()).history.entries.length, 1);
    store.closeWeeklyOptionsHistoryStore();
});

test("transaction途中失敗はrollbackし既存historyを不変にする", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-07-31", "2026-08", 100));
    const before = (await store.readWeeklyOptionsHistory()).history;
    const failed = await persist(store,
        await candidate("2026-08-07", "2026-08", 110),
        "2026-08-10T07:06:00.000Z", { failAfter: "revision" });
    assert.equal(failed.outcome, "transaction_failed");
    assert.deepEqual((await store.readWeeklyOptionsHistory()).history, before);
    store.closeWeeklyOptionsHistoryStore();
});

test("複数candidateを一括保存し再実行は冪等", async () => {
    const { store } = makeStore();
    const candidates = [
        await candidate("2026-08-07", "2026-08", 110),
        await candidate("2026-07-31", "2026-08", 100)
    ];
    const saved = await store.persistWeeklyOptionsHistoryCandidates(candidates,
        { confirmedAt: CONFIRMED_AT });
    assert.equal(saved.saved, true);
    assert.equal(saved.changedCount, 2);
    assert.deepEqual((await store.readWeeklyOptionsHistory()).history.entries
        .map(entry => entry.sourceDate), ["2026-07-31", "2026-08-07"]);
    const repeated = await store.persistWeeklyOptionsHistoryCandidates(candidates,
        { confirmedAt: "2026-08-11T07:00:00.000Z" });
    assert.equal(repeated.outcome, "same_versions");
    const repeatedHistory = (await store.readWeeklyOptionsHistory()).history;
    assert.equal(repeatedHistory.entries.length, 2);
    assert.deepEqual(repeatedHistory.entries.map(entry => entry.revisions.length), [1, 1]);
    store.closeWeeklyOptionsHistoryStore();
});

test("一括保存のtransaction失敗は既存historyを不変にする", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-07-24", "2026-08", 90));
    const before = (await store.readWeeklyOptionsHistory()).history;
    const failed = await store.persistWeeklyOptionsHistoryCandidates([
        await candidate("2026-07-31", "2026-08", 100),
        await candidate("2026-08-07", "2026-08", 110)
    ], { confirmedAt: CONFIRMED_AT, failAfter: "entries" });
    assert.equal(failed.outcome, "transaction_failed");
    assert.deepEqual((await store.readWeeklyOptionsHistory()).history, before);
    store.closeWeeklyOptionsHistoryStore();
});

test("一括保存のquota失敗は既存historyを不変にする", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-07-31", "2026-08", 100));
    const before = (await store.readWeeklyOptionsHistory()).history;
    const failed = await store.persistWeeklyOptionsHistoryCandidates([
        await candidate("2026-08-07", "2026-08", 110)
    ], { confirmedAt: CONFIRMED_AT, failWith: "quota" });
    assert.equal(failed.error, "QuotaExceededError");
    assert.deepEqual((await store.readWeeklyOptionsHistory()).history, before);
    store.closeWeeklyOptionsHistoryStore();
});

test("entry/revision/latest/previous calendar/same-expiryを取得", async () => {
    const { store } = makeStore();
    await persist(store, await candidate("2026-07-24", "2026-08", 90));
    await persist(store, await candidate("2026-07-31", "2026-09", 100),
        "2026-08-10T07:06:00.000Z");
    await persist(store, await candidate("2026-08-07", "2026-08", 110),
        "2026-08-10T07:07:00.000Z");
    assert.equal((await store.getStoredWeeklyOptionsEntry("2026-07-31")).status,
        "available");
    assert.equal((await store.getLatestStoredWeeklyOptionsRevision()).sourceDate,
        "2026-08-07");
    const previous = await store.getPreviousStoredWeeklyOptionsRevision("2026-08-07");
    assert.equal(previous.previousCalendar.sourceDate, "2026-07-31");
    assert.equal(previous.previousSameExpiry.sourceDate, "2026-07-24");
    assert.equal(historyApi.classifyWeeklyOptionsComparison(
        previous.previousCalendar.revision,
        (await store.getLatestStoredWeeklyOptionsRevision()).revision
    ).status, "roll_transition");
    store.closeWeeklyOptionsHistoryStore();
});

test("非active revision破損を隔離し他entryとactiveを利用できる", async () => {
    const { store, databaseName } = makeStore();
    const first = await candidate("2026-07-31", "2026-08", 100);
    await persist(store, first);
    const revised = await candidate("2026-07-31", "2026-08", 101, true);
    await persist(store, revised, "2026-08-11T07:00:00.000Z");
    await persist(store, await candidate("2026-08-07", "2026-08", 110),
        "2026-08-11T07:01:00.000Z");
    const old = await store.getStoredWeeklyOptionsRevision("2026-07-31", first.versionKey);
    old.canonical.records[0].value = -1;
    store.closeWeeklyOptionsHistoryStore();
    await rawPut(databaseName, storeApi.REVISION_STORE,
        { sourceDate: "2026-07-31", ...old });
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "partial");
    assert.equal(result.diagnostics.invalidRevisionCount, 1);
    assert.equal(result.diagnostics.recoveryRequired, false);
    assert.equal(result.usableHistory.entries.some(entry =>
        entry.sourceDate === "2026-08-07"
    ), true);
    assert.equal((await store.getStoredWeeklyOptionsEntry("2026-07-31")).status,
        "partial");
    store.closeWeeklyOptionsHistoryStore();
});

test("active revision破損はrecovery_requiredで旧版へ自動昇格しない", async () => {
    const { store, databaseName } = makeStore();
    const first = await candidate("2026-08-07", "2026-08", 100);
    await persist(store, first);
    const revised = await candidate("2026-08-07", "2026-08", 101, true);
    await persist(store, revised, "2026-08-11T07:00:00.000Z");
    const active = await store.getStoredWeeklyOptionsRevision(
        "2026-08-07", revised.versionKey
    );
    active.signature = "a".repeat(64);
    store.closeWeeklyOptionsHistoryStore();
    await rawPut(databaseName, storeApi.REVISION_STORE,
        { sourceDate: "2026-08-07", ...active });
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "recovery_required");
    assert.equal(result.diagnostics.recoveryRequired, true);
    const latest = await store.getLatestStoredWeeklyOptionsRevision();
    assert.equal(latest.status, "recovery_required");
    assert.equal(latest.revision, null);
    store.closeWeeklyOptionsHistoryStore();
});

test("activeVersionKey不整合を検出", async () => {
    const { store, databaseName } = makeStore();
    await persist(store, await candidate());
    const entry = (await store.getStoredWeeklyOptionsEntry("2026-08-07")).entry;
    store.closeWeeklyOptionsHistoryStore();
    await rawPut(databaseName, storeApi.ENTRY_STORE, {
        sourceDate: entry.sourceDate, expiries: entry.expiries,
        activeVersionKey: "missing", firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt
    });
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "recovery_required");
    assert.ok(result.diagnostics.invalidEntries[0].errors.includes(
        "active_revision_invalid"
    ));
    store.closeWeeklyOptionsHistoryStore();
});

test("revision sourceDateとcanonical sourceDateの不一致を検出", async () => {
    const { store, databaseName } = makeStore();
    const item = await candidate();
    await persist(store, item);
    const revision = await store.getStoredWeeklyOptionsRevision(
        "2026-08-07", item.versionKey
    );
    revision.canonical.sourceDate = "2026-07-31";
    store.closeWeeklyOptionsHistoryStore();
    await rawPut(databaseName, storeApi.REVISION_STORE,
        { sourceDate: "2026-08-07", ...revision });
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "recovery_required");
    assert.equal(result.diagnostics.invalidEntries[0]
        .invalidRevisions[0].index, 0);
    store.closeWeeklyOptionsHistoryStore();
});

test("metadata破損を検出しrecordを自動修復しない", async () => {
    const { store, databaseName } = makeStore();
    await persist(store, await candidate());
    store.closeWeeklyOptionsHistoryStore();
    await rawPut(databaseName, storeApi.META_STORE, {
        id: "history", historyVersion: 999, source: "broken",
        canonicalParserVersion: 2, canonicalSchemaVersion: 2,
        signatureAlgorithm: "sha256",
        retentionPolicy: { configuredMaxEntries: null, automaticPruning: false }
    });
    const result = await store.readWeeklyOptionsHistory();
    assert.equal(result.status, "metadata_invalid");
    assert.equal(result.diagnostics.metadataInvalid, true);
    assert.ok(result.diagnostics.topLevelErrors.includes("history_version_invalid"));
    store.closeWeeklyOptionsHistoryStore();
});

test("openだけではLocal StorageやDB recordを書き込まない", async () => {
    const { store } = makeStore();
    let localStorageCalls = 0;
    const previous = global.localStorage;
    global.localStorage = { setItem() { localStorageCalls += 1; } };
    try {
        await store.openWeeklyOptionsHistoryStore();
        const result = await store.readWeeklyOptionsHistory();
        assert.equal(result.status, "empty");
        assert.equal(localStorageCalls, 0);
    } finally {
        global.localStorage = previous;
        store.closeWeeklyOptionsHistoryStore();
    }
});

test("入力candidateを変更しない", async () => {
    const { store } = makeStore();
    const item = await candidate();
    const before = structuredClone(item);
    await persist(store, item);
    assert.deepEqual(item, before);
    store.closeWeeklyOptionsHistoryStore();
});

for (const count of [52, 104]) {
    test(`${count}週相当を保存・復元`, async () => {
        const { store } = makeStore();
        const start = new Date("2024-01-05T00:00:00.000Z");
        for (let index = 0; index < count; index += 1) {
            const date = new Date(start);
            date.setUTCDate(date.getUTCDate() + index * 7);
            const sourceDate = date.toISOString().slice(0, 10);
            const result = await persist(store,
                await candidate(sourceDate, "2026-08", 100 + index),
                new Date(Date.UTC(2026, 7, 10, 7, 5, index % 60)).toISOString());
            assert.equal(result.saved, true);
        }
        const restored = await store.readWeeklyOptionsHistory();
        assert.equal(restored.status, "ready");
        assert.equal(restored.history.entries.length, count);
        assert.equal(restored.history.entries[0].sourceDate, "2024-01-05");
        store.closeWeeklyOptionsHistoryStore();
    });
}
