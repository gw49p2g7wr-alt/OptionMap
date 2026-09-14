"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const State = require("../js/qriTimeTravelState.js");
const Projection = require("../js/qriTimeTravelProjection.js");
const Historical = require("../js/qriOptionsHistoricalViewModel.js");

function entry(contract, date, call, put, seed) {
    const records = [call, put].flatMap((values, side) => Object.entries(values).map(([strike, value]) =>
        ({ contract, optionType: side ? "put" : "call", strike: Number(strike), published: value !== null,
            value })));
    const sourceUrl = contract === "2026-09" ? "https://svc.qri.jp/jpx/nkopm/" : "https://svc.qri.jp/jpx/nkopm/1";
    const canonical = { parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options", sourceUrl,
        pageUpdatedAt: `${date}T16:00:00+09:00`, tradingDate: date, openInterestAsOf: null,
        contract, gengetsu: contract.replace("-", ""), contractLabel: `${Number(contract.slice(5))}月限月`, isActiveContract: true,
        lastTradingDate: `${contract}-10`, openInterestStatus: "available",
        availableContracts: [{ contract, label: `${Number(contract.slice(5))}月限月`, url: contract === "2026-09"
            ? "https://svc.qri.jp/jpx/nkopm/" : "https://svc.qri.jp/jpx/nkopm/1", active: true }], records };
    const signature = String(seed).repeat(64).slice(0, 64), versionKey =
        `qri-options-v2|${contract}|${canonical.pageUpdatedAt}|sha256:${signature}`;
    return { entryKey: `${contract}|${date}`, contract, sourceDateKey: date, activeVersionKey: versionKey,
        revisions: [{ versionKey, signature, signatureAlgorithm: "sha256", contract, tradingDate: date,
            pageUpdatedAt: canonical.pageUpdatedAt, sourceUrl, fetchedAt: `${date}T08:00:00Z`,
            confirmedAt: `${date}T09:00:00Z`, snapshotDate: date, replacedAt: null,
            openInterestStatus: "available", openInterestAsOf: null, lastTradingDate: canonical.lastTradingDate,
            canonical }] };
}
async function fixture() {
    return { historyVersion: 1, parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options",
        signatureAlgorithm: "sha256", entries: [
            entry("2026-09", "2026-09-07", { 60000: 10, 61000: 5 }, { 60000: 20, 61000: 8 }, "1"),
            entry("2026-10", "2026-09-07", { 60000: 20, 61000: 3 }, { 60000: 30, 61000: 4 }, "5"),
            entry("2026-12", "2026-09-07", { 60000: 40, 61000: 7 }, { 60000: 50, 61000: 9 }, "6"),
            entry("2026-09", "2026-09-08", { 60000: 15, 61000: 4 }, { 60000: 18, 61000: null }, "2"),
            entry("2026-10", "2026-09-08", { 60000: 30, 61000: 6 }, { 60000: 40, 61000: 7 }, "3"),
            entry("2026-12", "2026-09-08", { 60000: 50, 61000: 9 }, { 60000: 60, 61000: 10 }, "4") ] };
}
function ivHistory(contract = "2026-09", date = "2026-09-08") {
    const versionKey = `qri-option-iv-v1|${contract}|${date}|sha256:${"a".repeat(64)}`;
    return { entries: [{ entryKey: `${contract}|${date}`, contract, tradingDate: date,
        activeVersionKey: versionKey, revisions: [{ versionKey, contract, tradingDate: date,
            canonical: { contract, tradingDate: date, records: [
                { optionType: "call", strike: 60000, iv: { status: "available", value: 21.5 } },
                { optionType: "put", strike: 60000, iv: { status: "missing", value: null } },
                { optionType: "call", strike: 99999, iv: { status: "available", value: 99 } }
            ] } }] }] };
}

test("historical stateはimmutableでlive復帰を明示する", () => {
    const initial = State.create({ selectedTradingDate: "2026-09-08", selectedContract: "2026-09" });
    const next = State.transition(initial, { selectedContract: "2026-11" });
    assert.equal(Object.isFrozen(initial), true); assert.equal(next.selectedTradingDate, "2026-09-08");
    assert.equal(next.selectedContract, "2026-11"); assert.equal(State.returnLive(next).mode, "live");
});

