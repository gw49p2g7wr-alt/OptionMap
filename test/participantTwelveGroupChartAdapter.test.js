const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const weekly = require("../js/weeklyFutures.js");
const shadow = require("../js/weeklyFuturesTwelveGroupShadow.js");
const Adapter = require("../js/participantTwelveGroupChartAdapter.js");

const names = Object.fromEntries(shadow.GROUP_DEFINITIONS.flatMap(group =>
    group.members.map(member => [member.key, member])
));

function record(member, volume, patch = {}) {
    return {
        participantCode: member.participantCode,
        company: member.brokerName,
        volume,
        ...patch
    };
}

function snapshot(memberRecords = {}) {
    const file = key => ({ large: { records: memberRecords[key] || [] } });
    return {
        sourceDate: "2026-08-21T00:00:00.000Z",
        parsedDayData: {
            dayAuction: file("dayAuction"),
            dayJnet: file("dayJnet"),
            nightAuction: file("nightAuction"),
            nightJnet: file("nightJnet")
        }
    };
}

function completeSingle(member) {
    return snapshot({
        dayAuction: [record(member, 10)],
        dayJnet: [record(member, 3)],
        nightAuction: [record(member, 7)],
        nightJnet: [record(member, 2)]
    });
}

test("selectorは互換keyを保つ12 scoring group", () => {
    assert.deepEqual(Adapter.SELECTOR_DEFINITIONS.map(item => item.key), [
        "JPM", "GS", "NOMURA", "BNP", "ABN", "SG", "MORGAN_MUFG",
        "SBI_RAKUTEN", "MITSUBISHI_UFJ", "DAIWA", "CITI", "BARCLAYS"
    ]);
    assert.deepEqual(Adapter.SELECTOR_DEFINITIONS.map(item => item.displayName), [
        "JPM", "GS", "野村", "BNP", "ABN", "ソシエテG", "MorganMUFG",
        "SBI＋楽天", "三菱UFJ", "大和", "シティ", "バークレイズ"
    ]);
});

for (const key of ["JPM", "GS", "NOMURA", "BNP", "ABN"]) {
    test(`existing ${key}はlegacy Major5 pathを維持`, () => {
        assert.equal(Adapter.isExistingMajor5(key), true);
        assert.equal(Adapter.isAdditionalGroup(key), false);
        assert.equal(Adapter.createAdditionalSeries([], key).reason,
            "strict_additional_group_required");
    });
}

for (const key of [
    "SG", "MORGAN_MUFG", "MITSUBISHI_UFJ", "DAIWA", "CITI", "BARCLAYS"
]) {
    test(`${key}をstrict identityで日中・夜間集計`, () => {
        const member = names[key];
        const result = Adapter.createAdditionalSeries([completeSingle(member)], key);
        assert.equal(result.points[0].day, 13);
        assert.equal(result.points[0].night, 9);
        assert.equal(result.points[0].available, true);
    });
}

test("SBI＋楽天は両社をsessionごとに合算", () => {
    const result = Adapter.createAdditionalSeries([snapshot({
        dayAuction: [record(names.SBI, 10), record(names.RAKUTEN, 20)],
        dayJnet: [record(names.SBI, 1), record(names.RAKUTEN, 2)],
        nightAuction: [record(names.SBI, 7), record(names.RAKUTEN, 8)],
        nightJnet: [record(names.SBI, 3), record(names.RAKUTEN, 4)]
    })], "SBI_RAKUTEN");
    assert.equal(result.points[0].day, 33);
    assert.equal(result.points[0].night, 22);
});

for (const missing of ["SBI", "RAKUTEN"]) {
    test(`${missing} missingはcompositeを0補完しない`, () => {
        const other = missing === "SBI" ? names.RAKUTEN : names.SBI;
        const result = Adapter.createAdditionalSeries([completeSingle(other)],
            "SBI_RAKUTEN");
        assert.equal(result.points[0].day, null);
        assert.equal(result.points[0].night, null);
        assert.equal(result.points[0].available, false);
    });
}

