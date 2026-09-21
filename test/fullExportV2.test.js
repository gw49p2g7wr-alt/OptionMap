const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const v1 = require("../js/fullExport.js");
const v2 = require("../js/fullExportV2.js");
const source = require("../js/fullExportSourceFaithfulCanonical.js");
const security = require("../js/fullExportSecurity.js");
const fileSave = require("../js/fullExportFileSave.js");
const ui = require("../js/fullExportUi.js");

const generatedAt = "2026-09-21T12:34:56+09:00";
const envelope = () => ({ status: "unavailable", reason: "fixture_unavailable",
    authority: { source: null, sourceClass: null, origin: null, formalStatus: null,
        versionKey: null, signature: null }, asOf: { tradingDate: null, sourceDate: null,
        snapshotDate: null, pageUpdatedAt: null, fetchedAt: null, confirmedAt: null },
    freshness: { status: "unavailable", reason: "fixture" }, summary: null, details: null });
function v1Fixture() {
    const sections = Object.fromEntries(v1.REQUIRED_SECTION_KEYS.map(key => [key, envelope()]));
    sections.qriOptions = { ...envelope(), status: "available", reason: null,
        authority: { ...envelope().authority, versionKey: "qri-active", signature: "abc" },
        summary: { contract: "2026-10" }, details: { records: [] } };
    sections.qriOptionIv = { ...envelope(), status: "available", reason: null,
        summary: { valueUnit: "percent_points" }, details: { roles: [{ role: "active",
            status: "available" }], payloads: [{ payloadId: "iv-active", records: [
                { optionType: "call", strike: 40000, iv: { status: "available", value: 0,
                    sourceFormat: "percent" } }, { optionType: "put", strike: 40000,
                    iv: { status: "invalid", value: null, sourceFormat: "malformed" } }] }] } };
    sections.weeklyFutures = { ...envelope(), status: "available", reason: null,
        authority: { ...envelope().authority, versionKey: "wf-current", signature: "def" },
        summary: {}, details: { previousIdentity: { versionKey: "wf-previous" },
            currentIdentity: { versionKey: "wf-current" }, records: [] } };
    sections.weeklyOptions = { ...envelope(), status: "available", reason: null,
        authority: { ...envelope().authority, versionKey: "wo-current", signature: "ghi" },
        summary: {}, details: { comparison: { previousVersionKey: "wo-previous" }, records: [] } };
    return v1.buildFullExport({ exportMeta: { generatedAt, timeZone: "Asia/Tokyo",
        profile: "full", appVersion: "1.1.0-beta.5", readOnly: true }, compactSummary: {
        generatedAt, market: "Nikkei 225 derivatives", session: {}, currentPrice: {},
        currentContract: "2026-10", overallV2: { interpretation: v1.SAFE_INTERPRETATION },
        morningChange: {}, importantLevels: {}, qriHighlights: [], freshnessIssues: [], warnings: []
    }, sections, warnings: [] });
}
const history = (...versions) => ({ entries: [{ entryKey: "entry", activeVersionKey: versions.at(-1),
    revisions: versions.map(versionKey => ({ versionKey, canonical: { records: [] } })) }] });
function participantCache() {
    const files = {};
    for (const role of source.FILE_ROLES) files[role] = { status: "success",
        sourceDate: "2026-09-18", sourceDateKind: "excel",
        sourceUrl: `https://www.jpx.co.jp/automation/${role}.xlsx`,
        signatureAlgorithm: "sha256", signature: role.padEnd(64, "0"), versionKey: role,
        data: { large: { records: [{ product: "NK225F", contractCode: "x",
            contractName: "2026-10", rank: 1, participantCode: "1", company: "会社",
            companyEnglish: "Company", volume: 0 }], top10: [] }, mini: { records: [], top10: [] },
            topix: { records: [], top10: [] }, micro: { records: [], top10: [] },
            option: { records: [], top10: [] }, sourceDate: "2026-09-18",
            sourceDateKind: "excel" } };
    return { version: 1, parserVersion: 1, source: "jpx-daily-participant-volume",
        sourceDate: "2026-09-18", fetchedAt: "2026-09-18T09:00:00Z", status: "complete",
        files, signatureAlgorithm: "sha256", signature: "a".repeat(64), versionKey: "set" };
}

