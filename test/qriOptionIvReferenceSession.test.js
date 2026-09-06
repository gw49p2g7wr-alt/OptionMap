"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const ActiveRuntime = require("../js/qriOptionIvRuntime.js");
const Session = require("../js/qriOptionIvReferenceSession.js");
const ViewModel = require("../js/qriIvGraphViewModel.js");

const urlFor = contract => `https://svc.qri.jp/jpx/nkopm/${contract.replace("-", "")}`;
function htmlFor(contract, { tradingDate = "2026-09-07",
    updated = "2026/09/06 19:03", call = "20%", put = "21%" } = {}) {
    const rows = [60000, 61000, 64000, 64250, 64500, 65000, 65500, 66000,
        66500, 67000, 70000]
        .map((strike, index) => {
            const cells = Array(17).fill("-");
            cells[5] = index === 2 ? "bad" : index === 3 ? "-" : call;
            cells[8] = String(strike); cells[11] = index === 4 ? "" : put;
            return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
        }).join("");
    return `<dt>最終更新時刻</dt><dd>${updated}</dd>
        <dt>取引日</dt><dd>${tradingDate.replace(/-/g, "/")}</dd>
        <dt>取引最終日</dt><dd>2026/12/10</dd>
        <a href="?gengetsu=${contract.replace("-", "")}&amp;lang=ja">CSV</a>
        <table>${rows}</table>`;
}
function accepted(contract, overrides = {}) {
    const sourceUrl = urlFor(contract);
    const referenceVersionKey = `qri-options-v2|${contract}|version`;
    return { responseHtml: htmlFor(contract), targetContract: contract, sourceUrl,
        referenceStatus: "saved", referenceVersionKey,
        requestId: `${contract}-request`, parentMarketRefreshRequestId: "market-1",
        formalPublicationGeneration: 4, acquisitionGeneration: 1,
        fetchedAt: "2026-09-06T10:04:00.000Z", completedAt: "2026-09-06T10:05:00.000Z",
        referenceCache: { contract, sourceUrl, versionKey: referenceVersionKey },
        referenceCanonical: { contract, sourceUrl, tradingDate: "2026-09-07",
            pageUpdatedAt: "2026-09-06T19:03:00+09:00" }, ...overrides };
}

test("next and Major-SQ IV are retained by role and contract identity", async () => {
    const runtime = Session.createRuntime(); runtime.beginSession("market-1");
    const next = await runtime.publishAccepted("next", accepted("2026-10"));
    const major = await runtime.publishAccepted("major_sq", accepted("2026-12", {
        referenceStatus: "unchanged", requestId: "major-request", acquisitionGeneration: 2
    }));
    const state = runtime.getState();
    assert.deepEqual([next.published, major.published,
        state.sources.next.contract, state.sources.major_sq.contract],
    [true, true, "2026-10", "2026-12"]);
    assert.equal(Iv.validateCanonical(state.sources.next.canonical), true);
    assert.equal(Iv.validateCanonical(state.sources.major_sq.canonical), true);
    assert.notEqual(state.sources.next.versionKey, state.sources.major_sq.versionKey);
    assert.equal(state.sources.next.versionKey,
        await Iv.createVersionKey(state.sources.next.canonical));
    assert.equal(state.sources.next.signature,
        await Iv.createSignature(state.sources.next.canonical));
    assert.equal("currentPrice" in state.sources.next.referenceIdentity, false);
    assert.equal(Object.isFrozen(state.sources.next.canonical), true);
});

test("reference publication order cannot change role-to-contract identity", async () => {
    const runtime = Session.createRuntime(); runtime.beginSession("market-1");
    await runtime.publishAccepted("major_sq", accepted("2026-12", {
        requestId: "major-request", acquisitionGeneration: 2
    }));
    await runtime.publishAccepted("next", accepted("2026-10"));
    const state = runtime.getState();
    assert.deepEqual([state.sources.next.referenceIdentity.role,
        state.sources.next.contract, state.sources.major_sq.referenceIdentity.role,
        state.sources.major_sq.contract], ["next", "2026-10", "major_sq", "2026-12"]);
});

