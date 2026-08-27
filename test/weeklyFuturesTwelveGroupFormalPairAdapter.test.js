const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const weekly = require("../js/weeklyFutures.js");
const config = require("../js/weeklyBrokerConfig.js");
const shadow = require("../js/weeklyFuturesTwelveGroupShadow.js");
const adapter = require(
    "../js/weeklyFuturesTwelveGroupFormalPairAdapter.js"
);

const PARTICIPANTS = [
    ...config.PARTICIPANTS,
    shadow.ADDITIONAL_PARTICIPANTS.SG,
    shadow.ADDITIONAL_PARTICIPANTS.MORGAN_MUFG,
    shadow.ADDITIONAL_PARTICIPANTS.SBI,
    shadow.ADDITIONAL_PARTICIPANTS.RAKUTEN,
    shadow.ADDITIONAL_PARTICIPANTS.MITSUBISHI_UFJ,
    shadow.ADDITIONAL_PARTICIPANTS.DAIWA,
    shadow.ADDITIONAL_PARTICIPANTS.CITI,
    shadow.ADDITIONAL_PARTICIPANTS.BARCLAYS
];

function data(values = {}) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...PARTICIPANTS.map(item => [
            "1", "2026年09月限月", null, null, null,
            item.participantCode, item.brokerName, values[item.key] ?? 100
        ])
    ]);
}

function sourceExpiry(expiry) {
    const [year, month] = expiry.split("-");
    return `${year}年${Number(month)}月限月`;
}

function remove(input, ...keys) {
    const codes = new Set(keys.map(key =>
        PARTICIPANTS.find(item => item.key === key).participantCode
    ));
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...input.records.filter(record =>
            !codes.has(record.participantCode)
        ).map(record => [
            "1", sourceExpiry(record.expiry), null, null, null,
            record.participantCode, record.broker, record.value
        ])
    ]);
}

function renameBroker(input, participantCode, nextName) {
    return weekly.parseWeeklyFuturesRows([
        ["＜日経225先物＞"],
        ...input.records.map(record => [
            "1", sourceExpiry(record.expiry), null, null, null,
            record.participantCode,
            record.participantCode === participantCode
                ? nextName : record.broker,
            record.value
        ])
    ]);
}

function revision(sourceDate, canonicalData) {
    const signature = crypto.createHash("sha256").update(JSON.stringify(
        weekly.normalizeForSignature(canonicalData)
    )).digest("hex");
    const versionKey = `weekly-futures-v2|${sourceDate}|sha256:${signature}`;
    return {
        sourceDate,
        versionKey,
        signature,
        activeVersionKey: versionKey,
        canonicalData
    };
}

function input(current = data(), previous = data()) {
    return {
        previous: revision("2026-08-07", previous),
        current: revision("2026-08-14", current),
        formalContext: {
            sourceClass: "formal_history",
            activeVersionMatched: true,
            requestId: "weekly-request-7",
            generation: 4,
            generationFingerprint: "weekly-generation-4"
        }
    };
}

function calculateDirectly(source) {
    return shadow.calculatePair({
        ...source.previous,
        futureOpenInterest: source.previous.canonicalData
    }, {
        ...source.current,
        futureOpenInterest: source.current.canonicalData
    });
}

test("valid verified pairを既存12-group計算へ渡す", async () => {
    const source = input(data({ SG: 125 }));
    const expected = calculateDirectly(source);
    const result = await adapter.adaptFormalPair(source);
    assert.equal(result.available, true);
    assert.equal(result.status, "available");
    assert.deepEqual(result.result, expected);
    assert.equal(result.diagnostics.inputBindingVerified, true);
});

for (const [name, mutate, reason] of [
    ["previous identity missing", value => { delete value.previous.versionKey; },
        "previous_identity_missing"],
    ["current identity missing", value => { delete value.current.sourceDate; },
        "current_identity_missing"],
    ["previous signature missing", value => { delete value.previous.signature; },
        "previous_signature_missing"],
    ["current signature missing", value => { delete value.current.signature; },
        "current_signature_missing"],
    ["previous activeVersion mismatch", value => {
        value.previous.activeVersionKey = "different";
    }, "previous_active_version_mismatch"],
    ["current activeVersion mismatch", value => {
        value.current.activeVersionKey = "different";
    }, "current_active_version_mismatch"],
    ["formal pair active mismatch", value => {
        value.formalContext.activeVersionMatched = false;
    }, "active_pair_mismatch"],
    ["formal_history以外", value => {
        value.formalContext.sourceClass = "cache";
    }, "formal_history_required"]
]) {
    test(`${name}はfail-closed`, async () => {
        const value = input();
        mutate(value);
        const result = await adapter.adaptFormalPair(value);
        assert.equal(result.available, false);
        assert.equal(result.reason, reason);
        assert.equal(result.result, null);
        assert.equal(result.diagnostics.calculationExecuted, false);
    });
}

