const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fullExport = require("../js/fullExport.js");
const security = require("../js/fullExportSecurity.js");

const section = (overrides = {}) => ({
    status: "available",
    reason: null,
    authority: {
        source: "qri-nikkei225-options",
        sourceClass: "formal_history",
        origin: "history",
        formalStatus: "verified",
        versionKey: "qri-options-v2|2026-09|example",
        signature: "sha256:example"
    },
    asOf: {
        tradingDate: "2026-09-07",
        sourceDate: "2026-09-07",
        snapshotDate: "2026-09-05",
        pageUpdatedAt: "2026-09-05T18:45:00+09:00",
        fetchedAt: "2026-09-05T09:45:30.000Z",
        confirmedAt: "2026-09-05T09:46:00.000Z"
    },
    freshness: { status: "fresh", reason: "current" },
    summary: { count: 2 },
    details: { records: [{ strike: 42000, value: 0 }] },
    ...overrides
});

function fixture() {
    return {
        exportMeta: {
            generatedAt: "2026-09-06T07:15:00+09:00",
            timeZone: "Asia/Tokyo",
            profile: "full",
            appVersion: "1.1.0-beta.2",
            readOnly: true
        },
        compactSummary: {
            generatedAt: "2026-09-06T07:15:00+09:00",
            market: "Nikkei 225 derivatives",
            session: { status: "verified", calendarDate: "2026-09-06",
                tradingDate: "2026-09-07" },
            currentPrice: { status: "available", value: 42125 },
            currentContract: "2026-09",
            overallV2: { status: "complete", direction: 24,
                interpretation: "supply_demand_assessment_not_trade_signal" },
            morningChange: { status: "available", priceDelta: 125 },
            importantLevels: { upper: 42500, lower: 41750 },
            qriHighlights: [{ optionType: "call", netDelta: 200 }],
            freshnessIssues: [],
            warnings: []
        },
        sections: Object.fromEntries(fullExport.REQUIRED_SECTION_KEYS.map(key => [key, section()])),
        warnings: []
    };
}

test("valid Full Export v1を固定schemaで生成する", () => {
    const result = fullExport.buildFullExport(fixture());
    assert.equal(result.schemaVersion, "optionmap-full-export-v1");
    assert.deepEqual(Object.keys(result), ["schemaVersion", "exportMeta", "compactSummary",
        "sections", "warnings"]);
    assert.equal(fullExport.validateFullExport(result).valid, true);
});

test("builderはinputを変更せずdetachedかつdeep frozenな結果を返す", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = fullExport.buildFullExport(input);
    assert.deepEqual(input, before);
    assert.notEqual(result.exportMeta, input.exportMeta);
    assert.notEqual(result.sections.qriOptions, input.sections.qriOptions);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.sections.qriOptions.details.records[0]), true);
    assert.throws(() => { result.sections.qriOptions.details.records.push({}); }, TypeError);
});

test("serializationはinput key順序に依存せずdeterministic", () => {
    const first = fixture();
    const second = { warnings: [], sections: Object.fromEntries(
        Object.entries(first.sections).reverse()), compactSummary: {
        warnings: [], freshnessIssues: [], qriHighlights: first.compactSummary.qriHighlights,
        importantLevels: first.compactSummary.importantLevels,
        morningChange: first.compactSummary.morningChange,
        overallV2: first.compactSummary.overallV2,
        currentContract: first.compactSummary.currentContract,
        currentPrice: first.compactSummary.currentPrice,
        session: first.compactSummary.session,
        market: first.compactSummary.market,
        generatedAt: first.compactSummary.generatedAt
    }, exportMeta: first.exportMeta };
    assert.equal(fullExport.serializeFullExport(fullExport.buildFullExport(first)),
        fullExport.serializeFullExport(fullExport.buildFullExport(second)));
});

test("unknown future sectionを共通envelopeのまま許容する", () => {
    const input = fixture();
    input.sections.wallMovement = section({ status: "unavailable", reason: "not_implemented",
        summary: null, details: null });
    const result = fullExport.buildFullExport(input);
    assert.equal(result.sections.wallMovement.status, "unavailable");
    assert.equal(result.sections.wallMovement.summary, null);
    assert.equal(result.sections.wallMovement.details, null);
});

test("qriOptionIvはoptional additiveで旧v1とrequired keysを変更しない", () => {
    const legacyInput = fixture();
    const legacy = fullExport.buildFullExport(legacyInput);
    const requiredBefore = ["marketSnapshot", "overallV2", "morning", "importantLevels",
        "qriOptions", "qriOptionsNextContract", "qriOptionsMajorSqNextContract",
        "qriHistoryComparison", "weeklyFutures", "weeklyOptions", "participants", "intelligence"];
    assert.deepEqual(fullExport.REQUIRED_SECTION_KEYS, requiredBefore);
    assert.equal(legacy.schemaVersion, "optionmap-full-export-v1");
    assert.equal(fullExport.validateFullExport(legacy).valid, true);
    const additiveInput = fixture();
    additiveInput.sections.qriOptionIv = section({ summary: { valueUnit: "percent_points" },
        details: { roles: [], payloads: [] } });
    const additive = fullExport.buildFullExport(additiveInput);
    assert.equal(additive.schemaVersion, legacy.schemaVersion);
    assert.deepEqual(additive.compactSummary, legacy.compactSummary);
    assert.equal(fullExport.validateFullExport(additive).valid, true);
});

test("必須unavailable sectionを省略せずnullと0を区別する", () => {
    const input = fixture();
    input.sections.participants = section({ status: "unavailable", reason: "history_missing",
        summary: null, details: null });
    input.sections.intelligence = section({ summary: { snapshotCount: 0 }, details: null });
    const result = fullExport.buildFullExport(input);
    assert.equal(Object.hasOwn(result.sections, "participants"), true);
    assert.equal(result.sections.participants.summary, null);
    assert.equal(result.sections.intelligence.summary.snapshotCount, 0);
});