test("CALL/PUT status, nulls, invalid observations and existing ranges are reused", async () => {
    const runtime = Session.createRuntime(); runtime.beginSession("market-1");
    await runtime.publishAccepted("next", accepted("2026-10"));
    const canonical = runtime.getState().sources.next.canonical;
    assert.equal(canonical.records.some(record => record.iv.status === "missing" &&
        record.iv.value === null), true);
    assert.equal(canonical.records.some(record => record.iv.status === "invalid" &&
        record.iv.value === null), true);
    for (const [rangeMode, expected] of [["plus_minus_3000", [64000, 64500, 65000,
        65500, 66000, 66500, 67000]], ["plus_minus_5000", [61000, 64000, 64500,
        65000, 65500, 66000, 66500, 67000, 70000]], ["all", [60000, 61000,
        64000, 64500, 65000, 65500, 66000, 66500, 67000, 70000]]]) {
        const view = ViewModel.build({ canonical, rangeMode, currentPrice: 65500 });
        assert.deepEqual(view.labels, expected);
        assert.equal(view.series.call.values.includes(null), true);
        assert.equal(view.series.put.values.includes(null), true);
    }
});

test("reference and IV identity mismatches fail closed", async () => {
    const cases = [
        accepted("2026-10", { targetContract: "2026-11" }),
        accepted("2026-10", { sourceUrl: urlFor("2026-11") }),
        accepted("2026-10", { referenceCanonical: { contract: "2026-10",
            sourceUrl: urlFor("2026-10"), tradingDate: "2026-09-06",
            pageUpdatedAt: "2026-09-06T19:03:00+09:00" } }),
        accepted("2026-10", { referenceCanonical: { contract: "2026-10",
            sourceUrl: urlFor("2026-10"), tradingDate: "2026-09-07",
            pageUpdatedAt: "2026-09-06T18:00:00+09:00" } }),
        accepted("2026-10", { referenceVersionKey: null })
    ];
    for (const input of cases) {
        const runtime = Session.createRuntime(); runtime.beginSession("market-1");
        const result = await runtime.publishAccepted("next", input);
        assert.equal(result.published, false);
        assert.equal(runtime.getState().sources.next.available, false);
    }
});

test("failed, skipped and obsolete acquisitions cannot publish or fall back", async () => {
    for (const status of ["failed", "skipped", "stale"]) {
        const runtime = Session.createRuntime(); runtime.beginSession("market-1");
        const result = await runtime.publishAccepted("next", accepted("2026-10",
            { referenceStatus: status }));
        assert.deepEqual([result.published, runtime.getState().sources.next.available],
            [false, false]);
    }
    const runtime = Session.createRuntime(); runtime.beginSession("market-1");
    assert.equal((await runtime.publishAccepted("next", accepted("2026-10"),
        { isCurrent: () => false })).reason, "stale_request");
    runtime.beginSession("market-2");
    assert.equal((await runtime.publishAccepted("major_sq", accepted("2026-12"))).reason,
        "stale_request");
    assert.equal(runtime.getState().sources.major_sq.available, false);
});

test("active IV stays separate and a new runtime has no reference restoration", async () => {
    const activeCanonical = Iv.parseQriOptionIvPage(htmlFor("2026-09"), urlFor("2026-09"));
    const activeCandidate = await ActiveRuntime.createCandidate({ canonical: activeCanonical,
        fetchedAt: "2026-09-06T10:03:00.000Z", requestContext: { mode: "auto" } });
    const active = ActiveRuntime.adopt(ActiveRuntime.createState(), "active", activeCandidate,
        { isCurrent: true, activeContract: "2026-09", responseContract: "2026-09" }).state;
    const before = JSON.stringify(active);
    const session = Session.createRuntime(); session.beginSession("market-1");
    await session.publishAccepted("next", accepted("2026-10"));
    await session.publishAccepted("major_sq", accepted("2026-12"));
    assert.equal(JSON.stringify(active), before);
    assert.equal(active.selected, null);
    const afterReload = Session.createRuntime().getState();
    assert.deepEqual([afterReload.sources.next.available,
        afterReload.sources.major_sq.available], [false, false]);
});

test("module and renderer remain session-only with no fetch, storage or authority wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionIvReferenceSession.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|indexedDB|History|OverallV2|Morning|Mobile|\bfetch\s*\(/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /id="qriIvContractSwitch"/);
    assert.match(html, /qriIvContractSelection/);
    const acquisition = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsReferenceAcquisition.js"), "utf8") +
        fs.readFileSync(path.join(__dirname,
            "../js/qriOptionsMajorSqAcquisition.js"), "utf8");
    assert.match(acquisition, /responseHtml: raw/);
    assert.match(html, /共通原資産基準・表示範囲のみ/);
    assert.equal((html.match(/id="qriIvChart"/g) || []).length, 1);
});
