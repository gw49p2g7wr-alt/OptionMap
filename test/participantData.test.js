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
