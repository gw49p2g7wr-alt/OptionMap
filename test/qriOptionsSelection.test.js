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

const activeCanonical = { ...structuredClone(canonical),
    sourceUrl: manifest.availableContracts[0].url, contract: "2026-09", gengetsu: "202609",
    contractLabel: "9月限月", lastTradingDate: "2026-09-10",
    availableContracts: [
        { contract: "2026-09", label: "9月限月", url: manifest.availableContracts[0].url, active: true },
        { contract: null, label: "10月限月", url: manifest.availableContracts[1].url, active: false },
        { contract: null, label: "12月限月", url: manifest.availableContracts[2].url, active: false }
    ], records: canonical.records.map(record => ({ ...record, contract: "2026-09" })) };

test("active canonicalから推測なしのpartial manifestを生成する", () => {
    const partial = selection.createPartialManifest(activeCanonical);
    assert.equal(selection.validateManifest(partial), true);
    assert.deepEqual(partial.availableContracts.slice(1), [
        { contract: null, gengetsu: null, label: "10月限月",
            url: manifest.availableContracts[1].url, active: false, lastTradingDate: null,
            resolution: "unresolved", selectionKey: `url:${manifest.availableContracts[1].url}` },
        { contract: null, gengetsu: null, label: "12月限月",
            url: manifest.availableContracts[2].url, active: false, lastTradingDate: null,
            resolution: "unresolved", selectionKey: `url:${manifest.availableContracts[2].url}` }
    ]);
});

test("partial manifestのunresolved entryを内部URL key付き・未確認・選択可能で表示する", () => {
    const partial = selection.createPartialManifest(activeCanonical);
    const options = selection.createSelectOptions(partial);
    assert.deepEqual(options.map(item => item.value), ["auto", "2026-09",
        `url:${manifest.availableContracts[1].url}`, `url:${manifest.availableContracts[2].url}`]);
    assert.match(options[2].label, /10月限月（未確認）/);
    assert.equal(options[2].disabled, false);
    const state = selection.selectMode(selection.createState(), options[2].value, partial);
    assert.equal(state.mode, "unresolved"); assert.equal(state.error, "contract_unresolved");
});

test("unresolved選択まで取得せず、選択後の同一URL二重要求を1 Promiseへ集約する", async () => {
    const partial = selection.createPartialManifest(activeCanonical);
    const option = selection.createSelectOptions(partial)[2];
    let calls = 0; let complete;
    const load = () => { calls += 1; return new Promise(resolve => { complete = resolve; }); };
    assert.equal(calls, 0);
    const resolver = selection.createLazyManifestResolver();
    const input = { manifest: partial, selectionKey: option.value, load,
        validateCanonical: qri.validateCanonical };
    const first = resolver.resolve(input); const second = resolver.resolve(input);
    assert.equal(first, second); assert.equal(calls, 0);
    await Promise.resolve();
    assert.equal(calls, 1); assert.equal(resolver.pendingCount(), 1);
    complete({ canonical, payload: { marker: "display-only" } });
    const result = await first;
    assert.equal(resolver.pendingCount(), 0);
    assert.equal(result.manifest.defaultContract, "2026-09");
    const resolved = result.manifest.availableContracts.find(item => item.url === canonical.sourceUrl);
    assert.deepEqual(resolved, { contract: "2026-10", gengetsu: "202610", label: "10月限月",
        url: canonical.sourceUrl, active: false, lastTradingDate: "2026-10-08",
        resolution: "resolved", selectionKey: "2026-10" });
    assert.equal(selection.createSelectOptions(result.manifest)[2].label, "2026-10");
});

test("lazy resolveはsourceUrl・label・contract/gengetsu不整合を昇格させない", async () => {
    const variants = [
        value => { value.sourceUrl = manifest.availableContracts[2].url; },
        value => { value.contractLabel = "12月限月"; },
        value => { value.gengetsu = "202612"; },
        value => { value.contract = "2026-11"; }
    ];
    for (const mutate of variants) {
        const partial = selection.createPartialManifest(activeCanonical);
        const broken = structuredClone(canonical); mutate(broken);
        const resolver = selection.createLazyManifestResolver();
        await assert.rejects(resolver.resolve({ manifest: partial,
            selectionKey: partial.availableContracts[1].selectionKey,
            load: async () => ({ canonical: broken }), validateCanonical: qri.validateCanonical }));
        assert.equal(partial.availableContracts[1].contract, null);
        assert.equal(partial.defaultContract, "2026-09");
    }
});

test("unresolved entryの推測値・active化・URL key不一致を拒否する", () => {
    for (const mutate of [
        item => { item.contract = "2026-10"; }, item => { item.gengetsu = "202610"; },
        item => { item.lastTradingDate = "2026-10-08"; }, item => { item.active = true; },
        item => { item.selectionKey = "url:https://svc.qri.jp/guessed"; }
    ]) {
        const partial = selection.createPartialManifest(activeCanonical);
        mutate(partial.availableContracts[1]);
        assert.equal(selection.validateManifest(partial), false);
    }
});

test("partial manifest生成はcanonical・signature・cache v2を変更しない", async () => {
    const before = structuredClone(activeCanonical);
    const signature = await qri.createSignature(activeCanonical);
    selection.createPartialManifest(activeCanonical);
    assert.deepEqual(activeCanonical, before);
    assert.equal(await qri.createSignature(activeCanonical), signature);
    const cache = await qri.createCacheV2(activeCanonical, "2026-08-18T05:01:00+09:00");
    assert.equal(await qri.validateCacheV2(cache), true);
});

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
test("selection変更は進行中requestをinvalidateする", () => {
    const loading = selection.beginRequest(selection.selectMode(
        selection.createState(), "2026-10", manifest));
    const invalidated = selection.invalidateRequest(loading);
    assert.equal(invalidated.requestSequence, loading.requestSequence + 1);
    assert.equal(selection.finishRequest(invalidated, loading.requestSequence,
        { status: "ready" }).status, "stale_ignored");
});
test("fetch失敗とvalidation失敗を区別する", () => {
    const state = selection.beginRequest(selection.selectMode(selection.createState(), "2026-10", manifest));
    assert.equal(selection.finishRequest(state, state.requestSequence, { status: "fetch_failed" }).status,
        "fetch_failed");
    assert.equal(selection.finishRequest(state, state.requestSequence, { status: "validation_failed" }).status,
        "validation_failed");
});
