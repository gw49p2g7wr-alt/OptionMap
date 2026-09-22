"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const XLSX = require("xlsx");
const { indexedDB, IDBFactory } = require("fake-indexeddb");
const parser = require("../js/jpxDerivativesOpenInterest/workbookParser.js");
const source = require("../js/jpxDerivativesOpenInterest/sourceContract.js");
const identity = require("../js/jpxDerivativesOpenInterest/identity.js");
const history = require("../js/jpxDerivativesOpenInterest/historyContract.js");
const schema = require("../js/jpxDerivativesOpenInterest/historySchemaV1.js");
const readerApi = require("../js/jpxDerivativesOpenInterest/readOnlyConsumer.js");
const writerApi = require("../js/jpxDerivativesOpenInterest/controlledWriter.js");
const acquisition = require("../js/jpxDerivativesOpenInterest/acquisitionCoordinator.js");

const fixturePath = path.join(__dirname, "fixtures/jpx-derivatives-open-interest/20260918open_interest.xlsx");
const bytes = fs.readFileSync(fixturePath);
const sha = crypto.createHash("sha256").update(bytes).digest("hex");
const workbookUrl = "https://www.jpx.co.jp/markets/derivatives/trading-volume/" +
    "tvdivq00000014nn-att/20260918open_interest.xlsx";
const AT = "2026-09-18T10:26:39.000Z";
function parsed() { return parser.parse({ XLSX, bytes, listingDate: "2026-09-18", workbookUrl,
    listingUrl: source.LISTING_URL, fetchedAt: AT, workbookSha256: sha,
    httpMetadata: { status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        lastModified: "Fri, 18 Sep 2026 10:26:39 GMT" } }); }
let sequence = 0;
function databaseName() { return `${schema.DATABASE_NAME}-test-${++sequence}-${Date.now()}`; }

test("監査済みworkbook全体を161先物+18オプション=179 recordとしてFormal化", () => {
    const result = parsed(); assert.equal(result.accepted, true); assert.deepEqual(result.counts,
        { futures: 161, options: 18, total: 179 }); assert.equal(result.diagnostics.length, 0);
    assert.equal(result.canonical.sourceDate, "2026-09-18"); assert.equal(result.canonical.preliminary, true);
    assert.equal(result.canonical.revisionExpected, true); assert.equal(result.canonical.officialNotes.length, 3);
    const totals = [...result.canonical.blocks.oseIndexFutures.records,
        ...result.canonical.blocks.oseIndexOptions.records].filter(item => item.rowKind === "official_total");
    assert.ok(totals.length > 0); assert.ok(totals.every(item => item.recordIdentity.rowKind === "official_total"));
    assert.ok(result.informational.some(item => item.code === "official_total_matches_components"));
});

test("+959/-15/±0はnumeric semanticとexact display provenanceを分離", () => {
    const result = parsed(); const cells = result.evidence.recordProvenance.flatMap(item => item.cells)
        .filter(item => item.field === "changeFromPreviousDay");
    for (const [address, value, formatted] of [["E30", 959, "+959"], ["E31", -15, "-15"], ["E32", 0, "±0"]]) {
        const found = cells.find(item => item.cellAddress === address); assert.equal(found.underlyingValue, value);
        assert.equal(found.cellType, "n"); assert.equal(found.formattedValue, formatted);
        assert.equal(found.numberFormat, source.SIGNED_NUMBER_FORMAT);
    }
    const dash = result.canonical.blocks.oseIndexFutures.records.find(item => item.rowKind === "not_applicable");
    assert.ok(dash); assert.equal(dash.changeFromPreviousDay.state, "not_applicable");
    assert.equal(dash.changeFromPreviousDay.sourceLexeme, "-");
});

