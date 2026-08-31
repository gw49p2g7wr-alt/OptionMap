const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const weekly = require("../js/weeklyOptions.js");
const historyApi = require("../js/weeklyOptionsHistory.js");
const viewApi = require("../js/weeklyOptionsParticipantHistoricalViewModel.js");

function rows(sourceDate, expiry, records) {
    const value = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    value[0][0] = weekly.SOURCE_TITLE;
    value[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    value[2][0] = `${year}年${month}月10日`;
    value[6][1] = `プット（${expiryYear}年${expiryMonth}月限月）`;
    value[6][11] = `コール（${expiryYear}年${expiryMonth}月限月）`;
    weekly.BLOCK_START_ROWS.forEach((start, block) => {
        value[start - 1][1] = value[start - 1][11] = 65000 + block * 125;
        for (let rank = 1; rank <= 15; rank += 1) {
            value[start + rank - 2][0] = value[start + rank - 2][10] = rank;
        }
    });
    for (const record of records) {
        const block = (record.strike - 65000) / 125;
        const row = value[weekly.BLOCK_START_ROWS[block] + record.rank - 2];
        const strikeColumn = record.optionType === "put" ? 1 : 11;
        const offset = record.side === "sell" ? 1 : 4;
        row[strikeColumn + offset] = record.participantCode;
        row[strikeColumn + offset + 1] = record.broker;
        row[strikeColumn + offset + 2] = record.value;
    }
    return value;
}

async function candidate(sourceDate, expiry, records, officialRefetch = false) {
    const data = weekly.parseWeeklyOptionsRows(rows(sourceDate, expiry, records));
    const signature = await weekly.createSignature(data);
    const compact = sourceDate.replaceAll("-", "");
    const cache = {
        version: 2,
        parserVersion: 2,
        schemaVersion: 2,
        source: "jpx-weekly-nikkei225-options-open-interest",
        sourceDate,
        sourceDateKind: "jpx_open_interest_as_of",
        publishedDate: data.publishedDate,
        publishedAt: null,
        listingUpdatedAt: `${sourceDate}T15:31:00+09:00`,
        listingUpdatedAtKind: "jpx_listing_updated_at",
        listingUrl: `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_${yearOf(sourceDate)}.json`,
        fetchedAt: `${sourceDate}T07:00:00.000Z`,
        sourceUrl: `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/${yearOf(sourceDate)}/${compact}_nk225op_oi_by_tp.xlsx`,
        signatureAlgorithm: "sha256",
        signature,
        versionKey: `weekly-options-v2|${sourceDate}|sha256:${signature}`,
        dateEvidence: {
            excelAsOf: sourceDate,
            listingTradeDate: sourceDate,
            urlDate: sourceDate,
            consistent: true
        },
        versionAssessment: "confirmed",
        currentOfficialRefetch: officialRefetch,
        data
    };
    return (await historyApi.createWeeklyOptionsHistoryCandidate(cache)).candidate;
}

function yearOf(date) {
    return date.slice(0, 4);
}

async function history(candidates) {
    let value = historyApi.createEmptyWeeklyOptionsHistory();
    let minute = 0;
    for (const item of candidates) {
        value = (await historyApi.mergeWeeklyOptionsHistory(value, item, {
            confirmedAt: `2026-08-31T00:${String(minute).padStart(2, "0")}:00.000Z`
        })).history;
        minute += 1;
    }
    return value;
}

const participant = (overrides = {}) => ({
    optionType: "call",
    side: "buy",
    strike: 65000,
    rank: 1,
    participantCode: "12400",
    broker: "野村証券",
    value: 100,
    ...overrides
});

async function build(value, overrides = {}) {
    return viewApi.buildWeeklyOptionsParticipantHistoricalViewModel({
        history: value,
        selectedParticipantCode: "12400",
        selectedOptionType: "call",
        period: "all",
        ...overrides
    });
}

test("empty historyとinvalid option typeをfail-closedで返す", async () => {
    const empty = await build(historyApi.createEmptyWeeklyOptionsHistory());
    assert.equal(empty.status, "empty");
    assert.equal(empty.reason, "no_history");
    const invalid = await build(historyApi.createEmptyWeeklyOptionsHistory(), {
        selectedOptionType: "call_put"
    });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.reason, "invalid_option_type");
});