test("v1 serialized golden fixtureはv2追加後も完全一致", () => {
    const serialized = v1.serializeFullExport(v1Fixture(), 2);
    assert.equal(crypto.createHash("sha256").update(serialized).digest("hex"),
        "c7350382954d44c1ea08b36f8e26fc2c6387ecf6b3ccd2748b111a92cdfc9a62");
});

test("v2はsourceFaithfulCanonicalを独立追加しv1 projectionを不変維持", async () => {
    const first = v1Fixture();
    const faithful = await source.collect({
        readQriHistory: async () => ({ history: { entries: [{ entryKey: "qri",
            activeVersionKey: "qri-active", revisions: [{ versionKey: "qri-active",
                canonical: { records: [
                    { optionType: "call", strike: 40000, published: true, value: 0 },
                    { optionType: "put", strike: 40000, published: false, value: null }
                ] } }] }] } }),
        readWeeklyFuturesHistory: async () => history("wf-previous", "wf-current"),
        readWeeklyOptionsHistory: async () => ({ history: history("wo-previous", "wo-current") }),
        readParticipantCache: async () => participantCache()
    }, first);
    const result = v2.build(first, faithful);
    assert.equal(result.schemaVersion, v2.SCHEMA_VERSION);
    assert.deepEqual(v2.v1Projection(result), first);
    assert.equal(v2.validate(result).valid, true);
    assert.equal(result.sourceFaithfulCanonical.qriImpliedVolatility.payloads[0]
        .records[0].iv.value, 0);
    assert.equal(result.sourceFaithfulCanonical.qriImpliedVolatility.payloads[0]
        .records[1].iv.value, null);
    assert.equal(result.sourceFaithfulCanonical.qriImpliedVolatility.payloads[0]
        .records[1].iv.status, "invalid");
    const qriRecords = result.sourceFaithfulCanonical.qriOpenInterest.roles.active
        .selected.revision.canonical.records;
    assert.deepEqual(qriRecords.map(record => [record.published, record.value]),
        [[true, 0], [false, null]]);
});

test("participantは4 file roleを各recordへ結び付け0を維持", () => {
    const projected = source.participants(participantCache());
    assert.equal(projected.status, "available");
    for (const role of source.FILE_ROLES) {
        assert.equal(projected.files[role].records[0].provenance.fileRole, role);
        assert.equal(projected.files[role].records[0].record.volume, 0);
    }
    assert.equal(projected.lossDisclosure.rawExcelRetained, false);
});

test("JPX日次建玉残高はaccepted active 179 recordsを無選別で追加", async () => {
    const parser = require("../js/jpxDerivativesOpenInterest/workbookParser.js");
    const XLSX = require("xlsx");
    const workbook = fs.readFileSync(path.join(__dirname,
        "fixtures/jpx-derivatives-open-interest/20260918open_interest.xlsx"));
    const parsed = parser.parse({ XLSX, bytes: workbook, listingDate: "2026-09-18",
        workbookUrl: "https://www.jpx.co.jp/markets/derivatives/trading-volume/" +
            "tvdivq00000014nn-att/20260918open_interest.xlsx",
        listingUrl: "https://www.jpx.co.jp/markets/derivatives/trading-volume/index.html",
        fetchedAt: "2026-09-18T10:26:39Z",
        workbookSha256: crypto.createHash("sha256").update(workbook).digest("hex"),
        httpMetadata: { status: 200 } });
    const identities = await require("../js/jpxDerivativesOpenInterest/identity.js")
        .derive(parsed.canonical, parsed.evidence);
    const active = { status: "available", revision: { revisionKey: identities.revisionKey,
        semanticIdentity: identities.semanticIdentity, sourceDate: parsed.canonical.sourceDate,
        canonical: parsed.canonical }, evidence: { acquisitionEvidenceIdentity:
            identities.acquisitionEvidenceIdentity, acceptedAt: "2026-09-18T10:30:00Z",
        evidence: parsed.evidence } };
    const faithful = await source.collect({ readJpxDerivativesOpenInterest: async () => active }, v1Fixture());
    const daily = faithful.jpxDerivativesOpenInterestDaily;
    assert.equal(daily.status, "available");
    assert.equal(daily.canonical.blocks.oseIndexFutures.records.length, 161);
    assert.equal(daily.canonical.blocks.oseIndexOptions.records.length, 18);
    assert.equal(daily.selectionPolicy.aggregation, "none");
    assert.equal(daily.selectionPolicy.filtering, "none");
    assert.equal(daily.lossDisclosure.rawExcelRetained, false);
    const output = v2.build(v1Fixture(), faithful);
    assert.equal(v2.validate(output).valid, true);
});

