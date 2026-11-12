"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Identity = require("../js/overallTraceIdentityContract.js");
const Overall = require("../js/overallJudgmentV2.js");
const Observation = require("../js/overallTraceObservation.js");
const Read = require("../js/overallTraceReadSurfaces.js");
const Projection = require("../js/overallTraceReadProjection.js");
const AiSummary = require("../js/fullExportAiSummary.js");
const Historical = require("../js/timeTravel/optionMapHistoricalReadModel.js");

const hex = value => value.repeat(64);
const key = (name, value) => `${name}|sha256:${hex(value)}`;
const generations = { option: "option-1", weekly: "weekly-1",
    overall: "overall-1", futures: "futures-1" };
function option(revision = "a", referenceState = "current_formal") {
    return { readinessState: "available", reason: null, referenceState,
        currentQri: { contract: "2026-11", tradingDate: "2026-11-04",
            pageUpdatedAt: "2026-11-04T07:30:00+09:00",
            revisionIdentity: key("qri-current", revision),
            versionKey: key("qri-current", revision), canonicalSignature: hex(revision) },
        previousComparisonQri: { contract: "2026-11", sourceDate: "2026-11-03T07:30:00+09:00",
            revisionIdentity: key("qri-previous", "b"), versionKey: key("qri-previous", "b"),
            canonicalSignature: hex("b") }, comparisonFingerprint: hex("c"),
        futuresQuote: { source: "qri-nikkei225-futures", contract: "2026-12",
            quotedAt: "2026-11-04T06:00:00+09:00", value: 66480,
            versionKey: key("futures", "d"), quoteSignature: hex("d") } };
}
function weekly(revision = "f") {
    return { readinessState: "available", reason: null,
        previous: { sourceDate: "2026-10-22", versionKey: key("weekly-previous", "e"),
            signature: hex("e") }, current: { sourceDate: "2026-10-29",
            versionKey: key("weekly-current", revision), signature: hex(revision) },
        activeVersionKey: key("weekly-current", revision), sourceSchemaVersion: 2,
        parserVersion: 2, brokerSetVersion: 1, scoringVersion: 2,
        contractExpiries: ["2026-12", "2027-03"] };
}
const component = (direction, quality = 1, evidence = .8, metadata = {}) => ({ available: true,
    normalizedDirection: direction, qualityFactor: quality, evidenceFactor: evidence, metadata });
async function trace({ acceptedAt = "2026-11-04T00:10:00.000Z", observedAt = acceptedAt,
    calendarDay = "2026-11-04", session = "day", logic = Identity.CURRENT_LOGIC_IDENTITY,
    optionInput = option(), weeklyInput = weekly(), optionComponent = component(.4, 1, .8,
        { usingFallback: false, scoreDifference: 3 }),
    weeklyComponent = component(.2, 1, .6, { scoreDiff: .02 }) } = {}) {
    const identity = await Identity.createObservationIdentity({ logic,
        inputs: { option: optionInput, weekly: weeklyInput }, observationSlot: { calendarDay,
            sessionIdentity: { kind: session, key: calendarDay } } });
    const result = Overall.calculateOverallJudgmentV2({ option: optionComponent,
        weekly: weeklyComponent }, "2026-11-04T00:09:00.000Z");
    const built = await Observation.buildTraceObservation({ identity: identity.identity,
        envelope: { formalApplied: true, identityVerified: true, inputFingerprint: hex("9"),
            publicationGeneration: 4, result }, observedAt, acceptedAt,
        generationBinding: generations });
    assert.equal(built.success, true, built.reason);
    return built.observation;
}
const record = observation => ({ observationId: observation.observationId, observation });
function service(records, current) {
    return Read.createReadService({ storeFactory: () => ({ load: async () => ({ stores: {
        overallTraceObservations: records.map(record) } }) }),
    evaluateCurrent: async () => current ? { status: "accepted", observation: current } :
        { status: "unavailable", reason: "authority_unavailable" } });
}
const readCurrent = async (previous, current) => service(previous ? [previous, current] : [current],
    current).read({ scope: "current" });

test("T4-1 first observation exports bounded first_observation", async () => {
    const current = await trace(), result = Projection.exportSection(await readCurrent(null, current));
    assert.equal(result.summary.classification, "first_observation");
    assert.equal(result.details.previous, null);
    assert.equal(JSON.stringify(result).includes("overallTraceObservations"), false);
});

