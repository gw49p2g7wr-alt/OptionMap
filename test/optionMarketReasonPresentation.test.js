const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../js/script.js"), "utf8");
const start = source.indexOf("function createReasonSemanticKey(");
const end = source.indexOf("function createAIComment(", start);
const context = {}; vm.createContext(context); vm.runInContext(`${source.slice(start, end)}\n` +
    "globalThis.presentation = { createReasonSemanticKey, groupDiagnosisReasons, " +
    "groupDiagnosisReasonsForPresentation, renderDiagnosisReasonPhrase, " +
    "renderDiagnosisPresentationGroup, createDiagnosisSentence };", context);
const Presentation = context.presentation;
const calculationStart = source.indexOf("function calculateOptionMarketJudgment(");
const calculationEnd = source.indexOf("function renderDifferenceRankings(", calculationStart);
const calculationContext = {}; vm.createContext(calculationContext);
vm.runInContext(`${source.slice(start, end)}\n${source.slice(calculationStart, calculationEnd)}\n` +
    "globalThis.calculateOptionMarketJudgment = calculateOptionMarketJudgment;", calculationContext);
const calculateOptionMarketJudgment = calculationContext.calculateOptionMarketJudgment;
const aiContext = {}; vm.createContext(aiContext);
vm.runInContext(`${source.slice(start, calculationStart)}\n` +
    "globalThis.createAIComment = createAIComment;", aiContext);
const createAIComment = aiContext.createAIComment;

const reason = (optionType, changeType, overrides = {}) => ({
    text: `${optionType} raw`, priority: 3, optionType, changeType,
    strike: 66250, diff: changeType === "increase" ? 800 : -800, distance: 500, ...overrides
});
const duplicate = (optionType, changeType) => [reason(optionType, changeType),
    reason(optionType, changeType, { priority: 5, distance: 50, text: "near raw" })];

for (const [optionType, changeType] of [["PUT", "decrease"], ["CALL", "decrease"],
    ["PUT", "increase"], ["CALL", "increase"]])
    test(`${optionType} ${changeType} semantic duplicate is displayed once`, () => {
        const sentence = Presentation.createDiagnosisSentence(duplicate(optionType, changeType), "やや強気");
        assert.equal((sentence.match(new RegExp(`${optionType}建玉`, "g")) || []).length, 1);
        assert.match(sentence, new RegExp(`現在値付近での${optionType}建玉の`));
    });

test("semantic key uses fact type, option type, change type and strike", () => {
    assert.equal(Presentation.createReasonSemanticKey(reason("PUT", "decrease")),
        "open_interest|PUT|decrease|66250");
});

test("different and contradictory facts remain separate", () => {
    for (const pair of [[reason("CALL", "increase"), reason("PUT", "decrease")],
        [reason("CALL", "decrease"), reason("PUT", "increase")],
        [reason("CALL", "increase"), reason("PUT", "increase")],
        [reason("PUT", "increase"), reason("PUT", "decrease")]])
        assert.equal(Presentation.groupDiagnosisReasons(pair).length, 2);
});

test("PUT increase and decrease become one mixed presentation group without losing facts", () => {
    const groups = Presentation.groupDiagnosisReasonsForPresentation([
        reason("PUT", "increase", { strike: 66375, diff: 900, distance: 175 }),
        reason("PUT", "decrease", { strike: 66125, diff: -6, distance: 75 })]);
    assert.deepEqual([groups.length, groups[0].mixed, groups[0].facts.length], [1, true, 2]);
    assert.equal(Presentation.renderDiagnosisPresentationGroup(groups[0]),
        "PUT建玉は価格帯によって増減が混在");
    assert.deepEqual(JSON.parse(JSON.stringify(groups[0].facts.map(item => [item.representative.strike,
        item.representative.diff, item.representative.distance]))), [[66375, 900, 175], [66125, -6, 75]]);
});

test("CALL increase and decrease become one symmetric mixed presentation group", () => {
    const groups = Presentation.groupDiagnosisReasonsForPresentation([
        reason("CALL", "increase"), reason("CALL", "decrease", { strike: 66500 })]);
    assert.deepEqual([groups.length, groups[0].optionType, groups[0].mixed,
        groups[0].facts.length], [1, "CALL", true, 2]);
});

