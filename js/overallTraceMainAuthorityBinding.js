"use strict";

const crypto = require("node:crypto");
const Identity = require("./overallTraceIdentityContract.js");
const Observation = require("./overallTraceObservation.js");
const TradingDate = require("./qriTradingDateContext.js");

const BINDING_VERSION = 1;
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { return Identity.canonicalize(value); }
const digest = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");

function generationOf(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const option = snapshot.optionEvidence, weekly = snapshot.weekly,
        overall = snapshot.overall, futures = snapshot.futures;
    if (!Number.isSafeInteger(option?.publicationGeneration) ||
        !Number.isSafeInteger(weekly?.publicationGeneration) ||
        !Number.isSafeInteger(overall?.publicationGeneration) ||
        !Number.isSafeInteger(futures?.publicationGeneration)) return null;
    return freeze({
        option: `${option.publicationGeneration}|${digest({ status: option.status,
            reason: option.reason || null,
            evidence: option.comparisonEnvelope?.evidenceFingerprint || null })}`,
        weekly: `${weekly.publicationGeneration}|${digest({ status: weekly.status,
            reason: weekly.reason || null,
            fingerprint: weekly.fact?.sourceFingerprint || null,
            contractExpiries: Array.isArray(snapshot.weeklyContractExpiries)
                ? snapshot.weeklyContractExpiries : [] })}`,
        overall: `${overall.publicationGeneration}|${digest({ status: overall.status,
            reason: overall.reason || null,
            fingerprint: overall.envelope?.inputFingerprint || null })}`,
        futures: `${futures.publicationGeneration}|${digest({ status: futures.status,
            reason: futures.reason || null, versionKey: futures.fact?.versionKey || null })}`
    });
}

function createMainAuthorityBinding({ getFreshSnapshot, now = () => new Date().toISOString() } = {}) {
    if (typeof getFreshSnapshot !== "function" || typeof now !== "function")
        throw new Error("main_authority_binding_configuration_invalid");
    async function currentAuthorityBinding() { return generationOf(await getFreshSnapshot()); }
    async function evaluate() {
        const snapshot = await getFreshSnapshot(), startGeneration = generationOf(snapshot);
        const envelope = snapshot?.overall?.envelope;
        if (!startGeneration || snapshot?.overall?.status !== "available" || !envelope)
            return freeze({ status: "unavailable", reason: "authority_unavailable",
                writeCandidate: false, observation: null, generationBinding: null });
        const observedAt = now(), session = TradingDate.sessionOf(observedAt);
        if (!session) return freeze({ status: "unavailable", reason: "session_invalid",
            writeCandidate: false, observation: null, generationBinding: null });
        const builtIdentity = await Identity.adaptCurrentEnvelope({ envelope,
            optionComparisonEnvelope: snapshot.optionEvidence?.comparisonEnvelope || null,
            futuresQuoteFact: snapshot.futures?.fact || null,
            weeklyFact: snapshot.weekly?.fact || null,
            weeklyContractExpiries: Array.isArray(snapshot.weeklyContractExpiries)
                ? snapshot.weeklyContractExpiries : [],
            observationSlot: { calendarDay: session.calendarDate,
                sessionIdentity: { kind: session.kind, key: session.key } } });
        if (!builtIdentity.accepted) return freeze({ status: "unavailable",
            reason: builtIdentity.reason, writeCandidate: false, observation: null,
            generationBinding: null });
        const endGeneration = await currentAuthorityBinding();
        if (!endGeneration || canonical(startGeneration) !== canonical(endGeneration))
            return freeze({ status: "unavailable", reason: "authority_generation_stale",
                writeCandidate: false, observation: null, generationBinding: null });
        const built = await Observation.buildTraceObservation({ identity: builtIdentity.identity,
            envelope, observedAt, acceptedAt: now(), generationBinding: startGeneration });
        if (!built.success) return freeze({ status: "unavailable", reason: built.reason,
            writeCandidate: false, observation: null, generationBinding: null });
        return freeze({ status: "accepted", reason: null, writeCandidate: true,
            observation: clone(built.observation), generationBinding: clone(startGeneration) });
    }
    return freeze({ bindingVersion: BINDING_VERSION, generationOf, evaluate,
        currentAuthorityBinding });
}
module.exports = freeze({ BINDING_VERSION, generationOf, createMainAuthorityBinding });
