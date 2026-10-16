"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Observation = require("./morningV5FormalObservation.js");
const Filesystem = require("./marketCalendarHistory/crossPlatformFilesystemSafety.js");

const STORE_ID = "optionMapMorningV5Formal";
const STORE_VERSION = 1;
const FILE_NAME = "observations-v1.json";
const STORE_FIELDS = Object.freeze(["storeId", "storeVersion", "observations"]);
const RECORD_FIELDS = Object.freeze(["observationId", "observationSlotId", "contentSignature",
    "signature", "versionKey", "supersedesObservationId", "observation"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function empty() { return { storeId: STORE_ID, storeVersion: STORE_VERSION, observations: [] }; }
function fail(reason, details = {}) { const error = new Error(reason);
    Object.assign(error, details); throw error; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }

function safeDirectory(root, { create = false } = {}) {
    if (!fs.existsSync(root)) { if (!create) return false;
        fs.mkdirSync(root, { recursive: false, mode: 0o700 }); }
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("store_directory_invalid");
    return true;
}

function safeFile(file) {
    if (!fs.existsSync(file)) return false;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("store_file_invalid");
    return true;
}

function validateRoot(root, targetEnvironment) {
    if (typeof root !== "string" || !path.isAbsolute(root) || !fs.existsSync(root))
        fail("store_root_invalid");
    const real = fs.realpathSync(root), stat = fs.lstatSync(root);
    if (real !== root || stat.isSymbolicLink() || !stat.isDirectory()) fail("store_root_invalid");
    if (targetEnvironment === "isolated_test") {
        const temporary = fs.realpathSync(os.tmpdir());
        if (path.dirname(real) !== temporary) fail("isolated_store_root_invalid");
    }
    return real;
}

async function validateContainer(value) {
    if (!exact(value, STORE_FIELDS) || value.storeId !== STORE_ID ||
        value.storeVersion !== STORE_VERSION || !Array.isArray(value.observations)) return false;
    const ids = new Set();
    for (let index = 0; index < value.observations.length; index += 1) {
        const record = value.observations[index];
        if (!exact(record, RECORD_FIELDS) || ids.has(record.observationId) ||
            record.observationId !== record.observation?.observationId ||
            record.observationSlotId !== record.observation?.observationSlotId ||
            record.contentSignature !== record.observation?.contentSignature ||
            record.signature !== record.observation?.signature ||
            record.versionKey !== record.observation?.versionKey ||
            record.supersedesObservationId !== null && !ids.has(record.supersedesObservationId) ||
            !await Observation.validateFormalObservation(record.observation)) return false;
        ids.add(record.observationId);
        if (index > 0 && Date.parse(value.observations[index - 1].observation.observedAt) >=
            Date.parse(record.observation.observedAt)) return false;
        const priorSlot = value.observations.slice(0, index).filter(item =>
            item.observationSlotId === record.observationSlotId).at(-1) || null;
        if (record.supersedesObservationId !== (priorSlot?.observationId || null)) return false;
    }
    return true;
}

function createStore({ root, targetEnvironment, crashAt = null } = {}) {
    const profile = validateRoot(root, targetEnvironment);
    const directory = path.join(profile, STORE_ID), file = path.join(directory, FILE_NAME);
    const allowedCrashes = [null, "before_write", "after_temp", "before_rename", "after_rename"];
    if (!allowedCrashes.includes(crashAt)) fail("crash_point_invalid");
    function point(name, details = {}) { if (crashAt === name)
        fail(name === "after_rename" ? "commit_ambiguous" : "transaction_aborted", details); }
    async function load() {
        if (!safeDirectory(directory) || !safeFile(file)) return freeze(empty());
        let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (_error) { fail("store_read_invalid"); }
        if (!await validateContainer(value)) fail("store_schema_invalid");
        return freeze(clone(value));
    }
    async function readByObservationId(observationId) {
        const value = await load(); return freeze(clone(value.observations.find(record =>
            record.observationId === observationId) || null));
    }
    async function latestAcceptedObservation() {
        const value = await load(); return freeze(clone(value.observations.at(-1) || null));
    }
    async function observationSlotHistory(observationSlotId) {
        const value = await load(); return freeze(clone(value.observations.filter(record =>
            record.observationSlotId === observationSlotId)));
    }
    async function calendarDayHistory(calendarDay) {
        if (typeof calendarDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(calendarDay))
            fail("calendar_day_invalid");
        const value = await load(); return freeze(clone(value.observations.filter(record =>
            record.observation.calendarDay === calendarDay)));
    }
    async function commit(observation) {
        if (!await Observation.validateFormalObservation(observation)) fail("observation_invalid");
        const before = await load();
        const duplicate = before.observations.find(record =>
            record.observationId === observation.observationId);
        if (duplicate) {
            if (duplicate.signature !== observation.signature ||
                duplicate.contentSignature !== observation.contentSignature)
                fail("observation_identity_conflict");
            return freeze({ classification: "exact_duplicate", transactionCount: 0,
                committed: false, aborted: false,
                supersedesObservationId: duplicate.supersedesObservationId,
                record: clone(duplicate) });
        }
        const latest = before.observations.at(-1) || null;
        if ((latest?.observationId || null) !== observation.baselineSelection.baselineObservationId ||
            latest && Date.parse(latest.observation.observedAt) >= Date.parse(observation.observedAt))
            fail("baseline_binding_invalid");
        const priorSlot = before.observations.filter(record =>
            record.observationSlotId === observation.observationSlotId).at(-1) || null;
        const record = { observationId: observation.observationId,
            observationSlotId: observation.observationSlotId,
            contentSignature: observation.contentSignature, signature: observation.signature,
            versionKey: observation.versionKey,
            supersedesObservationId: priorSlot?.observationId || null,
            observation: clone(observation) };
        const next = clone(before); next.observations.push(record);
        if (!await validateContainer(next)) fail("next_store_invalid");
        point("before_write", { classification: priorSlot ? "revision" : "new",
            supersedesObservationId: record.supersedesObservationId });
        safeDirectory(directory, { create: true });
        const temporary = path.join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
        let renamed = false;
        try {
            const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
                fs.constants.O_EXCL, 0o600);
            try { fs.writeFileSync(descriptor, `${canonical(next)}\n`, "utf8"); fs.fsyncSync(descriptor); }
            finally { fs.closeSync(descriptor); }
            point("after_temp", { classification: priorSlot ? "revision" : "new",
                supersedesObservationId: record.supersedesObservationId });
            point("before_rename", { classification: priorSlot ? "revision" : "new",
                supersedesObservationId: record.supersedesObservationId });
            fs.renameSync(temporary, file); renamed = true;
            Filesystem.syncDirectory(directory);
            point("after_rename", { classification: priorSlot ? "revision" : "new",
                supersedesObservationId: record.supersedesObservationId });
        } catch (error) {
            if (!renamed) { try { fs.unlinkSync(temporary); } catch (_) { /* absent */ } }
            throw error;
        }
        return freeze({ classification: priorSlot ? "revision" : "new", transactionCount: 1,
            committed: true, aborted: false, supersedesObservationId: record.supersedesObservationId,
            record: freeze(clone(record)) });
    }
    return freeze({ storeId: STORE_ID, storeVersion: STORE_VERSION, file,
        load, commit, readByObservationId, latestAcceptedObservation, observationSlotHistory,
        calendarDayHistory });
}

function createIsolatedStore(options = {}) {
    if (!exact(options, ["root", "targetEnvironment", "crashAt"]) ||
        options.targetEnvironment !== "isolated_test") fail("isolated_store_options_invalid");
    return createStore(options);
}

function createProductionStore(authority) {
    if (!exact(authority, ["getUserDataPath"]) ||
        typeof authority.getUserDataPath !== "function")
        fail("production_store_authority_invalid");
    const root = authority.getUserDataPath();
    return createStore({ root, targetEnvironment: "production", crashAt: null });
}

module.exports = freeze({ STORE_ID, STORE_VERSION, FILE_NAME, STORE_FIELDS, RECORD_FIELDS,
    validateContainer, createIsolatedStore, createProductionStore });
