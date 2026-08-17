const test = require("node:test");
const assert = require("node:assert/strict");
const QriOptions = require("../js/qriOptions.js");

const URLS = [
    "https://svc.qri.jp/jpx/nkopm/",
    "https://svc.qri.jp/jpx/nkopm/1",
    "https://svc.qri.jp/jpx/nkopm/2"
];
const CONTRACTS = ["2026-09", "2026-10", "2026-12"];
const LABELS = ["9月限月", "10月限月", "12月限月"];

function row(strike, callOpenInterest, putOpenInterest) {
    const cells = Array(17).fill("－");
    cells[1] = callOpenInterest;
    cells[8] = `${strike}<span>リスク指標</span>`;
    cells[15] = putOpenInterest;
    return `<tr class="odd row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(index = 0, values = [[40000, "1,234", "－"], [40500, "0", ""]]) {
    const contract = CONTRACTS[index];
    const gengetsu = contract.replace("-", "");
    const navigation = URLS.map((url, itemIndex) => {
        const active = itemIndex === index ? " class=\"active\"" : "";
        const href = itemIndex === index ? "javascript:void(0)" : url;
        return `<li${active}><a href="${href}">${LABELS[itemIndex]}</a></li>`;
    }).join("");
    return `<!doctype html><html><body>
        <div class="update-time"><dl><dt>最終更新時刻</dt><dd>2026/08/17 20:08</dd></dl></div>
        <div id="futuresContractTab"><ul>${navigation}</ul></div>
        <dl><dt>取引日</dt><dd>2026/08/18</dd></dl>
        <dl><dt>取引最終日</dt><dd>2026/${contract.slice(5)}/10</dd></dl>
        <a href="https://example.invalid/?type=nkopm&amp;gengetsu=${gengetsu}&amp;lang=ja">CSV</a>
        <table><tbody>${values.map(value => row(...value)).join("")}</tbody></table>
    </body></html>`;
}

test("QRI page parser keeps contract metadata and distinguishes zero from unpublished", () => {
    const parsed = QriOptions.parseQriOptionsPage(page(), URLS[0]);
    assert.equal(parsed.parserVersion, 2);
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.contract, "2026-09");
    assert.equal(parsed.gengetsu, "202609");
    assert.equal(parsed.contractLabel, "9月限月");
    assert.equal(parsed.pageUpdatedAt, "2026-08-17T20:08:00+09:00");
    assert.equal(parsed.tradingDate, "2026-08-18");
    assert.equal(parsed.openInterestAsOf, null);
    assert.equal(parsed.lastTradingDate, "2026-09-10");
    assert.equal(parsed.openInterestStatus, "partial");
    assert.deepEqual(parsed.records, [
        { contract: "2026-09", optionType: "call", strike: 40000, published: true, value: 1234 },
        { contract: "2026-09", optionType: "put", strike: 40000, published: false, value: null },
        { contract: "2026-09", optionType: "call", strike: 40500, published: true, value: 0 },
        { contract: "2026-09", optionType: "put", strike: 40500, published: false, value: null }
    ]);
    assert.deepEqual(parsed.availableContracts.map(item => item.url), URLS);
    assert.equal(QriOptions.validateCanonical(parsed, { allowUnresolvedContracts: true }), true);
});

test("blank and dash OI produce unavailable entry state without zero filling", () => {
    const parsed = QriOptions.parseQriOptionsPage(page(0, [[40000, "－", ""]]), URLS[0]);
    assert.equal(parsed.openInterestStatus, "unavailable");
    assert.equal(parsed.records.every(record => !record.published && record.value === null), true);
});

test("actual tab pages resolve a selectable manifest without guessed contracts", () => {
    const inputs = URLS.map((sourceUrl, index) => ({ sourceUrl, html: page(index) }));
    const bundle = QriOptions.parseQriOptionsBundle(inputs, URLS[0]);
    assert.equal(bundle.defaultContract, "2026-09");
    assert.deepEqual(bundle.availableContracts.map(item => item.contract), CONTRACTS);
    assert.equal(QriOptions.selectContractUrl(bundle, "2026-10"), URLS[1]);
    assert.equal(QriOptions.selectContractUrl(bundle, "2026-11"), null);
    assert.throws(() => QriOptions.parseQriOptionsBundle(inputs.slice(0, 2), URLS[0]),
        /contract_page_missing/);
    const swapped = structuredClone(inputs);
    [swapped[1].html, swapped[2].html] = [swapped[2].html, swapped[1].html];
    assert.throws(() => QriOptions.parseQriOptionsBundle(swapped, URLS[0]),
        /(contract_url_mismatch|qri_canonical_invalid)/);
});

test("invalid source, gengetsu, URL evidence mismatch, duplicate and record contract are rejected", () => {
    assert.throws(() => QriOptions.parseQriOptionsPage(page(), "https://example.com/jpx/nkopm/"),
        /invalid_qri_page/);
    assert.throws(() => QriOptions.parseQriOptionsPage(page().replace("202609", "202613"), URLS[0]),
        /qri_metadata_invalid/);
    assert.throws(() => QriOptions.parseQriOptionsPage(
        page(0, [["not-a-strike", "1", "2"]]), URLS[0]), /invalid_strike/);
    const parsed = QriOptions.parseQriOptionsPage(page(), URLS[0]);
    const mismatch = structuredClone(parsed);
    mismatch.sourceUrl = URLS[1];
    assert.equal(QriOptions.validateCanonical(mismatch, { allowUnresolvedContracts: true }), false);
    const duplicate = structuredClone(parsed);
    duplicate.records.push(structuredClone(duplicate.records[0]));
    assert.equal(QriOptions.validateCanonical(duplicate, { allowUnresolvedContracts: true }), false);
    const wrongContract = structuredClone(parsed);
    wrongContract.records[0].contract = "2026-10";
    assert.equal(QriOptions.validateCanonical(wrongContract, { allowUnresolvedContracts: true }), false);
});

test("signature is order independent and changes with value or contract", async () => {
    const parsed = QriOptions.parseQriOptionsPage(page(), URLS[0]);
    const reordered = structuredClone(parsed);
    reordered.records.reverse();
    assert.equal(await QriOptions.createSignature(parsed), await QriOptions.createSignature(reordered));
    const changed = structuredClone(parsed);
    changed.records[0].value += 1;
    assert.notEqual(await QriOptions.createSignature(parsed), await QriOptions.createSignature(changed));
    const otherContract = QriOptions.parseQriOptionsPage(page(1), URLS[1]);
    assert.notEqual(await QriOptions.createSignature(parsed), await QriOptions.createSignature(otherContract));
    const firstCache = await QriOptions.createCacheV2(parsed, "2026-08-17T20:10:00+09:00");
    const secondCache = await QriOptions.createCacheV2(otherContract, "2026-08-17T20:10:00+09:00");
    assert.notEqual(firstCache.versionKey, secondCache.versionKey);
});

test("cache v2 validates and restores while v1 and tampering are rejected", async () => {
    const parsed = QriOptions.parseQriOptionsPage(page(), URLS[0]);
    const cache = await QriOptions.createCacheV2(parsed, "2026-08-17T20:10:00+09:00");
    assert.equal(cache.cacheVersion, 2);
    assert.match(cache.versionKey,
        /^qri-options-v2\|2026-09\|2026-08-17T20:08:00\+09:00\|sha256:[0-9a-f]{64}$/);
    assert.equal(await QriOptions.validateCacheV2(cache), true);
    assert.deepEqual(await QriOptions.restoreCacheV2(JSON.stringify(cache)), cache);
    assert.equal(await QriOptions.restoreCacheV2(JSON.stringify({ version: 1 })), null);
    const tampered = structuredClone(cache);
    tampered.canonical.records[0].value += 1;
    assert.equal(await QriOptions.restoreCacheV2(tampered), null);
});

test("legacy display conversion is explicitly derived and never mutates canonical", () => {
    const parsed = QriOptions.parseQriOptionsPage(page(), URLS[0]);
    const before = structuredClone(parsed);
    const legacy = QriOptions.createLegacyDisplayView(parsed);
    assert.equal(legacy.legacyDisplayOnly, true);
    assert.deepEqual(legacy.putOpenInterest, [0, 0]);
    assert.equal(parsed.records[1].value, null);
    assert.deepEqual(parsed, before);
});