test("sourceDate順序と同一versionをrejectする", async () => {
    const reversed = input();
    reversed.previous.sourceDate = "2026-08-15";
    assert.equal((await adapter.adaptFormalPair(reversed)).reason,
        "source_date_order_invalid");
    const same = input();
    same.current.versionKey = same.previous.versionKey;
    same.current.activeVersionKey = same.previous.versionKey;
    assert.equal((await adapter.adaptFormalPair(same)).reason,
        "distinct_versions_required");
});

test("canonical signatureとversionKeyの不一致をrejectする", async () => {
    const badSignature = input();
    badSignature.current.signature = "f".repeat(64);
    assert.equal((await adapter.adaptFormalPair(badSignature)).reason,
        "current_signature_mismatch");
    const badVersion = input();
    badVersion.current.versionKey = `${badVersion.current.versionKey}-changed`;
    badVersion.current.activeVersionKey = badVersion.current.versionKey;
    assert.equal((await adapter.adaptFormalPair(badVersion)).reason,
        "current_version_key_mismatch");
});

test("pair identityとrequest/generation contextを保持する", async () => {
    const source = input();
    const result = await adapter.adaptFormalPair(source);
    assert.deepEqual(result.pairIdentity.previous, {
        sourceDate: source.previous.sourceDate,
        versionKey: source.previous.versionKey,
        signature: source.previous.signature,
        activeVersionKey: source.previous.activeVersionKey
    });
    assert.deepEqual(result.formalContext, {
        sourceClass: "formal_history",
        requestId: "weekly-request-7",
        generation: 4,
        generationFingerprint: "weekly-generation-4"
    });
    assert.equal(result.diagnostics.major5PairComparable, true);
});

test("12/12・11/12・10/12・9/12とcore missing semanticsを維持する",
    async () => {
        const full = await adapter.adaptFormalPair(input());
        const elevenInput = input(remove(data(), "MITSUBISHI_UFJ"));
        assert.equal(await weekly.createSignature(
            elevenInput.current.canonicalData
        ), elevenInput.current.signature);
        const eleven = await adapter.adaptFormalPair(elevenInput);
        const ten = await adapter.adaptFormalPair(input(
            remove(data(), "MITSUBISHI_UFJ", "CITI")
        ));
        const nine = await adapter.adaptFormalPair(input(
            remove(data(), "MITSUBISHI_UFJ", "CITI", "BARCLAYS")
        ));
        const core = await adapter.adaptFormalPair(input(remove(data(), "JPM")));
        assert.ok(eleven.result, eleven.reason);
        assert.ok(ten.result, ten.reason);
        assert.ok(nine.result, nine.reason);
        assert.ok(core.result, core.reason);
        assert.equal(full.result.qualityState, "full");
        assert.equal(eleven.result.qualityState, "partial_one_missing");
        assert.equal(ten.result.qualityState, "partial_two_missing");
        assert.equal(nine.result.reason, "insufficient_group_count");
        assert.equal(core.result.reason, "core_group_missing");
    });

test("missingは0補完せず固定denominator 12を維持する", async () => {
    const result = await adapter.adaptFormalPair(input(
        remove(data({ SG: 124 }), "MITSUBISHI_UFJ", "CITI")
    ));
    assert.equal(result.result.availableGroupCount, 10);
    assert.equal(result.result.rawScoreDiff, 0.24);
    assert.ok(Math.abs(result.result.scaledScoreDiff - 0.1) < 1e-12);
    assert.equal(result.result.groups.MITSUBISHI_UFJ.contribution, null);
});

