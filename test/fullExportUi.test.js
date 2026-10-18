const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fullExport = require("../js/fullExport.js");
const ui = require("../js/fullExportUi.js");
const fileSave = require("../js/fullExportFileSave.js");

function validExport(overrides = {}) {
    const generatedAt = overrides.generatedAt || "2026-09-06T07:15:00+09:00";
    const empty = status => ({ status, reason: status === "available" ? null : "not_ready",
        authority: { source: null, sourceClass: null, origin: null, formalStatus: null,
            versionKey: null, signature: null },
        asOf: { tradingDate: null, sourceDate: null, snapshotDate: null, pageUpdatedAt: null,
            fetchedAt: null, confirmedAt: null }, freshness: { status: "unavailable" },
        summary: status === "available" ? {} : null, details: status === "available" ? {} : null });
    const sections = Object.fromEntries(fullExport.REQUIRED_SECTION_KEYS.map((key, index) =>
        [key, empty(index === 0 ? "available" : "unavailable")]));
    return fullExport.buildFullExport({ exportMeta: { generatedAt, timeZone: "Asia/Tokyo",
        profile: "full", appVersion: null, readOnly: true }, compactSummary: {
        generatedAt, market: "Nikkei", session: {}, currentPrice: {}, currentContract: null,
        overallV2: { interpretation: fullExport.SAFE_INTERPRETATION }, morningChange: {},
        importantLevels: {}, qriHighlights: [], freshnessIssues: [], warnings: []
    }, sections, warnings: [] });
}

function harness(options = {}) {
    const calls = { collect: 0, save: 0, busy: [], status: [] };
    let release;
    const gate = options.gated ? new Promise(resolve => { release = resolve; }) : null;
    const controller = ui.createController({
        collect: async () => { calls.collect += 1; if (gate) await gate; return options.value || validExport(); },
        save: async request => { calls.save += 1; calls.request = request;
            if (options.saveError) throw new Error("disk details /Users/private");
            return options.saveResult || { success: true, cancelled: false }; },
        setBusy: value => calls.busy.push(value),
        setStatus: (...args) => calls.status.push(args)
    });
    return { controller, calls, release };
}

test("button controllerはcollector→validation→serialization→saveを1回実行", async () => {
    const { controller, calls } = harness(); const result = await controller.run();
    assert.equal(result.success, true); assert.equal(calls.collect, 1); assert.equal(calls.save, 1);
    assert.equal(JSON.parse(calls.request.json).schemaVersion, fullExport.SCHEMA_VERSION);
});

test("二重実行を抑止", async () => {
    const { controller, calls, release } = harness({ gated: true });
    const first = controller.run(); const second = await controller.run(); release(); await first;
    assert.equal(second.reason, "already_running"); assert.equal(calls.collect, 1); assert.equal(calls.save, 1);
});

test("invalid/security failure/collector failureでは保存しない", async () => {
    const invalid = harness({ value: { schemaVersion: "bad" } });
    await invalid.controller.run(); assert.equal(invalid.calls.save, 0);
    const calls = { save: 0 };
    const controller = ui.createController({ collect: async () => { throw new Error(
        "security_validation_failed:forbidden_key"); }, save: async () => { calls.save += 1; } });
    const result = await controller.run(); assert.equal(calls.save, 0);
    assert.equal(result.reason, "安全性検査に失敗しました");
    const failed = ui.createController({ collect: async () => { throw new Error("reader_failed"); },
        save: async () => { calls.save += 1; } });
    await failed.run(); assert.equal(calls.save, 0);
});

test("partial/unavailable sectionを含むvalid exportは保存可能", async () => {
    const { controller, calls } = harness(); await controller.run(); assert.equal(calls.save, 1);
});