test("history実掲載participantCodeからdeterministicな一覧を作る", async () => {
    const value = await history([
        await candidate("2026-08-07", "2026-08", [
            participant(),
            participant({ participantCode: "12479", broker: "ＡＢＮ証券",
                rank: 2, value: 90 })
        ]),
        await candidate("2026-08-14", "2026-08", [
            participant({ broker: "野村證券", value: 120 })
        ])
    ]);
    const listed = await viewApi.listWeeklyOptionsParticipants(value);
    assert.equal(listed.status, "available");
    const nomura = listed.participants.find(item =>
        item.participantCode === "12400"
    );
    assert.deepEqual(nomura.observedNames, ["野村証券", "野村證券"]);
    assert.equal(nomura.nameVariation, true);
    assert.equal(nomura.firstSeenDate, "2026-08-07");
    assert.equal(nomura.lastSeenDate, "2026-08-14");
    assert.equal(nomura.observationCount, 2);
});

test("broker名ではなくparticipantCodeで結合し不存在codeを拒否", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", [
        participant()
    ])]);
    const missing = await build(value, { selectedParticipantCode: "99999" });
    assert.equal(missing.status, "empty");
    assert.equal(missing.reason, "participant_not_found");
    assert.equal(missing.points.length, 0);
});

test("CALL/PUTとbuy/sellを分離し全掲載strikeを合計", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", [
        participant({ side: "buy", strike: 65000, rank: 1, value: 100 }),
        participant({ side: "buy", strike: 65125, rank: 1, value: 250 }),
        participant({ side: "sell", strike: 65250, rank: 1, value: 80 }),
        participant({ optionType: "put", side: "buy", strike: 65000,
            rank: 1, value: 999 })
    ])]);
    const call = await build(value);
    assert.equal(call.points[0].buy.total, 350);
    assert.equal(call.points[0].buy.contributingRecords, 2);
    assert.equal(call.points[0].buy.contributingStrikes, 2);
    assert.equal(call.points[0].sell.total, 80);
    const put = await build(value, { selectedOptionType: "put" });
    assert.equal(put.points[0].buy.total, 999);
    assert.equal(put.points[0].sell.total, null);
});

test("side別非掲載とparticipant非掲載をzeroへ変換しない", async () => {
    const value = await history([
        await candidate("2026-08-07", "2026-08", [participant()]),
        await candidate("2026-08-14", "2026-08", [
            participant({ participantCode: "12479", broker: "ＡＢＮ証券" })
        ])
    ]);
    const result = await build(value);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "partial_publication");
    assert.deepEqual(result.points[0].sell, {
        published: false, total: null, contributingRecords: 0,
        contributingStrikes: 0
    });
    assert.equal(result.points[1].buy.published, false);
    assert.equal(result.points[1].buy.total, null);
    assert.equal(result.summary.missingObservations, 1);
});

test("canonical v2のzeroはvalidatorで拒否し非掲載との混同を許さない", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", [
        participant()
    ])]);
    value.entries[0].revisions[0].canonical.records[0].value = 0;
    const result = await build(value);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, "history_corrupted");
    assert.equal(result.points.length, 0);
});

test("sourceDate順・expiry・strike window・coverage・provenanceを保持", async () => {
    const value = await history([
        await candidate("2026-08-14", "2026-09", [participant({ value: 120 })]),
        await candidate("2026-08-07", "2026-08", [participant({ value: 100 })])
    ]);
    const result = await build(value);
    assert.deepEqual(result.points.map(point => point.sourceDate), [
        "2026-08-07", "2026-08-14"
    ]);
    assert.deepEqual(result.points[0].strikeWindow, {
        min: 65000, max: 65500, count: 5
    });
    assert.equal(result.points[0].coverage.publishedStrikeCount, 1);
    assert.equal(result.points[0].coverage.scope, "jpx_published_ranked_records");
    assert.equal(result.points[0].provenance.activeVersionKey,
        value.entries[0].activeVersionKey);
    assert.match(result.points[0].provenance.sourceUrl, /nk225op_oi_by_tp/);
});

