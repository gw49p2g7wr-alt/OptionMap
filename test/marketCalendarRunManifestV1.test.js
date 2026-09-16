"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Manifest = require("../js/marketCalendarHistory/runManifestV1.js");
const Virtual = require("../js/marketCalendarHistory/virtualRunManifestV1.js");
const ACCEPTED = "2026-09-16T06:00:00.000Z", SOURCE = "jp-jpx-market-holidays";
const revisionKey = eventKey => `${eventKey}|sha256:${"a".repeat(64)}`;
async function fixture() { const keys = ["event-b", "event-a"], revisions = keys.map(eventKey => ({
    eventKey, revisionKey: revisionKey(eventKey), sourceId: SOURCE })), semanticSetHash = await Canon.sha256(
        revisions.map(item => item.revisionKey).sort()), run = { runKey: `${SOURCE}|r1`, sourceId: SOURCE,
        runId: "r1", acceptedAt: ACCEPTED, fetchedAt: [ACCEPTED], status: "accepted", semanticSetHash },
        evidence = revisions.map(item => ({ ...item, acceptedAt: ACCEPTED, runId: "r1" })), observations =
        keys.map(eventKey => ({ eventKey, sourceId: SOURCE, runId: "r1", acceptedAt: ACCEPTED,
            state: "observed" })); return { run, runs: [run], evidence, observations, revisions }; }

test("canonical item sortとmanifestHashは入力順に非依存", async () => {
    const value = await fixture(), first = await Virtual.build(value), second = await Virtual.build({ ...value,
        evidence: [...value.evidence].reverse(), observations: [...value.observations].reverse(),
        revisions: [...value.revisions].reverse() });
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.deepEqual(first.manifest, second.manifest); assert.equal(first.manifest.itemCount, 2);
    assert.deepEqual(first.manifest.items.map(item => item.eventKey), ["event-a", "event-b"]);
    assert.equal(await Manifest.manifestHash(first.manifest), first.manifest.manifestHash);
});

test("observed revision集合からsemanticSetHashを再構成してSourceRunと照合", async () => {
    const value = await fixture(), result = await Virtual.build(value);
    assert.equal(result.ok, true); assert.equal(await Manifest.semanticSetHash(result.manifest.items),
        value.run.semanticSetHash); assert.equal((await Manifest.validate(result.manifest,
        { run: value.run })).valid, true);
});

test("SourceRun identity・acceptedAt・sourceId不一致をfail-closed", async () => {
    const value = await fixture(), result = await Virtual.build(value), cases = [
        ["runId", "other", "run_id_mismatch"], ["acceptedAt", "2026-09-16T07:00:00.000Z",
            "accepted_at_mismatch"], ["sourceId", "other", "source_id_mismatch"] ];
    for (const [field, replacement, error] of cases) { const manifest = { ...result.manifest,
        [field]: replacement }; manifest.manifestHash = await Manifest.manifestHash(manifest);
        assert.ok((await Manifest.validate(manifest, { run: value.run })).errors.includes(error)); }
});

test("Manifest欠損・duplicate item・revision conflictをfail-closed", async () => {
    assert.deepEqual((await Manifest.validate(null)).errors, ["manifest_missing"]);
    const value = await fixture(), result = await Virtual.build(value), duplicate = { ...result.manifest,
        items: [...result.manifest.items, result.manifest.items[0]], itemCount: 3 };
    duplicate.manifestHash = await Manifest.manifestHash(duplicate);
    assert.ok((await Manifest.validate(duplicate)).errors.includes("duplicate_item"));
    value.evidence[1].revisionKey = value.evidence[0].revisionKey;
    assert.ok((await Virtual.build(value)).errors.includes("revision_conflict"));
});

test("manifestHashとsemanticSetHashの改変をfail-closed", async () => {
    const value = await fixture(), result = await Virtual.build(value), manifestTamper = { ...result.manifest,
        manifestHash: "0".repeat(64) };
    assert.ok((await Manifest.validate(manifestTamper, { run: value.run })).errors.includes(
        "manifest_hash_mismatch"));
    const semanticTamper = { ...result.manifest, semanticSetHash: "0".repeat(64) };
    semanticTamper.manifestHash = await Manifest.manifestHash(semanticTamper);
    const errors = (await Manifest.validate(semanticTamper, { run: value.run })).errors;
    assert.ok(errors.includes("semantic_set_hash_mismatch"));
    assert.ok(errors.includes("source_run_semantic_set_hash_mismatch"));
});

test("observed evidence欠損とrevision欠損をfail-closed", async () => {
    const value = await fixture(); value.evidence.pop();
    assert.ok((await Virtual.build(value)).errors.includes("observed_evidence_missing"));
    const other = await fixture(); other.revisions.pop();
    assert.ok((await Virtual.build(other)).errors.includes("revision_missing"));
});

test("virtual adapterはpureでstorage・schema mutation APIを持たない", () => {
    for (const file of ["runManifestV1.js", "virtualRunManifestV1.js"]) { const source = fs.readFileSync(
        path.resolve(__dirname, `../js/marketCalendarHistory/${file}`), "utf8");
        assert.doesNotMatch(source, /indexedDB|createObjectStore|deleteObjectStore|["']readwrite["']|\.put\(|objectStore\([^)]*\)\.add\(/); }
});
