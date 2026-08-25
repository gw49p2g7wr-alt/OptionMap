const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Qri = require("../js/qriOptions.js");
const Cache = require("../js/qriOptionsLastValidCache.js");
const Shadow = require("../js/qriOptionsBootRestoreShadow.js");

const KEY = "optionMapQriOptionsLastValidV1";
const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-25T06:10:00.000Z";

function row(strike, call = "100", put = "200") {
    const cells = Array(17).fill("－");
    cells[1] = call; cells[8] = strike; cells[15] = put;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}
function page(rows = row("65,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/25 05:50</dd>
        <div id="futuresContractTab"><li class="active"><a>9月限月</a></li></div>
        <dt>取引日</dt><dd>2026/08/25</dd><dt>取引最終日</dt><dd>2026/09/10</dd>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}
async function serialized() {
    const canonical = Qri.parseQriOptionsPage(page(
        row("65,000") + row("65,500", "110", "210")), URL);
    const formal = await Qri.createCacheV2(canonical, FETCHED_AT);
    const built = await Cache.buildQriOptionsLastValidCache({ channel: "active",
        mode: "auto", acquisitionOrigin: "live", isCurrent: true, available: true,
        sourceStatus: "acquired", status: "available", canonical,
        canonicalSignature: formal.signature, canonicalVersionKey: formal.versionKey,
        fetchedAt: FETCHED_AT, activeContract: canonical.contract,
        responseContract: canonical.contract, requestContext: { channel: "active",
            mode: "auto", acquisitionOrigin: "live", requestId: "qri-1",
            requestedContract: "auto", responseContract: canonical.contract } });
    assert.equal(built.success, true);
    return JSON.stringify(built.cache);
}
function storage(entries = []) {
    const values = new Map(entries); const calls = [];
    return { values, calls, getItem(key) { calls.push(key); return values.get(key) ?? null; } };
}

test("valid saved OI becomes a cache-origin display-only candidate", async () => {
    const result = await Shadow.buildQriOptionsBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]),
        context: { restoredAt: "2026-08-25T07:00:00Z" } });
    assert.deepEqual([result.status, result.candidate.origin, result.candidate.contract,
        result.candidate.recordCount, result.candidate.callPublishedCount,
        result.candidate.putPublishedCount, result.candidate.openInterestStatus],
    ["candidate", "cache", "2026-09", 4, 2, 2, "available"]);
    assert.deepEqual([result.freshness.origin, result.displayEligible,
        result.calculationEligible], ["cache", true, "undetermined"]);
});

test("missing malformed and tampered cache create no candidate", async () => {
    const valid = JSON.parse(await serialized());
    const inputs = [null, "{", JSON.stringify({ ...valid, signature: "0".repeat(64) })];
    for (const mutate of [value => { value.canonical.records[0].value += 1; },
        value => { value.canonicalSignature = "0".repeat(64); },
        value => { value.canonicalVersionKey += "x"; },
        value => { value.versionKey += "x"; }]) {
        const changed = structuredClone(valid); mutate(changed); inputs.push(JSON.stringify(changed));
    }
    for (const value of inputs) {
        const result = await Shadow.buildQriOptionsBootRestoreShadow({
            storage: storage(value === null ? [] : [[KEY, value]]) });
        assert.equal(result.candidate, null);
        assert.equal(["missing", "invalid"].includes(result.status), true);
    }
});

test("selected specific and non-live contexts are rejected by formal restore", async () => {
    const valid = JSON.parse(await serialized());
    for (const mutate of [value => { value.requestContext.channel = "selected"; },
        value => { value.requestContext.mode = "specific"; },
        value => { value.requestContext.acquisitionOrigin = "cache"; }]) {
        const changed = structuredClone(valid); mutate(changed);
        const result = await Shadow.buildQriOptionsBootRestoreShadow({
            storage: storage([[KEY, JSON.stringify(changed)]]) });
        assert.deepEqual([result.status, result.candidate], ["invalid", null]);
    }
});

