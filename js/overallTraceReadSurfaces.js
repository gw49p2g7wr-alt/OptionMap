"use strict";

const Delta = require("./overallTraceDelta.js");
const Observation = require("./overallTraceObservation.js");

const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const recordObservation = value => value?.observation || value;
const order = (left, right) => Date.parse(recordObservation(left).acceptedAt) -
    Date.parse(recordObservation(right).acceptedAt) ||
    Date.parse(recordObservation(left).observedAt) - Date.parse(recordObservation(right).observedAt) ||
    recordObservation(left).observationId.localeCompare(recordObservation(right).observationId);

function traceProjection(value) {
    if (!value) return null;
    return freeze({ traceVersion: value.traceVersion, schemaVersion: value.schemaVersion,
        observationId: value.observationId, observationSlot: clone(value.observationSlot),
        calculatedAt: value.calculatedAt, observedAt: value.observedAt,
        acceptedAt: value.acceptedAt, calendarDay: value.calendarDay,
        sessionIdentity: clone(value.sessionIdentity), logicIdentityHash: value.logicIdentityHash,
        inputSetIdentityHash: value.inputSetIdentityHash, status: value.status,
        direction: value.direction, directionLabel: value.directionLabel,
        confidence: value.confidence, coverage: value.coverage,
        coverageSemantic: "componentAvailabilityCoveragePercent",
        componentSnapshots: clone(value.componentSnapshots),
        confidenceFactors: clone(value.confidenceFactors),
        readinessSummary: clone(value.readinessSummary), resultFacts: clone(value.resultFacts),
        sourceBindings: clone(value.sourceBindings), contentSignature: value.contentSignature,
        signature: value.signature, versionKey: value.versionKey });
}

function deltaProjection(value) {
    if (!value) return null;
    return freeze({ deltaContractVersion: value.deltaContractVersion, deltaId: value.deltaId,
        previousObservationId: value.previousObservationId,
        currentObservationId: value.currentObservationId,
        comparability: value.comparability, reason: value.reason,
        classification: value.classification, sessionComparison: value.sessionComparison,
        outputDelta: clone(value.outputDelta), componentDeltas: clone(value.componentDeltas),
        confidenceFactorDeltas: clone(value.confidenceFactorDeltas),
        inputIdentityChanges: clone(value.inputIdentityChanges),
        logicIdentityChanges: clone(value.logicIdentityChanges),
        readinessChanges: clone(value.readinessChanges),
        fallbackChanges: clone(value.fallbackChanges),
        contributionExplanation: clone(value.contributionExplanation) });
}

async function pair(records, currentRecord) {
    const current = recordObservation(currentRecord);
    if (!await Observation.validateTraceObservation(current)) throw new Error("trace_invalid");
    const selected = await Delta.selectPreviousComparable(records, current);
    const previous = selected.previous;
    const delta = await Delta.projectOverallTraceDelta(previous, current);
    return freeze({ persistenceStatus: "trace_saved", current: traceProjection(current),
        previous: traceProjection(previous), change: deltaProjection(delta) });
}

function unavailable(scope, calendarDate, persistenceStatus, reason) {
    return freeze({ status: persistenceStatus === "trace_invalid" ? "invalid" : "unavailable",
        reason, persistenceStatus, scope, calendarDate: calendarDate || null,
        records: [], current: null, previous: null, change: null });
}

function validRequest(request) {
    if (!object(request)) return false;
    const keys = Object.keys(request).sort().join("|");
    return keys === "scope" && request.scope === "current" ||
        keys === "calendarDate|scope" && request.scope === "calendar_day" &&
        validDate(request.calendarDate);
}

function createReadService({ storeFactory, evaluateCurrent } = {}) {
    if (typeof storeFactory !== "function" || typeof evaluateCurrent !== "function")
        throw new Error("trace_read_service_configuration_invalid");
    async function read(request) {
        if (!validRequest(request)) return unavailable(null, null, "trace_unavailable",
            "invalid_argument");
        const scope = request.scope, calendarDate = request.calendarDate || null;
        try {
            const store = storeFactory(), container = await store.load();
            const all = container.stores.overallTraceObservations.slice().sort(order);
            if (scope === "current") {
                const accepted = await evaluateCurrent();
                if (accepted?.status !== "accepted" || !accepted.observation)
                    return unavailable(scope, null, "trace_unavailable",
                        accepted?.reason || "current_trace_authority_unavailable");
                const current = all.find(item => item.observationId ===
                    accepted.observation.observationId);
                if (!current) return unavailable(scope, null, "trace_not_saved",
                    "compatible_trace_not_saved");
                const projected = await pair(all, current);
                return freeze({ status: "available", reason: null, scope, calendarDate: null,
                    records: [projected], ...projected });
            }
            const cutoff = Date.parse(`${calendarDate}T14:59:59.999Z`);
            const known = all.filter(item => Date.parse(item.observation.acceptedAt) <= cutoff);
            const day = known.filter(item => item.observation.calendarDay === calendarDate);
            const latestBySession = new Map();
            day.forEach(item => latestBySession.set(item.observation.sessionIdentity.kind, item));
            const records = [];
            for (const current of [...latestBySession.values()].sort(order))
                records.push(await pair(known, current));
            if (!records.length) return unavailable(scope, calendarDate, "trace_not_saved",
                "trace_not_recorded");
            return freeze({ status: "available", reason: null, persistenceStatus: "trace_saved",
                scope, calendarDate, records, current: records.at(-1).current,
                previous: records.at(-1).previous, change: records.at(-1).change });
        } catch (_error) {
            return unavailable(scope, calendarDate, "trace_invalid", "trace_read_invalid");
        }
    }
    return freeze({ read });
}

module.exports = freeze({ createReadService, traceProjection, deltaProjection, validRequest });