test("T4-2 market-data change exposes input and component facts", async () => {
    const previous = await trace(), changed = option("1"), current = await trace({
        acceptedAt: "2026-11-04T00:20:00.000Z", optionInput: changed });
    const result = Projection.exportSection(await readCurrent(previous, current));
    assert.equal(result.summary.classification, "market_data_change");
    assert.equal(result.summary.logicChanged, false); assert.equal(result.summary.inputChanged, true);
    assert.equal(result.details.current.components.option.currentQriRevisionChanged, true);
});

test("T4-3 logic change exposes bounded changed fields", async () => {
    const logic = structuredClone(Identity.CURRENT_LOGIC_IDENTITY);
    logic.fallbackPolicyVersion = "overall-v2-quality-origin-v2";
    const result = Projection.exportSection(await readCurrent(await trace(), await trace({
        acceptedAt: "2026-11-04T00:20:00.000Z", logic })));
    assert.equal(result.summary.classification, "logic_change");
    assert.deepEqual(result.details.change.logicIdentityChanges.changedFields.map(x => x.field),
        ["fallbackPolicyVersion"]);
});

test("T4-4 readiness unavailable to available is explicit", async () => {
    const unavailable = { readinessState: "unavailable", reason: "missing",
        referenceState: "unavailable" };
    const previous = await trace({ optionInput: unavailable,
        optionComponent: { available: false, reason: "missing" } });
    const current = await trace({ acceptedAt: "2026-11-04T00:20:00.000Z" });
    const result = Projection.exportSection(await readCurrent(previous, current));
    assert.equal(result.summary.readinessChanged, true);
    assert.deepEqual([result.details.change.readinessChanges.option.previous,
        result.details.change.readinessChanges.option.current], ["unavailable", "available"]);
});

test("T4-5 mixed change remains mixed", async () => {
    const logic = structuredClone(Identity.CURRENT_LOGIC_IDENTITY);
    logic.readinessPolicyVersion = "overall-v2-component-availability-v2";
    const result = Projection.exportSection(await readCurrent(await trace(), await trace({
        acceptedAt: "2026-11-04T00:20:00.000Z", logic, optionInput: option("1") })));
    assert.equal(result.summary.classification, "mixed");
});

test("T4-6 confidence factor deltas are projected without recomputation", async () => {
    const previous = await trace(), current = await trace({ acceptedAt: "2026-11-04T00:20:00.000Z",
        optionInput: option("1"), optionComponent: component(.4, 1, .6,
            { usingFallback: false, scoreDifference: 3 }) });
    const result = Projection.exportSection(await readCurrent(previous, current));
    assert.equal(result.details.change.confidenceFactorDeltas.evidence.delta,
        current.confidenceFactors.evidence - previous.confidenceFactors.evidence);
});

test("T4-7 denominator changes disable additive attribution", async () => {
    const unavailable = { readinessState: "unavailable", reason: "missing",
        referenceState: "unavailable" };
    const previous = await trace({ optionInput: unavailable,
        optionComponent: { available: false, reason: "missing" } });
    const result = Projection.exportSection(await readCurrent(previous, await trace({
        acceptedAt: "2026-11-04T00:20:00.000Z" })));
    assert.equal(result.summary.additiveAttributionAvailable, false);
    assert.equal(result.summary.additiveAttributionReason, "effective_weight_denominator_changed");
});

for (const [name, before, after] of [["T4-8 fallback starts", "current_formal", "fallback"],
    ["T4-9 fallback ends", "fallback", "current_formal"]]) test(name, async () => {
    const left = option("a", before), right = option("1", after);
    const previous = await trace({ optionInput: left,
        optionComponent: component(.4, before === "fallback" ? .7 : 1, .8,
            { usingFallback: before !== "current_formal", scoreDifference: 3 }) });
    const current = await trace({ acceptedAt: "2026-11-04T00:20:00.000Z", optionInput: right,
        optionComponent: component(.4, after === "fallback" ? .7 : 1, .8,
            { usingFallback: after !== "current_formal", scoreDifference: 3 }) });
    const result = Projection.exportSection(await readCurrent(previous, current));
    assert.equal(result.summary.fallbackChanged, true);
});

test("T4-10 compatible current authority without saved trace is trace_not_saved", async () => {
    const current = await trace(), response = await service([], current).read({ scope: "current" });
    assert.equal(response.persistenceStatus, "trace_not_saved");
    assert.equal(Projection.exportSection(response).summary.persistenceStatus, "trace_not_saved");
});

