const test = require("node:test");
const assert = require("node:assert/strict");
const activity = require("../js/participantActivity.js");

const row = ({
    product = "NK225MF",
    contractCode = "M1",
    contractName = "MINI M1",
    participantCode = "001",
    company = "会社A",
    companyEnglish = "Broker A",
    rank = 1,
    volume = 100
} = {}) => ({
    product,
    contractCode,
    contractName,
    participantCode,
    company,
    companyEnglish,
    rank,
    volume
});

const emptyGroup = () => ({ records: [], top10: [] });

function fileData(sourceDate, values = {}) {
    return {
        sourceDate,
        sourceDateKind: "excel",
        large: { records: values.large || [], top10: [] },
        mini: { records: values.mini || [], top10: [] },
        topix: { records: values.topix || [], top10: [] },
        micro: { records: values.micro || [], top10: [] },
        option: { records: values.option || [], top10: [] }
    };
}

function completeSet(sourceDate, files, version = "a") {
    return {
        version: 1,
        parserVersion: 1,
        source: "jpx-daily-participant-volume",
        sourceDate,
        status: "complete",
        signature: version.repeat(64).slice(0, 64),
        versionKey: `participant-set|${sourceDate}|sha256:${version.repeat(64).slice(0, 64)}`,
        files: Object.fromEntries(
            Object.entries(files).map(([key, data]) => [key, { data }])
        )
    };
}

function standardFiles(sourceDate, multiplier = 1, contracts = ["M1", "M2"]) {
    const mini = (participantCode, company, volume, contractCode = "M1", rank = 1) =>
        row({ participantCode, company, companyEnglish: `${company} EN`, volume: volume * multiplier, contractCode, contractName: contractCode, rank });
    return {
        dayAuction: fileData(sourceDate, {
            large: [row({ product: "NK225F", contractCode: "L1", volume: 25 * multiplier })],
            mini: [
                mini("001", "会社A", 100, contracts[0], 2),
                mini("002", "会社B", 50, contracts[0], 1)
            ],
            topix: [row({ product: "TOPIXF", contractCode: "T1", volume: 30 * multiplier })],
            option: [row({ product: "NK225E", contractCode: "O1", volume: 999 })],
            micro: [row({ product: "MICRO", contractCode: "X1", volume: 999 })]
        }),
        dayJnet: fileData(sourceDate, {
            mini: [mini("001", "会社A", 20, contracts[0])]
        }),
        nightAuction: fileData(sourceDate, {
            mini: [
                mini("001", "会社A", 80, contracts[0]),
                mini("003", "会社C", 40, contracts[1] || contracts[0])
            ]
        }),
        nightJnet: fileData(sourceDate, {
            mini: [mini("002", "会社B", 10, contracts[0])]
        })
    };
}

function entry(sourceDate, files, version = "a", oldCompleteSet = null) {
    const active = completeSet(sourceDate, files, version);
    const revisions = oldCompleteSet ? [
        {
            versionKey: oldCompleteSet.versionKey,
            signature: oldCompleteSet.signature,
            completeSet: oldCompleteSet
        }
    ] : [];
    revisions.push({
        versionKey: active.versionKey,
        signature: active.signature,
        completeSet: active
    });
    return {
        sourceDate,
        activeVersionKey: active.versionKey,
        revisions
    };
}

function history(entries) {
    return {
        version: 1,
        parserVersion: 1,
        source: "jpx-daily-participant-volume-history",
        maxEntries: 30,
        entries
    };
}

function canonicalDays(entries) {
    const result = activity.buildCanonicalHistory(history(entries));
    assert.equal(result.status, entries.length ? "ready" : "empty");
    return result.days;
}

test("active revisionだけを抽出しold revisionを除外する", () => {
    const date = "2026-08-14";
    const old = completeSet(date, standardFiles(date, 9), "b");
    const days = canonicalDays([entry(date, standardFiles(date), "a", old)]);
    const summary = activity.createProductDailySummary(days[0], "mini");
    assert.equal(summary.disclosedVolumeTotal, 300);
    assert.equal(days.length, 1);
});

