"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const participant = require("../js/participantData.js");
const historyApi = require("../js/participantHistory.js");
const Preview = require("../js/formalArchive/participantFormalArchiveMigrationPreview.js");
const clone = value => JSON.parse(JSON.stringify(value));
function rows(sourceDate, volume = 100) { return [["Trading Date", sourceDate.replaceAll("-", "/")],
    ["NK225F", "161090018", "NIKKEI 225 FUT", 1, "00123", "証券会社", "Broker", volume]]; }
function urls(sourceDate) { const compact = sourceDate.replaceAll("-", ""), ym = compact.slice(0, 6),
    base = `https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/${ym}/`;
    return { dayAuction: `${base}${compact}_volume_by_participant_whole_day.xlsx`,
        dayJnet: `${base}${compact}_volume_by_participant_whole_day_J-NET.xlsx`,
        nightAuction: `${base}${compact}_volume_by_participant_night.xlsx`,
        nightJnet: `${base}${compact}_volume_by_participant_night_J-NET.xlsx` }; }
async function complete(sourceDate, volume = 100) { const parsed = participant.parseParticipantExcel(
    rows(sourceDate, volume), sourceDate), data = Object.fromEntries(participant.FILE_KEYS.map(key =>
        [key, clone(parsed)])); return participant.createCompleteCache({ data, sourceUrls: urls(sourceDate),
            sourceDate, fetchedAt: `${sourceDate}T12:00:00.000Z` }); }
async function fixture() { let history = historyApi.createEmptyHistory();
    for (const sourceDate of ["2026-09-11", "2026-09-14"]) { const result =
        await historyApi.upsertCompleteVersion(history, await complete(sourceDate),
            { assessment: "new_version", confirmedAt: `${sourceDate}T12:00:00.000Z` },
            participant.validateParticipantCache); history = result.history; }
    const revised = await historyApi.upsertCompleteVersion(history, await complete("2026-09-14", 200),
        { assessment: "revised_same_date", confirmedAt: "2026-09-14T13:00:00.000Z" },
        participant.validateParticipantCache); return revised.history; }
test("valid 30-day source projects every Participant semantic into memory", async () => {
    const source = await fixture(), result = await Preview.previewMigration(source);
    assert.equal(result.semanticEquivalenceStatus, "PASS");
    assert.equal(result.counts.sourceDateCount, 2); assert.equal(result.counts.sourceRevisionCount, 3);
    assert.equal(result.counts.activeRevisionCount, 2); assert.equal(result.counts.migratableCount, 3);
    assert.equal(result.counts.nonMigratableCount, 0); assert.equal(result.failures.length, 0);
    assert.equal(result.counts.projectedActiveRevisionCount, 2);
    assert.equal(result.counts.projectedReplacedRevisionCount, 1);
    assert.equal(result.counts.versionKeyCount, 3); assert.equal(result.counts.contentSignatureCount, 3);
    assert.equal(result.counts.completeSetCount, 3);
    assert.equal(result.projectedArchive.entries.length, 2);
    const revisions = result.projectedArchive.revisions;
    assert.equal(revisions.filter(item => item.revisionState === "active").length, 2);
    assert.equal(revisions.filter(item => item.revisionState === "replaced").length, 1);
    assert.equal(revisions.every(item => item.contentSignature === item.signature &&
        item.completeSet.versionKey === item.versionKey), true);
    assert.match(result.sourceFingerprint, /^[0-9a-f]{64}$/);
    assert.match(result.projectedArchiveFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.diagnostics.databaseOpened, false);
});
test("invalid completeSet is blocked with record-level reason and no fabrication", async () => {
    const source = await fixture(); source.entries[0].revisions[0].completeSet.status = "partial";
    const result = await Preview.previewMigration(source);
    assert.equal(result.semanticEquivalenceStatus, "FAIL");
    assert.equal(result.counts.nonMigratableCount, 1);
    assert.deepEqual(result.failures[0].reasons, ["complete_set_invalid"]);
});
test("duplicate and conflicting identities block every affected revision", async () => {
    const source = await fixture(), duplicate = clone(source.entries[0]);
    duplicate.sourceDate = source.entries[1].sourceDate;
    const revision = duplicate.revisions[0]; revision.completeSet.sourceDate = duplicate.sourceDate;
    source.entries.push(duplicate); const result = await Preview.previewMigration(source);
    assert.equal(result.semanticEquivalenceStatus, "FAIL"); assert.ok(result.duplicates.length > 0);
    assert.ok(result.failures.some(item => item.reasons.includes("duplicate_source_date")));
});