test("filenameはWindows互換でtradingDateを使わない", () => {
    const name = ui.createFileName("2026-09-05T22:15:00Z");
    assert.equal(name, "OptionMap-Full-Export-2026-09-06T071500-JST.json");
    assert.doesNotMatch(name, /[:\\/*?"<>|]|2026-09-07/);
});

test("generatedAtはJST offsetを持つ", () => assert.equal(
    ui.generatedAtJst("2026-09-05T22:15:00Z"), "2026-09-06T07:15:00+09:00"));

test("JSONはparse round-trip可能かつdeterministic", async () => {
    const first = harness(); const second = harness(); await first.controller.run(); await second.controller.run();
    assert.deepEqual(JSON.parse(first.calls.request.json), validExport());
    assert.equal(first.calls.request.json, second.calls.request.json);
});

test("保存失敗はsanitized表示でbusyを解除", async () => {
    const { controller, calls } = harness({ saveError: true }); const result = await controller.run();
    assert.equal(result.success, false); assert.deepEqual(calls.busy, [true, false]);
    assert.doesNotMatch(calls.status.at(-1)[1], /Users|private|disk details/);
});

test("キャンセルを失敗と区別", async () => {
    const { controller, calls } = harness({ saveResult: { success: false, cancelled: true } });
    const result = await controller.run(); assert.equal(result.cancelled, true);
    assert.equal(calls.status.at(-1)[0], "cancelled");
});

test("main save request validatorはsecret値をlogせず不正JSONをreject", () => {
    assert.equal(fileSave.validateRequest({ fileName: "bad.json", json: "token-secret" }).valid, false);
    assert.equal(fileSave.validateRequest({ fileName: ui.createFileName("2026-09-06T00:00:00+09:00"),
        json: JSON.stringify(validExport()) }).valid, true);
});

test("save serviceはcancel時に書かず成功時だけtemporary fileをrename", async () => {
    const operations = [];
    const request = { fileName: ui.createFileName("2026-09-06T00:00:00+09:00"),
        json: JSON.stringify(validExport()) };
    const cancelled = fileSave.createSaveService({ dialog: { showSaveDialog: async () =>
        ({ canceled: true }) }, fs: { writeFile: async () => operations.push("write"),
        rename: async () => operations.push("rename"), rm: async () => operations.push("rm") },
    path, randomUUID: () => "id" });
    assert.equal((await cancelled.save({}, request)).cancelled, true);
    assert.deepEqual(operations, []);
    const saved = fileSave.createSaveService({ dialog: { showSaveDialog: async () =>
        ({ canceled: false, filePath: "/tmp/export.json" }) }, fs: {
        writeFile: async file => operations.push(["write", file]),
        rename: async (from, to) => operations.push(["rename", from, to]),
        rm: async file => operations.push(["rm", file])
    }, path, randomUUID: () => "id" });
    assert.equal((await saved.save({}, request)).success, true);
    assert.deepEqual(operations.map(item => item[0]), ["write", "rename"]);
});

test("save serviceはwrite/rename失敗時にtemporary fileを除去して失敗を返す", async () => {
    const operations = [];
    const service = fileSave.createSaveService({ dialog: { showSaveDialog: async () =>
        ({ canceled: false, filePath: "/tmp/export.json" }) }, fs: {
        writeFile: async () => operations.push("write"),
        rename: async () => { throw new Error("private path"); },
        rm: async () => operations.push("rm")
    }, path, randomUUID: () => "id" });
    const request = { fileName: ui.createFileName("2026-09-06T00:00:00+09:00"),
        json: JSON.stringify(validExport()) };
    const result = await service.save({}, request);
    assert.deepEqual(result, { success: false, cancelled: false, reason: "file_save_failed" });
    assert.deepEqual(operations, ["write", "rm"]);
});

test("UI wiringは専用buttonとPhase 1A/1Bを読み込む", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /id="fullExportJsonButton"/); assert.match(html, /id="fullExportStatus"/);
    for (const file of ["fullExportSecurity.js", "fullExport.js",
        "fullExportConsumerReadiness.js", "fullExportCollector.js", "fullExportUi.js"])
        assert.match(html, new RegExp(`js/${file.replace(".", "\\.")}`));
});

test("Full Export runtime versionはmain-owned Electron metadataから取得", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    const preload = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(main, /ipcMain\.handle\("get-runtime-metadata"[\s\S]*?BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]*?app\.getVersion\(\)/);
    assert.match(preload, /getRuntimeMetadata:\s*\(\.\.\.args\)\s*=>\s*invokeRuntimeMetadata\(args\)/);
    const wiring = html.slice(html.indexOf("window.OptionMapFullExportUi.configure"),
        html.indexOf("const qriOptionsHistoryPersistence"));
    assert.match(wiring, /await optionMapBridge\.getRuntimeMetadata\(\)/);
    assert.match(wiring, /appVersion:\s*runtimeMetadata\.appVersion/);
    assert.doesNotMatch(wiring, /appVersion:\s*["'][^"']+["']/);
});

test("marketSnapshot identityとfreshnessは同一取得世代を共有", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const wiring = html.slice(html.indexOf("window.OptionMapFullExportUi.configure"),
        html.indexOf("const qriOptionsHistoryPersistence"));
    assert.equal((wiring.match(/getCurrentPriceLiveIdentityFact\?\.\(\)/g) || []).length, 1);
    assert.match(wiring, /const currentPriceIdentity\s*=\s*window\.getCurrentPriceLiveIdentityFact\?\.\(\)\s*\|\|\s*null/);
    assert.equal((wiring.match(/getCurrentPriceIdentity:\s*\(\)\s*=>\s*currentPriceIdentity/g) || []).length, 2);
});

test("UI export pathにfetch/write/publishやtrade計算を持たない", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/fullExportUi.js"), "utf8");
    assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|indexedDB|\.publish\s*\(|\.put\s*\(|\.add\s*\(|\.delete\s*\(|calculateOverall/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const wiring = html.slice(html.indexOf("window.OptionMapFullExportUi.configure"),
        html.indexOf("const qriOptionsHistoryPersistence"));
    assert.doesNotMatch(wiring, /setItem|\.put\s*\(|\.add\s*\(|\.delete\s*\(|\bfetch\s*\(|publish|calculateOptionMap/);
    assert.match(wiring, /getWeeklyCandidateState/);
});
