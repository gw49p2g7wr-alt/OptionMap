const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const weekly = require("../js/weeklyOptions.js");
const historyApi = require("../js/weeklyOptionsHistory.js");
const storeApi = require("../js/storage/weeklyOptionsHistoryStore.js");
const persistenceApi = require("../js/weeklyOptionsHistoryPersistence.js");

const BLOCK_STARTS = [10, 25, 40, 55, 70];
let databaseSequence = 0;
let timeSequence = 0;

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

async function cache(sourceDate = "2026-08-07", value = 100) {
    const data = weekly.parseWeeklyOptionsRows(fixture(sourceDate, "2026-08", value));
    const signature = await weekly.createSignature(data);
    const compact = sourceDate.replaceAll("-", "");
    const sourceUrl = `https://www.jpx.co.jp/automation/markets/derivatives/` +
        `open-interest/files/${sourceDate.slice(0, 4)}/` +
        `${compact}_nk225op_oi_by_tp.xlsx`;
    return {
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
        versionAssessment: "confirmed", data
    };
}

function now() {
    const value = new Date(Date.UTC(2026, 7, 10, 8, 0, timeSequence));
    timeSequence = (timeSequence + 1) % 60;
    return value.toISOString();
}

function integration() {
    const store = storeApi.createWeeklyOptionsHistoryStore({
        indexedDB,
        databaseName: `${storeApi.DATABASE_NAME}-persistence-${++databaseSequence}`
    });
    const persistence = persistenceApi.createWeeklyOptionsHistoryPersistence({
        historyApi, store, now
    });
    return { store, persistence };
}

test("store open成功と初期state clone", async () => {
    const { store, persistence } = integration();
    const state = await persistence.openWeeklyOptionsHistoryPersistence();
    assert.equal(state.status, "not_attempted");
    assert.equal(state.storeStatus, "ready");
    state.storeStatus = "mutated";
    assert.equal(persistence.getWeeklyOptionsHistoryPersistenceState().storeStatus,
        "ready");
    assert.equal((await store.readWeeklyOptionsHistory()).status, "empty");
    store.closeWeeklyOptionsHistoryStore();
});

test("store open失敗でも例外を外へ出さない", async () => {
    const persistence = persistenceApi.createWeeklyOptionsHistoryPersistence({
        historyApi,
        store: { async openWeeklyOptionsHistoryStore() {
            throw new Error("open_denied");
        } },
        now
    });
    const state = await persistence.openWeeklyOptionsHistoryPersistence();
    assert.equal(state.status, "failed");
    assert.equal(state.reason, "store_open_failed");
    assert.equal(state.errorCode, "open_denied");
});

test("正常remote cacheだけを2週persistしlatestを復元", async () => {
    const { store, persistence } = integration();
    const july = await cache("2026-07-31", 100);
    const august = await cache("2026-08-07", 110);
    assert.equal((await persistence.persistConfirmedWeeklyOptionsCache(july)).status,
        "saved");
    assert.equal((await persistence.persistConfirmedWeeklyOptionsCache(august)).status,
        "saved");
    const history = await store.readWeeklyOptionsHistory();
    assert.deepEqual(history.history.entries.map(entry => entry.sourceDate), [
        "2026-07-31", "2026-08-07"
    ]);
    assert.equal((await store.getLatestStoredWeeklyOptionsRevision()).sourceDate,
        "2026-08-07");
    store.closeWeeklyOptionsHistoryStore();
});

for (const [name, mutate, reason] of [
    ["invalid canonical", value => { value.data.records[0].value = -1; },
        "invalid_canonical_cache"],
    ["unconfirmed assessment", value => { value.versionAssessment = "indeterminate"; },
        "invalid_formal_cache"],
    ["dateEvidence不整合", value => { value.dateEvidence.consistent = false; },
        "date_evidence_invalid"],
    ["signature不整合", value => { value.signature = "a".repeat(64); },
        "invalid_canonical_cache"],
    ["versionKey不整合", value => { value.versionKey = "broken"; },
        "invalid_canonical_cache"],
    ["cache v1", value => { value.version = 1; },
        "unsupported_cache_version"]
]) {
    test(`${name}はpersistしない`, async () => {
        const { store, persistence } = integration();
        const value = await cache();
        mutate(value);
        const state = await persistence.persistConfirmedWeeklyOptionsCache(value);
        assert.equal(state.status, "not_attempted");
        assert.equal(state.reason, reason);
        assert.equal((await store.readWeeklyOptionsHistory()).status, "empty");
        store.closeWeeklyOptionsHistoryStore();
    });
}