for (const [name, facts, expected] of [
    ["CALL single plus PUT mixed", [reason("CALL", "increase"), reason("PUT", "increase"),
        reason("PUT", "decrease", { strike: 66500 })], ["CALL", "PUT"]],
    ["PUT single plus CALL mixed", [reason("PUT", "decrease"), reason("CALL", "increase"),
        reason("CALL", "decrease", { strike: 66500 })], ["PUT", "CALL"]],
    ["CALL and PUT both mixed", [reason("CALL", "increase"), reason("CALL", "decrease", { strike: 66500 }),
        reason("PUT", "increase"), reason("PUT", "decrease", { strike: 66500 })], ["CALL", "PUT"]]
]) test(name, () => {
    const groups = Presentation.groupDiagnosisReasonsForPresentation(facts);
    assert.deepEqual([...groups].map(group => group.optionType), expected);
    assert.equal(groups.filter(group => group.mixed).length, name.includes("both") ? 2 : 1);
});

test("mixed priority is the child maximum and firstIndex keeps ties deterministic", () => {
    const groups = Presentation.groupDiagnosisReasonsForPresentation([
        reason("PUT", "increase", { priority: 3 }), reason("CALL", "increase", { priority: 5 }),
        reason("PUT", "decrease", { priority: 5, strike: 66500 })]);
    assert.deepEqual(JSON.parse(JSON.stringify(groups.map(group =>
        [group.optionType, group.priority, group.firstIndex]))),
        [["PUT", 5, 0], ["CALL", 5, 1]]);
});

test("representative keeps the strongest priority and near-current evidence", () => {
    const grouped = Presentation.groupDiagnosisReasons(duplicate("PUT", "decrease"));
    assert.deepEqual([grouped.length, grouped[0].evidenceCount, grouped[0].representative.priority,
        grouped[0].representative.diff, grouped[0].representative.distance], [1, 2, 5, -800, 50]);
    assert.equal(Presentation.renderDiagnosisReasonPhrase(grouped[0].representative),
        "現在値付近でのPUT建玉の減少");
});

test("one, two and three facts form noun-phrase Japanese without broken suffixes", () => {
    const facts = [reason("CALL", "increase"), reason("PUT", "decrease", { strike: 66000 }),
        reason("CALL", "decrease", { strike: 66500 })];
    for (let count = 1; count <= 3; count += 1) {
        const sentence = Presentation.createDiagnosisSentence(facts.slice(0, count), "やや強気");
        assert.match(sentence, /建玉(?:の(?:大幅な)?(?:増加|減少)|は価格帯によって増減が混在)/);
        assert.doesNotMatch(sentence, /建玉が(?:増加|減少)が|が[^、。]*が確認|、。/);
        assert.match(sentence, /(?:が確認され、|全体として)上方向への意識がやや強まっています。$/);
    }
});

test("dedupe occurs before top three and preserves another useful fact", () => {
    const input = [...duplicate("PUT", "decrease"), reason("CALL", "increase", { priority: 4 }),
        reason("CALL", "decrease", { priority: 2, strike: 66500 })];
    const sentence = Presentation.createDiagnosisSentence(input, "中立");
    assert.match(sentence, /PUT建玉の減少/);
    assert.match(sentence, /CALL建玉は価格帯によって増減が混在/);
});

test("top-N is applied after option presentation grouping", () => {
    const facts = [reason("PUT", "increase", { priority: 5 }),
        reason("PUT", "decrease", { priority: 5, strike: 66500 }),
        reason("CALL", "increase", { priority: 4 }), "legacy A", "legacy B"];
    const sentence = Presentation.createDiagnosisSentence(facts, "中立");
    assert.match(sentence, /PUT建玉は価格帯によって増減が混在/);
    assert.match(sentence, /CALL建玉の大幅な増加/); assert.match(sentence, /legacy A/);
    assert.doesNotMatch(sentence, /legacy B/);
});

