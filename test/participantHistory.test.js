const test = require("node:test");
const assert = require("node:assert/strict");
const participant = require("../js/participantData.js");
const historyApi = require("../js/participantHistory.js");

const clone = value => JSON.parse(JSON.stringify(value));
const isoTime = day => `${day}T12:00:00.000Z`;

function participantRows(sourceDate, volume = 100, company = "証券会社") {
    return [
        ["Trading Date", sourceDate.replaceAll("-", "/")],
        ["NK225F", "161090018", "NIKKEI 225 FUT", 1,
            "00123", company, "Broker", volume]
    ];
}

function urlsFor(sourceDate) {
    const compact = sourceDate.replaceAll("-", "");
    const ym = compact.slice(0, 6);
    const base = `https://www.jpx.co.jp/automation/markets/derivatives/participant-volume/files/daily/${ym}/`;
    return {
        dayAuction: `${base}${compact}_volume_by_participant_whole_day.xlsx`,
        dayJnet: `${base}${compact}_volume_by_participant_whole_day_J-NET.xlsx`,
        nightAuction: `${base}${compact}_volume_by_participant_night.xlsx`,
        nightJnet: `${base}${compact}_volume_by_participant_night_J-NET.xlsx`
    };
}

async function makeCompleteSet(sourceDate = "2026-08-14", volume = 100) {
    const parsed = participant.parseParticipantExcel(
        participantRows(sourceDate, volume),
        sourceDate
    );
    const data = Object.fromEntries(
        participant.FILE_KEYS.map(key => [key, clone(parsed)])
    );
    return participant.createCompleteCache({
        data,
        sourceUrls: urlsFor(sourceDate),
        sourceDate,
        fetchedAt: isoTime(sourceDate)
    });
}

async function add(history, completeSet, assessment = "new_version", at) {
    return historyApi.upsertCompleteVersion(
        history,
        completeSet,
        { assessment, confirmedAt: at || isoTime(completeSet.sourceDate) },
        participant.validateParticipantCache
    );
}

test("empty history is valid", async () => {
    assert.equal(await historyApi.validateParticipantHistory(
        historyApi.createEmptyHistory(),
        participant.validateParticipantCache
    ), true);
});

for (const [name, mutate] of [
    ["version不正を拒否", value => { value.version = 2; }],
    ["parserVersion不正を拒否", value => { value.parserVersion = 2; }],
    ["source不正を拒否", value => { value.source = "wrong"; }],
    ["maxEntries不正を拒否", value => { value.maxEntries = 31; }]
]) {
    test(name, async () => {
        const value = historyApi.createEmptyHistory();
        mutate(value);
        assert.equal(await historyApi.validateParticipantHistory(
            value,
            participant.validateParticipantCache
        ), false);
    });
}

async function oneEntryHistory() {
    const result = await add(
        historyApi.createEmptyHistory(),
        await makeCompleteSet()
    );
    return result.history;
}

for (const [name, mutate] of [
    ["壊れたentryを拒否", value => { value.entries[0].sourceDate = "bad"; }],
    ["壊れたrevisionを拒否", value => { value.entries[0].revisions[0].confirmedAt = "bad"; }],
    ["completeSet不正を拒否", value => { value.entries[0].revisions[0].completeSet.status = "partial"; }],
    ["signature不一致を拒否", value => { value.entries[0].revisions[0].signature = "0".repeat(64); }],
    ["versionKey不一致を拒否", value => { value.entries[0].activeVersionKey = "wrong"; }]
]) {
    test(name, async () => {
        const value = await oneEntryHistory();
        mutate(value);
        assert.equal(await historyApi.validateParticipantHistory(
            value,
            participant.validateParticipantCache
        ), false);
    });
}

test("初回completeを追加する", async () => {
    const result = await add(historyApi.createEmptyHistory(), await makeCompleteSet());
    assert.equal(result.outcome, "entry_added");
    assert.equal(result.history.entries.length, 1);
    assert.equal(result.history.entries[0].revisions.length, 1);
});

test("same_versionでも履歴が空なら初回追加する", async () => {
    const result = await add(
        historyApi.createEmptyHistory(),
        await makeCompleteSet(),
        "same_version"
    );
    assert.equal(result.outcome, "entry_added");
    assert.equal(result.history.entries.length, 1);
});

test("same date same versionは重複せずlastSeenAtだけ更新する", async () => {
    const completeSet = await makeCompleteSet();
    const first = await add(historyApi.createEmptyHistory(), completeSet);
    const secondAt = "2026-08-15T13:00:00.000Z";
    const second = await add(first.history, completeSet, "same_version", secondAt);
    assert.equal(second.outcome, "same_version");
    assert.equal(second.history.entries.length, 1);
    assert.equal(second.history.entries[0].revisions.length, 1);
    assert.equal(second.history.entries[0].lastSeenAt, secondAt);
    assert.equal(second.history.entries[0].firstSeenAt, isoTime("2026-08-14"));
});

test("翌日を追加しsourceDate昇順にする", async () => {
    const first = await add(historyApi.createEmptyHistory(), await makeCompleteSet());
    const second = await add(first.history, await makeCompleteSet("2026-08-15"));
    assert.deepEqual(
        second.history.entries.map(entry => entry.sourceDate),
        ["2026-08-14", "2026-08-15"]
    );
});

for (const assessment of ["partial", "failed", "indeterminate", "older_or_inconsistent"]) {
    test(`${assessment}判定は履歴へ追加しない`, async () => {
        const result = await add(
            historyApi.createEmptyHistory(),
            await makeCompleteSet(),
            assessment
        );
        assert.equal(result.changed, false);
        assert.equal(result.history.entries.length, 0);
    });
}