test("expiry変更ごとにroll boundaryを生成", async () => {
    const value = await history([
        await candidate("2026-07-31", "2026-08", [participant()]),
        await candidate("2026-08-07", "2026-08", [participant()]),
        await candidate("2026-08-14", "2026-09", [participant()]),
        await candidate("2026-08-21", "2026-10", [participant()])
    ]);
    const result = await build(value);
    assert.deepEqual(result.rollBoundaries, [
        { index: 2, sourceDate: "2026-08-14", fromExpiry: "2026-08",
            toExpiry: "2026-09" },
        { index: 3, sourceDate: "2026-08-21", fromExpiry: "2026-09",
            toExpiry: "2026-10" }
    ]);
    assert.equal(result.summary.observedExpiryCount, 3);
});

test("last20は最新20 stored observationsを使い欠損週を補完しない", async () => {
    const candidates = [];
    for (let day = 1; day <= 21; day += 1) {
        const sourceDate = `2026-08-${String(day).padStart(2, "0")}`;
        candidates.push(await candidate(sourceDate, "2026-09", [participant()]));
    }
    const value = await history(candidates);
    const result = await build(value, { period: "last20" });
    assert.equal(result.points.length, 20);
    assert.equal(result.points[0].sourceDate, "2026-08-02");
    assert.equal(result.points.at(-1).sourceDate, "2026-08-21");
});

test("threeMonthsはhistory最新日からcalendar 3か月、allは全件", async () => {
    const value = await history([
        await candidate("2026-02-28", "2026-03", [participant()]),
        await candidate("2026-05-31", "2026-06", [participant()]),
        await candidate("2026-08-31", "2026-09", [participant()])
    ]);
    const threeMonths = await build(value, { period: "threeMonths" });
    assert.deepEqual(threeMonths.points.map(point => point.sourceDate), [
        "2026-05-31", "2026-08-31"
    ]);
    assert.equal((await build(value, { period: "all" })).points.length, 3);
});

test("active revisionだけを使用しreplaced revisionへfallbackしない", async () => {
    const original = await candidate("2026-08-07", "2026-08", [
        participant({ value: 100 })
    ]);
    const revised = await candidate("2026-08-07", "2026-08", [
        participant({ value: 175 })
    ], true);
    const value = await history([original, revised]);
    const result = await build(value);
    assert.equal(result.points[0].buy.total, 175);
    assert.equal(result.points[0].provenance.activeVersionKey, revised.versionKey);
    value.entries[0].activeVersionKey = "missing";
    assert.equal((await build(value)).reason, "history_corrupted");
});

test("duplicate active revisionとcorrupt historyをfail-closed", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", [
        participant()
    ])]);
    value.entries[0].revisions.push(structuredClone(value.entries[0].revisions[0]));
    const result = await build(value);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, "history_corrupted");
});

test("summary・noticesは掲載範囲と非方向性を明示", async () => {
    const value = await history([
        await candidate("2026-08-07", "2026-08", [participant()]),
        await candidate("2026-08-14", "2026-08", [
            participant({ side: "sell", value: 80 })
        ])
    ]);
    const result = await build(value);
    assert.deepEqual(result.summary, {
        totalObservations: 2,
        publishedObservations: 2,
        missingObservations: 0,
        buyPublishedObservations: 1,
        sellPublishedObservations: 1,
        observedExpiryCount: 1
    });
    assert.equal(result.notices.publishedRankedRecordsOnly, true);
    assert.equal(result.notices.directionalInterpretationAllowed, false);
    assert.equal(result.notices.absenceIsZero, false);
    assert.equal("net" in result.points[0], false);
});

test("input非mutation・detached・deep frozen・deterministic", async () => {
    const value = await history([await candidate("2026-08-07", "2026-08", [
        participant()
    ])]);
    const before = structuredClone(value);
    const first = await build(value);
    const second = await build(value);
    assert.deepEqual(value, before);
    assert.deepEqual(first, second);
    assert.notStrictEqual(first.points, value.entries);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.points[0].buy), true);
    assert.throws(() => first.points.push({}), TypeError);
});

test("moduleはDOM・storage・network・QRIへ依存しない", () => {
    const source = fs.readFileSync(
        require.resolve("../js/weeklyOptionsParticipantHistoricalViewModel.js"),
        "utf8"
    );
    for (const forbidden of [
        "indexedDB", "localStorage", "sessionStorage", "document.",
        "fetch(", "ipcRenderer", "Chart", "Qri", "OverallV2", "Morning",
        "LastValid", "CurrentPrice"
    ]) assert.equal(source.includes(forbidden), false, forbidden);
});