test("participant role mismatchとraw payloadはfail-closed", async () => {
    const first = v1Fixture();
    const faithful = await source.collect({ readParticipantCache: async () => participantCache() }, first);
    faithful.participants.files.dayAuction.records[0].provenance.fileRole = "nightAuction";
    assert.throws(() => v2.build(first, faithful), /participant_dayAuction_invalid/);
    assert.equal(security.inspectFullExportSecurity({ sourceFaithfulCanonical: {
        rawExcel: "PK\\x03\\x04" } }).valid, false);
});

test("v2 filename/schemaを許可し50MB超過は拒否", () => {
    const first = v1Fixture();
    const faithful = { contractVersion: 1, selectionPolicy: { scope: "export_basis_revisions",
        wholeHistoryIncluded: false, rawHtmlIncluded: false, rawExcelIncluded: false },
    qriOpenInterest: {}, qriImpliedVolatility: {}, weeklyFutures: {}, weeklyOptions: {},
    participants: {}, jpxDerivativesOpenInterestDaily: { status: "unavailable" } };
    const value = v2.build(first, faithful);
    const request = { fileName: "OptionMap-Full-Export-v2-2026-09-21T123456-JST.json",
        json: v2.serialize(value) };
    assert.equal(fileSave.validateRequest(request).valid, true);
    assert.equal(fileSave.validateRequest({ ...request, json: "x".repeat(50 * 1024 * 1024 + 1) })
        .reason, "invalid_export_request");
});

test("v2 foundationはstorage/network/UIへ直接接続しない", () => {
    for (const file of ["fullExportV2.js", "fullExportSourceFaithfulCanonical.js"]) {
        const code = fs.readFileSync(path.join(__dirname, "../js", file), "utf8");
        assert.doesNotMatch(code, /localStorage|indexedDB|\bfetch\s*\(|document\.|ipcRenderer|ipcMain/);
    }
});

test("UIはv1を既定に保ち明示v2だけ別filenameで保存", async () => {
    const first = v1Fixture();
    const faithful = { contractVersion: 1, selectionPolicy: { scope: "export_basis_revisions",
        wholeHistoryIncluded: false, rawHtmlIncluded: false, rawExcelIncluded: false },
    qriOpenInterest: { unknownCanonicalField: false }, qriImpliedVolatility: {},
    weeklyFutures: {}, weeklyOptions: {}, participants: {},
    jpxDerivativesOpenInterestDaily: { status: "unavailable" } };
    const second = v2.build(first, faithful); const calls = [];
    const controller = ui.createController({ collect: async () => first,
        collectV2: async value => { assert.equal(value, first); return second; },
        save: async request => { calls.push(request); return { success: true }; } });
    await controller.run(); await controller.run("v2");
    assert.match(calls[0].fileName, /^OptionMap-Full-Export-\d/);
    assert.match(calls[1].fileName, /^OptionMap-Full-Export-v2-/);
    assert.equal(JSON.parse(calls[0].json).schemaVersion, v1.SCHEMA_VERSION);
    assert.equal(JSON.parse(calls[1].json).sourceFaithfulCanonical
        .qriOpenInterest.unknownCanonicalField, false);
});

test("実画面文言とv1既定選択を固定", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /value="v1" checked>[\s\S]*標準（整理済み・軽量）/);
    assert.match(html, /詳細（元データに近い情報も含む）/);
    assert.match(html, /保存済みの公式source canonical・取得情報を追加します。元HTML・Excelファイルそのものは含みません。/);
    const uiCode = fs.readFileSync(path.join(__dirname, "../js/fullExportUi.js"), "utf8");
    assert.match(uiCode, /collectV2:\s*browserConfiguration\.collectV2/);
});