test("fileKeyからsessionとmarketTypeを導出する", () => {
    const days = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))]);
    const dimensions = Object.fromEntries(days[0].rows.map(item => [item.fileKey, [item.session, item.marketType]]));
    assert.deepEqual(dimensions.dayAuction, ["day", "auction"]);
    assert.deepEqual(dimensions.dayJnet, ["day", "jnet"]);
    assert.deepEqual(dimensions.nightAuction, ["night", "auction"]);
    assert.deepEqual(dimensions.nightJnet, ["night", "jnet"]);
});

test("optionとmicroをcanonical activityから除外する", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    assert.equal(day.rows.some(item => item.productBucket === "option"), false);
    assert.equal(day.rows.some(item => item.productBucket === "micro"), false);
});

test("large mini TOPIXの商品別合計を算出する", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    assert.equal(activity.createProductDailySummary(day, "large").disclosedVolumeTotal, 25);
    assert.equal(activity.createProductDailySummary(day, "mini").disclosedVolumeTotal, 300);
    assert.equal(activity.createProductDailySummary(day, "topix").disclosedVolumeTotal, 30);
});

test("day night auction J-NETと件数を集計する", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    const summary = activity.createProductDailySummary(day, "mini");
    assert.equal(summary.dayVolume, 170);
    assert.equal(summary.nightVolume, 130);
    assert.equal(summary.auctionVolume, 270);
    assert.equal(summary.jnetVolume, 30);
    assert.equal(summary.participantCount, 3);
    assert.equal(summary.contractCount, 2);
});

test("night/day ratioと公表上位行J-NET ratioを算出する", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    const summary = activity.createProductDailySummary(day, "mini");
    assert.equal(summary.nightDayRatio, 130 / 170);
    assert.equal(summary.disclosedJnetRatio, 30 / 300);
});

test("ratioは分母0ならnull", () => {
    const date = "2026-08-14";
    const files = Object.fromEntries(Object.keys(activity.FILE_DIMENSIONS).map(key => [key, fileData(date)]));
    const summary = activity.createProductDailySummary(canonicalDays([entry(date, files)])[0], "mini");
    assert.equal(summary.nightDayRatio, null);
    assert.equal(summary.disclosedJnetRatio, null);
});

test("sessionまたはmarketType欠損時はratioを作らない", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    day.availableFileKeys = ["dayAuction", "nightAuction"];
    const summary = activity.createProductDailySummary(day, "mini");
    assert.equal(summary.dayVolume, null);
    assert.equal(summary.nightVolume, null);
    assert.equal(summary.disclosedJnetRatio, null);
});

test("previous saved entryと暦日差を選択する", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11")),
        entry("2026-08-14", standardFiles("2026-08-14", 2), "b")
    ]);
    const result = activity.compareProductObservations(days[0], days[1], "mini");
    assert.equal(result.previousSourceDate, "2026-08-11");
    assert.equal(result.currentSourceDate, "2026-08-14");
    assert.equal(result.dayGap, 3);
    assert.equal(result.comparisonKind, "previous_saved_entry");
    assert.equal(result.absoluteChange, 300);
    assert.equal(result.percentChange, 100);
});

test("parserVersion差をcomparison metadataへ保持する", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11")),
        entry("2026-08-14", standardFiles("2026-08-14"), "b")
    ]);
    days[0].parserVersion = 0;
    const result = activity.compareProductObservations(days[0], days[1], "mini");
    assert.equal(result.sameParserVersion, false);
    assert.equal(result.warnings.includes("parser_version_changed"), true);
});

