"use strict";

const Identity = require("./overallTraceIdentityContract.js");
const Observation = require("./overallTraceObservation.js");

const DELTA_CONTRACT_VERSION = 1;
const DELTA_SERIES_ID = "overall-v2-trace-delta";
const MAX_LOGIC_CHANGES = 64;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
const canonical = value => Identity.canonicalize(value);
const same = (left, right) => canonical(left) === canonical(right);
const finite = Number.isFinite;
const cleanNumber = value => Object.is(value, -0) ? 0 : value;
function numericDelta(previous, current) {
    return freeze({ previous: finite(previous) ? previous : null,
        current: finite(current) ? current : null,
        delta: finite(previous) && finite(current) ? cleanNumber(current - previous) : null });
}
function scalarChange(field, previous, current) {
    return freeze({ field, previous: clone(previous ?? null), current: clone(current ?? null) });
}
function changed(left, right) { return !same(left ?? null, right ?? null); }
function identityView(value) {
    return { contractVersion: value.inputSetIdentity.contractVersion,
        schemaVersion: value.inputSetIdentity.schemaVersion,
        option: clone(value.inputSetIdentity.option), weekly: clone(value.inputSetIdentity.weekly) };
}
function observationIdentity(value) {
    return { contractVersion: value.logicIdentity.contractVersion,
        schemaVersion: value.logicIdentity.schemaVersion,
        observationSlot: clone(value.observationSlot), logicIdentity: clone(value.logicIdentity),
        logicIdentityHash: value.logicIdentityHash, inputSetIdentity: identityView(value),
        inputSetIdentityHash: value.inputSetIdentityHash, observationId: value.observationId };
}
function semanticOutput(value) {
    return { status: value.status, direction: value.direction,
        directionLabel: value.directionLabel, confidence: value.confidence,
        coverage: value.coverage, componentSnapshots: clone(value.componentSnapshots),
        confidenceFactors: clone(value.confidenceFactors),
        readinessSummary: clone(value.readinessSummary), resultFacts: clone(value.resultFacts) };
}
function comparableResult(classification, reason, previous = null, current = null) {
    return freeze({ deltaContractVersion: DELTA_CONTRACT_VERSION, deltaId: null,
        previousObservationId: previous?.observationId || null,
        currentObservationId: current?.observationId || null,
        comparability: classification === "first_observation" ? "first_observation" : "not_comparable",
        reason, classification, sessionComparison: null, outputDelta: null,
        componentDeltas: null, confidenceFactorDeltas: null,
        inputIdentityChanges: null, logicIdentityChanges: null,
        readinessChanges: null, fallbackChanges: null, contributionExplanation: null });
}
function leafLogicChanges(previous, current, path = "", output = []) {
    if (output.length > MAX_LOGIC_CHANGES || same(previous, current)) return output;
    if (object(previous) && object(current)) {
        for (const key of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
            leafLogicChanges(previous[key], current[key], path ? `${path}.${key}` : key, output);
            if (output.length > MAX_LOGIC_CHANGES) break;
        }
        return output;
    }
    output.push(scalarChange(path, previous, current));
    return output;
}
function logicChanges(previous, current) {
    const changes = leafLogicChanges(previous.logicIdentity, current.logicIdentity);
    return freeze({ changed: previous.logicIdentityHash !== current.logicIdentityHash,
        previousHash: previous.logicIdentityHash, currentHash: current.logicIdentityHash,
        changedFields: changes.slice(0, MAX_LOGIC_CHANGES),
        truncated: changes.length > MAX_LOGIC_CHANGES });
}
function optionIdentityChanges(left, right) {
    const fields = [];
    const add = (field, a, b) => { if (changed(a, b)) fields.push(scalarChange(field, a, b)); };
    add("option.readinessState", left.readinessState, right.readinessState);
    add("option.reason", left.reason, right.reason);
    add("option.referenceState", left.referenceState, right.referenceState);
    add("option.currentQri.contract", left.currentQri?.contract, right.currentQri?.contract);
    add("option.currentQri.tradingDate", left.currentQri?.tradingDate,
        right.currentQri?.tradingDate);
    add("option.currentQri.pageUpdatedAt", left.currentQri?.pageUpdatedAt,
        right.currentQri?.pageUpdatedAt);
    add("option.currentQriRevision", left.currentQri?.revisionIdentity, right.currentQri?.revisionIdentity);
    add("option.currentQri.versionKey", left.currentQri?.versionKey, right.currentQri?.versionKey);
    add("option.currentQri.canonicalSignature", left.currentQri?.canonicalSignature,
        right.currentQri?.canonicalSignature);
    add("option.previousComparisonQri.contract", left.previousComparisonQri?.contract,
        right.previousComparisonQri?.contract);
    add("option.previousComparisonQri.sourceDate", left.previousComparisonQri?.sourceDate,
        right.previousComparisonQri?.sourceDate);
    add("option.previousComparisonRevision", left.previousComparisonQri?.revisionIdentity,
        right.previousComparisonQri?.revisionIdentity);
    add("option.previousComparisonQri.versionKey", left.previousComparisonQri?.versionKey,
        right.previousComparisonQri?.versionKey);
    add("option.previousComparisonQri.canonicalSignature",
        left.previousComparisonQri?.canonicalSignature,
        right.previousComparisonQri?.canonicalSignature);
    add("option.comparisonFingerprint", left.comparisonFingerprint, right.comparisonFingerprint);
    add("option.futuresQuote.source", left.futuresQuote?.source, right.futuresQuote?.source);
    add("option.futuresQuote.contract", left.futuresQuote?.contract, right.futuresQuote?.contract);
    add("option.futuresQuote.quotedAt", left.futuresQuote?.quotedAt,
        right.futuresQuote?.quotedAt);
    add("option.futuresQuote.value", left.futuresQuote?.value, right.futuresQuote?.value);
    add("option.futuresQuoteVersion", left.futuresQuote?.versionKey, right.futuresQuote?.versionKey);
    add("option.futuresQuoteSignature", left.futuresQuote?.quoteSignature,
        right.futuresQuote?.quoteSignature);
    return freeze({ changed: fields.length > 0, changedFields: fields,
        readinessChanged: left.readinessState !== right.readinessState,
        referenceStateChanged: left.referenceState !== right.referenceState,
        currentQriRevisionChanged: changed(left.currentQri?.revisionIdentity,
            right.currentQri?.revisionIdentity),
        previousComparisonRevisionChanged: changed(left.previousComparisonQri?.revisionIdentity,
            right.previousComparisonQri?.revisionIdentity),
        futuresQuoteChanged: changed(left.futuresQuote, right.futuresQuote) });
}
function weeklyIdentityChanges(left, right) {
    const fields = [];
    const add = (field, a, b) => { if (changed(a, b)) fields.push(scalarChange(field, a, b)); };
    add("weekly.readinessState", left.readinessState, right.readinessState);
    add("weekly.reason", left.reason, right.reason);
    add("weekly.previous.sourceDate", left.previous?.sourceDate, right.previous?.sourceDate);
    add("weekly.previousRevision", left.previous?.versionKey, right.previous?.versionKey);
    add("weekly.previous.signature", left.previous?.signature, right.previous?.signature);
    add("weekly.current.sourceDate", left.current?.sourceDate, right.current?.sourceDate);
    add("weekly.currentRevision", left.current?.versionKey, right.current?.versionKey);
    add("weekly.current.signature", left.current?.signature, right.current?.signature);
    add("weekly.activeVersionKey", left.activeVersionKey, right.activeVersionKey);
    add("weekly.sourceSchemaVersion", left.sourceSchemaVersion, right.sourceSchemaVersion);
    add("weekly.parserVersion", left.parserVersion, right.parserVersion);
    add("weekly.brokerSetVersion", left.brokerSetVersion, right.brokerSetVersion);
    add("weekly.scoringVersion", left.scoringVersion, right.scoringVersion);
    add("weekly.contractExpiries", left.contractExpiries, right.contractExpiries);
    return freeze({ changed: fields.length > 0, changedFields: fields,
        readinessChanged: left.readinessState !== right.readinessState,
        previousRevisionChanged: changed(left.previous?.versionKey, right.previous?.versionKey),
        currentRevisionChanged: changed(left.current?.versionKey, right.current?.versionKey),
        activeVersionChanged: left.activeVersionKey !== right.activeVersionKey,
        scoringVersionChanged: left.scoringVersion !== right.scoringVersion });
}
function inputChanges(previous, current) {
    const option = optionIdentityChanges(previous.inputSetIdentity.option,
        current.inputSetIdentity.option);
    const weekly = weeklyIdentityChanges(previous.inputSetIdentity.weekly,
        current.inputSetIdentity.weekly);
    return freeze({ changed: previous.inputSetIdentityHash !== current.inputSetIdentityHash,
        previousHash: previous.inputSetIdentityHash, currentHash: current.inputSetIdentityHash,
        option, weekly, changedFields: [...option.changedFields, ...weekly.changedFields] });
}
function componentDelta(previous, current, identityChanges) {
    return freeze({ readinessChanged: identityChanges.readinessChanged,
        inputIdentityChanged: identityChanges.changed,
        currentQriRevisionChanged: identityChanges.currentQriRevisionChanged ?? null,
        previousComparisonRevisionChanged:
            identityChanges.previousComparisonRevisionChanged ?? null,
        futuresQuoteChanged: identityChanges.futuresQuoteChanged ?? null,
        currentRevisionChanged: identityChanges.currentRevisionChanged ?? null,
        previousRevisionChanged: identityChanges.previousRevisionChanged ?? null,
        activeVersionChanged: identityChanges.activeVersionChanged ?? null,
        scoringVersionChanged: identityChanges.scoringVersionChanged ?? null,
        rawScore: numericDelta(previous.rawScore, current.rawScore),
        normalizedDirection: numericDelta(previous.normalizedDirection, current.normalizedDirection),
        directionScore: numericDelta(previous.directionScore, current.directionScore),
        effectiveWeight: numericDelta(previous.effectiveWeight, current.effectiveWeight),
        weightedContribution: numericDelta(previous.weightedContribution,
            current.weightedContribution),
        sourceReferenceClass: scalarChange("sourceReferenceClass",
            previous.sourceReferenceClass, current.sourceReferenceClass) });
}
function confidenceDeltas(previous, current) {
    return freeze({ coverage: numericDelta(previous.coverage, current.coverage),
        quality: numericDelta(previous.quality, current.quality),
        evidence: numericDelta(previous.evidence, current.evidence),
        agreement: numericDelta(previous.agreement, current.agreement),
        finalConfidence: numericDelta(previous.resultingConfidence,
            current.resultingConfidence) });
}
function readiness(previous, current) {
    const transition = (field, left, right) => freeze({ field, previous: left,
        current: right, changed: left !== right });
    return freeze({ overall: transition("overall", previous.status, current.status),
        option: transition("option", previous.inputSetIdentity.option.readinessState,
            current.inputSetIdentity.option.readinessState),
        weekly: transition("weekly", previous.inputSetIdentity.weekly.readinessState,
            current.inputSetIdentity.weekly.readinessState),
        coverageSemantic: "componentAvailabilityCoveragePercent" });
}
function fallback(previous, current) {
    const leftOption = previous.componentSnapshots.option;
    const rightOption = current.componentSnapshots.option;
    const leftWeekly = previous.componentSnapshots.weekly;
    const rightWeekly = current.componentSnapshots.weekly;
    return freeze({ option: { previousReferenceState:
        previous.inputSetIdentity.option.referenceState,
    currentReferenceState: current.inputSetIdentity.option.referenceState,
    referenceStateChanged: previous.inputSetIdentity.option.referenceState !==
        current.inputSetIdentity.option.referenceState,
    previousUsingFallback: leftOption.fallbackReferenceFacts.usingFallback,
    currentUsingFallback: rightOption.fallbackReferenceFacts.usingFallback,
    usingFallbackChanged: leftOption.fallbackReferenceFacts.usingFallback !==
        rightOption.fallbackReferenceFacts.usingFallback }, weekly: {
        previousOrigin: leftWeekly.sourceReferenceClass,
        currentOrigin: rightWeekly.sourceReferenceClass,
        originChanged: leftWeekly.sourceReferenceClass !== rightWeekly.sourceReferenceClass },
    componentInclusion: { option: leftOption.readiness !== rightOption.readiness,
        weekly: leftWeekly.readiness !== rightWeekly.readiness } });
}
function contribution(previous, current, componentDeltas) {
    const before = previous.resultFacts.effectiveWeightTotal;
    const after = current.resultFacts.effectiveWeightTotal;
    const denominatorChanged = before !== after;
    const impact = name => {
        const delta = componentDeltas[name].weightedContribution.delta;
        return finite(delta) && !denominatorChanged && before > 0 ? cleanNumber(delta / before * 100) : null;
    };
    const impacts = { option: impact("option"), weekly: impact("weekly") };
    const directionDelta = current.direction - previous.direction;
    const additive = !denominatorChanged && Object.values(impacts).every(finite) &&
        Math.round(impacts.option + impacts.weekly) === directionDelta;
    return freeze({ previousTotalEffectiveWeight: before,
        currentTotalEffectiveWeight: after, denominatorChanged,
        componentWeightedContributionDeltas: {
            option: componentDeltas.option.weightedContribution.delta,
            weekly: componentDeltas.weekly.weightedContribution.delta },
        componentDirectionImpactDeltas: impacts,
        additiveAttributionSupported: additive,
        reason: denominatorChanged ? "effective_weight_denominator_changed" :
            (additive ? null : "rounding_or_normalization_prevents_exact_attribution") });
}
async function deltaId(previousObservationId, currentObservationId) {
    return `${DELTA_SERIES_ID}|sha256:${await Identity.sha256({
        deltaContractVersion: DELTA_CONTRACT_VERSION, previousObservationId,
        currentObservationId })}`;
}

