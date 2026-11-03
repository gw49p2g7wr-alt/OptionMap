"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const Observation = require("./overallTraceObservation.js");
const Identity = require("./overallTraceIdentityContract.js");
const Filesystem = require("./marketCalendarHistory/crossPlatformFilesystemSafety.js");

const DATABASE_NAME = "optionMapOverallTraceHistory";
const SCHEMA_VERSION = 1;
const FILE_NAME = "optionMapOverallTraceHistory-v1.json";
const STORE_NAMES = Object.freeze(["overallTraceObservations", "overallTraceLogicIdentities",
    "overallTraceInputSets", "overallTraceSourceBindings", "overallTraceRuns"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value); }
function fail(reason, details = {}) { const error = new Error(reason); Object.assign(error, details); throw error; }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function empty() { return { databaseName: DATABASE_NAME, schemaVersion: SCHEMA_VERSION,
    stores: Object.fromEntries(STORE_NAMES.map(name => [name, []])) }; }
function validateRoot(root, targetEnvironment) {
    if (typeof root !== "string" || !path.isAbsolute(root) || !fs.existsSync(root)) fail("store_root_invalid");
    const real = fs.realpathSync(root), stat = fs.lstatSync(root);
    if (!Filesystem.samePath(real, root) || stat.isSymbolicLink() || !stat.isDirectory())
        fail("store_root_invalid");
    if (targetEnvironment === "isolated_test" &&
        !Filesystem.samePath(path.dirname(real), fs.realpathSync(os.tmpdir())))
        fail("isolated_store_root_invalid");
    return real;
}
async function validateContainer(value) {
    if (!object(value) || value.databaseName !== DATABASE_NAME || value.schemaVersion !== SCHEMA_VERSION ||
        !object(value.stores) || Object.keys(value.stores).sort().join("|") !==
        [...STORE_NAMES].sort().join("|") || STORE_NAMES.some(name => !Array.isArray(value.stores[name])))
        return false;
    const observations = value.stores.overallTraceObservations;
    const ids = new Set(), logic = new Set(), inputs = new Set();
    for (const entry of value.stores.overallTraceLogicIdentities) {
        const rebuilt = object(entry) ? await Identity.createLogicIdentity(entry.logicIdentity) : null;
        if (!object(entry) || logic.has(entry.logicIdentityHash) || rebuilt?.accepted !== true ||
            rebuilt.hash !== entry.logicIdentityHash) return false;
        logic.add(entry.logicIdentityHash);
    }
    for (const entry of value.stores.overallTraceInputSets) {
        const rebuilt = object(entry) ? await Identity.createInputSetIdentity(entry.inputSetIdentity) : null;
        if (!object(entry) || inputs.has(entry.inputSetIdentityHash) || rebuilt?.accepted !== true ||
            rebuilt.hash !== entry.inputSetIdentityHash) return false;
        inputs.add(entry.inputSetIdentityHash);
    }
    for (let index = 0; index < observations.length; index += 1) {
        const record = observations[index];
        if (!object(record) || ids.has(record.observationId) ||
            record.observationId !== record.observation?.observationId ||
            !logic.has(record.observation?.logicIdentityHash) ||
            !inputs.has(record.observation?.inputSetIdentityHash) ||
            !await Observation.validateTraceObservation(record.observation)) return false;
        ids.add(record.observationId);
        if (index && compareRecords(observations[index - 1], record) > 0) return false;
    }
    for (const name of ["overallTraceSourceBindings", "overallTraceRuns"]) {
        if (value.stores[name].length !== observations.length ||
            value.stores[name].some(item => !ids.has(item.observationId))) return false;
    }
    for (const record of observations) {
        const source = value.stores.overallTraceSourceBindings.find(item =>
            item.observationId === record.observationId);
        const run = value.stores.overallTraceRuns.find(item =>
            item.observationId === record.observationId);
        if (!source || canonical(source.sourceBindings) !== canonical(record.observation.sourceBindings) ||
            !run || run.acceptedAt !== record.observation.acceptedAt ||
            run.status !== record.observation.status) return false;
    }
    return true;
}
function compareRecords(left, right) {
    return Date.parse(left.observation.acceptedAt) - Date.parse(right.observation.acceptedAt) ||
        Date.parse(left.observation.observedAt) - Date.parse(right.observation.observedAt) ||
        left.observationId.localeCompare(right.observationId);
}
function createStore({ root, targetEnvironment, crashAt = null } = {}) {
    const profile = validateRoot(root, targetEnvironment), file = path.join(profile, FILE_NAME);
    if (![null, "before_write", "after_temp", "before_rename", "after_rename"].includes(crashAt))
        fail("crash_point_invalid");
    const point = (name, details = {}) => { if (crashAt === name)
        fail(name === "after_rename" ? "commit_ambiguous" : "transaction_aborted", details); };
    async function load() {
        if (!fs.existsSync(file)) return freeze(empty());
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("store_file_invalid");
        let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (_) { fail("store_read_invalid"); }
        if (!await validateContainer(value)) fail("store_schema_invalid");
        return freeze(clone(value));
    }
    async function commit(observation) {
        if (!await Observation.validateTraceObservation(observation)) fail("observation_invalid");
        const before = await load();
        const duplicate = before.stores.overallTraceObservations.find(item =>
            item.observationId === observation.observationId);
        if (duplicate) {
            if (duplicate.observation.signature !== observation.signature) fail("observation_identity_conflict");
            return freeze({ classification: "exact_duplicate", transactionCount: 0,
                committed: false, aborted: false, record: clone(duplicate) });
        }
        const next = clone(before);
        if (!next.stores.overallTraceLogicIdentities.some(item =>
            item.logicIdentityHash === observation.logicIdentityHash))
            next.stores.overallTraceLogicIdentities.push({
                logicIdentityHash: observation.logicIdentityHash,
                logicIdentity: clone(observation.logicIdentity) });
        if (!next.stores.overallTraceInputSets.some(item =>
            item.inputSetIdentityHash === observation.inputSetIdentityHash))
            next.stores.overallTraceInputSets.push({
                inputSetIdentityHash: observation.inputSetIdentityHash,
                inputSetIdentity: clone(observation.inputSetIdentity) });
        const record = { observationId: observation.observationId, observation: clone(observation) };
        next.stores.overallTraceObservations.push(record);
        next.stores.overallTraceObservations.sort(compareRecords);
        next.stores.overallTraceSourceBindings.push({ observationId: observation.observationId,
            sourceBindings: clone(observation.sourceBindings) });
        next.stores.overallTraceRuns.push({ observationId: observation.observationId,
            acceptedAt: observation.acceptedAt, status: observation.status });
        if (!await validateContainer(next)) fail("next_store_invalid");
        point("before_write", { classification: "append" });
        const temporary = path.join(profile, `.${FILE_NAME}.${randomUUID()}.tmp`);
        let renamed = false;
        try {
            const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
                fs.constants.O_EXCL, 0o600);
            try { fs.writeFileSync(descriptor, `${canonical(next)}\n`, "utf8"); fs.fsyncSync(descriptor); }
            finally { fs.closeSync(descriptor); }
            point("after_temp", { classification: "append" });
            point("before_rename", { classification: "append" });
            fs.renameSync(temporary, file); renamed = true; Filesystem.syncDirectory(profile);
            point("after_rename", { classification: "append" });
        } catch (error) {
            if (!renamed) { try { fs.unlinkSync(temporary); } catch (_) { /* absent */ } }
            throw error;
        }
        return freeze({ classification: "append", transactionCount: 1,
            committed: true, aborted: false, record: freeze(clone(record)) });
    }
    async function readByObservationId(id) { const value = await load(); return freeze(clone(
        value.stores.overallTraceObservations.find(item => item.observationId === id) || null)); }
    async function latest() { const value = await load(); return freeze(clone(
        [...value.stores.overallTraceObservations].sort(compareRecords).at(-1) || null)); }
    async function byCalendarDaySession(calendarDay, sessionKind = null) { const value = await load();
        return freeze(clone(value.stores.overallTraceObservations.filter(item =>
            item.observation.calendarDay === calendarDay && (!sessionKind ||
                item.observation.sessionIdentity.kind === sessionKind)).sort(compareRecords))); }
    async function asKnownAt(value) { if (!timestamp(value)) fail("as_known_at_invalid");
        const state = await load(); return freeze(clone(state.stores.overallTraceObservations
            .filter(item => Date.parse(item.observation.acceptedAt) <= Date.parse(value))
            .sort(compareRecords).at(-1) || null)); }
    return freeze({ databaseName: DATABASE_NAME, schemaVersion: SCHEMA_VERSION, file, load, commit,
        readByObservationId, latest, byCalendarDaySession, asKnownAt });
}
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
function createIsolatedStore(options = {}) {
    if (!object(options) || Object.keys(options).sort().join("|") !== "crashAt|root|targetEnvironment" ||
        options.targetEnvironment !== "isolated_test") fail("isolated_store_options_invalid");
    return createStore(options);
}
function createProductionStore(authority) {
    if (!object(authority) || Object.keys(authority).join("|") !== "getUserDataPath" ||
        typeof authority.getUserDataPath !== "function") fail("production_store_authority_invalid");
    return createStore({ root: authority.getUserDataPath(), targetEnvironment: "production" });
}
module.exports = freeze({ DATABASE_NAME, SCHEMA_VERSION, FILE_NAME, STORE_NAMES,
    validateContainer, createIsolatedStore, createProductionStore });