test("partial unavailable and all-unpublished canonical fail the shadow availability policy", async () => {
    const source = JSON.parse(await serialized());
    for (const mutate of [canonical => { canonical.openInterestStatus = "partial"; },
        canonical => { canonical.openInterestStatus = "unavailable"; },
        canonical => canonical.records.forEach(record => { record.published = false; })]) {
        const canonical = structuredClone(source.canonical); mutate(canonical);
        assert.equal(Shadow.fullyAvailable(canonical), false);
    }
});

test("unknown contract and reference date remain deferred without inference", async () => {
    const result = await Shadow.buildQriOptionsBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]) });
    assert.deepEqual([result.diagnostics.activeContractContext,
        result.diagnostics.contractEvaluationDeferred,
        result.diagnostics.referenceDateEvaluationDeferred,
        result.diagnostics.activeContract], ["unknown", true, true, null]);
    assert.equal(result.candidate.contract, "2026-09");
});

test("known active contract is evaluated without changing cache identity", async () => {
    const result = await Shadow.buildQriOptionsBootRestoreShadow({
        storage: storage([[KEY, await serialized()]]), context: { activeContract: "2026-09" } });
    assert.deepEqual([result.diagnostics.contractMatches,
        result.diagnostics.contractEvaluationDeferred, result.candidate.origin],
    [true, false, "cache"]);
});

test("cache canonical records candidate and output are detached deeply frozen", async () => {
    const source = await serialized(); const parsed = JSON.parse(source);
    const result = await Shadow.buildQriOptionsBootRestoreShadow({
        storage: storage([[KEY, source]]) });
    assert.notStrictEqual(result.cache, parsed);
    assert.notStrictEqual(result.canonical, parsed.canonical);
    for (const value of [result, result.cache, result.canonical, result.canonical.records,
        result.canonical.records[0], result.candidate, result.freshness, result.diagnostics]) {
        assert.equal(Object.isFrozen(value), true);
    }
});

test("runtime initializes once and getter returns detached frozen snapshots", async () => {
    const runtime = Shadow.createQriOptionsBootRestoreShadowRuntime();
    const source = storage([[KEY, await serialized()]]);
    const first = runtime.initialize({ storage: source });
    assert.equal(first, runtime.initialize({ storage: source }));
    await first;
    const one = runtime.getState(); const two = runtime.getState();
    assert.deepEqual([source.calls.length, one.status, one.generation], [1, "candidate", 1]);
    assert.notStrictEqual(one, two); assert.equal(Object.isFrozen(one.canonical.records), true);
});

test("live supersede prevents a slow restore from rewinding generation", async () => {
    let release;
    const runtime = Shadow.createQriOptionsBootRestoreShadowRuntime({ build: () =>
        new Promise(resolve => { release = resolve; }) });
    const pending = runtime.initialize({ storage: storage() });
    const live = runtime.markLiveAcquisitionSuperseded({ requestId: "live-2",
        acquisitionIdentity: "identity", contract: "2026-09", fetchedAt: FETCHED_AT,
        canonicalSignature: "signature", canonicalVersionKey: "version",
        acquiredAt: FETCHED_AT });
    release({ status: "candidate", reason: null, candidate: { origin: "cache" },
        cache: {}, canonical: {}, freshness: {}, displayEligible: true,
        calculationEligible: "undetermined", restoredAt: null, diagnostics: {} });
    const completed = await pending;
    assert.deepEqual([live.status, live.reason, completed.status,
        runtime.getState().generation], ["superseded", "replaced_by_live", "superseded", 2]);
    assert.deepEqual([live.diagnostics.liveRequestId, live.diagnostics.liveContract,
        live.diagnostics.currentQriApplied, live.diagnostics.liveOverwriteAllowed],
    ["live-2", "2026-09", false, false]);
});

test("only the dedicated key is read and the input storage remains unchanged", async () => {
    const value = await serialized();
    const source = storage([[KEY, value], ["optionMapLastValidQriOpenInterest", "legacy"]]);
    const before = JSON.stringify([...source.values]);
    await Shadow.buildQriOptionsBootRestoreShadow({ storage: source });
    assert.deepEqual(source.calls, [KEY]);
    assert.equal(JSON.stringify([...source.values]), before);
});