async function projectOverallTraceDelta(previous, current, { allowCrossSession = false } = {}) {
    if (!await Observation.validateTraceObservation(current))
        return comparableResult("not_comparable", "trace_integrity_invalid", previous, current);
    if (!previous) return comparableResult("first_observation", "no_previous_trace", null, current);
    if (!await Observation.validateTraceObservation(previous))
        return comparableResult("not_comparable", "trace_integrity_invalid", previous, current);
    const sameObservation = previous.observationId === current.observationId;
    if (!sameObservation && Date.parse(previous.acceptedAt) >= Date.parse(current.acceptedAt))
        return comparableResult("not_comparable", "chronological_order_invalid", previous, current);
    const sameSession = previous.sessionIdentity.kind === current.sessionIdentity.kind;
    if (!sameSession && !allowCrossSession)
        return comparableResult("not_comparable", "session_incompatible", previous, current);
    const identityClassification = await Identity.classifyIdentityChange(
        observationIdentity(previous), observationIdentity(current));
    if (identityClassification === "not_comparable")
        return comparableResult("not_comparable", "identity_contract_incompatible", previous, current);
    if (identityClassification === "same" && !same(semanticOutput(previous), semanticOutput(current)))
        return comparableResult("not_comparable", "trace_inconsistency", previous, current);
    const classification = identityClassification === "same" ? "unchanged" : identityClassification;
    const inputs = inputChanges(previous, current);
    const components = freeze({ option: componentDelta(previous.componentSnapshots.option,
        current.componentSnapshots.option, inputs.option), weekly: componentDelta(
        previous.componentSnapshots.weekly, current.componentSnapshots.weekly, inputs.weekly) });
    const outputDelta = freeze({ direction: numericDelta(previous.direction, current.direction),
        confidence: numericDelta(previous.confidence, current.confidence),
        coverage: numericDelta(previous.coverage, current.coverage),
        coverageSemantic: "componentAvailabilityCoveragePercent",
        directionLabel: scalarChange("directionLabel", previous.directionLabel,
            current.directionLabel) });
    return freeze({ deltaContractVersion: DELTA_CONTRACT_VERSION,
        deltaId: await deltaId(previous.observationId, current.observationId),
        previousObservationId: previous.observationId,
        currentObservationId: current.observationId, comparability: "comparable", reason: null,
        classification, sessionComparison: sameSession ? "same_session_kind" : "cross_session_explicit",
        outputDelta, componentDeltas: components,
        confidenceFactorDeltas: confidenceDeltas(previous.confidenceFactors,
            current.confidenceFactors), inputIdentityChanges: inputs,
        logicIdentityChanges: logicChanges(previous, current),
        readinessChanges: readiness(previous, current),
        fallbackChanges: fallback(previous, current),
        contributionExplanation: contribution(previous, current, components) });
}

