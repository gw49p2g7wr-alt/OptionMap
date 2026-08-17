const test = require("node:test");
const assert = require("node:assert/strict");
const selection = require("../js/qriOptionsSelection.js");
const qri = require("../js/qriOptions.js");

const manifest = { defaultContract: "2026-09", availableContracts: [
    { contract: "2026-09", label: "9月限月", url: "https://svc.qri.jp/jpx/nkopm/", active: true },
    { contract: "2026-10", label: "10月限月", url: "https://svc.qri.jp/jpx/nkopm/1", active: false },
    { contract: "2026-12", label: "12月限月", url: "https://svc.qri.jp/jpx/nkopm/2", active: false }
] };
const canonical = { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
    sourceUrl: manifest.availableContracts[1].url, pageUpdatedAt: "2026-08-18T05:00:00+09:00",
    tradingDate: "2026-08-18", openInterestAsOf: null, contract: "2026-10", gengetsu: "202610",
    contractLabel: "10月限月", isActiveContract: true, lastTradingDate: "2026-10-08",
    openInterestStatus: "partial", availableContracts: [
        { contract: null, label: "9月限月", url: manifest.availableContracts[0].url, active: false },
        { contract: "2026-10", label: "10月限月", url: manifest.availableContracts[1].url, active: true },
        { contract: null, label: "12月限月", url: manifest.availableContracts[2].url, active: false }
    ], records: [
        { contract: "2026-10", optionType: "call", strike: 70000, published: true, value: 0 },
        { contract: "2026-10", optionType: "put", strike: 70000, published: false, value: null }
    ] };

test("availableContractsだけからautoとspecific optionsを生成する", () => {
    assert.deepEqual(selection.createSelectOptions(manifest).map(item => item.value),
        ["auto", "2026-09", "2026-10", "2026-12"]);
    assert.match(selection.createSelectOptions(manifest)[0].label, /2026-09/);
});
test("autoとspecificを切り替え、掲載消失をunavailableにする", () => {
    const auto = selection.selectMode(selection.createState(), "auto", manifest);
    assert.equal(auto.displayedContract, "2026-09");
    const specific = selection.selectMode(auto, "2026-10", manifest);
    assert.equal(specific.mode, "specific"); assert.equal(specific.status, "loading");
    assert.equal(selection.selectMode(specific, "auto", manifest).mode, "auto");
    const missing = selection.selectMode(auto, "2026-11", manifest);
    assert.equal(missing.status, "unavailable"); assert.equal(missing.contract, "2026-11");
});
test("specificはmanifestの実URLとcanonical contract/gengetsuが一致する場合だけ採用", () => {
    const input = { requestedContract: "2026-10", requestedUrl: manifest.availableContracts[1].url,
        manifest, canonical, validateCanonical: qri.validateCanonical };
    assert.equal(selection.validateSpecificResult(input), true);
    assert.equal(selection.validateSpecificResult({ ...input, requestedUrl: "/guessed/1" }), false);
    assert.equal(selection.validateSpecificResult({ ...input, requestedContract: "2026-12" }), false);
    assert.equal(selection.validateSpecificResult({ ...input, canonical: { ...canonical, gengetsu: "202612" } }), false);
});
test("CALL/PUT contract不一致を拒否しcanonicalの非掲載を0へ変えない", () => {
    const broken = structuredClone(canonical); broken.records[1].contract = "2026-12";
    assert.equal(selection.validateSpecificResult({ requestedContract: "2026-10",
        requestedUrl: manifest.availableContracts[1].url, manifest, canonical: broken,
        validateCanonical: qri.validateCanonical }), false);
    const view = qri.createLegacyDisplayView(canonical);
    assert.equal(canonical.records[1].value, null); assert.equal(view.putOpenInterest[0], 0);
    assert.equal(view.legacyDisplayOnly, true);
});
test("specificではlegacy v1 fallbackを禁止しautoでは維持する", () => {
    assert.equal(selection.fallbackPolicy("auto").allowLegacyV1, true);
    assert.equal(selection.fallbackPolicy("specific").allowLegacyV1, false);
    assert.match(selection.fallbackPolicy("specific").unavailableMessage, /利用できません/);
});
test("sequence不一致の遅いresponseをstaleとして拒否する", () => {
    let state = selection.selectMode(selection.createState(), "2026-10", manifest);
    state = selection.beginRequest(state); const oldSequence = state.requestSequence;
    state = selection.selectMode(state, "2026-12", manifest); state = selection.beginRequest(state);
    const stale = selection.finishRequest(state, oldSequence, { status: "ready" });
    assert.equal(stale.status, "stale_ignored"); assert.equal(stale.contract, "2026-12");
    const ready = selection.finishRequest(state, state.requestSequence, { status: "ready" });
    assert.equal(ready.displayedContract, "2026-12");
});
test("fetch失敗とvalidation失敗を区別する", () => {
    const state = selection.beginRequest(selection.selectMode(selection.createState(), "2026-10", manifest));
    assert.equal(selection.finishRequest(state, state.requestSequence, { status: "fetch_failed" }).status,
        "fetch_failed");
    assert.equal(selection.finishRequest(state, state.requestSequence, { status: "validation_failed" }).status,
        "validation_failed");
});
