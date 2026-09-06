const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Iv = require("../js/qriOptionIv.js");
const History = require("../js/qriOptionIvHistory.js");

function canonical({ contract = "2026-09", tradingDate = "2026-09-07",
    pageUpdatedAt = "2026-09-07T06:00:00+09:00", value = 30 } = {}) {
    return { parserVersion: 1, schemaVersion: 1, source: Iv.SOURCE,
        sourceUrl: contract === "2026-09" ? "https://svc.qri.jp/jpx/nkopm/" :
            "https://svc.qri.jp/jpx/nkopm/1", valueUnit: "percent_points", contract,
        tradingDate, pageUpdatedAt, lastTradingDate: `${contract}-10`, records: [
            { optionType: "call", strike: 40000,
                iv: { status: "available", value, sourceFormat: "plain_number" } },
            { optionType: "put", strike: 40000,
                iv: { status: "available", value: value + 1, sourceFormat: "plain_number" } }
        ] };
}
const context = (overrides = {}) => ({ acquisitionRole: "active",
    parentMarketRefreshRequestId: "market-1", requestId: "qri-active-1",
    acquisitionGeneration: 1, formalPublicationGeneration: 2,
    parentOptionsVersionKey: "qri-options-v2|parent", fetchedAt: "2026-09-06T21:00:10Z",
    confirmedAt: "2026-09-06T21:00:20Z", formalStatus: "saved",
    origin: "formal_live", ...overrides });
async function candidate(canonicalOverrides = {}, contextOverrides = {}) {
    return (await History.createHistoryCandidate(canonical(canonicalOverrides),
        context(contextOverrides))).candidate;
}

test("fresh empty history is exact and valid", async () => {
    const history = History.createEmptyHistory();
    assert.deepEqual(Object.keys(history), History.HISTORY_FIELDS);
    assert.equal((await History.validateHistory(history)).valid, true);
    assert.equal(Object.isFrozen(history), true);
});

test("candidate reuses canonical signature/version identity and derives entry/snapshot date", async () => {
    const source = canonical(); const built = await History.createHistoryCandidate(source, context());
    assert.equal(built.ok, true);
    assert.equal(built.candidate.entryKey, "2026-09|2026-09-07");
    assert.equal(built.candidate.signature, await Iv.createSignature(source));
    assert.equal(built.candidate.versionKey, await Iv.createVersionKey(source));
    assert.equal(built.candidate.snapshotDate, "2026-09-07");
    const revision = structuredClone(built.candidate); delete revision.entryKey;
    assert.equal((await History.validateRevision(revision,
        { contract: "2026-09", tradingDate: "2026-09-07" })).valid, true);
});

test("snapshot date follows JST and cannot be supplied independently", () => {
    assert.equal(History.snapshotDateFromConfirmedAt("2026-09-07T14:59:59.999Z"), "2026-09-07");
    assert.equal(History.snapshotDateFromConfirmedAt("2026-09-07T15:00:00.000Z"), "2026-09-08");
});

test("all three acquisition roles are valid and unknown provenance fails closed", async () => {
    for (const role of ["active", "next", "major_sq"])
        assert.equal((await History.createHistoryCandidate(canonical(),
            context({ acquisitionRole: role }))).ok, true);
    for (const overrides of [{ acquisitionRole: "other" }, { requestId: "" },
        { acquisitionGeneration: 0.5 }, { formalPublicationGeneration: -1 },
        { confirmedAt: "bad" }]) assert.equal((await History.createHistoryCandidate(canonical(),
            context(overrides))).reason, "confirmation_invalid");
});

test("strict revision and history validation reject identity, metadata and extra-field corruption", async () => {
    const first = await candidate();
    const history = (await History.mergeCandidate(History.createEmptyHistory(), first)).history;
    const mutations = [
        value => { value.extra = true; },
        value => { value.entries[0].extra = true; },
        value => { value.entries[0].entryKey = "wrong"; },
        value => { value.entries[0].activeVersionKey = "missing"; },
        value => { value.entries[0].revisions[0].extra = true; },
        value => { value.entries[0].revisions[0].contract = "2026-10"; },
        value => { value.entries[0].revisions[0].tradingDate = "2026-09-08"; },
        value => { value.entries[0].revisions[0].sourceUrl += "x"; },
        value => { value.entries[0].revisions[0].pageUpdatedAt = "2026-09-07T07:00:00+09:00"; },
        value => { value.entries[0].revisions[0].lastTradingDate = "2026-09-11"; },
        value => { value.entries[0].revisions[0].signature = "0".repeat(64); },
        value => { value.entries[0].revisions[0].versionKey += "x"; },
        value => { value.entries[0].revisions[0].snapshotDate = "2026-09-06"; },
        value => { value.entries[0].revisions[0].confirmedAt = "bad"; },
        value => { value.entries[0].revisions.push(structuredClone(value.entries[0].revisions[0])); }
    ];
    for (const mutate of mutations) {
        const broken = structuredClone(history); mutate(broken);
        assert.equal((await History.validateHistory(broken)).valid, false);
    }
});