function unwrap(record) { return record?.observation || record; }
async function selectPreviousComparable(records, currentRecord, { allowCrossSession = false } = {}) {
    const current = unwrap(currentRecord);
    if (!await Observation.validateTraceObservation(current))
        return freeze({ status: "not_comparable", reason: "current_trace_invalid",
            previous: null, sessionComparison: null });
    const candidates = [];
    for (const value of Array.isArray(records) ? records : []) {
        const trace = unwrap(value);
        if (!trace || trace.observationId === current.observationId ||
            !await Observation.validateTraceObservation(trace) ||
            Date.parse(trace.acceptedAt) >= Date.parse(current.acceptedAt)) continue;
        const sameSession = trace.sessionIdentity.kind === current.sessionIdentity.kind;
        if (!sameSession && !allowCrossSession) continue;
        candidates.push({ trace, sameSession });
    }
    candidates.sort((left, right) => Date.parse(left.trace.acceptedAt) -
        Date.parse(right.trace.acceptedAt) || Date.parse(left.trace.observedAt) -
        Date.parse(right.trace.observedAt) ||
        left.trace.observationId.localeCompare(right.trace.observationId));
    const selected = candidates.at(-1);
    if (!selected) return freeze({ status: "first_observation", reason: "no_previous_trace",
        previous: null, sessionComparison: null });
    return freeze({ status: "selected", reason: null, previous: clone(selected.trace),
        sessionComparison: selected.sameSession ? "same_session_kind" : "cross_session_explicit" });
}

module.exports = freeze({ DELTA_CONTRACT_VERSION, DELTA_SERIES_ID, MAX_LOGIC_CHANGES,
    projectOverallTraceDelta, selectPreviousComparable });