test("T4-11 invalid store fails closed", async () => {
    const reader = Read.createReadService({ storeFactory: () => ({ load: async () => {
        throw new Error("store_schema_invalid"); } }), evaluateCurrent: async () => null });
    const response = await reader.read({ scope: "current" });
    assert.equal(response.persistenceStatus, "trace_invalid");
    assert.equal(Projection.exportSection(response).status, "invalid");
});

test("T4-12 same-day sessions return their own latest stored trace", async () => {
    const day = await trace(), night = await trace({ session: "night",
        acceptedAt: "2026-11-04T11:00:00.000Z", observedAt: "2026-11-04T11:00:00.000Z" });
    const response = await service([day, night], night).read({ scope: "calendar_day",
        calendarDate: "2026-11-04" });
    assert.equal(response.records.length, 2);
    assert.deepEqual(response.records.map(x => x.current.sessionIdentity.kind), ["day", "night"]);
    let request = null;
    const historical = await Historical.overallTraceFor(async value => {
        request = value; return response;
    }, "2026-11-04");
    assert.deepEqual(request, { scope: "calendar_day", calendarDate: "2026-11-04" });
    assert.equal(historical.status, "available");
});

test("T4-13 historical selection excludes later accepted records", async () => {
    const historical = await trace({ calendarDay: "2026-11-03",
        acceptedAt: "2026-11-03T00:10:00.000Z", observedAt: "2026-11-03T00:10:00.000Z" });
    const later = await trace();
    const response = await service([historical, later], later).read({ scope: "calendar_day",
        calendarDate: "2026-11-03" });
    assert.equal(response.current.observationId, historical.observationId);
    assert.equal(response.previous, null);
});

test("T4-14 historical day without trace stays not recorded", async () => {
    const response = await service([], null).read({ scope: "calendar_day",
        calendarDate: "2026-11-03" });
    assert.equal(response.reason, "trace_not_recorded");
    assert.equal(response.records.length, 0);
    assert.equal((await Historical.overallTraceFor(null, "2026-11-03")).status, "absent");
    const ui = fs.readFileSync(path.join(__dirname, "../js/optionMapTimeTravelMvp.js"), "utf8");
    assert.match(ui, /trace unavailable \/ not recorded/);
});

test("T4-15 change is additive and writer/schema/score sources remain unchanged", () => {
    const full = fs.readFileSync(path.join(__dirname, "../js/fullExport.js"), "utf8");
    const writer = fs.readFileSync(path.join(__dirname, "../js/overallTraceMainWriter.js"), "utf8");
    const score = fs.readFileSync(path.join(__dirname, "../js/overallJudgmentV2.js"), "utf8");
    assert.doesNotMatch(full, /overallV2Trace.*REQUIRED_SECTION_KEYS/s);
    assert.doesNotMatch(writer, /overallTraceReadSurfaces|read-formal-overall-trace/);
    assert.doesNotMatch(score, /overallTraceReadSurfaces|overallTraceReadProjection/);
});

test("AI consumer receives the bounded why-changed summary and source pointer", async () => {
    const section = Projection.exportSection(await readCurrent(null, await trace()));
    const result = AiSummary.buildFullExportAiSummary({ exportMeta: {
        generatedAt: "2026-11-04T09:00:00+09:00" }, compactSummary: {},
    sections: { overallV2Trace: section }, warnings: [] });
    assert.equal(result.status, "available");
    assert.equal(result.summary.overallV2Trace.sourcePointer, "/sections/overallV2Trace");
    assert.equal(result.summary.overallV2Trace.classification, "first_observation");
    assert.equal(result.summary.readingOrder[0].purpose, "saved_overall_why_changed_trace");
});

test("main exposes a sender-validated read-only trace IPC separate from the writer", () => {
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(main, /ipcMain\.handle\("read-formal-overall-trace", async \(event, request\)/);
    assert.match(main, /overallTraceReadService\.read\(request\)/);
    const block = main.slice(main.indexOf('ipcMain.handle("read-formal-overall-trace"'),
        main.indexOf('ipcMain.handle("acquire-participants"'));
    assert.doesNotMatch(block, /registerMainAcceptedObservation|commitAcceptedObservation|\.commit\(/);
});