test("module remains pure shadow-only", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsBootRestoreShadow.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|setItem|removeItem|indexedDB|\bfetch\s*\(|ipcRenderer/);
    assert.doesNotMatch(source, /optionMapLastValidQriOpenInterest|qriOptionsHistory/);
    assert.doesNotMatch(source, /document\.|querySelector|Chart|OverallV2|setTimeout|setInterval/);
});

test("renderer loads dependencies and starts boot shadow without awaiting initial fetch", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const ordered = ["js/qriOptions.js", "js/qriOptionsLastValidCache.js",
        "js/dataFreshness.js", "js/qriOptionsLastValidRestore.js",
        "js/storage/qriOptionsLastValidReadOnlyStore.js",
        "js/qriOptionsBootRestoreShadow.js"];
    const positions = ordered.map(item => html.indexOf(`<script src="${item}"></script>`));
    assert.equal(positions.every(position => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const initializeAt = html.indexOf("initializeQriOptionsBootRestoreShadow({");
    const initialRefreshAt = html.lastIndexOf(".finally(() => refreshAllMarketData())");
    assert.ok(initializeAt > 0 && initializeAt < initialRefreshAt);
    assert.match(html, /void qriOptionsBootRestoreShadowPromise;/);
    assert.doesNotMatch(html, /await qriOptionsBootRestoreShadowPromise/);
});

test("active auto live success supersedes shadow before unchanged save and legacy wiring", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const active = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("async function fetchParticipantData"));
    const historyAt = active.indexOf("persistQriOptionsHistory(");
    const supersedeAt = active.indexOf("markQriOptionsBootRestoreShadowSuperseded");
    const saveAt = active.indexOf("buildAndSaveQriOptionsLastValid(localStorage");
    const legacyAt = active.indexOf("window.saveLastValidQriOpenInterest({");
    assert.ok(historyAt >= 0 && historyAt < supersedeAt && supersedeAt < saveAt &&
        saveAt < legacyAt);
    const wiring = active.slice(historyAt, saveAt);
    for (const fact of ["openInterestStatus", "validateCanonical", "optionType === \"call\"",
        "optionType === \"put\"", "published === true", "isCurrentFetchRequest",
        "validateCacheV2", "requestId", "contract", "fetchedAt", "canonicalSignature",
        "canonicalVersionKey", "acquisitionIdentity"]) {
        assert.equal(wiring.includes(fact), true, fact);
    }
});

test("stale and specific paths cannot supersede active boot shadow", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const active = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("async function fetchParticipantData"));
    const supersedeAt = active.indexOf("markQriOptionsBootRestoreShadowSuperseded");
    const wiring = active.slice(active.indexOf("payload.canonicalV2?.openInterestStatus"),
        supersedeAt);
    assert.ok((wiring.match(/isCurrentFetchRequest\(source, activeRequestId\)/g) || [])
        .length >= 2);
    const specific = html.slice(html.indexOf("async function showSpecificQriContract"),
        html.indexOf("async function updateQriContractManifest"));
    assert.equal(specific.includes("markQriOptionsBootRestoreShadowSuperseded"), false);
});

test("display runtime wiring adds no storage history fetch or analysis connection", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const boot = html.slice(html.indexOf("const qriOptionsBootRestoreShadowPromise"),
        html.indexOf("let lastValidParticipantCache"));
    assert.doesNotMatch(boot, /setItem|removeItem|indexedDB|fetch\(|ipcRenderer|\bChart\b|OverallV2/);
    assert.doesNotMatch(boot, /currentQri|saveLastValidQriOpenInterest|persistQriOptionsHistory/);
    const active = html.slice(html.indexOf("markQriOptionsBootRestoreShadowSuperseded"),
        html.indexOf("buildAndSaveQriOptionsLastValid(localStorage"));
    assert.doesNotMatch(active, /setItem|removeItem|clear\(|indexedDB|render|Chart|OverallV2/);
});
