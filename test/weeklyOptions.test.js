const test = require("node:test");
const assert = require("node:assert/strict");
const weekly = require("../js/weeklyOptions.js");

const BLOCK_STARTS = [10, 25, 40, 55, 70];

function fixture({ sourceDate = "2026-08-07", expiry = "2026-08" } = {}) {
    const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
    const [year, month, day] = sourceDate.split("-");
    const [expiryYear, expiryMonth] = expiry.split("-");
    rows[0][0] = weekly.SOURCE_TITLE;
    rows[1][0] = `（ ${year}年${month}月${day}日現在 ）`;
    rows[2][0] = `${year}年${month}月10日`;
    rows[6][1] = `プット（${expiryYear}年${expiryMonth}月限月）`;
    rows[6][11] = `コール（${expiryYear}年${expiryMonth}月限月）`;

    BLOCK_STARTS.forEach((start, blockIndex) => {
        const strike = 65375 + blockIndex * 125;
        rows[start - 1][1] = strike;
        rows[start - 1][11] = strike;
        for (let index = 0; index < 15; index += 1) {
            rows[start - 1 + index][0] = index + 1;
            rows[start - 1 + index][10] = index + 1;
        }
    });
    return rows;
}

function setSide(rows, {
    optionType, block = 1, rank = 1, side,
    code, broker, value
}) {
    const base = optionType === "put" ? 1 : 11;
    const offset = side === "sell" ? 1 : 4;
    const row = rows[BLOCK_STARTS[block] - 1 + rank - 1];
    row[base + offset] = code;
    row[base + offset + 1] = broker;
    row[base + offset + 2] = value;
}

function populatedFixture(options) {
    const rows = fixture(options);
    setSide(rows, {
        optionType: "put", side: "sell", code: "12479",
        broker: "ＡＢＮクリアリン証券", value: 392
    });
    setSide(rows, {
        optionType: "put", side: "buy", code: "12800",
        broker: "モルガンＭＵＦＧ証券", value: 794
    });
    setSide(rows, {
        optionType: "call", side: "sell", code: "12800",
        broker: "モルガンＭＵＦＧ証券", value: 278
    });
    setSide(rows, {
        optionType: "call", side: "buy", code: "11746",
        broker: "ＵＢＳ証券", value: 250
    });
    return rows;
}

test("PUT/CALLとsell/buyをparticipantCode・会社名・数量ごとに保持する", () => {
    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    assert.deepEqual(data.records, [
        {
            product: "日経225オプション", optionType: "put",
            expiry: "2026-08", strike: 65500, rank: 1,
            participantCode: "12479", broker: "ＡＢＮクリアリン証券",
            side: "sell", published: true, value: 392
        },
        {
            product: "日経225オプション", optionType: "put",
            expiry: "2026-08", strike: 65500, rank: 1,
            participantCode: "12800", broker: "モルガンＭＵＦＧ証券",
            side: "buy", published: true, value: 794
        },
        {
            product: "日経225オプション", optionType: "call",
            expiry: "2026-08", strike: 65500, rank: 1,
            participantCode: "12800", broker: "モルガンＭＵＦＧ証券",
            side: "sell", published: true, value: 278
        },
        {
            product: "日経225オプション", optionType: "call",
            expiry: "2026-08", strike: 65500, rank: 1,
            participantCode: "11746", broker: "ＵＢＳ証券",
            side: "buy", published: true, value: 250
        }
    ]);
});

test("5 strike blockと結合strikeを順位15まで伝播する", () => {
    const rows = fixture();
    BLOCK_STARTS.forEach((_start, block) => {
        for (let rank = 1; rank <= 15; rank += 1) {
            setSide(rows, {
                optionType: "put", block, rank, side: "sell",
                code: String(10000 + block * 100 + rank),
                broker: `テスト証券${block}-${rank}`, value: rank
            });
        }
    });
    const data = weekly.parseWeeklyOptionsRows(rows);
    assert.equal(data.records.length, 75);
    assert.deepEqual(data.strikes.put, [65375, 65500, 65625, 65750, 65875]);
    assert.equal(data.records.find(record =>
        record.strike === 65875 && record.rank === 15
    ).value, 15);
});

