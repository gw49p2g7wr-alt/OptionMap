"use strict";

const { randomUUID } = require("node:crypto");
const Observation = require("./overallTraceObservation.js");

const WRITER_VERSION = 1;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function binding(value) { return object(value) && ["option", "weekly", "overall", "futures"]
    .every(key => typeof value[key] === "string" && value[key]); }
function mainOnly() { if (process?.type === "renderer") throw new Error("main_ownership_required"); }

function createMainOwnedWriter({ storeFactory, getCurrentAuthorityBinding,
    createOperationId = randomUUID } = {}) {
    mainOnly();
    if (typeof storeFactory !== "function" || typeof getCurrentAuthorityBinding !== "function" ||
        typeof createOperationId !== "function") throw new Error("writer_configuration_invalid");
    const pending = new Map(), active = new Set(); let closed = false;
    async function registerMainAcceptedObservation({ observation, generationBinding } = {}) {
        mainOnly(); if (closed) throw new Error("writer_closed");
        if (!await Observation.validateTraceObservation(observation) || !binding(generationBinding))
            throw new Error("accepted_observation_invalid");
        const current = await getCurrentAuthorityBinding();
        if (!binding(current) || canonical(current) !== canonical(generationBinding))
            throw new Error("authority_generation_stale");
        if (active.has(observation.observationId)) throw new Error("writer_single_flight");
        const operationId = createOperationId(), challenge = createOperationId();
        const entry = freeze({ operationId, challenge, observation: clone(observation),
            generationBinding: clone(generationBinding) });
        pending.set(operationId, entry); active.add(observation.observationId);
        return freeze({ operationId, observationId: observation.observationId, challenge });
    }
    async function commitAcceptedObservation(request) {
        mainOnly();
        const entry = object(request) ? pending.get(request.operationId) : null;
        if (!entry || request.observationId !== entry.observation.observationId ||
            request.challenge !== entry.challenge) throw new Error("challenge_invalid_or_spent");
        pending.delete(entry.operationId);
        try {
            const current = await getCurrentAuthorityBinding();
            if (!binding(current) || canonical(current) !== canonical(entry.generationBinding) ||
                !await Observation.validateTraceObservation(entry.observation))
                throw new Error("authority_generation_stale");
            let committed;
            try { committed = await storeFactory({ purpose: "write" }).commit(entry.observation); }
            catch (error) {
                const record = await storeFactory({ purpose: "readback" })
                    .readByObservationId(entry.observation.observationId);
                if (!record || record.observation.signature !== entry.observation.signature)
                    return freeze({ status: "failed", reason: error.message,
                        transactionCount: error.message === "transaction_aborted" ? 1 : 0,
                        committed: false, readBack: false });
                return freeze({ status: "committed", reason: "commit_ambiguity_resolved",
                    transactionCount: 1, committed: true, readBack: true,
                    observationId: entry.observation.observationId });
            }
            const record = await storeFactory({ purpose: "readback" })
                .readByObservationId(entry.observation.observationId);
            const matched = !!record && await Observation.validateTraceObservation(record.observation) &&
                record.observation.signature === entry.observation.signature;
            if (!matched) return freeze({ status: "failed", reason: "fresh_readback_failed",
                transactionCount: committed.transactionCount, committed: false, readBack: false });
            return freeze({ status: committed.committed ? "committed" : "unchanged", reason: null,
                classification: committed.classification,
                transactionCount: committed.transactionCount, committed: committed.committed,
                readBack: true, observationId: entry.observation.observationId });
        } finally { active.delete(entry.observation.observationId); }
    }
    function close() { closed = true; pending.clear(); active.clear(); }
    return freeze({ writerVersion: WRITER_VERSION, registerMainAcceptedObservation,
        commitAcceptedObservation, close });
}
module.exports = freeze({ WRITER_VERSION, createMainOwnedWriter });