test("AI comment uses the same mixed groups and supplements both sides", () => {
    const bullish = [reason("CALL", "increase", { strike: 66000, diff: 2043, distance: 200 }),
        reason("PUT", "decrease", { strike: 66125, diff: -6, distance: 75 })];
    const bearish = [reason("PUT", "increase", { strike: 66375, diff: 900, distance: 175 })];
    const comment = createAIComment(bullish, bearish, "中立", null);
    assert.match(comment, /66,000円CALL/); assert.match(comment, /66,125円PUT/);
    assert.match(comment, /66,375円PUT/); assert.match(comment, /PUT建玉は価格帯によって増減が混在/);
    assert.doesNotMatch(comment, /上方向を意識|下方向への警戒/);
    assert.match(comment, /オプション需給は中立です/);
});

test("AI comment does not hide an opposing fact for bullish or bearish market levels", () => {
    const bullish = [reason("CALL", "increase", { strike: 66000, diff: 2043 }),
        reason("PUT", "decrease", { strike: 66125, diff: -6 })];
    const bearish = [reason("PUT", "increase", { strike: 66375, diff: 900 })];
    for (const level of ["強気", "弱気"]) {
        const comment = createAIComment(bullish, bearish, level, null);
        assert.match(comment, /66,125円PUT/); assert.match(comment, /66,375円PUT/);
        assert.match(comment, /PUT建玉は価格帯によって増減が混在/);
    }
});

test("priority ordering is deterministic and input is not mutated", () => {
    const input = [reason("PUT", "decrease", { priority: 3 }),
        reason("CALL", "increase", { priority: 5, distance: 10 })];
    const before = structuredClone(input);
    const first = Presentation.createDiagnosisSentence(input, "やや強気");
    assert.equal(first, Presentation.createDiagnosisSentence(input, "やや強気"));
    assert.ok(first.indexOf("CALL") < first.indexOf("PUT")); assert.deepEqual(input, before);
});

test("calculation candidates and judgment values remain unchanged by presentation dedupe", () => {
    const input = { nearbyCallIncrease: null, nearbyCallDecrease: null,
        nearbyPutIncrease: null, nearbyPutDecrease: { strike: 66250, diff: -1200 },
        currentPrice: 66200 }; const before = structuredClone(input);
    const judgment = calculateOptionMarketJudgment(input);
    assert.deepEqual(input, before);
    assert.deepEqual([judgment.bullishScore, judgment.bearishScore, judgment.scoreDifference,
        judgment.marketLevel, judgment.confidenceScore, judgment.confidence,
        judgment.available, judgment.marketIcon, judgment.bullishReasons.length],
    [4, 0, 4, "やや強気", 4, "★★★★☆", true, "🟢", 2]);
    assert.equal(judgment.diagnosisReason,
        "現在値付近でのPUT建玉の減少が確認され、上方向への意識がやや強まっています。");
});

test("mixed presentation leaves the complete neutral option judgment calculation invariant", () => {
    const input = { currentPrice: 66200,
        nearbyCallIncrease: { strike: 66000, diff: 2043 },
        nearbyCallDecrease: { strike: 66400, diff: -600 },
        nearbyPutIncrease: { strike: 66300, diff: 1200 },
        nearbyPutDecrease: { strike: 66125, diff: -6 } };
    const before = structuredClone(input); const judgment = calculateOptionMarketJudgment(input);
    assert.deepEqual(input, before);
    assert.deepEqual([judgment.bullishScore, judgment.bearishScore, judgment.scoreDifference,
        judgment.marketLevel, judgment.confidenceScore, judgment.confidence,
        judgment.available, judgment.marketIcon, judgment.reasons.selected.length],
    [6, 6, 0, "中立", 3, "★★★☆☆", true, "🟡", 8]);
    assert.equal(judgment.diagnosisReason,
        "CALL建玉とPUT建玉は価格帯によって増減が混在しており、方向感はまだ明確ではありません。");
});

test("presentation helper remains pure and disconnected from protected systems", () => {
    const helper = source.slice(start, end);
    assert.doesNotMatch(helper, /fetch\s*\(|localStorage|indexedDB|OverallV2|Morning|Mobile|Full Export|aiSummary/);
});