test("同一signature再取得はunchangedでrevisionを増やさない", async () => {
    const { store, persistence } = integration();
    const value = await cache();
    await persistence.persistConfirmedWeeklyOptionsCache(value);
    const state = await persistence.persistConfirmedWeeklyOptionsCache(value);
    const history = await store.readWeeklyOptionsHistory();
    assert.equal(state.status, "unchanged");
    assert.equal(state.reason, "same_version");
    assert.equal(history.history.entries[0].revisions.length, 1);
    store.closeWeeklyOptionsHistoryStore();
});

test("confirmed same-date revisionだけをpure rule経由で追加", async () => {
    const { store, persistence } = integration();
    await persistence.persistConfirmedWeeklyOptionsCache(await cache(undefined, 100));
    const revised = await cache(undefined, 101);
    const unconfirmed = await persistence.persistConfirmedWeeklyOptionsCache(revised);
    assert.equal(unconfirmed.status, "unchanged");
    assert.equal(unconfirmed.reason, "unconfirmed_revision");
    const confirmed = await persistence.persistConfirmedWeeklyOptionsCache(revised, {
        currentOfficialRefetch: true
    });
    assert.equal(confirmed.status, "saved");
    assert.equal(confirmed.reason, "revised");
    const entry = (await store.readWeeklyOptionsHistory()).history.entries[0];
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.activeVersionKey, revised.versionKey);
    assert.notEqual(entry.revisions[0].replacedAt, null);
    store.closeWeeklyOptionsHistoryStore();
});

test("保存失敗はcache・canonical・shadow相当stateを変更しない", async () => {
    const sourceCache = await cache();
    const before = structuredClone(sourceCache);
    const localStorageCache = JSON.stringify(sourceCache);
    const shadowSignal = { status: "available", signal: { quality: 0.8 } };
    const shadowChanges = { status: "waiting_previous", changes: null };
    const persistence = persistenceApi.createWeeklyOptionsHistoryPersistence({
        historyApi,
        store: {
            async openWeeklyOptionsHistoryStore() {},
            async persistWeeklyOptionsHistoryCandidate() {
                return { saved: false, outcome: "transaction_failed", error: "quota" };
            }
        },
        now
    });
    const state = await persistence.persistConfirmedWeeklyOptionsCache(sourceCache);
    assert.equal(state.status, "failed");
    assert.equal(state.reason, "transaction_failed");
    assert.deepEqual(sourceCache, before);
    assert.equal(localStorageCache, JSON.stringify(sourceCache));
    assert.deepEqual(shadowSignal, { status: "available", signal: { quality: 0.8 } });
    assert.deepEqual(shadowChanges, { status: "waiting_previous", changes: null });
});

test("canonical属性を変更せず派生データを保存しない", async () => {
    const { store, persistence } = integration();
    const value = await cache();
    const records = structuredClone(value.data.records);
    await persistence.persistConfirmedWeeklyOptionsCache(value);
    const history = (await store.readWeeklyOptionsHistory()).history;
    const canonical = history.entries[0].revisions[0].canonical;
    assert.deepEqual(canonical.records, records);
    assert.equal(canonical.records[0].participantCode, "00123");
    assert.equal(canonical.records[0].broker, "ＡＢＮクリアリン証券");
    assert.equal(canonical.records[0].rank, 1);
    assert.equal(canonical.records.some(record => record.value === 0), false);
    const serialized = JSON.stringify(history);
    for (const forbidden of ["signals", "changes", "bullish", "bearish",
        "directionScore"]) assert.equal(serialized.includes(forbidden), false);
    store.closeWeeklyOptionsHistoryStore();
});
