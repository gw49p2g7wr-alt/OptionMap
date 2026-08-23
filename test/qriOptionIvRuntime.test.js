const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const QriV2 = require("../js/qriOptions.js");
const Runtime = require("../js/qriOptionIvRuntime.js");
const View = require("../js/qriIvGraphViewModel.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";
const FETCHED_AT = "2026-08-24T07:00:00.000Z";

function row(strike, callIv = "20%", putIv = "21%") {
    const cells = Array(17).fill("-");
    cells[5] = callIv; cells[8] = strike; cells[11] = putIv;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(rows = row("40,000")) {
    return `<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
        <dt>取引日</dt><dd>2026/08/24</dd>
        <dt>取引最終日</dt><dd>2026/09/10</dd>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}

async function candidate(html = page(), context = { mode: "auto", requestId: "qri-1" }) {
    return Runtime.createCandidate({ canonical: Iv.parseQriOptionIvPage(html, URL),
        fetchedAt: FETCHED_AT, requestContext: context });
}

test("active HTML produces validated runtime canonical, signature and versionKey", async () => {
    const item = await candidate();
    assert.equal(item.available, true);
    assert.equal(item.contract, "2026-09");
    assert.equal(Iv.validateCanonical(item.canonical), true);
    assert.equal(item.signature, await Iv.createSignature(item.canonical));
    assert.equal(item.versionKey, await Iv.createVersionKey(item.canonical));
    assert.equal(item.fetchedAt, FETCHED_AT);
    assert.equal("fetchedAt" in item.canonical, false);
    assert.equal("currentPrice" in item, false);
    assert.equal("currentPrice" in item.canonical, false);
});

test("all missing IV remains a successful acquisition", async () => {
    const item = await candidate(page(row("40,000", "-", "") + row("40,500", "-", "-")));
    assert.equal(item.available, true);
    assert.equal(item.sourceStatus, "acquired");
    assert.equal(item.canonical.records.every(record => record.iv.status === "missing"), true);
});

test("source, parser and canonical failures stay isolated and distinct", async () => {
    assert.equal((await Runtime.createCandidate({ sourceAvailable: false,
        error: "offline" })).reason, "source_unavailable");
    assert.equal((await Runtime.createCandidate({ parserError: "bad row" })).reason,
        "parser_error");
    const invalid = Iv.parseQriOptionIvPage(page(), URL); invalid.schemaVersion = 99;
    assert.equal((await Runtime.createCandidate({ canonical: invalid })).reason,
        "canonical_invalid");
});

test("active and selected slots remain independent", async () => {
    let state = Runtime.createState();
    const active = await candidate();
    state = Runtime.adopt(state, "active", active, { isCurrent: true,
        responseContract: "2026-09", activeContract: "2026-09" }).state;
    const selected = await candidate(page(), { mode: "specific", sequence: 3,
        requestedContract: "2026-09" });
    state = Runtime.adopt(state, "selected", selected, { isCurrent: true,
        requestedContract: "2026-09", selectedContract: "2026-09",
        responseContract: "2026-09" }).state;
    assert.equal(state.active.requestContext.mode, "auto");
    assert.equal(state.selected.requestContext.mode, "specific");
    assert.notStrictEqual(state.active, state.selected);
});

test("stale and mismatched requests cannot overwrite current state", async () => {
    const original = Runtime.adopt(Runtime.createState(), "active", await candidate(), {
        isCurrent: true, responseContract: "2026-09", activeContract: "2026-09"
    }).state;
    const old = await candidate(page(), { mode: "specific", sequence: 1,
        requestedContract: "2026-09" });
    for (const guard of [
        { isCurrent: false, requestedContract: "2026-09", selectedContract: "2026-09",
            responseContract: "2026-09" },
        { isCurrent: true, requestedContract: "2026-09", selectedContract: "2026-10",
            responseContract: "2026-09" },
        { isCurrent: true, requestedContract: "2026-09", selectedContract: "2026-09",
            responseContract: "2026-10" }
    ]) {
        const result = Runtime.adopt(original, "selected", old, guard);
        assert.equal(result.status, "stale_ignored");
        assert.strictEqual(result.state, original);
    }
});

test("runtime canonical is a manual graph view-model input only", async () => {
    const item = await candidate(page(row("39,500") + row("40,000")));
    const view = View.build({ canonical: item.canonical,
        rangeMode: "plus_minus_3000", currentPrice: 40000 });
    assert.equal(view.available, true);
    assert.deepEqual(view.labels, [39500, 40000]);
});

test("same HTML leaves existing QRI v2 canonical and signature unchanged", async () => {
    const html = fs.readFileSync(path.join(__dirname, "../data/sample2026_07_23-2.html"), "utf8");
    const v2 = QriV2.parseQriOptionsPage(html, `${URL}1`);
    const before = await QriV2.createSignature(v2);
    await Runtime.createCandidate({ canonical: Iv.parseQriOptionIvPage(html, `${URL}1`),
        fetchedAt: FETCHED_AT });
    assert.equal(await QriV2.createSignature(v2), before);
});

test("runtime module has no fetch, storage, history, OverallV2, DOM or Chart connection", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/qriOptionIvRuntime.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|ipcRenderer|fetch\s*\(|History|OverallV2/);
    assert.doesNotMatch(source, /document\.|querySelector|createElement|new\s+Chart/);
});

test("renderer reuses one payload HTML, loads dependencies in order and adds no IV fetch", () => {
    const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const scriptOrder = ["js/qriOptions.js", "js/qriOptionIv.js",
        "js/qriIvGraphViewModel.js", "js/qriOptionIvRuntime.js", "js/qriIvGraphView.js",
        "js/qriOptionsSelection.js"].map(name => index.indexOf(`src="${name}"`));
    assert.equal(scriptOrder.every((position, i) => position >= 0 &&
        (i === 0 || position > scriptOrder[i - 1])), true);
    const payload = index.slice(index.indexOf("function createQriPayload"),
        index.indexOf("function validateQriPayload"));
    assert.match(payload, /parseQriOptionsPage\(\s*html, sourceUrl/);
    assert.match(payload, /parseQriOptionIvPage\(\s*html, sourceUrl/);
    const active = index.slice(index.indexOf("async function fetchQriData"),
        index.indexOf("async function fetchParticipantData"));
    assert.equal((active.match(/ipcRenderer\.invoke\(/g) || []).length, 1);
    assert.match(index, /id="qriIvCurvePanel"/);
});