test("canonical-only identity mismatches are rejected independently", async () => {
    const first = await candidate();
    const base = structuredClone(first); delete base.entryKey;
    for (const mutate of [
        value => { value.canonical.contract = "2026-10"; },
        value => { value.canonical.tradingDate = "2026-09-08"; },
        value => { value.canonical.sourceUrl = "https://svc.qri.jp/jpx/nkopm/1"; },
        value => { value.canonical.pageUpdatedAt = "2026-09-07T07:00:00+09:00"; },
        value => { value.canonical.lastTradingDate = "2026-09-11"; }
    ]) {
        const revision = structuredClone(base); mutate(revision);
        assert.equal((await History.validateRevision(revision,
            { contract: "2026-09", tradingDate: "2026-09-07" })).valid, false);
    }
});

test("confirmation schema is exact and deterministic", async () => {
    const first = await candidate(); const valid = first.confirmations[0];
    assert.equal(History.validateConfirmation(valid).valid, true);
    const extra = { ...valid, extra: true };
    assert.equal(History.validateConfirmation(extra).valid, false);
    const initial = (await History.mergeCandidate(History.createEmptyHistory(), first)).history;
    const later = await History.createHistoryCandidate(first.canonical,
        context({ acquisitionRole: "major_sq", requestId: "major-request",
            confirmedAt: "2026-09-06T21:10:00Z", formalStatus: "unchanged" }));
    const next = await History.createHistoryCandidate(first.canonical,
        context({ acquisitionRole: "next", requestId: "next-request",
            confirmedAt: "2026-09-06T21:05:00Z", formalStatus: "unchanged" }));
    const left = await History.mergeCandidate((await History.mergeCandidate(initial,
        later.candidate)).history, next.candidate);
    const right = await History.mergeCandidate((await History.mergeCandidate(initial,
        next.candidate)).history, later.candidate);
    assert.equal(History.serialize(left.history), History.serialize(right.history));
});

test("merge creates contracts/dates/revisions and maintains active replacement", async () => {
    let history = History.createEmptyHistory();
    for (const item of [await candidate(),
        await candidate({ tradingDate: "2026-09-08", pageUpdatedAt: "2026-09-08T06:00:00+09:00" },
            { requestId: "qri-active-2", confirmedAt: "2026-09-07T21:00:20Z" }),
        await candidate({ contract: "2026-10" }, { acquisitionRole: "next",
            requestId: "qri-next-1" })]) {
        const merged = await History.mergeCandidate(history, item); assert.equal(merged.changed, true);
        history = merged.history;
    }
    assert.deepEqual(History.listContracts(history), ["2026-09", "2026-10"]);
    assert.deepEqual(History.listTradingDates(history, "2026-09"), ["2026-09-07", "2026-09-08"]);
    const revised = await candidate({ value: 35, pageUpdatedAt: "2026-09-07T07:00:00+09:00" },
        { requestId: "qri-active-3", confirmedAt: "2026-09-06T22:00:20Z" });
    const merged = await History.mergeCandidate(history, revised); history = merged.history;
    const entry = History.getEntry(history, "2026-09", "2026-09-07");
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, revised.confirmedAt);
    assert.equal(entry.activeVersionKey, revised.versionKey);
    assert.equal(History.getActiveRevision(history, "2026-09", "2026-09-07").versionKey,
        revised.versionKey);
});

test("same revision merges distinct confirmations and exact duplicates are a no-op", async () => {
    const first = await candidate();
    let merged = await History.mergeCandidate(History.createEmptyHistory(), first);
    const unchanged = await History.createHistoryCandidate(first.canonical,
        context({ acquisitionRole: "next", requestId: "qri-next-2",
            formalStatus: "unchanged", confirmedAt: "2026-09-06T21:05:00Z" }));
    const withRole = await History.mergeCandidate(merged.history, unchanged.candidate);
    assert.equal(withRole.outcome, "confirmation_added");
    assert.equal(withRole.history.entries[0].revisions[0].confirmations.length, 2);
    const anotherRequest = await History.createHistoryCandidate(first.canonical,
        context({ requestId: "qri-active-4", acquisitionGeneration: 3,
            confirmedAt: "2026-09-06T21:06:00Z", formalStatus: "unchanged" }));
    merged = await History.mergeCandidate(withRole.history, anotherRequest.candidate);
    assert.equal(merged.history.entries[0].revisions[0].confirmations.length, 3);
    const duplicate = await History.mergeCandidate(merged.history, anotherRequest.candidate,
        { changedAt: "2026-09-06T22:00:00Z" });
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.outcome, "same_version");
    assert.equal(duplicate.history.updatedAt, merged.history.updatedAt);
});

test("invalid candidate is non-mutating and output is frozen/deterministic", async () => {
    const first = await candidate(); const empty = History.createEmptyHistory();
    const before = structuredClone({ empty, first });
    const broken = structuredClone(first); broken.signature = "0".repeat(64);
    const invalid = await History.mergeCandidate(empty, broken);
    assert.equal(invalid.changed, false); assert.deepEqual({ empty, first }, before);
    const left = await History.mergeCandidate(empty, first);
    const right = await History.mergeCandidate(empty, structuredClone(first));
    assert.equal(History.serialize(left.history), History.serialize(right.history));
    assert.equal(Object.isFrozen(left.history), true);
    assert.equal(Object.isFrozen(left.history.entries[0].revisions[0].canonical.records), true);
});

test("history foundation has no runtime, storage, network, DOM or dynamic code", () => {
    const source = fs.readFileSync("js/qriOptionIvHistory.js", "utf8");
    for (const token of ["indexedDB", "localStorage", "fetch(", "innerHTML", "eval(", "Function("])
        assert.doesNotMatch(source, new RegExp(token.replace("(", "\\(")));
});