test("auctionまたはJ-NET missingはsessionをnullにする", () => {
    const member = names.SG;
    const result = Adapter.createAdditionalSeries([snapshot({
        dayAuction: [record(member, 10)],
        nightAuction: [record(member, 7)],
        nightJnet: [record(member, 2)]
    })], "SG");
    assert.equal(result.points[0].day, null);
    assert.equal(result.points[0].night, 9);
});

test("name一致code不一致をreject", () => {
    const result = Adapter.resolveMember([
        record(names.SG, 10, { participantCode: "different" })
    ], names.SG);
    assert.equal(result.available, false);
    assert.equal(result.reason, "identity_mismatch");
});

test("code一致name不一致をreject", () => {
    const result = Adapter.resolveMember([
        record(names.SG, 10, { company: "別会社" })
    ], names.SG);
    assert.equal(result.available, false);
    assert.equal(result.reason, "identity_mismatch");
});

test("participantCode missingはlegacy fallbackせずreject", () => {
    const result = Adapter.resolveMember([
        record(names.SG, 10, { participantCode: undefined })
    ], names.SG);
    assert.equal(result.available, false);
    assert.equal(result.value, null);
    assert.equal(result.reason, "legacy_code_missing");
});

test("coverage diagnosticsはavailable/unavailable/identity未検証を分離", () => {
    const valid = completeSingle(names.SG);
    const legacy = completeSingle(names.SG);
    legacy.parsedDayData.dayAuction.large.records[0].participantCode = undefined;
    const result = Adapter.createAdditionalSeries([valid, legacy], "SG");
    assert.deepEqual(result.diagnostics, {
        availableDays: 1,
        unavailableDays: 1,
        identityUnverifiedDays: 1
    });
});

function weeklyData(value) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ["1", "2026年09月限月", null, null, null,
            names.SG.participantCode, names.SG.brokerName, value]
    ]);
}

test("追加group classificationは既存calculateGroup semanticsを再利用", () => {
    const intervals = Adapter.createAdditionalClassificationHistory([
        { sourceDate: "2026-08-07", futureOpenInterest: weeklyData(100) },
        { sourceDate: "2026-08-14", futureOpenInterest: weeklyData(120) }
    ], "SG");
    assert.equal(intervals[0].available, true);
    assert.equal(intervals[0].status, "estimatedBuy");
    assert.equal(Adapter.classificationForDate("2026-08-10", intervals),
        "estimatedBuy");
});

test("Weekly pair外はclassificationを推測しない", () => {
    assert.equal(Adapter.classificationForDate("2026-08-01", []),
        "unconfirmed");
});

test("adapterはdeep frozen outputでinputを変更しない", () => {
    const input = completeSingle(names.SG);
    const before = structuredClone(input);
    const result = Adapter.createAdditionalSeries([input], "SG");
    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.points[0]), true);
});

test("chart wiringはMajor5分岐を保持し追加groupだけadapterを使用", () => {
    const source = fs.readFileSync("js/script.js", "utf8");
    assert.match(source, /additionalSeries\?\.points \|\|\s*createExistingMajor5Series/);
    assert.match(source, /isAdditionalGroup\?\.\(selectedBrokerKey\)/);
});

test("formal runtime・storage・fetch・migration・timerから隔離", () => {
    const source = fs.readFileSync(
        "js/participantTwelveGroupChartAdapter.js", "utf8"
    );
    assert.doesNotMatch(source,
        /localStorage|sessionStorage|indexedDB|setItem|fetch\s*\(|XMLHttpRequest/);
    assert.doesNotMatch(source,
        /publishWeeklyFormalIdentity|publishWeeklyFuturesTwelveGroupDualRun/);
    assert.doesNotMatch(source,
        /calculateOverallJudgmentV2|createWeeklyComponentInputV2/);
    assert.doesNotMatch(source, /migration|backfill|setTimeout|setInterval/);
});
