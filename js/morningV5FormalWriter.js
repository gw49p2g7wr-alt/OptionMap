"use strict";

const { randomUUID } = require("node:crypto");
const Observation = require("./morningV5FormalObservation.js");

const WRITER_VERSION = 1;
const RECEIPT_FIELDS = Object.freeze(["receiptVersion", "operationId", "observationId",
    "classification", "transaction", "commit", "readBack", "durableSignature",
    "supersedesObservationId"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function generation(value) { return exact(value, ["qri", "weekly", "overall", "futures"]) &&
    Object.values(value).every(item => typeof item === "string" && item.length > 0); }
function mainOnly() { if (process?.type === "renderer") throw new Error("main_ownership_required"); }

function createMainOwnedWriter({ storeFactory, getCurrentAuthorityBinding,
    createOperationId = randomUUID, faultAt = null } = {}) {
    mainOnly();
    if (typeof storeFactory !== "function" || typeof getCurrentAuthorityBinding !== "function" ||
        typeof createOperationId !== "function" || ![null, "pre_write", "after_readback"].includes(faultAt))
        throw new Error("writer_configuration_invalid");
    const pending = new Map(), activeObservations = new Set(), activeSlots = new Set();
    let closed = false;
    function release(entry) { activeObservations.delete(entry.observation.observationId);
        activeSlots.delete(entry.observation.observationSlotId); }
    async function registerMainAcceptedObservation({ observation, generationBinding } = {}) {
        mainOnly(); if (closed) throw new Error("writer_closed");
        if (!await Observation.validateFormalObservation(observation) || !generation(generationBinding))
            throw new Error("accepted_observation_invalid");
        const current = await getCurrentAuthorityBinding();
        if (!generation(current) || canonical(current) !== canonical(generationBinding))
            throw new Error("authority_generation_stale");
        if (activeObservations.has(observation.observationId) ||
            activeSlots.has(observation.observationSlotId)) throw new Error("writer_single_flight");
        const operationId = createOperationId(), challenge = createOperationId();
        if (typeof operationId !== "string" || !operationId || typeof challenge !== "string" || !challenge)
            throw new Error("operation_identity_invalid");
        const entry = freeze({ operationId, challenge, observation: clone(observation),
            generationBinding: clone(generationBinding) });
        pending.set(operationId, entry); activeObservations.add(observation.observationId);
        activeSlots.add(observation.observationSlotId);
        return freeze({ operationId, observationId: observation.observationId, challenge });
    }
    function receipt(entry, classification, transaction, commit, readBack, durable,
        supersedesObservationId) {
        const value = { receiptVersion: WRITER_VERSION, operationId: entry.operationId,
            observationId: entry.observation.observationId, classification,
            transaction, commit, readBack, durableSignature: durable?.signature || null,
            supersedesObservationId: supersedesObservationId || null };
        if (!exact(value, RECEIPT_FIELDS)) throw new Error("receipt_invalid");
        return freeze(value);
    }
    async function freshReadBack(observation) {
        const fresh = storeFactory({ purpose: "readback" });
        const record = await fresh.readByObservationId(observation.observationId);
        const valid = !!record && await Observation.validateFormalObservation(record.observation);
        const matched = valid && record.observationId === observation.observationId &&
            record.observationSlotId === observation.observationSlotId &&
            record.contentSignature === observation.contentSignature &&
            record.signature === observation.signature && record.versionKey === observation.versionKey &&
            canonical(record.observation.sourceIdentities) === canonical(observation.sourceIdentities) &&
            canonical(record.observation.inputDigests) === canonical(observation.inputDigests) &&
            canonical(record.observation.contractContext) === canonical(observation.contractContext) &&
            canonical(record.observation.freshness) === canonical(observation.freshness) &&
            canonical(record.observation.baselineSelection) === canonical(observation.baselineSelection) &&
            canonical(record.observation.comparison) === canonical(observation.comparison);
        return { record, readBack: { reopened: true, valid, matched } };
    }
    async function commitAcceptedObservation(request) {
        mainOnly();
        if (!exact(request, ["operationId", "observationId", "challenge"]))
            throw new Error("commit_request_invalid");
        const entry = pending.get(request.operationId);
        if (!entry || entry.observation.observationId !== request.observationId ||
            entry.challenge !== request.challenge) throw new Error("challenge_invalid_or_spent");
        pending.delete(request.operationId);
        try {
            const current = await getCurrentAuthorityBinding();
            if (!generation(current) || canonical(current) !== canonical(entry.generationBinding) ||
                !await Observation.validateFormalObservation(entry.observation))
                throw new Error("authority_generation_stale");
            if (faultAt === "pre_write") throw new Error("pre_write_crash");
            let committed;
            try { committed = await storeFactory({ purpose: "write" }).commit(entry.observation); }
            catch (error) {
                const diagnosed = await freshReadBack(entry.observation);
                if (!diagnosed.readBack.matched) return freeze({ status: "failed", reason: error.message,
                    receipt: receipt(entry, error.classification || "none",
                        { count: error.message === "transaction_aborted" ? 1 : 0,
                            committed: 0, aborted: error.message === "transaction_aborted" ? 1 : 0 },
                        "not_committed", diagnosed.readBack, null,
                        error.supersedesObservationId || null) });
                return freeze({ status: "committed", reason: "commit_ambiguity_resolved",
                    receipt: receipt(entry, error.classification ||
                        (diagnosed.record.supersedesObservationId ? "revision" : "new"),
                    { count: 1, committed: 1, aborted: 0 }, "ambiguous_durable",
                    diagnosed.readBack, diagnosed.record, diagnosed.record.supersedesObservationId) });
            }
            const diagnosed = await freshReadBack(entry.observation);
            if (!diagnosed.readBack.matched) return freeze({ status: "failed",
                reason: "fresh_readback_failed", receipt: receipt(entry, committed.classification,
                    { count: committed.transactionCount, committed: committed.committed ? 1 : 0,
                        aborted: committed.aborted ? 1 : 0 }, committed.committed ? "committed" : "not_committed",
                    diagnosed.readBack, null, committed.supersedesObservationId) });
            if (faultAt === "after_readback") throw new Error("receipt_delivery_crash");
            return freeze({ status: committed.committed ? "committed" : "unchanged", reason: null,
                receipt: receipt(entry, committed.classification,
                    { count: committed.transactionCount, committed: committed.committed ? 1 : 0,
                        aborted: committed.aborted ? 1 : 0 }, committed.committed ? "committed" : "not_needed",
                    diagnosed.readBack, diagnosed.record, committed.supersedesObservationId) });
        } finally { release(entry); }
    }
    function close() { closed = true; for (const entry of pending.values()) release(entry); pending.clear(); }
    return freeze({ writerVersion: WRITER_VERSION, registerMainAcceptedObservation,
        commitAcceptedObservation, close });
}

module.exports = freeze({ WRITER_VERSION, RECEIPT_FIELDS, createMainOwnedWriter });