test("正式headerから限月を抽出し週をまたぐ切替を保持する", () => {
    const july = weekly.parseWeeklyOptionsRows(populatedFixture({
        sourceDate: "2026-07-03", expiry: "2026-07"
    }));
    const august = weekly.parseWeeklyOptionsRows(populatedFixture({
        sourceDate: "2026-07-10", expiry: "2026-08"
    }));
    assert.deepEqual(july.optionExpiries, { put: "2026-07", call: "2026-07" });
    assert.deepEqual(august.optionExpiries, { put: "2026-08", call: "2026-08" });
});

test("非掲載はfalse/nullで照会し0へ変換しない", () => {
    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    assert.deepEqual(weekly.getObservation(data, {
        optionType: "put", strike: 65375,
        participantCode: "99999", side: "sell"
    }), { published: false, value: null });
});

test("明示数量0と不完全行を拒否する", () => {
    const zero = populatedFixture();
    setSide(zero, {
        optionType: "put", rank: 2, side: "sell",
        code: "10002", broker: "ゼロ証券", value: 0
    });
    assert.throws(() => weekly.parseWeeklyOptionsRows(zero), /不完全な公表行/);

    const incomplete = populatedFixture();
    setSide(incomplete, {
        optionType: "call", rank: 2, side: "buy",
        code: "10003", broker: null, value: 10
    });
    assert.throws(() => weekly.parseWeeklyOptionsRows(incomplete), /不完全な公表行/);
});

test("participantCodeを数値化せず文字列で保持する", () => {
    const rows = populatedFixture();
    setSide(rows, {
        optionType: "put", rank: 2, side: "sell",
        code: "00123", broker: "先頭ゼロ証券", value: 10
    });
    const data = weekly.parseWeeklyOptionsRows(rows);
    assert.equal(data.records.find(record => record.broker === "先頭ゼロ証券")
        .participantCode, "00123");
});

test("同一type・expiry・strike・code・sideの重複を拒否する", () => {
    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    const duplicate = {
        ...data.records[0],
        rank: 2
    };
    data.records.push(duplicate);
    assert.equal(weekly.validateWeeklyOptionsData(data), false);
});

test("signatureは順序非依存でrank/value変更を検出する", async () => {
    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    const reordered = structuredClone(data);
    reordered.records.reverse();
    assert.equal(await weekly.createSignature(data),
        await weekly.createSignature(reordered));

    const valueChanged = structuredClone(data);
    valueChanged.records[0].value += 1;
    assert.notEqual(await weekly.createSignature(data),
        await weekly.createSignature(valueChanged));

    const rankChanged = structuredClone(data);
    rankChanged.records[0].rank = 2;
    assert.notEqual(await weekly.createSignature(data),
        await weekly.createSignature(rankChanged));
});

test("cache v2とversionKeyを検証し旧cache v1を拒否する", async () => {
    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    const signature = await weekly.createSignature(data);
    const cache = {
        version: 2,
        parserVersion: 2,
        schemaVersion: 2,
        sourceDate: data.sourceDate,
        signature,
        versionKey: `weekly-options-v2|${data.sourceDate}|sha256:${signature}`,
        data
    };
    assert.equal(await weekly.validateVersionedCacheData(cache), true);
    assert.equal(await weekly.validateVersionedCacheData({
        ...cache, version: 1
    }), false);
    assert.equal(await weekly.validateVersionedCacheData({
        ...cache, versionKey: `weekly-options|${data.sourceDate}|sha256:${signature}`
    }), false);
});

test("source title・PUT/CALL header・canonical versionを検証する", () => {
    const badTitle = populatedFixture();
    badTitle[0][0] = "別商品";
    assert.throws(() => weekly.parseWeeklyOptionsRows(badTitle), /タイトル/);

    const badHeader = populatedFixture();
    badHeader[6][1] = "コール（2026年08月限月）";
    assert.throws(() => weekly.parseWeeklyOptionsRows(badHeader), /header/);

    const data = weekly.parseWeeklyOptionsRows(populatedFixture());
    assert.equal(weekly.validateWeeklyOptionsData({
        ...data, parserVersion: 1
    }), false);
    assert.equal(weekly.validateWeeklyOptionsData({
        ...data, schemaVersion: 1
    }), false);
});
