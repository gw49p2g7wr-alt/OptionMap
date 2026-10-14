"use strict";

const crypto = require("node:crypto");
const Authority = require("./morningV5FormalAuthority.js");
const Observation = require("./morningV5FormalObservation.js");

const BINDING_VERSION = 1;
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
const digest = value => `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
const generation = value => value && ["qri", "weekly", "overall", "futures"].every(key => text(value[key]));

function generationOf(snapshot) {
    const qri = snapshot?.qri, weekly = snapshot?.weekly, overall = snapshot?.overall;
    const reference = snapshot?.reference;
    if (qri?.status !== "available" || weekly?.status !== "available" ||
        overall?.status !== "available" || reference?.status !== "available") return null;
    const value = {
        qri: `${qri.publicationGeneration}|${qri.fact?.generation?.fingerprint || ""}`,
        weekly: `${weekly.publicationGeneration}|${weekly.fact?.generation?.fingerprint || ""}`,
        overall: `${overall.publicationGeneration}|${overall.envelope?.inputFingerprint || ""}`,
        futures: `${reference.publicationGeneration}|${reference.fact?.versionKey || ""}`
    };
    return generation(value) ? freeze(value) : null;
}

function inputOf(snapshot, calendar, observedAt) {
    const qri = snapshot?.qri?.fact, weekly = snapshot?.weekly?.fact;
    const pair = snapshot?.weeklyCandidate?.metadata, overall = snapshot?.overall?.envelope;
    const reference = snapshot?.reference, futures = reference?.fact, mapping = reference?.mapping;
    if (!qri || !weekly || !pair?.previous || !pair?.current || !overall || !futures || !mapping)
        return null;
    if (pair.previous.versionKey !== weekly.previousVersionKey ||
        pair.current.versionKey !== weekly.currentVersionKey ||
        pair.current.signature !== weekly.currentSignature ||
        pair.activeVersionKey !== pair.current.versionKey || pair.activeVersionMatched !== true)
        return null;
    if (mapping.optionContract !== qri.contract || mapping.referenceContract !== futures.contract ||
        mapping.referenceVersionKey !== futures.versionKey ||
        mapping.formalTradingDate !== qri.tradingDate) return null;
    const calendarDay = new Date(Date.parse(observedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { observedAt, calendarDay, tradingDate: qri.tradingDate,
        qri: { accepted: true, sourceClass: qri.sourceClass, contract: qri.contract,
            tradingDate: qri.tradingDate, canonicalVersionKey: qri.canonicalVersionKey,
            signature: qri.canonicalSignature, confirmedAt: qri.fetchedAt },
        weekly: { accepted: true, sourceClass: weekly.sourceClass,
            sourceDate: pair.current.sourceDate, previousVersionKey: pair.previous.versionKey,
            previousSignature: pair.previous.signature, currentVersionKey: pair.current.versionKey,
            currentSignature: pair.current.signature },
        overall: { formalApplied: overall.formalApplied, logicVersion: overall.logicVersion,
            inputFingerprint: overall.inputFingerprint,
            qriVersionKey: overall.optionSourceIdentity?.canonicalVersionKey,
            weeklyVersionKey: overall.weeklySourceIdentity?.currentVersionKey,
            direction: overall.result?.direction, confidence: overall.result?.confidence },
        futures: { available: futures.available, source: futures.source,
            instrument: futures.instrument, contract: futures.contract, value: futures.value,
            quotedAtNormalized: futures.quotedAtNormalized, quoteSignature: futures.quoteSignature,
            versionKey: futures.versionKey },
        shadowMappingClass: mapping.mappingClass,
        freshnessPolicyVersion: Authority.FRESHNESS_POLICY_VERSION,
        calendar: { mode: "read_only", asKnownAt: calendar.asKnownAt, digest: calendar.digest },
        calculation: { calculationVersion: Authority.CALCULATION_VERSION,
            comparisonPolicyVersion: Authority.COMPARISON_POLICY_VERSION } };
}

function createMainAuthorityBinding({ getFreshSnapshot, getCalendarContext, storeFactory,
    now = () => new Date().toISOString() } = {}) {
    if (typeof getFreshSnapshot !== "function" || typeof getCalendarContext !== "function" ||
        typeof storeFactory !== "function" || typeof now !== "function")
        throw new Error("main_authority_binding_configuration_invalid");
    async function currentAuthorityBinding() {
        const sources = generationOf(await getFreshSnapshot());
        const observedAt = now(), rawCalendar = await getCalendarContext(observedAt);
        if (!sources || !rawCalendar || !text(rawCalendar.asKnownAt)) return null;
        return freeze({ ...sources, overall: `${sources.overall}|${digest(rawCalendar.value)}` });
    }
    async function evaluate() {
        const start = await getFreshSnapshot(), sourceGeneration = generationOf(start);
        if (!sourceGeneration) return freeze({ status: "unavailable", reason: "authority_unavailable",
            writeCandidate: false, observation: null, generationBinding: null });
        const observedAt = now(), rawCalendar = await getCalendarContext(observedAt);
        const calendar = rawCalendar && text(rawCalendar.asKnownAt) ? { asKnownAt: rawCalendar.asKnownAt,
            digest: digest(rawCalendar.value) } : null;
        if (!calendar) return freeze({ status: "unavailable", reason: "calendar_context_invalid",
            writeCandidate: false, observation: null, generationBinding: null });
        const startGeneration = freeze({ ...sourceGeneration,
            overall: `${sourceGeneration.overall}|${calendar.digest}` });
        const input = inputOf(start, calendar, observedAt);
        if (!input) return freeze({ status: "unavailable", reason: "authority_binding_invalid",
            writeCandidate: false, observation: null, generationBinding: null });
        const endGeneration = await currentAuthorityBinding();
        if (!endGeneration || canonical(startGeneration) !== canonical(endGeneration))
            return freeze({ status: "unavailable", reason: "authority_generation_stale",
                writeCandidate: false, observation: null, generationBinding: null });
        const previous = (await storeFactory({ purpose: "authority_read" }).load()).observations
            .map(record => record.observation);
        const built = await Observation.buildMorningV5FormalObservation(input, previous);
        if (!built.success) return freeze({ status: "unavailable", reason: built.reason,
            writeCandidate: false, observation: null, generationBinding: null });
        return freeze({ status: "accepted", reason: null, writeCandidate: true,
            observation: clone(built.observation), generationBinding: clone(startGeneration) });
    }
    return freeze({ bindingVersion: BINDING_VERSION, evaluate, currentAuthorityBinding });
}

module.exports = freeze({ BINDING_VERSION, digest, generationOf, inputOf, createMainAuthorityBinding });
