"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const qri = require("../js/qriOptions.js");
const historyApi = require("../js/qriOptionsHistory.js");
const historical = require("../js/qriOptionsHistoricalViewModel.js");

const build = historical.buildQriHistoricalViewModel;
const fetchedAt = "2026-08-31T11:00:00.000Z";

function canonical({ contract = "2026-09", date = "2026-08-31",
    updated = "2026-08-31T16:00:00+09:00", status = "available", records } = {}) {
    const sourceUrl = contract === "2026-09"
        ? "https://svc.qri.jp/jpx/nkopm/" : "https://svc.qri.jp/jpx/nkopm/1";
    const values = records || [
        { optionType: "put", strike: 40500, published: false, value: null },
        { optionType: "call", strike: 40000, published: true, value: 10 },
        { optionType: "put", strike: 40000, published: true, value: 20 },
        { optionType: "call", strike: 40500, published: true, value: 0 }
    ];
    return { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
        sourceUrl, pageUpdatedAt: updated, tradingDate: date, openInterestAsOf: null,
        contract, gengetsu: contract.replace("-", ""), contractLabel: `${Number(contract.slice(5))}月限月`,
        isActiveContract: true, lastTradingDate: `${contract}-10`, openInterestStatus: status,
        availableContracts: [{ contract, label: `${Number(contract.slice(5))}月限月`,
            url: sourceUrl, active: true }],
        records: values.map(record => ({ contract, ...record })) };
}

async function add(history, options = {}, confirmedAt = fetchedAt) {
    const cache = await qri.createCacheV2(canonical(options), fetchedAt);
    const candidate = (await historyApi.createHistoryCandidate(cache)).candidate;
    return (await historyApi.mergeCandidate(history, candidate, { confirmedAt })).history;
}

async function fixture() {
    let history = historyApi.createEmptyQriOptionsHistory();
    history = await add(history, { contract: "2026-09", date: "2026-08-30",
        updated: "2026-08-30T16:00:00+09:00" }, "2026-08-30T11:00:00Z");
    history = await add(history, { contract: "2026-09", date: "2026-08-31" });
    history = await add(history, { contract: "2026-10", date: "2026-08-31" });
    return history;
}

test("null/empty historyは明示的emptyを返す", () => {
    assert.equal(build({ history: null }).reason, "no_history");
    assert.equal(build({ history: historyApi.createEmptyQriOptionsHistory() }).status, "empty");
});

test("contractをdedupeして年月降順にし最新contractをdefault選択", async () => {
    const view = build({ history: await fixture() });
    assert.deepEqual(view.contracts, ["2026-10", "2026-09"]);
    assert.equal(view.selection.contract, "2026-10");
});

test("dateを降順にして最新日をdefault選択", async () => {
    const view = build({ history: await fixture(), selectedContract: "2026-09" });
    assert.deepEqual(view.dates, ["2026-08-31", "2026-08-30"]);
    assert.equal(view.selection.tradingDate, "2026-08-31");
});

test("明示contract/dateを選択できarchive identityを返す", async () => {
    const view = build({ history: await fixture(), selectedContract: "2026-09",
        selectedTradingDate: "2026-08-30" });
    assert.deepEqual(view.selection, { contract: "2026-09", tradingDate: "2026-08-30",
        entryKey: "2026-09|2026-08-30", activeVersionKey: view.metadata.activeVersionKey });
});

test("不存在の明示contract/dateへfallbackしない", async () => {
    const history = await fixture();
    assert.equal(build({ history, selectedContract: "2026-11" }).reason, "selection_not_found");
    const missingDate = build({ history, selectedContract: "2026-09",
        selectedTradingDate: "2026-08-29" });
    assert.equal(missingDate.reason, "selection_not_found");
    assert.equal(missingDate.selection, null);
});

test("activeVersionKeyだけを選びreplaced revisionへfallbackしない", async () => {
    let history = historyApi.createEmptyQriOptionsHistory();
    history = await add(history, { updated: "2026-08-31T15:00:00+09:00" }, "2026-08-31T10:00:00Z");
    history = await add(history, { updated: "2026-08-31T16:00:00+09:00" }, "2026-08-31T11:00:00Z");
    const entry = history.entries[0];
    const view = build({ history });
    assert.equal(view.selection.activeVersionKey, entry.revisions[1].versionKey);
    assert.notEqual(view.selection.activeVersionKey, entry.revisions[0].versionKey);
});