test("date-scoped active projectionはTOP3と前回保存観測比を作る", async () => {
    const history = await fixture(), state = State.create({ selectedTradingDate: "2026-09-08",
        selectedContract: "2026-09", selectedContracts: ["2026-09"] });
    const direct = Historical.buildQriHistoricalViewModel({ history, selectedContract: "2026-09",
        selectedTradingDate: "2026-09-08" });
    assert.equal(direct.status, "available", direct.reason);
    const value = Projection.build({ history, state });
    assert.equal(value.status, "available", value.reason); assert.equal(value.previousTradingDate, "2026-09-07");
    assert.deepEqual(value.top3.call.map(x => [x.strike, x.oi, x.previousSavedObservationDelta]),
        [[60000, 15, 5], [61000, 4, -1]]);
    assert.deepEqual(value.coverage, { total: 4, observed: 3, notPublished: 1, comparable: 3 });
    assert.equal(value.storageWrite, false); assert.equal(value.activeRevisionWrite, false);
    assert.equal(value.liveStateWrite, false); assert.equal(Object.isFrozen(value), true);
});

test("保存日availabilityは09/10/12を示し11限を補完しない", async () => {
    const history = await fixture(); const missing = Projection.build({ history, state: State.create({
        selectedTradingDate: "2026-09-08", selectedContract: "2026-11",
        selectedContracts: ["2026-11"] }) });
    assert.equal(missing.reason, "snapshot_not_saved"); assert.deepEqual(missing.missingContracts, ["2026-11"]);
    assert.deepEqual(missing.availability.find(x => x.tradingDate === "2026-09-08").contracts,
        ["2026-09", "2026-10", "2026-12"]);
});

test("aggregateは同日active snapshotだけを合算する", async () => {
    const history = await fixture(), value = Projection.build({ history, state: State.create({
        viewMode: "aggregate", selectedTradingDate: "2026-09-08", selectedContract: "2026-09",
        selectedContracts: ["2026-09", "2026-10", "2026-12"] }) });
    assert.equal(value.status, "available", value.reason); assert.equal(value.top3.call[0].oi, 95);
    assert.equal(value.top3.put[0].oi, 118); assert.equal(value.selectedRevision.length, 3);
    assert.equal(value.previousTradingDate, "2026-09-07");
    assert.equal(value.top3.call[0].previousSavedObservationDelta, 25);
    assert.equal(value.top3.put[0].previousSavedObservationDelta, 18);
});

test("IVはcontract・tradingDate・strike・side完全一致のactive revisionだけを結合", async () => {
    const history = await fixture(), state = State.create({ selectedTradingDate: "2026-09-08",
        selectedContract: "2026-09", selectedContracts: ["2026-09"] });
    const value = Projection.build({ history, ivHistory: ivHistory(), state });
    const call = value.comparisonFacts.find(item => item.side === "call" && item.strike === 60000);
    const put = value.comparisonFacts.find(item => item.side === "put" && item.strike === 60000);
    assert.deepEqual(call.iv, { status: "available", value: 21.5,
        sourceRevision: ivHistory().entries[0].activeVersionKey });
    assert.deepEqual(put.iv, { status: "missing", value: null,
        sourceRevision: ivHistory().entries[0].activeVersionKey });
    assert.deepEqual(value.ivCoverage, { eligible: 4, observed: 1, missing: 3 });
    assert.equal(Projection.build({ history, ivHistory: ivHistory("2026-10"), state })
        .ivCoverage.observed, 0);
    assert.equal(Projection.build({ history, ivHistory: ivHistory("2026-09", "2026-09-07"), state })
        .ivCoverage.observed, 0);
});

test("aggregate IVは合成せず対象外を明示", async () => {
    const history = await fixture(), value = Projection.build({ history, ivHistory: ivHistory(),
        state: State.create({ viewMode: "aggregate", selectedTradingDate: "2026-09-08",
            selectedContract: "2026-09", selectedContracts: ["2026-09", "2026-10"] }) });
    assert.deepEqual(value.ivCoverage, { eligible: 0, observed: 0, missing: 0,
        reason: "aggregate_not_applicable" });
});

test("既存panelをTime Travelへ発展させ保護対象へ接続しない", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const source = fs.readFileSync(path.join(__dirname, "../js/qriTimeTravelView.js"), "utf8");
    assert.match(html, /過去日のQRIを見る（Time Travel β）/);
    assert.match(html, /timeTravelPreviousDate[\s\S]*historyDateSelect[\s\S]*timeTravelNextDate/);
    assert.match(html, /過去表示[\s\S]*現在へ戻る/);
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|fetch\s*\(|Overall|Morning|FullExport/);
    assert.doesNotMatch(source, /\bpersist\b|\bsave\b|setInterval|setTimeout/);
});