test("source固有の日付概念を統合・推測しない", () => {
    const input = fixture();
    input.sections.qriOptions.asOf = { tradingDate: "2026-09-07", sourceDate: null,
        snapshotDate: "2026-09-05", pageUpdatedAt: "2026-09-05T18:45:00+09:00",
        fetchedAt: null, confirmedAt: null };
    const result = fullExport.buildFullExport(input);
    assert.deepEqual(result.sections.qriOptions.asOf, input.sections.qriOptions.asOf);
});

test("fallback/cache/referenceをFormalへ昇格させない", () => {
    for (const origin of ["fallback", "cache", "reference"]) {
        const input = fixture();
        input.sections.qriOptions.authority = { source: "qri-nikkei225-options",
            sourceClass: "formal_history", origin, formalStatus: "verified" };
        assert.throws(() => fullExport.buildFullExport(input), /authority_escalation/);
    }
});

test("security denylistをnested objectとarray内まで検出する", () => {
    const keys = ["token", "accessToken", "refreshToken", "idToken", "authorization",
        "bearer", "cookie", "session", "password", "secret", "credential", "email", "uid",
        "rawHtml", "innerHTML", "stack", "stackTrace", "env", "memo", "tags",
        "optionMapAiTemplates", "nightData", "dayData", "optionData", "rawInput",
        "storageDump", "indexedDbDump", "rawExcel", "binary"];
    const payloads = keys.map((key, index) => index % 2 === 0
        ? { nested: { [key]: "private" } } : { rows: [{ [key]: "private" }] });
    for (const payload of payloads) {
        const inspected = security.inspectFullExportSecurity(payload);
        assert.equal(inspected.valid, false, JSON.stringify(payload));
    }
});

test("absolute path、user home、raw HTML、email、Bearer、stackを検出する", () => {
    for (const value of ["/Users/natsu/private.json", "/etc/passwd", "C:\\Users\\Natsu\\secret.txt",
        "~/OptionMap/data.json", "<html><body>raw</body></html>", "user@example.com",
        "Bearer abc.def.ghi", "Error: bad\n    at app.js:1:1"]) {
        assert.equal(security.inspectFullExportSecurity({ value }).valid, false, value);
    }
});

test("公開URLはallowlistかつcredential/query/fragmentなしだけ許可する", () => {
    assert.equal(security.inspectFullExportSecurity({ sourceUrl:
        "https://www.jpx.co.jp/markets/derivatives/open-interest/index.html" }).valid, true);
    for (const sourceUrl of ["https://evil.example/data", "https://user:pass@www.jpx.co.jp/data",
        "https://www.jpx.co.jp/data?token=x", "https://svc.qri.jp/data#private"]) {
        assert.equal(security.inspectFullExportSecurity({ sourceUrl }).valid, false, sourceUrl);
    }
});

test("aiSummary内の固定RFC 6901 pointerだけをlocal pathと区別する", () => {
    assert.equal(security.inspectFullExportSecurity({ sections: { aiSummary: { details: {
        authoritativeRoot: "/sections", sourcePointer: "/sections/qriOptions",
        pointer: "/sections/overallV2/freshness",
        iv: { sourcePointer: "/sections/qriOptionIv" } } } } }).valid, true);
    for (const value of ["/etc/passwd", "/sections/unknown", "/sections/qriOptions/details"]) {
        assert.equal(security.inspectFullExportSecurity({ sections: { aiSummary: {
            sourcePointer: value } } }).valid, false);
    }
});

test("NaN / Infinity / undefined / function / symbol / Dateをreject", () => {
    for (const value of [NaN, Infinity, undefined, () => 1, Symbol("x"), new Date()]) {
        const input = fixture();
        input.sections.marketSnapshot.details = { value };
        assert.throws(() => fullExport.buildFullExport(input));
    }
});

test("circular referenceをreject", () => {
    const input = fixture();
    input.sections.marketSnapshot.details = {};
    input.sections.marketSnapshot.details.self = input.sections.marketSnapshot.details;
    assert.throws(() => fullExport.buildFullExport(input), /circular_reference/);
});

test("OverallV2は需給評価でありtrade signal fieldや文言をreject", () => {
    const valid = fullExport.buildFullExport(fixture());
    assert.equal(valid.compactSummary.overallV2.interpretation,
        "supply_demand_assessment_not_trade_signal");
    for (const overallV2 of [
        { status: "complete", tradeSignal: "buy",
            interpretation: "supply_demand_assessment_not_trade_signal" },
        { status: "complete", message: "今すぐ買い推奨",
            interpretation: "supply_demand_assessment_not_trade_signal" },
        { status: "complete", direction: 10, interpretation: "trade_signal" }
    ]) {
        const input = fixture();
        input.compactSummary.overallV2 = overallV2;
        assert.throws(() => fullExport.buildFullExport(input));
    }
});

test("security failureではpartial exportを返さない", () => {
    const input = fixture();
    input.sections.qriOptions.details = { safe: true, nested: { idToken: "secret" } };
    let returned = null;
    assert.throws(() => { returned = fullExport.buildFullExport(input); }, /security_validation_failed/);
    assert.equal(returned, null);
});

test("foundation modulesはruntime・storage・UI・networkへ接続しない", () => {
    for (const file of ["fullExport.js", "fullExportSecurity.js"]) {
        const source = fs.readFileSync(path.join(__dirname, "../js", file), "utf8");
        assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(|document\.|ipcRenderer|ipcMain|showSaveDialog|Blob\s*\(|createObjectURL/);
    }
});