test("source-date、header、signed format、算術、option構造をfail-closed", () => {
    assert.equal(parser.parse({ XLSX, bytes, listingDate: "2026-09-17", workbookUrl,
        listingUrl: source.LISTING_URL, fetchedAt: AT, workbookSha256: sha }).accepted, false);
    function mutate(address, values) { const wb = XLSX.read(bytes, { type: "buffer", cellStyles: true, cellNF: true,
        cellText: true }), sheet = wb.Sheets[source.SHEET_NAME]; Object.assign(sheet[address], values);
        return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }); }
    for (const [address, values, code] of [["B29", { v: "unknown" }, "header_mismatch"],
        ["E30", { z: "General" }, "signed_number_format_invalid"],
        ["D30", { v: 132208 }, "open_interest_arithmetic_mismatch"],
        ["B339", { v: "合計" }, "option_structure_invalid"]]) {
        const changed = parser.parse({ XLSX, bytes: mutate(address, values), listingDate: "2026-09-18",
            workbookUrl, listingUrl: source.LISTING_URL, fetchedAt: AT, workbookSha256: sha });
        assert.equal(changed.accepted, false, address); assert.ok(changed.diagnostics.some(item => item.code === code), address);
    }
});

test("anchor・商品継承・official total欠落・duplicate identityをfail-closed", () => {
    function mutate(address, values) { const wb = XLSX.read(bytes, { type: "buffer", cellStyles: true, cellNF: true,
        cellText: true }), sheet = wb.Sheets[source.SHEET_NAME]; Object.assign(sheet[address], values);
        return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }); }
    for (const [address, values, code] of [["A28", { v: "＜OSE 指数先物?取引＞" }, "futures_anchor_invalid"],
        ["A30", { v: undefined, t: "z" }, "product_inheritance_missing"],
        ["B63", { v: undefined, t: "z" }, "futures_total_missing"],
        ["B31", { v: "2026年12月限" }, "duplicate_identity"]]) {
        const changed = parser.parse({ XLSX, bytes: mutate(address, values), listingDate: "2026-09-18",
            workbookUrl, listingUrl: source.LISTING_URL, fetchedAt: AT, workbookSha256: sha });
        assert.equal(changed.accepted, false, address); assert.ok(changed.diagnostics.some(item => item.code === code), address);
    }
});

test("公式total加算差はauthorityを置換せずinformational diagnostic", () => {
    const wb = XLSX.read(bytes, { type: "buffer", cellStyles: true, cellNF: true, cellText: true });
    const officialValue = wb.Sheets[source.SHEET_NAME].C49.v + 1;
    wb.Sheets[source.SHEET_NAME].C49.v = officialValue;
    const changed = parser.parse({ XLSX, bytes: XLSX.write(wb, { type: "buffer", bookType: "xlsx",
        cellStyles: true }), listingDate: "2026-09-18", workbookUrl, listingUrl: source.LISTING_URL,
        fetchedAt: AT, workbookSha256: sha });
    assert.equal(changed.accepted, true); assert.ok(changed.informational.some(item =>
        item.code === "official_total_differs_from_components"));
    assert.equal(changed.canonical.blocks.oseIndexFutures.records.find(item =>
        item.product.officialLabel === "日経225" && item.rowKind === "official_total").tradingVolume.value,
        officialValue);
});

