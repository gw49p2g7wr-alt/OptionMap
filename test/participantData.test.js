const test = require("node:test");
const assert = require("node:assert/strict");

const participant = require("../js/participantData.js");

const header = date => [
    ["手口上位一覧"],
    [null, "取引日 Trading Date :", date]
];

const row = (product, participantCode = "00123", volume = 100) => [
    product,
    "161090018",
    `${product} CONTRACT`,
    1,
    participantCode,
    "テスト証券",
    "Test Securities",
    volume
];

test("商品コードを正しく分類し、NK225Eをmicroへ入れない", () => {
    const result = participant.parseParticipantExcel([
        ...header("20260814"),
        row("NK225F"),
        row("NK225MF"),
        row("TOPIXF"),
        row("NK225E"),
        row("UNKNOWN")
    ]);

    assert.equal(result.large.records.length, 1);
    assert.equal(result.mini.records.length, 1);
    assert.equal(result.topix.records.length, 1);
    assert.equal(result.micro.records.length, 0);
    assert.equal(result.option.records.length, 1);
});

test("participantCodeを文字列で保持し、volumeは第8列から読む", () => {
    const result = participant.parseParticipantExcel([
        ...header("20260814"),
        row("NK225F", "00123", 456)
    ]);
    const record = result.large.records[0];

    assert.equal(record.participantCode, "00123");
    assert.equal(record.volume, 456);
    assert.equal("reportedVolume" in record, false);
});

test("Excel取引日を取得し、ない場合だけURL対象日を使う", () => {
    const excelDate = participant.parseParticipantExcel(
        [...header("20260814"), row("NK225F")],
        "2026-08-13"
    );
    const fallbackDate = participant.parseParticipantExcel(
        [row("NK225F")],
        "2026-08-13"
    );

    assert.equal(excelDate.sourceDate, "2026-08-14");
    assert.equal(excelDate.sourceDateKind, "excel");
    assert.equal(fallbackDate.sourceDate, "2026-08-13");
    assert.equal(fallbackDate.sourceDateKind, "url_target");
});

for (const successCount of [4, 3, 2, 1, 0]) {
    test(`${successCount}/4成功の全体statusを導出する`, () => {
        const settled = participant.FILE_KEYS.map((key, index) =>
            index < successCount
                ? {
                    status: "fulfilled",
                    value: participant.parseParticipantExcel(
                        [...header("20260814"), row("NK225F")]
                    )
                }
                : { status: "rejected", reason: new Error(`${key} failed`) }
        );
        const result = participant.buildParticipantResult(
            settled,
            "2026-08-14"
        );
        const expected = successCount === 4
            ? "success"
            : successCount > 0
                ? "partial"
                : "failed";

        assert.equal(result.metadata.status, expected);
        assert.equal(result.metadata.successCount, successCount);
        assert.equal(
            Object.values(result.data).filter(Boolean).length,
            successCount
        );
    });
}

test("日付不一致ファイルはactiveデータへ混ぜない", () => {
    const settled = participant.FILE_KEYS.map((key, index) => ({
        status: "fulfilled",
        value: participant.parseParticipantExcel([
            ...header(index === 0 ? "20260813" : "20260814"),
            row("NK225F")
        ])
    }));
    const result = participant.buildParticipantResult(
        settled,
        "2026-08-14"
    );

    assert.equal(result.metadata.status, "partial");
    assert.equal(result.data.dayAuction, null);
    assert.match(result.metadata.errors.dayAuction, /取引日不一致/);
});

const sourceDate = "2026-08-14";
const sourceUrls = Object.freeze({
    dayAuction: "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202608/20260814_volume_by_participant_whole_day.xlsx",
    dayJnet: "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202608/20260814_volume_by_participant_whole_day_J-NET.xlsx",
    nightAuction: "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202608/20260814_volume_by_participant_night.xlsx",
    nightJnet: "https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/202608/20260814_volume_by_participant_night_J-NET.xlsx"
});

function completeData(date = sourceDate) {
    return Object.fromEntries(participant.FILE_KEYS.map((key, index) => [
        key,
        participant.parseParticipantExcel([
            ...header(date.replaceAll("-", "")),
            row("NK225F", `00${index + 1}`, 100 + index),
            row("NK225MF", `01${index + 1}`, 200 + index),
            row("TOPIXF", `02${index + 1}`, 300 + index),
            row("NK225E", `03${index + 1}`, 400 + index)
        ])
    ]));
}

async function validCache(overrides = {}) {
    const cache = await participant.createCompleteCache({
        data: completeData(),
        sourceUrls,
        sourceDate,
        fetchedAt: "2026-08-14T18:00:00+09:00"
    });
    return Object.assign(cache, overrides);
}

function clone(value) {
    return structuredClone(value);
}

