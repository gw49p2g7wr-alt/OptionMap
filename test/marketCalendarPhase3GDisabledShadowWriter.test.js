"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Shadow = require("../js/marketCalendarHistory/disabledShadowWriter.js");
const T1 = "2026-09-16T05:15:58.893Z";
async function event() { const logical = { eventKey: "JP|BOJ|BOJ_MPM|p|regular|national",
    jurisdiction: "JP", authority: "BOJ", eventType: "BOJ_MPM", referencePeriod: "p",
    edition: "regular", scope: "national" }, semantic = { schemaVersion: 1, logical,
        schedule: { kind: "date_only", canonicalStart: null, canonicalEnd: null,
            sourceLocal: { startDate: "2026-09-18", startTime: null, endDate: null, endTime: null,
                timeZone: "Asia/Tokyo", resolvedOffset: null }, precision: "date_only" },
        lifecycleStatus: "scheduled", title: { ja: "会合", en: null },
        change: { reason: null, supersedesRevisionKey: null } }, evidence = {
        sourceId: "source", fetchedAt: T1, parserVersion: 1 },
    canonicalContentHash = await Canonicalizer.sha256(semantic),
    acquisitionEvidenceHash = await Canonicalizer.sha256(evidence);
    return { ...semantic, eventKey: logical.eventKey,
        revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`, canonicalContentHash,
        acquisitionEvidence: evidence, acquisitionEvidenceHash,
        acquisitionEvidenceKey: `source|sha256:${acquisitionEvidenceHash}` }; }
const run = { sourceId: "source", runId: "r1", acceptedAt: T1, fetchedAt: [T1],
    status: "accepted", semanticSetHash: "a".repeat(64) };

test("shadow previewはwriteせずpure planとprojected snapshotを返す", async () => {
    let writes = 0; const writer = Shadow.createDisabledShadowWriter({ productionWriter: () => { writes += 1; } }),
        result = await writer.preview({ snapshot: {}, run, canonicalSet: [await event()] });
    assert.equal(result.outcome, "shadow_projected"); assert.equal(result.storageWrite, false);
    assert.equal(result.projectedSnapshot.revisions.length, 1); assert.equal(writes, 0);
});

test("authorizationの有無にかかわらずproduction writeを拒否", async () => {
    let writes = 0; const writer = Shadow.createDisabledShadowWriter({ productionWriter: () => { writes += 1; } });
    for (const options of [{}, { authorization: "anything" }]) assert.deepEqual(await writer.write(options), {
        saved: false, outcome: "production_write_disabled", phaseCeiling: "3G",
        productionWriterSupplied: true, authorizationIgnored: true });
    assert.equal(writes, 0); assert.equal(writer.diagnostics.schemaCreation, false);
});

test("projected snapshotとfake adapter結果をdeterministic比較", async () => {
    const writer = Shadow.createDisabledShadowWriter(), projected = await writer.preview({ snapshot: {},
        run, canonicalSet: [await event()] }), comparison = await writer.compareWithFake({
            projectedSnapshot: projected.projectedSnapshot,
            fakeSnapshot: JSON.parse(JSON.stringify(projected.projectedSnapshot)) });
    assert.equal(comparison.equal, true);
});

test("3G moduleはproduction storage/UI/Time Travel等へ非接続", () => {
    const source = fs.readFileSync(path.resolve(__dirname,
        "../js/marketCalendarHistory/disabledShadowWriter.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|createObjectStore|\"readwrite\"/);
    assert.doesNotMatch(source, /document\.|querySelector|setInterval|setTimeout|OverallV2/);
    assert.doesNotMatch(source, /productionWriter\s*\(/);
});
