"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Audit = require("../js/marketCalendarHistory/readOnlyAuditCoordinator.js");

test("exact audit flag only; malformed and duplicate flags are rejected", () => {
    const flag = Audit.AUDIT_FLAG, source = `${Audit.SOURCE_FLAG}us-bea-calendar`;
    assert.equal(Audit.classifyArguments(["electron", "."]), "normal");
    assert.equal(Audit.classifyArguments(["electron", ".", flag, source]), "audit");
    assert.equal(Audit.classifyArguments(["electron", ".", flag]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", source]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", `${flag}=1`]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", flag, flag, source]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", flag, source, source]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", flag,
        `${Audit.SOURCE_FLAG}unknown-source`]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", flag,
        `${Audit.SOURCE_FLAG}../../optionmap`]), "invalid_audit_flag");
    assert.equal(Audit.classifyArguments(["electron", ".", flag,
        "--optionmap-calendar-audit-source"]), "invalid_audit_flag");
    assert.equal(Audit.sourceIdFromArguments(["electron", ".", flag, source]), "us-bea-calendar");
    for (const sourceId of ["us-bea-calendar", "us-census-calendar", "jp-stat-labor",
        "jp-esri-machinery-orders-calendar"]) {
        assert.equal(Audit.allowedSourceId(sourceId), true);
    }
    assert.equal(Audit.allowedSourceId("jp-meti-calendar"), false);
});
test("report bridge rejects sender/nonce mismatch and duplicate report", () => {
    const gate = Audit.createReportGate(37, "random-invocation-nonce"), message = {
        nonce: "random-invocation-nonce", result: { ok: true } };
    assert.deepEqual(gate.receive(38, message), { accepted: false, reason: "sender_mismatch" });
    assert.deepEqual(gate.receive(37, { ...message, nonce: "wrong" }), {
        accepted: false, reason: "nonce_mismatch" });
    assert.equal(gate.consumed, false);
    assert.deepEqual(gate.receive(37, message), { accepted: true, result: { ok: true } });
    assert.deepEqual(gate.receive(37, message), { accepted: false, reason: "duplicate_report" });
});
test("direct audit invocation rejects missing source before window or DB access", async () => {
    assert.deepEqual(await Audit.runAudit({ argv: ["electron", ".", Audit.AUDIT_FLAG] }),
        { ok: false, outcome: "audit_source_rejected" });
});
test("audit page seals raw IndexedDB before any UMD dependency and loads no writer", () => {
    const html = fs.readFileSync(path.join(__dirname,
        "../scripts/marketCalendarReadOnlyProbe.html"), "utf8"), early = fs.readFileSync(
        path.join(__dirname, "../scripts/marketCalendarReadOnlyProbeEarly.js"), "utf8"),
        preload = fs.readFileSync(path.join(__dirname,
            "../scripts/marketCalendarReadOnlyAuditReportPreload.js"), "utf8"),
        main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.ok(html.indexOf("marketCalendarReadOnlyProbeEarly.js") <
        html.indexOf("eventTaxonomy.js"));
    assert.match(early, /Object\.defineProperty\(root, "indexedDB"/);
    assert.doesNotMatch(html, /productionHistoryWriter|approvalArtifactDelivery|readwrite/);
    assert.doesNotMatch(preload, /productionHistoryWriter|\.put\(|\.add\(|readwrite/);
    assert.match(main, /auditCoordinator\.classifyArguments\(process\.argv\)/);
    const boot = fs.readFileSync(path.join(__dirname,
        "../scripts/marketCalendarReadOnlyProbeBoot.js"), "utf8");
    assert.match(boot, /source\?\.formalEligible !== true/);
    assert.doesNotMatch(boot, /sourceId: params\.get\("sourceId"\) \|\|/);
});