test("previous 0ではpercent changeをnullにする", () => {
    const previousDate = "2026-08-11";
    const emptyFiles = Object.fromEntries(Object.keys(activity.FILE_DIMENSIONS).map(key => [key, fileData(previousDate)]));
    const days = canonicalDays([
        entry(previousDate, emptyFiles),
        entry("2026-08-14", standardFiles("2026-08-14"), "b")
    ]);
    assert.equal(activity.compareProductObservations(days[0], days[1], "mini").percentChange, null);
});

test("1日だけなら前回比較なし", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    assert.equal(activity.compareProductObservations(null, day, "mini").available, false);
});

test("欠損日を0補完せずsourceDateだけ系列化する", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11")),
        entry("2026-08-14", standardFiles("2026-08-14"), "b")
    ]);
    assert.deepEqual(activity.createProductTimeSeries(days, "mini").map(item => item.sourceDate), [
        "2026-08-11", "2026-08-14"
    ]);
});

test("participantCodeで会社系列を統合し最新名称を使う", () => {
    const firstDate = "2026-08-11";
    const secondDate = "2026-08-14";
    const firstFiles = standardFiles(firstDate);
    const secondFiles = standardFiles(secondDate);
    for (const file of Object.values(secondFiles)) {
        for (const item of file.mini.records) {
            if (item.participantCode === "001") {
                item.company = "会社A新名称";
                item.companyEnglish = "Broker A New";
            }
        }
    }
    const series = activity.createCompanySeries(canonicalDays([
        entry(firstDate, firstFiles), entry(secondDate, secondFiles, "b")
    ]), "mini");
    const companyA = series.find(item => item.participantCode === "001");
    assert.equal(companyA.points.length, 2);
    assert.equal(companyA.company, "会社A新名称");
    assert.equal(series.some(item => item.participantCode === "002"), true);
});

test("会社系列をsession marketType contractで絞り込める", () => {
    const days = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))]);
    const series = activity.createCompanySeries(days, "mini", {
        session: "day", marketType: "jnet", contractCode: "M1"
    });
    assert.equal(series.length, 1);
    assert.equal(series[0].points[0].disclosedVolume, 20);
});

test("上位会社はrankでなく会社合算volumeで選ぶ", () => {
    const day = canonicalDays([entry("2026-08-14", standardFiles("2026-08-14"))])[0];
    const top = activity.getTopParticipants(day, "mini", 3);
    assert.deepEqual(top.map(item => item.participantCode), ["001", "002", "003"]);
    assert.equal(top[0].disclosedVolume, 200);
});

test("top participant retentionとturnoverを算出する", () => {
    const firstDate = "2026-08-11";
    const secondDate = "2026-08-14";
    const secondFiles = standardFiles(secondDate);
    for (const file of Object.values(secondFiles)) {
        for (const item of file.mini.records) {
            if (item.participantCode === "003") item.participantCode = "004";
        }
    }
    const days = canonicalDays([
        entry(firstDate, standardFiles(firstDate)),
        entry(secondDate, secondFiles, "b")
    ]);
    const result = activity.compareTopParticipants(days[0], days[1], "mini", 3);
    assert.equal(result.retainedCount, 2);
    assert.equal(result.topNRetentionRate, 2 / 3);
    assert.equal(result.topNTurnoverCount, 1);
});

test("公表上位層内top5 concentrationを算出しtotal 0ならnull", () => {
    const date = "2026-08-14";
    const day = canonicalDays([entry(date, standardFiles(date))])[0];
    assert.equal(activity.getDisclosedTopNConcentration(day, "mini", 2), 260 / 300);
    const emptyFiles = Object.fromEntries(Object.keys(activity.FILE_DIMENSIONS).map(key => [key, fileData(date)]));
    const emptyDay = canonicalDays([entry(date, emptyFiles)])[0];
    assert.equal(activity.getDisclosedTopNConcentration(emptyDay, "mini", 5), null);
});

