"use strict";

const crypto = require("node:crypto");
const Identity = require("./overallTraceIdentityContract.js");

const TRACE_VERSION = 1;
const SCHEMA_VERSION = 1;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { return Identity.canonicalize(value); }
const signature = value => `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const finite = Number.isFinite;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key));
const TOP_FIELDS = Object.freeze(["traceVersion", "schemaVersion", "observationId",
    "observationSlot", "calculatedAt", "observedAt", "acceptedAt", "calendarDay",
    "sessionIdentity", "logicIdentity", "logicIdentityHash", "inputSetIdentity",
    "inputSetIdentityHash", "status", "direction", "directionLabel", "confidence",
    "coverage", "componentSnapshots", "confidenceFactors", "readinessSummary",
    "resultFacts", "sourceBindings", "contentSignature", "signature", "versionKey"]);

function boundedComponent(name, component, inputIdentity) {
    const available = component?.available === true;
    return {
        name,
        readiness: inputIdentity.readinessState,
        reason: inputIdentity.reason,
        sourceReferenceClass: name === "option" ? inputIdentity.referenceState :
            (available ? "formal_history" : "unavailable"),
        exactInputIdentity: clone(inputIdentity),
        rawScore: component?.metadata?.scoreDifference ?? component?.metadata?.scoreDiff ?? null,
        normalizedDirection: available ? component.normalizedDirection : null,
        directionScore: available ? component.directionScore : null,
        baseWeight: component?.baseWeight,
        qualityFactor: available ? component.qualityFactor : null,
        evidenceFactor: available ? component.evidenceFactor : null,
        effectiveWeight: component?.effectiveWeight,
        weightedContribution: component?.weightedContribution,
        fallbackReferenceFacts: name === "option" ? {
            usingFallback: component?.metadata?.usingFallback === true,
            referenceState: inputIdentity.referenceState
        } : { usingFallback: false, referenceState: available ? "current_formal" : "unavailable" }
    };
}

function validComponent(component, input, name) {
    if (!object(component) || component.name !== name ||
        canonical(component.exactInputIdentity) !== canonical(input)) return false;
    const available = input.readinessState === "available";
    if ((component.readiness === "available") !== available) return false;
    if (!finite(component.baseWeight) || !finite(component.effectiveWeight) ||
        !finite(component.weightedContribution)) return false;
    if (!available) return component.normalizedDirection === null &&
        component.directionScore === null && component.qualityFactor === null &&
        component.evidenceFactor === null && component.effectiveWeight === 0 &&
        component.weightedContribution === 0;
    return [component.normalizedDirection, component.directionScore,
        component.qualityFactor, component.evidenceFactor].every(finite) &&
        component.directionScore === component.normalizedDirection * 100 &&
        component.effectiveWeight === component.baseWeight * component.qualityFactor &&
        component.weightedContribution === component.normalizedDirection *
            component.effectiveWeight && component.effectiveWeight > 0;
}

function resultInternallyConsistent(value) {
    const components = [value.componentSnapshots.option, value.componentSnapshots.weekly];
    const available = components.filter(item => item.readiness === "available");
    if (components.some(item => item.baseWeight !== value.logicIdentity.configuredWeights[item.name]))
        return false;
    const effectiveWeightTotal = available.reduce((sum, item) => sum + item.effectiveWeight, 0);
    const expectedDirection = Math.round(Math.min(100, Math.max(-100,
        available.reduce((sum, item) => sum + item.weightedContribution, 0) /
            effectiveWeightTotal * 100)));
    const expectedCoverage = available.length / value.logicIdentity.plannedComponents.length * 100;
    const factors = value.confidenceFactors, weights = value.logicIdentity.confidenceWeights;
    const expectedConfidence = Math.round(Math.min(100, Math.max(0,
        factors.coverage * weights.coverage + factors.quality * weights.quality +
        factors.evidence * weights.evidence + factors.agreement * weights.agreement)));
    return effectiveWeightTotal > 0 && value.resultFacts.effectiveWeightTotal === effectiveWeightTotal &&
        value.direction === expectedDirection && value.coverage === expectedCoverage &&
        value.confidence === expectedConfidence && value.readinessSummary.availableComponentCount ===
            available.length && value.readinessSummary.plannedComponentCount ===
            value.logicIdentity.plannedComponents.length && value.status ===
            (available.length === value.logicIdentity.plannedComponents.length ? "complete" : "partial");
}

async function validIdentity(record) {
    const rebuilt = await Identity.createObservationIdentity({ logic: record.logicIdentity,
        inputs: record.inputSetIdentity, observationSlot: record.observationSlot });
    return rebuilt.accepted === true && rebuilt.identity.observationId === record.observationId &&
        rebuilt.identity.logicIdentityHash === record.logicIdentityHash &&
        rebuilt.identity.inputSetIdentityHash === record.inputSetIdentityHash;
}

async function buildTraceObservation({ identity, envelope, observedAt, acceptedAt,
    generationBinding } = {}) {
    if (!object(identity) || !object(envelope) || !timestamp(observedAt) ||
        !timestamp(acceptedAt) || !object(generationBinding))
        return freeze({ success: false, reason: "trace_input_invalid", observation: null });
    const identityValid = await validIdentity(identity);
    const result = envelope.result;
    if (!identityValid || envelope.formalApplied !== true || envelope.identityVerified !== true ||
        !["complete", "partial"].includes(result?.status) ||
        !timestamp(result?.metadata?.calculatedAt))
        return freeze({ success: false, reason: "accepted_result_invalid", observation: null });
    const option = boundedComponent("option", result.components?.option,
        identity.inputSetIdentity.option);
    const weekly = boundedComponent("weekly", result.components?.weekly,
        identity.inputSetIdentity.weekly);
    if (!validComponent(option, identity.inputSetIdentity.option, "option") ||
        !validComponent(weekly, identity.inputSetIdentity.weekly, "weekly"))
        return freeze({ success: false, reason: "component_binding_invalid", observation: null });
    const coverage = result.metadata.coverage;
    const factors = result.confidenceFactors;
    if (![result.direction, result.confidence, coverage, factors?.coverage, factors?.quality,
        factors?.evidence, factors?.agreement].every(finite) || coverage !== factors.coverage)
        return freeze({ success: false, reason: "result_facts_invalid", observation: null });
    const slot = identity.observationSlot;
    const content = {
        traceVersion: TRACE_VERSION, schemaVersion: SCHEMA_VERSION,
        observationId: identity.observationId, observationSlot: clone(slot),
        calculatedAt: result.metadata.calculatedAt, observedAt, acceptedAt,
        calendarDay: slot.calendarDay, sessionIdentity: clone(slot.sessionIdentity),
        logicIdentity: clone(identity.logicIdentity), logicIdentityHash: identity.logicIdentityHash,
        inputSetIdentity: clone(identity.inputSetIdentity),
        inputSetIdentityHash: identity.inputSetIdentityHash,
        status: result.status, direction: result.direction,
        directionLabel: result.directionLabel, confidence: result.confidence, coverage,
        componentSnapshots: { option, weekly },
        confidenceFactors: { coverage: factors.coverage, quality: factors.quality,
            evidence: factors.evidence, agreement: factors.agreement,
            resultingConfidence: result.confidence },
        readinessSummary: { status: result.status,
            option: identity.inputSetIdentity.option.readinessState,
            weekly: identity.inputSetIdentity.weekly.readinessState,
            availableComponentCount: result.metadata.availableComponentCount,
            plannedComponentCount: result.metadata.plannedComponentCount },
        resultFacts: { direction: result.direction, directionLabel: result.directionLabel,
            confidence: result.confidence, coverage,
            effectiveWeightTotal: result.effectiveWeightTotal,
            plannedComponents: clone(identity.logicIdentity.plannedComponents),
            effectiveComponents: [option, weekly].filter(item => item.readiness === "available")
                .map(item => item.name) },
        sourceBindings: { overallInputFingerprint: envelope.inputFingerprint,
            overallPublicationGeneration: envelope.publicationGeneration,
            generations: clone(generationBinding) }
    };
    const contentSignature = signature(content);
    const signed = { ...content, contentSignature };
    const recordSignature = signature(signed);
    const observation = freeze({ ...signed, signature: recordSignature,
        versionKey: `${identity.observationId}|${recordSignature}` });
    if (!await validateTraceObservation(observation))
        return freeze({ success: false, reason: "trace_consistency_invalid", observation: null });
    return freeze({ success: true, reason: null, observation });
}

async function validateTraceObservation(value) {
    if (!exact(value, TOP_FIELDS) || value.traceVersion !== TRACE_VERSION ||
        value.schemaVersion !== SCHEMA_VERSION || !timestamp(value.calculatedAt) ||
        !timestamp(value.observedAt) || !timestamp(value.acceptedAt) ||
        value.calendarDay !== value.observationSlot?.calendarDay ||
        canonical(value.sessionIdentity) !== canonical(value.observationSlot?.sessionIdentity) ||
        !["complete", "partial"].includes(value.status) ||
        !await validIdentity(value)) return false;
    if (!validComponent(value.componentSnapshots?.option, value.inputSetIdentity.option, "option") ||
        !validComponent(value.componentSnapshots?.weekly, value.inputSetIdentity.weekly, "weekly"))
        return false;
    if (![value.direction, value.confidence, value.coverage,
        value.confidenceFactors?.coverage, value.confidenceFactors?.quality,
        value.confidenceFactors?.evidence, value.confidenceFactors?.agreement,
        value.confidenceFactors?.resultingConfidence,
        value.resultFacts?.effectiveWeightTotal].every(finite) ||
        value.confidenceFactors.resultingConfidence !== value.confidence ||
        value.confidenceFactors.coverage !== value.coverage ||
        value.resultFacts.direction !== value.direction ||
        value.resultFacts.confidence !== value.confidence ||
        value.resultFacts.coverage !== value.coverage || !resultInternallyConsistent(value)) return false;
    const unsigned = clone(value); delete unsigned.versionKey; delete unsigned.signature;
    const storedContentSignature = unsigned.contentSignature; delete unsigned.contentSignature;
    if (signature(unsigned) !== storedContentSignature) return false;
    const signed = { ...unsigned, contentSignature: storedContentSignature };
    const expectedSignature = signature(signed);
    return value.signature === expectedSignature &&
        value.versionKey === `${value.observationId}|${expectedSignature}`;
}

module.exports = freeze({ TRACE_VERSION, SCHEMA_VERSION, TOP_FIELDS, signature,
    buildTraceObservation, validateTraceObservation });