test("active revision missing/ambiguousをreject", async () => {
    const history = await fixture();
    const missing = structuredClone(history);
    missing.entries[0].activeVersionKey = "missing";
    assert.equal(build({ history: missing, selectedContract: "2026-09",
        selectedTradingDate: "2026-08-30" }).reason, "active_revision_missing");
    const ambiguous = structuredClone(history);
    const entry = ambiguous.entries.find(item => item.entryKey === "2026-09|2026-08-30");
    entry.revisions.push(structuredClone(entry.revisions[0]));
    assert.equal(build({ history: ambiguous, selectedContract: "2026-09",
        selectedTradingDate: "2026-08-30" }).reason, "active_revision_ambiguous");
});

test("CALL/PUTをnumeric strike順に対応しunpublishedをnullで保持", async () => {
    const view = build({ history: await fixture(), selectedContract: "2026-09" });
    assert.deepEqual(view.chartData.strikes, [40000, 40500]);
    assert.deepEqual(view.chartData.callOpenInterest, [10, 0]);
    assert.deepEqual(view.chartData.putOpenInterest, [20, null]);
    assert.deepEqual(view.chartData.publishedByStrike[1],
        { strike: 40500, call: true, put: false });
    assert.deepEqual(view.chartData.series, { call: "call", put: "put" });
});

test("OI unavailableとrecords unavailableを明示", async () => {
    const history = await fixture();
    const unavailable = structuredClone(history);
    const revision = unavailable.entries.at(-1).revisions[0];
    revision.openInterestStatus = "unavailable";
    revision.canonical.openInterestStatus = "unavailable";
    assert.equal(build({ history: unavailable }).reason, "oi_unavailable");
    const noRecords = structuredClone(history);
    noRecords.entries.at(-1).revisions[0].canonical.records = [];
    assert.equal(build({ history: noRecords }).reason, "records_unavailable");
});

test("invalid contract/date/recordをfail-closedにする", async () => {
    const history = await fixture();
    const contract = structuredClone(history); contract.entries[0].contract = "bad";
    assert.equal(build({ history: contract }).status, "invalid");
    const date = structuredClone(history); date.entries[0].sourceDateKey = "2026-02-30";
    assert.equal(build({ history: date, selectedContract: "2026-09" }).status, "invalid");
    const record = structuredClone(history);
    record.entries.find(entry => entry.contract === "2026-10")
        .revisions[0].canonical.records[0].contract = "2026-09";
    assert.equal(build({ history: record }).reason, "records_unavailable");
});

test("provenance metadataとhistorical noticeを返す", async () => {
    const history = await fixture();
    const view = build({ history });
    assert.equal(view.metadata.contract, "2026-10");
    assert.equal(view.metadata.source, qri.SOURCE);
    assert.equal(view.metadata.historyVersion, 1);
    assert.equal(view.metadata.parserVersion, 2);
    assert.equal(view.metadata.schemaVersion, 2);
    assert.match(view.metadata.signatureShort, /^[0-9a-f]{12}…$/);
    assert.deepEqual(view.notices, { isHistorical: true, isCurrent: false, savedSnapshot: true });
});

test("inputを変更せずoutputはdetached/deep-frozen/deterministic", async () => {
    const history = await fixture();
    const before = structuredClone(history);
    const first = build({ history });
    const second = build({ history });
    assert.deepEqual(history, before);
    assert.deepEqual(first, second);
    assert.notEqual(first.snapshot.facts, history.entries.at(-1).revisions[0].canonical.records);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.chartData.points[0].call), true);
    assert.throws(() => { first.chartData.points[0].call.value = 999; }, TypeError);
});

test("single snapshot factsはaggregation-readyでhistorical計算を含まない", async () => {
    const view = build({ history: await fixture() });
    assert.deepEqual(Object.keys(view.snapshot).sort(), ["facts", "identity"]);
    for (const forbidden of ["wall", "top3", "change", "comparison", "signal",
        "overallV2", "morning", "currentPriceRange"]) {
        assert.equal(forbidden in view, false);
    }
});

test("moduleはcurrent runtime/DOM/window/storage/network/Chartへ接続しない", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsHistoricalViewModel.js"), "utf8");
    assert.doesNotMatch(source, /\bwindow\b|\bdocument\b|indexedDB|fetch\s*\(|XMLHttpRequest|Chart\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /qriContractSelection|currentQri|OverallV2|Morning|Formal|Last.Valid/);
    assert.doesNotMatch(source, /require\s*\(/);
});
