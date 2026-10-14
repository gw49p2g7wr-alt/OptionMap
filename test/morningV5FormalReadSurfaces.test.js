"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Observation = require("../js/morningV5FormalObservation.js");
const Surfaces = require("../js/morningV5FormalReadSurfaces.js");
const Historical = require("../js/timeTravel/optionMapHistoricalReadModel.js");

const hash = value => `sha256:${value.repeat(64)}`;
function input(overrides = {}) {
    const qriContract = overrides.qriContract || "2026-11", futuresContract = overrides.futuresContract || "2026-12";
    const observedAt = overrides.observedAt || "2026-10-15T09:05:00+09:00";
    const tradingDate = overrides.tradingDate || "2026-10-15";
    const qriVersion = `qri|${qriContract}|${overrides.qriRevision || "1"}`;
    return { observedAt, calendarDay: overrides.calendarDay || "2026-10-15", tradingDate,
        qri: { accepted: true, sourceClass: "formal_live", contract: qriContract,
            tradingDate, canonicalVersionKey: qriVersion,
            signature: hash("a"), confirmedAt: overrides.qriConfirmedAt || "2026-10-15T08:58:00+09:00" },
        weekly: { accepted: true, sourceClass: "formal_history", sourceDate: "2026-10-09",
            previousVersionKey: "weekly-previous", previousSignature: hash("b"),
            currentVersionKey: "weekly-current", currentSignature: hash("c") },
        overall: { formalApplied: true, logicVersion: "overall-v2-weights-55-45-v1",
            inputFingerprint: overrides.overallFingerprint || "overall-1", qriVersionKey: qriVersion,
            weeklyVersionKey: "weekly-current", direction: overrides.direction ?? 20, confidence: 80 },
        futures: { available: true, source: "qri-nikkei225-futures", instrument: "nikkei225_futures",
            contract: futuresContract, value: overrides.price ?? 68250,
            quotedAtNormalized: overrides.quotedAt || "2026-10-15T09:04:00+09:00",
            quoteSignature: overrides.quoteSignature || hash("d"), versionKey: overrides.priceVersion || "price-1" },
        shadowMappingClass: qriContract === futuresContract ? "same_contract_reference" : "explicit_cross_contract_reference",
        freshnessPolicyVersion: "current-price-session-v1",
        calendar: { mode: "read_only", asKnownAt: observedAt, digest: hash("e") },
        calculation: { calculationVersion: "formal-morning-v5-calculation-v1",
            comparisonPolicyVersion: "formal-morning-v5-comparison-v1" } };
}
async function build(overrides = {}, previous = []) {
    const result = await Observation.buildMorningV5FormalObservation(input(overrides), previous);
    assert.equal(result.success, true); return result.observation;
}
const record = (value, supersedesObservationId = null) => ({ observationId: value.observationId,
    observationSlotId: value.observationSlotId, contentSignature: value.contentSignature,
    signature: value.signature, versionKey: value.versionKey, supersedesObservationId, observation: value });
const response = values => ({ status: values.length ? "available" : "missing", reason: null,
    scope: "current", calendarDate: null, records: values });
function dom() { const children = [], document = { createElement: tag => ({ tag, className: "", textContent: "",
    children: [], appendChild(value) { this.children.push(value); } }) };
    return { ownerDocument: document, children, replaceChildren() { this.children = []; },
        appendChild(value) { this.children.push(value); } }; }
const text = node => [node.textContent || "", ...(node.children || []).map(text)].join(" ");

test("U1/U3/U4 current cross-contract first observation displays exact saved metadata", async () => {
    const first = await build(), value = Surfaces.project(response([record(first)]), "current"), container = dom();
    Surfaces.render(container, value);
    assert.equal(value.latest.contractContext.relation, "independent_cross_contract");
    assert.match(text(container), /QRI：2026-11/); assert.match(text(container), /Futures：2026-12/);
    assert.match(text(container), /independent_cross_contract/); assert.match(text(container), /first_observation/);
    assert.match(text(container), /current-price-session-v1/);
});

test("U2 same-contract metadata stays explicit", async () => {
    const value = Surfaces.project(response([record(await build({ qriContract: "2026-12" }))]));
    assert.equal(value.latest.contractContext.relation, "same_contract");
    assert.equal(value.latest.contractContext.qriContract, "2026-12");
    assert.equal(value.latest.contractContext.futuresContract, "2026-12");
});