test("contract集合一致ならwarningなし", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11")),
        entry("2026-08-14", standardFiles("2026-08-14", 2), "b")
    ]);
    const result = activity.compareProductObservations(days[0], days[1], "mini");
    assert.equal(result.contractCompositionChanged, false);
    assert.deepEqual(result.warnings, []);
});

test("contract追加を検出し共通限月だけ比較する", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11", 1, ["M1", "M1"])),
        entry("2026-08-14", standardFiles("2026-08-14", 2, ["M1", "M2"]), "b")
    ]);
    const result = activity.compareProductObservations(days[0], days[1], "mini");
    assert.equal(result.contractCompositionChanged, true);
    assert.deepEqual(result.commonContractCodes, ["M1"]);
    assert.equal(result.warnings.includes("contract_composition_changed"), true);
    assert.equal(result.sameContractDisclosedVolumePrevious, 300);
    assert.equal(result.sameContractDisclosedVolumeCurrent, 520);
});

test("contract消滅を検出する", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11", 1, ["M1", "M2"])),
        entry("2026-08-14", standardFiles("2026-08-14", 1, ["M1", "M1"]), "b")
    ]);
    assert.equal(activity.compareProductObservations(days[0], days[1], "mini").contractCompositionChanged, true);
});

test("contract別seriesは存在日だけを返す", () => {
    const days = canonicalDays([
        entry("2026-08-11", standardFiles("2026-08-11", 1, ["M1", "M1"])),
        entry("2026-08-14", standardFiles("2026-08-14", 1, ["M1", "M2"]), "b")
    ]);
    const series = activity.createContractSeries(days, "mini", "M2");
    assert.deepEqual(series.map(item => item.sourceDate), ["2026-08-14"]);
    assert.equal(series[0].disclosedVolume, 40);
});

test("historyをsourceDate昇順へ正規化する", () => {
    const days = canonicalDays([
        entry("2026-08-14", standardFiles("2026-08-14"), "b"),
        entry("2026-08-11", standardFiles("2026-08-11"))
    ]);
    assert.deepEqual(days.map(item => item.sourceDate), ["2026-08-11", "2026-08-14"]);
});

test("invalid historyを拒否する", () => {
    assert.equal(activity.buildCanonicalHistory({ version: 99 }).status, "invalid");
    const broken = history([entry("2026-08-14", standardFiles("2026-08-14"))]);
    broken.entries[0].activeVersionKey = "missing";
    assert.equal(activity.buildCanonicalHistory(broken).status, "invalid");
});

test("empty one-entry two-entry view modelを区別する", () => {
    assert.equal(activity.createActivityViewModel(history([]), "mini").status, "empty");
    assert.equal(activity.createActivityViewModel(history([
        entry("2026-08-11", standardFiles("2026-08-11"))
    ]), "mini").status, "one_entry");
    const ready = activity.createActivityViewModel(history([
        entry("2026-08-11", standardFiles("2026-08-11")),
        entry("2026-08-14", standardFiles("2026-08-14"), "b")
    ]), "mini");
    assert.equal(ready.status, "ready");
    assert.equal(ready.comparison.comparisonKind, "previous_saved_entry");
});

test("view modelは方向を示さないwarningとcontract warningを持つ", () => {
    const result = activity.createActivityViewModel(history([
        entry("2026-08-11", standardFiles("2026-08-11", 1, ["M1", "M1"])),
        entry("2026-08-14", standardFiles("2026-08-14", 1, ["M1", "M2"]), "b")
    ]), "mini");
    assert.equal(result.warnings.includes("activity_does_not_indicate_direction"), true);
    assert.equal(result.warnings.includes("contract_composition_changed"), true);
});

test("30 entriesをすべて系列化する", () => {
    const entries = Array.from({ length: 30 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
        return entry(date, standardFiles(date, index + 1), index % 2 ? "b" : "a");
    });
    const viewModel = activity.createActivityViewModel(history(entries), "mini");
    assert.equal(viewModel.entryCount, 30);
    assert.equal(viewModel.series.length, 30);
});