test("listing-derived exact URLだけをcoordinatorが取得しidentityを付与", async () => {
    let requested = null; const runner = acquisition.create({ XLSX,
        fetchListing: async url => ({ text: `<a href="/markets/derivatives/trading-volume/` +
            `tvdivq00000014nn-att/20260918open_interest.xlsx">Excel</a>`, url }),
        fetchWorkbook: async url => { requested = url; return { bytes, fetchedAt: AT, sha256: sha,
            finalUrl: url, httpMetadata: { status: 200,
                contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }; } });
    const result = await runner.run(); assert.equal(result.accepted, true); assert.equal(requested, workbookUrl);
    assert.match(result.identities.semanticIdentity, /^[0-9a-f]{64}$/);
    assert.match(result.identities.acquisitionEvidenceIdentity, /^[0-9a-f]{64}$/);
    assert.equal(acquisition.listingLink(`<a href="${workbookUrl}"></a><a href="${workbookUrl}"></a>`), null);
});

test("historyは初回・semantic unchanged・値変更revisionをimmutable simulation", async () => {
    const candidate = parsed(); let snapshot = history.snapshotEmpty();
    const first = await history.makePlan(snapshot, candidate, { runId: "run-1", acceptedAt: AT });
    assert.equal(first.outcome, "initial"); snapshot = history.simulate(snapshot, first);
    const sameEvidence = JSON.parse(JSON.stringify(candidate)); sameEvidence.evidence.acquiredAt = "2026-09-18T11:00:00Z";
    const same = await history.makePlan(snapshot, sameEvidence, { runId: "run-2", acceptedAt: "2026-09-18T11:00:00Z" });
    assert.equal(same.outcome, "semantic_unchanged"); assert.equal(same.appendRevision, null);
    snapshot = history.simulate(snapshot, same); assert.equal(snapshot.revisions.length, 1); assert.equal(snapshot.evidence.length, 2);
    const changed = JSON.parse(JSON.stringify(candidate)); changed.canonical.blocks.oseIndexFutures.records[0]
        .tradingVolume.value += 1;
    const revised = await history.makePlan(snapshot, changed, { runId: "run-3", acceptedAt: "2026-09-18T12:00:00Z" });
    assert.equal(revised.outcome, "semantic_revision"); snapshot = history.simulate(snapshot, revised);
    assert.equal(snapshot.revisions.length, 2); assert.equal(snapshot.revisions.filter(item => item.closedAt === null).length, 1);
    assert.equal(snapshot.revisions[0].canonical.blocks.oseIndexFutures.records[0].tradingVolume.value,
        candidate.canonical.blocks.oseIndexFutures.records[0].tradingVolume.value);
});

test("6-store controlled writer、readonly consumer、stale precondition rejection", async () => {
    const name = databaseName(), writer = writerApi.create({ indexedDB, databaseName: name,
        enabled: true, authorizationToken: "test-only", allowCreate: true }), empty = history.snapshotEmpty(),
        plan = await history.makePlan(empty, parsed(), { runId: "run-write", acceptedAt: AT }),
        precondition = await identity.preconditionIdentity(empty);
    const committed = await writer.write({ authorization: "test-only", plan,
        expectedPreconditionIdentity: precondition }); assert.equal(committed.saved, true);
    const reader = readerApi.create({ indexedDB, databaseName: name }), active = await reader.readActive();
    assert.equal(active.status, "available"); assert.equal(active.revision.canonical.blocks.oseIndexFutures.records.length, 161);
    const rejected = await writer.write({ authorization: "test-only", plan: await history.makePlan(
        history.snapshotEmpty(), parsed(), { runId: "run-stale", acceptedAt: "2026-09-18T13:00:00Z" }),
        expectedPreconditionIdentity: precondition }); assert.equal(rejected.saved, false);
    assert.match(rejected.error, /stale_precondition/);
});

test("browser UMDの引数なしconsumerはglobal IndexedDBから通常v2へ179件をreadonly投影", async () => {
    const browserIndexedDB = new IDBFactory(), empty = history.snapshotEmpty(), candidate = parsed();
    const plan = await history.makePlan(empty, candidate, { runId: "browser-runtime",
        acceptedAt: AT });
    const writer = writerApi.create({ indexedDB: browserIndexedDB, enabled: true,
        authorizationToken: "fixture-only", allowCreate: true });
    assert.equal((await writer.write({ authorization: "fixture-only", plan,
        expectedPreconditionIdentity: await identity.preconditionIdentity(empty) })).saved, true);

    const context = vm.createContext({ indexedDB: browserIndexedDB, console, setTimeout,
        clearTimeout, structuredClone, TextEncoder, TextDecoder });
    context.globalThis = context; context.window = context;
    for (const relative of ["sourceContract.js", "identity.js", "historySchemaV1.js",
        "historyContract.js", "readOnlyConsumer.js"]) vm.runInContext(fs.readFileSync(
        path.join(__dirname, "../js/jpxDerivativesOpenInterest", relative), "utf8"), context,
    { filename: relative });

    const browserReader = context.OptionMapJpxDerivativesOpenInterestReadOnlyConsumer.create();
    const active = await browserReader.readActive();
    assert.equal(active.status, "available");
    const faithful = await require("../js/fullExportSourceFaithfulCanonical.js").collect({
        readJpxDerivativesOpenInterest: () => active }, v1FixtureForRuntime());
    const daily = faithful.jpxDerivativesOpenInterestDaily;
    assert.equal(daily.status, "available");
    assert.equal(daily.canonical.blocks.oseIndexFutures.records.length, 161);
    assert.equal(daily.canonical.blocks.oseIndexOptions.records.length, 18);
    assert.equal(daily.selectionPolicy.aggregation, "none");
    assert.equal(daily.selectionPolicy.filtering, "none");

    const code = fs.readFileSync(path.join(__dirname,
        "../js/jpxDerivativesOpenInterest/readOnlyConsumer.js"), "utf8");
    assert.match(code, /transaction\(names, "readonly"\)/);
    assert.doesNotMatch(code, /transaction\([^\n]*"readwrite"/);
    let blocked = false; const deletion = browserIndexedDB.deleteDatabase(schema.DATABASE_NAME);
    deletion.onblocked = () => { blocked = true; };
    await new Promise((resolve, reject) => { deletion.onsuccess = resolve;
        deletion.onerror = () => reject(deletion.error); });
    assert.equal(blocked, false);
});

function v1FixtureForRuntime() {
    const fullExport = require("../js/fullExport.js");
    const envelope = () => ({ status: "unavailable", reason: "fixture", authority: {
        source: null, sourceClass: null, origin: null, formalStatus: null, versionKey: null,
        signature: null }, asOf: { tradingDate: null, sourceDate: null, snapshotDate: null,
        pageUpdatedAt: null, fetchedAt: null, confirmedAt: null }, freshness: {
        status: "unavailable", reason: "fixture" }, summary: null, details: null });
    return fullExport.buildFullExport({ exportMeta: { generatedAt: "2026-09-18T19:26:39+09:00",
        timeZone: "Asia/Tokyo", profile: "full", appVersion: "1.1.0-beta.5", readOnly: true },
    compactSummary: { generatedAt: "2026-09-18T19:26:39+09:00", market: "Nikkei 225 derivatives",
        session: {}, currentPrice: {}, currentContract: null, overallV2: {
            interpretation: fullExport.SAFE_INTERPRETATION }, morningChange: {}, importantLevels: {},
        qriHighlights: [], freshnessIssues: [], warnings: [] }, sections: Object.fromEntries(
        fullExport.REQUIRED_SECTION_KEYS.map(key => [key, envelope()])), warnings: [] });
}

test("read-only consumerはDB不存在時にopenせずschema mismatchを拒否", async () => {
    let opens = 0; const fake = { databases: async () => [], open: () => { opens += 1; } };
    await assert.rejects(() => readerApi.create({ indexedDB: fake, databaseName: "absent" }).readSnapshot(), /database_absent/);
    assert.equal(opens, 0);
    const name = databaseName(), db = await new Promise((resolve, reject) => { const value = indexedDB.open(name, 1);
        value.onupgradeneeded = () => value.result.createObjectStore("wrong", { keyPath: "id" });
        value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); db.close();
    await assert.rejects(() => readerApi.create({ indexedDB, databaseName: name }).readSnapshot(), /schema_mismatch/);
});

test("controlled writerのtransaction途中失敗は6-store全体をrollback", async () => {
    const name = databaseName(), writer = writerApi.create({ indexedDB, databaseName: name,
        enabled: true, authorizationToken: "test-only", allowCreate: true }), empty = history.snapshotEmpty(),
        plan = await history.makePlan(empty, parsed(), { runId: "rollback-run", acceptedAt: AT });
    const result = await writer.write({ authorization: "test-only", plan,
        expectedPreconditionIdentity: await identity.preconditionIdentity(empty), injectFailureAfter: "revision" });
    assert.equal(result.saved, false); const loaded = await readerApi.create({ indexedDB, databaseName: name }).readSnapshot();
    assert.equal(loaded.status, "empty"); assert.deepEqual(loaded.snapshot, empty);
});