test("4/4同日データから完全cacheを生成・検証できる", async () => {
    const cache = await validCache();

    assert.equal(cache.version, 1);
    assert.equal(cache.parserVersion, 1);
    assert.equal(cache.status, "complete");
    assert.match(cache.versionKey, /^participant-set\|2026-08-14\|sha256:/);
    assert.equal(await participant.validateParticipantCache(cache), true);
    assert.equal(
        (await participant.parseParticipantCache(JSON.stringify(cache)))
            .versionKey,
        cache.versionKey
    );
});

test("壊れたJSON cacheを例外なく無視する", async () => {
    assert.equal(await participant.parseParticipantCache("{broken"), null);
});

test("file署名はtop10や取得metadataに依存せずrankを含む", async () => {
    const data = completeData().dayAuction;
    const original = await participant.createFileSignature(data);
    const top10Changed = clone(data);
    top10Changed.large.top10 = [];
    const rankChanged = clone(data);
    rankChanged.large.records[0].rank = 2;

    assert.equal(await participant.createFileSignature(top10Changed), original);
    assert.notEqual(await participant.createFileSignature(rankChanged), original);
});

for (const [label, mutate] of [
    ["unknown cache version", cache => { cache.version = 99; }],
    ["unknown parserVersion", cache => { cache.parserVersion = 99; }],
    ["file signature改ざん", cache => { cache.files.dayAuction.signature = "0".repeat(64); }],
    ["set signature改ざん", cache => { cache.signature = "0".repeat(64); }],
    ["file versionKey改ざん", cache => { cache.files.dayAuction.versionKey += "x"; }],
    ["set versionKey改ざん", cache => { cache.versionKey += "x"; }],
    ["URL日付不一致", cache => { cache.files.dayAuction.sourceUrl = cache.files.dayAuction.sourceUrl.replace("20260814", "20260813"); }],
    ["participantCode型不正", cache => { cache.files.dayAuction.data.large.records[0].participantCode = 123; }],
    ["negative volume", cache => { cache.files.dayAuction.data.large.records[0].volume = -1; }],
    ["Infinity volume", cache => { cache.files.dayAuction.data.large.records[0].volume = Infinity; }],
    ["micro誤レコード", cache => { cache.files.dayAuction.data.micro.records.push(cache.files.dayAuction.data.large.records[0]); }]
]) {
    test(`${label}のcacheを拒否する`, async () => {
        const cache = clone(await validCache());
        mutate(cache);
        assert.equal(await participant.validateParticipantCache(cache), false);
    });
}

test("dangerous keyを含むcacheを拒否する", async () => {
    const cache = clone(await validCache());
    Object.defineProperty(cache.files.dayAuction.data, "__proto__", {
        value: { polluted: true },
        enumerable: true
    });
    assert.equal(await participant.validateParticipantCache(cache), false);
});

test("partialデータからcomplete cacheを生成しない", async () => {
    const data = completeData();
    data.dayJnet = null;
    const cache = await participant.createCompleteCache({
        data,
        sourceUrls,
        sourceDate,
        fetchedAt: "2026-08-14T18:00:00+09:00"
    });
    assert.equal(cache, null);
});

test("same/newer/older/revised/indeterminate版を判定する", async () => {
    const active = await validCache();
    const same = clone(active);
    const newer = clone(active);
    newer.sourceDate = "2026-08-15";
    const older = clone(active);
    older.sourceDate = "2026-08-13";
    const revised = clone(active);
    revised.signature = "f".repeat(64);

    assert.equal(participant.compareVersions(active, same).assessment, "same_version");
    assert.equal(participant.compareVersions(active, newer).assessment, "new_version");
    assert.equal(participant.compareVersions(active, older).assessment, "older_or_inconsistent");
    assert.equal(participant.compareVersions(active, revised, true).assessment, "revised_same_date");
    assert.equal(participant.compareVersions(active, revised, false).assessment, "indeterminate");
});

test("公式リンクを日付別にまとめて最新同日4リンクを選ぶ", () => {
    const older = Object.values(sourceUrls).map(url =>
        url.replaceAll("20260814", "20260813")
    );
    const result = participant.selectLatestParticipantListing([
        ...older,
        ...Object.values(sourceUrls)
    ]);

    assert.equal(result.sourceDate, sourceDate);
    assert.equal(result.complete, true);
    assert.deepEqual(result.urls, sourceUrls);
});

test("公式最新行のリンク欠損をpartial observationとして返す", () => {
    const result = participant.selectLatestParticipantListing(
        Object.values(sourceUrls).slice(0, 3)
    );
    assert.equal(result.sourceDate, sourceDate);
    assert.equal(result.complete, false);
    assert.equal(result.urls.nightJnet, undefined);
});

test("公式ページ相当リンクを解析できなければnullを返す", () => {
    assert.equal(
        participant.selectLatestParticipantListing([
            "https://example.com/file.xlsx",
            "not-a-participant-file"
        ]),
        null
    );
});