test("U5-U7 full and one-lane rollover comparisons remain distinct", async () => {
    const base = await build({ observedAt: "2026-10-15T09:00:00+09:00", quotedAt: "2026-10-15T08:59:00+09:00",
        direction: 10, price: 68000, overallFingerprint: "base", quoteSignature: hash("f"), priceVersion: "base-price" });
    const full = await build({ direction: 30, price: 68300, overallFingerprint: "full",
        quoteSignature: hash("1"), priceVersion: "full-price" }, [base]);
    const qriRoll = await build({ qriContract: "2026-12", qriRevision: "2", direction: 30,
        overallFingerprint: "qri-roll", quoteSignature: hash("2") }, [base]);
    const futuresRoll = await build({ futuresContract: "2027-03", direction: 30,
        overallFingerprint: "futures-roll", quoteSignature: hash("3") }, [base]);
    assert.deepEqual([full.comparison.aggregateClass, qriRoll.comparison.aggregateClass,
        qriRoll.comparison.supply.reason, futuresRoll.comparison.aggregateClass,
        futuresRoll.comparison.price.reason], ["full", "partial", "qri_contract_roll",
        "partial", "futures_contract_roll"]);
});

test("U8 missing V5 is explicit and never substitutes V4", () => {
    const value = Surfaces.project(response([])), container = dom(); Surfaces.render(container, value);
    assert.equal(value.status, "missing"); assert.match(text(container), /保存なし/);
    assert.doesNotMatch(JSON.stringify(value), /morning-v4|baselineV4/i);
});

test("T1-T4 exact day, ordering and supersedes chain use only persisted response", async () => {
    const first = await build(), second = await build({ observedAt: "2026-10-15T09:10:00+09:00",
        quotedAt: "2026-10-15T09:09:00+09:00", direction: 25, price: 68300,
        overallFingerprint: "second", quoteSignature: hash("4"), priceVersion: "price-2" }, [first]);
    let requests = 0; const dayResponse = { status: "available", reason: null, scope: "calendar_day",
        calendarDate: "2026-10-15", records: [record(first), record(second, first.observationId)] };
    const result = await Historical.read({ calendarDate: "2026-10-15", indexedDB: new IDBFactory(),
        localStorage: { getItem: () => null }, readMorningV5: async request => {
            requests++; assert.deepEqual(request, { scope: "calendar_day", calendarDate: "2026-10-15" });
            return dayResponse; } });
    const value = Surfaces.project(result.morningV5Formal, "calendar_day");
    assert.equal(requests, 1); assert.deepEqual(value.timeline.map(item => item.observationId),
        [first.observationId, second.observationId]);
    assert.deepEqual(value.supersedesChain, [first.observationId, second.observationId]);
    assert.equal(value.latest.observationId, second.observationId);
});

test("T3 cross-day baseline time resolves only from dedicated persisted baseline metadata", async () => {
    const baseline = await build({ observedAt: "2026-10-14T09:00:00+09:00",
        calendarDay: "2026-10-14", tradingDate: "2026-10-14",
        qriConfirmedAt: "2026-10-14T08:58:00+09:00", quotedAt: "2026-10-14T08:59:00+09:00",
        overallFingerprint: "prior", quoteSignature: hash("5"), priceVersion: "prior-price" });
    const current = await build({ overallFingerprint: "current", quoteSignature: hash("6"),
        priceVersion: "current-price" }, [baseline]);
    const value = Surfaces.project({ status: "available", reason: null, scope: "calendar_day",
        calendarDate: "2026-10-15", records: [record(current)],
        baselines: [{ observationId: baseline.observationId,
            observedAt: baseline.observedAt }] }, "calendar_day");
    assert.equal(value.latest.baselineSelection.baselineObservationId, baseline.observationId);
    assert.equal(value.baselineObservedAt, baseline.observedAt);
    assert.equal(value.timeline.length, 1);
});

test("E1-E3 export is separate, complete, and missing never falls back", async () => {
    const first = await build(), available = Surfaces.exportSection(response([record(first)]));
    assert.equal(available.status, "available"); assert.equal(available.summary.seriesId, "formal-morning-v5");
    assert.equal(available.summary.contractRelation, "independent_cross_contract");
    for (const key of ["sourceIdentities", "contractContext", "freshness", "baselineSelection",
        "comparison", "calculationVersion", "versionKey"]) assert.ok(Object.hasOwn(available.details, key));
    const missing = Surfaces.exportSection(response([]));
    assert.deepEqual([missing.status, missing.summary, missing.details], ["unavailable", null, null]);
});

test("security and isolation: one fixed read bridge, no writer/storage/network in surfaces", () => {
    const root = path.join(__dirname, "..");
    const source = fs.readFileSync(path.join(root, "js/morningV5FormalReadSurfaces.js"), "utf8");
    assert.doesNotMatch(source, /ipcRenderer|ipcMain|localStorage|indexedDB|\bfetch\s*\(|commitAccepted|saveMorning|optionMapMorningBaselinesV4/);
    const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
    assert.equal((preload.match(/read-formal-morning-v5/g) || []).length, 1);
});