test("SBI＋楽天compositeは両方必要で合算後1回だけscoreする", async () => {
    const both = await adapter.adaptFormalPair(input(data({
        SBI: 110, RAKUTEN: 130
    }), data({ SBI: 100, RAKUTEN: 100 })));
    assert.equal(both.result.groups.SBI_RAKUTEN.contribution, 0.2);
    for (const missing of ["SBI", "RAKUTEN"]) {
        const result = await adapter.adaptFormalPair(input(
            remove(data(), missing)
        ));
        assert.equal(result.result.groups.SBI_RAKUTEN.availability, false);
        assert.equal(result.result.groups.SBI_RAKUTEN.contribution, null);
    }
});

test("三菱UFJ・MorganMUFGとcode/name strict identityを維持する", async () => {
    const result = await adapter.adaptFormalPair(input());
    assert.equal(result.result.groups.MITSUBISHI_UFJ.members[0].participantCode,
        "11520");
    assert.equal(result.result.groups.MITSUBISHI_UFJ.members[0].brokerName,
        "三菱ＵＦＪ証券");
    assert.equal(result.result.groups.MORGAN_MUFG.members[0].participantCode,
        "12800");
    assert.equal(result.result.groups.MORGAN_MUFG.members[0].brokerName,
        "モルガンＭＵＦＧ証券");
    const mismatched = renameBroker(data(), "11520", "三菱UFJ証券");
    const rejected = await adapter.adaptFormalPair(input(mismatched));
    assert.equal(rejected.result.groups.MITSUBISHI_UFJ.availability, false);
    assert.equal(rejected.result.groups.MITSUBISHI_UFJ.members[0].reason,
        "code_name_mismatch");
});

test("config fingerprintはkey順序に非依存でconfig/group順変更を検出する",
    async () => {
        const descriptor = adapter.configDescriptor();
        const reorderedKeys = Object.fromEntries(
            Object.entries(descriptor).reverse()
        );
        assert.equal(await adapter.createConfigFingerprint(descriptor),
            await adapter.createConfigFingerprint(reorderedKeys));
        const changed = structuredClone(descriptor);
        changed.minimumAvailableGroupCount = 9;
        assert.notEqual(await adapter.createConfigFingerprint(descriptor),
            await adapter.createConfigFingerprint(changed));
        const reorderedGroups = structuredClone(descriptor);
        reorderedGroups.groups.reverse();
        assert.notEqual(await adapter.createConfigFingerprint(descriptor),
            await adapter.createConfigFingerprint(reorderedGroups));
    });

test("config/scoring versionとshadow境界を固定する", async () => {
    const result = await adapter.adaptFormalPair(input());
    assert.equal(result.configIdentity.configVersion,
        "weekly-scoring-groups-v1");
    assert.equal(result.configIdentity.scoringVersion,
        "twelve-group-shadow-scoring-v1");
    assert.match(result.configIdentity.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.shadowOnly, true);
    assert.equal(result.referenceOnly, true);
    assert.equal(result.formalApplied, false);
    assert.equal(result.overallV2Eligible, false);
    assert.equal(result.diagnostics.qualityFactorDefined, false);
});

test("既存moduleのscore/direction/dominance/qualityStateと一致する", async () => {
    const source = input(data({ SG: 125, DAIWA: 115 }));
    const expected = calculateDirectly(source);
    const actual = (await adapter.adaptFormalPair(source)).result;
    for (const key of ["rawScoreDiff", "scaledScoreDiff",
        "normalizedDirection", "direction", "dominantGroup",
        "dominanceRatio", "qualityState"]) {
        assert.deepEqual(actual[key], expected[key]);
    }
});

test("outputはdeep frozenでinputを変更しない", async () => {
    const source = input(data({ SG: 125 }));
    const before = structuredClone(source);
    const result = await adapter.adaptFormalPair(source);
    assert.deepEqual(source, before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.result.groups.SBI_RAKUTEN.members), true);
    assert.equal(Object.isFrozen(result.pairIdentity.previous), true);
});

test("history/storage/fetch/DOM/OverallV2から隔離する", () => {
    const source = fs.readFileSync(require.resolve(
        "../js/weeklyFuturesTwelveGroupFormalPairAdapter.js"
    ), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|ipcRenderer/);
    assert.doesNotMatch(source, /document\.|querySelector|createElement/);
    assert.doesNotMatch(source,
        /OverallJudgmentV2|calculateOverallJudgmentV2|createWeeklyComponentInputV2/);
    assert.doesNotMatch(source,
        /getActiveVersions|selectLatest|analyzeHistory|mergeCandidates|backfill/i);
});