test("mixed-date completeSetを保存しない", async () => {
    const completeSet = await makeCompleteSet();
    completeSet.files.dayAuction.data.sourceDate = "2026-08-13";
    const result = await add(historyApi.createEmptyHistory(), completeSet);
    assert.equal(result.changed, false);
    assert.equal(result.history.entries.length, 0);
});

test("revised same dateをrevisionへ追加しactiveを切り替える", async () => {
    const versionA = await makeCompleteSet("2026-08-14", 100);
    const versionB = await makeCompleteSet("2026-08-14", 200);
    const first = await add(historyApi.createEmptyHistory(), versionA);
    const confirmedAt = "2026-08-15T14:00:00.000Z";
    const revised = await add(
        first.history,
        versionB,
        "revised_same_date",
        confirmedAt
    );
    const entry = revised.history.entries[0];
    assert.equal(revised.outcome, "revision_added");
    assert.equal(revised.history.entries.length, 1);
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.activeVersionKey, versionB.versionKey);
    assert.equal(entry.revisions[0].replacedAt, confirmedAt);
    assert.equal(entry.revisions[1].replacedAt, null);
});

test("同じrevisionは追加しない", async () => {
    const versionA = await makeCompleteSet("2026-08-14", 100);
    const versionB = await makeCompleteSet("2026-08-14", 200);
    const first = await add(historyApi.createEmptyHistory(), versionA);
    const revised = await add(first.history, versionB, "revised_same_date");
    const repeated = await add(revised.history, versionB, "same_version");
    assert.equal(repeated.history.entries[0].revisions.length, 2);
    assert.equal(repeated.history.entries.length, 1);
});

test("別versionをsame_versionとして追加しない", async () => {
    const versionA = await makeCompleteSet("2026-08-14", 100);
    const versionB = await makeCompleteSet("2026-08-14", 200);
    const first = await add(historyApi.createEmptyHistory(), versionA);
    const result = await add(first.history, versionB, "same_version");
    assert.equal(result.outcome, "rejected_revision");
    assert.equal(result.history.entries[0].revisions.length, 1);
});

test("日付逆行を追加しない", async () => {
    const first = await add(
        historyApi.createEmptyHistory(),
        await makeCompleteSet("2026-08-15")
    );
    const result = await add(first.history, await makeCompleteSet("2026-08-14"));
    assert.equal(result.outcome, "older_or_inconsistent");
    assert.equal(result.history.entries.length, 1);
});

test("31件目で最古だけをpruneし最新を維持する", async () => {
    let history = historyApi.createEmptyHistory();
    for (let index = 0; index < 31; index += 1) {
        const sourceDate = new Date(Date.UTC(2026, 0, index + 1))
            .toISOString().slice(0, 10);
        history = (await add(history, await makeCompleteSet(sourceDate, index + 1))).history;
    }
    assert.equal(history.entries.length, 30);
    assert.equal(history.entries[0].sourceDate, "2026-01-02");
    assert.equal(history.entries.at(-1).sourceDate, "2026-01-31");
});

test("revision数はprune件数へ影響しない", async () => {
    const versionA = await makeCompleteSet("2026-08-14", 100);
    const versionB = await makeCompleteSet("2026-08-14", 200);
    const first = await add(historyApi.createEmptyHistory(), versionA);
    const revised = await add(first.history, versionB, "revised_same_date");
    assert.equal(revised.history.entries.length, 1);
    assert.equal(revised.history.entries[0].revisions.length, 2);
});

test("壊れたJSONをinvalidとして安全に無視する", async () => {
    const parsed = await historyApi.parseParticipantHistory(
        "{broken",
        participant.validateParticipantCache
    );
    assert.deepEqual(parsed, { status: "invalid", history: null });
});

test("invalid historyをupsertで自動上書きしない", async () => {
    const invalid = historyApi.createEmptyHistory();
    invalid.version = 99;
    const result = await add(invalid, await makeCompleteSet());
    assert.equal(result.outcome, "invalid_history");
    assert.equal(result.changed, false);
    assert.equal(result.history.version, 99);
});

test("読込時にentriesをsourceDate昇順へ正規化する", async () => {
    const first = await add(historyApi.createEmptyHistory(), await makeCompleteSet("2026-08-14"));
    const second = await add(first.history, await makeCompleteSet("2026-08-15"));
    second.history.entries.reverse();
    const parsed = await historyApi.parseParticipantHistory(
        JSON.stringify(second.history),
        participant.validateParticipantCache
    );
    assert.equal(parsed.status, "ready");
    assert.deepEqual(parsed.history.entries.map(entry => entry.sourceDate), [
        "2026-08-14",
        "2026-08-15"
    ]);
});

test("raw complete setに会社・participantCode・contractを保持する", async () => {
    const result = await add(historyApi.createEmptyHistory(), await makeCompleteSet());
    const record = result.history.entries[0].revisions[0]
        .completeSet.files.dayAuction.data.large.records[0];
    assert.equal(record.participantCode, "00123");
    assert.equal(record.company, "証券会社");
    assert.equal(record.companyEnglish, "Broker");
    assert.equal(record.contractCode, "161090018");
    assert.equal(record.contractName, "NIKKEI 225 FUT");
});

test("summary metadataを算出する", async () => {
    const result = await add(historyApi.createEmptyHistory(), await makeCompleteSet());
    assert.deepEqual(historyApi.summarizeHistory(result.history), {
        entryCount: 1,
        earliestSourceDate: "2026-08-14",
        latestSourceDate: "2026-08-14",
        revisionCount: 1,
        lastSavedAt: "2026-08-14T12:00:00.000Z"
    });
});
