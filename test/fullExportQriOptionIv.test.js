const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Iv = require("../js/qriOptionIv.js");
const ExportIv = require("../js/fullExportQriOptionIv.js");
const Security = require("../js/fullExportSecurity.js");

const timestamp = "2026-09-08T05:02:00+09:00";
const confirmation = (role, contract) => ({ acquisitionRole: role,
    parentMarketRefreshRequestId: role === "active" ? "request-active" : `parent-${role}`,
    requestId: `request-${role}`,
    acquisitionGeneration: role === "active" ? 7 : 8,
    formalPublicationGeneration: role === "active" ? 11 : 12,
    parentOptionsVersionKey: `options-${contract}`, confirmedAt: timestamp });

function canonical(contract, records = null) {
    return { parserVersion: 1, schemaVersion: 1, source: Iv.SOURCE,
        sourceUrl: contract === "2026-09" ? "https://svc.qri.jp/jpx/nkopm/" :
            `https://svc.qri.jp/jpx/nkopm/${contract.replace("-", "")}`,
        valueUnit: "percent_points", contract, tradingDate: "2026-09-08",
        pageUpdatedAt: "2026-09-08T04:55:00+09:00", lastTradingDate: "2026-09-10",
        records: records || [
            { optionType: "put", strike: 66000, iv: { status: "missing", value: null,
                sourceFormat: "dash" } },
            { optionType: "call", strike: 66500, iv: { status: "invalid", value: null,
                sourceFormat: "malformed" } },
            { optionType: "put", strike: 66500, iv: { status: "available", value: 0,
                sourceFormat: "plain_number" } },
            { optionType: "call", strike: 66000, iv: { status: "available", value: 20,
                sourceFormat: "percent_sign" } }
        ] };
}

async function source(role, contract) {
    const data = canonical(contract); const [signature, versionKey] = await Promise.all([
        Iv.createSignature(data), Iv.createVersionKey(data)
    ]);
    return { available: true, origin: "history", sourceClass: "formal_history",
        formalStatus: "verified", role, contract, tradingDate: data.tradingDate,
        revisionFormalStatus: "saved",
        versionKey, signature, sourceUrl: data.sourceUrl, pageUpdatedAt: data.pageUpdatedAt,
        lastTradingDate: data.lastTradingDate, canonical: data, fetchedAt: timestamp,
        confirmedAt: timestamp, snapshotDate: "2026-09-08",
        matchingRoleConfirmation: confirmation(role, contract),
        freshness: { status: "saved", reason: "formal_history" } };
}

async function fixture(options = {}) {
    const contracts = options.contracts || {
        active: "2026-09", next: "2026-10", major_sq: "2026-12" };
    const sources = {};
    for (const role of ExportIv.ROLES) sources[role] = await source(role, contracts[role]);
    const restore = { restoreVersion: 1, roles: Object.fromEntries(ExportIv.ROLES.map(
        (role, index) => [role, { generation: index + 1, status: "available", reason: null,
            context: { role, contract: contracts[role], tradingDate: "2026-09-08",
                sourceUrl: sources[role].sourceUrl }, source: sources[role], completedAt: timestamp }])) };
    const reference = { runtimeVersion: 1, sessionGeneration: 3,
        parentMarketRefreshRequestId: "session", sources: {} };
    for (const role of ["next", "major_sq"]) reference.sources[role] = {
        available: true, canonical: structuredClone(sources[role].canonical),
        signature: sources[role].signature, versionKey: sources[role].versionKey,
        fetchedAt: timestamp, referenceIdentity: { role,
            parentMarketRefreshRequestId: `parent-${role}`, requestId: `request-${role}`,
            acquisitionGeneration: 8, formalPublicationGeneration: 12,
            referenceVersionKey: `options-${contracts[role]}` } };
    const runtime = { runtimeVersion: 1, active: { available: true,
        canonical: structuredClone(sources.active.canonical), signature: sources.active.signature,
        versionKey: sources.active.versionKey, fetchedAt: timestamp,
        requestContext: { requestId: "request-active" } }, selected: null };
    const persistence = { roles: Object.fromEntries(ExportIv.ROLES.map(role => [role, {
        role, status: "saved", reason: null, contract: contracts[role],
        tradingDate: "2026-09-08", versionKey: sources[role].versionKey,
        signature: sources[role].signature }])) };
    const formal = { status: "available", publicationGeneration: 11, fact: {
        canonicalVersionKey: `options-${contracts.active}`, generation: { sequence: 7 } } };
    const state = { restore, reference, runtime, persistence, formal };
    return { state, config: { getRestoreState: () => state.restore,
        getReferenceSessionState: () => state.reference,
        getRuntimeState: () => state.runtime, getPersistenceState: () => state.persistence,
        getFormalIdentityState: () => state.formal,
        evaluateLiveFreshness: () => ({ status: "fresh", reason: "daily_current" }) } };
}

test("active/next/major-SQ verified live are projected with fixed role and record order", async () => {
    const { config } = await fixture(); const result = await ExportIv.collectQriOptionIv(config);
    assert.equal(result.status, "available");
    assert.deepEqual(result.details.roles.map(role => role.role), ["active", "next", "major_sq"]);
    assert.deepEqual(result.details.roles.map(role => role.sourceClass),
        ["verified_live", "verified_live", "verified_live"]);
    assert.deepEqual(result.details.payloads[0].records.map(item => [item.optionType, item.strike]),
        [["call", 66000], ["call", 66500], ["put", 66000], ["put", 66500]]);
    assert.equal(result.details.payloads[0].valueUnit, "percent_points");
    assert.equal(result.details.payloads[0].formalStatus, "saved");
    assert.equal(result.details.payloads[0].records[0].iv.value, 20);
    assert.equal(JSON.stringify(result).includes("currentPrice"), false);
    assert.equal(Security.inspectFullExportSecurity(result).valid, true);
});

test("verified exact Formal history is used for every role when live is absent or unverified", async () => {
    const { state, config } = await fixture(); state.runtime.active.available = false;
    state.reference.sources.next.available = false;
    state.persistence.roles.major_sq.status = "failed";
    const result = await ExportIv.collectQriOptionIv(config);
    assert.equal(result.status, "available");
    assert.deepEqual(result.details.roles.map(role => role.sourceClass),
        ["formal_history", "formal_history", "formal_history"]);
    assert.deepEqual(result.details.roles.map(role => role.freshness.status),
        ["saved", "saved", "saved"]);
});

test("one/two/all unavailable and invalid mixtures derive outer status without aborting export", async () => {
    for (const [missing, expected] of [[1, "partial"], [2, "partial"], [3, "unavailable"]]) {
        const { state, config } = await fixture();
        ExportIv.ROLES.slice(0, missing).forEach(role => {
            state.restore.roles[role] = { generation: 1, status: "unavailable",
                reason: "exact_entry_not_found", context: null, source: null, completedAt: timestamp };
        });
        assert.equal((await ExportIv.collectQriOptionIv(config)).status, expected);
    }
    const { state, config } = await fixture(); state.restore.roles.active.source.signature = "bad";
    assert.equal((await ExportIv.collectQriOptionIv(config)).status, "partial");
    for (const role of ["next", "major_sq"]) state.restore.roles[role].status = "unavailable";
    assert.equal((await ExportIv.collectQriOptionIv(config)).status, "invalid");
});

test("last-valid/unverified live is excluded and exact history is the only fallback", async () => {
    const { state, config } = await fixture();
    state.restore.roles.active = { generation: 2, status: "unavailable",
        reason: "exact_entry_not_found", context: null, source: null, completedAt: timestamp };
    state.runtime.active.sourceClass = "last_valid";
    const result = await ExportIv.collectQriOptionIv(config);
    assert.equal(result.summary.roles.active.status, "unavailable");
    assert.equal(result.summary.roles.active.reason, "formal_iv_revision_unavailable");
    assert.equal(result.details.payloads.some(item => item.contract === "2026-09"), false);
});

test("contract/date/source/signature/version/confirmation mismatches fail closed", async () => {
    const mutations = [
        value => { value.state.restore.roles.active.context.contract = "2026-12"; },
        value => { value.state.restore.roles.active.context.tradingDate = "2026-09-07"; },
        value => { value.state.restore.roles.active.context.sourceUrl =
            "https://svc.qri.jp/jpx/nkopm/202612"; },
        value => { value.state.restore.roles.active.source.signature = "bad"; },
        value => { value.state.restore.roles.active.source.versionKey = "bad"; },
        value => { value.state.restore.roles.active.source.matchingRoleConfirmation = null; }
    ];
    for (const mutate of mutations) {
        const value = await fixture(); mutate(value);
        const result = await ExportIv.collectQriOptionIv(value.config);
        assert.equal(result.summary.roles.active.status, "invalid");
    }
});

test("same canonical revision keeps next and major-SQ bindings and dedupes payload", async () => {
    const value = await fixture({ contracts: {
        active: "2026-09", next: "2026-12", major_sq: "2026-12" } });
    const nextSource = value.state.restore.roles.next.source;
    value.state.restore.roles.major_sq.source = { ...structuredClone(nextSource), role: "major_sq",
        matchingRoleConfirmation: confirmation("major_sq", "2026-12") };
    value.state.restore.roles.major_sq.context = { ...value.state.restore.roles.next.context,
        role: "major_sq" };
    value.state.reference.sources.major_sq = { ...structuredClone(value.state.reference.sources.next),
        referenceIdentity: { ...value.state.reference.sources.next.referenceIdentity,
            role: "major_sq", parentMarketRefreshRequestId: "parent-major_sq",
            requestId: "request-major_sq" } };
    value.state.persistence.roles.major_sq = { ...value.state.persistence.roles.next,
        role: "major_sq" };
    const result = await ExportIv.collectQriOptionIv(value.config);
    assert.equal(result.summary.roles.next.payloadId, result.summary.roles.major_sq.payloadId);
    assert.equal(result.details.roles.filter(role => role.contract === "2026-12").length, 2);
    assert.equal(result.details.payloads.filter(item => item.contract === "2026-12").length, 1);
});

test("missing/invalid/zero and inventory counts/min/max are retained without interpolation", async () => {
    const result = await ExportIv.collectQriOptionIv((await fixture()).config);
    const payload = result.details.payloads[0];
    assert.deepEqual(payload.inventory, { call: { available: 1, missing: 0, invalid: 1 },
        put: { available: 1, missing: 1, invalid: 0 }, minStrike: 66000,
        maxStrike: 66500, valueUnit: "percent_points" });
    assert.ok(payload.records.some(item => item.iv.status === "missing" && item.iv.value === null));
    assert.ok(payload.records.some(item => item.iv.status === "invalid" && item.iv.value === null));
    assert.ok(payload.records.some(item => item.iv.status === "available" && item.iv.value === 0));
});

test("generation change marks only the changed role unavailable without retry", async () => {
    const value = await fixture(); let calls = 0;
    value.config.getRestoreState = () => {
        calls += 1; const current = structuredClone(value.state.restore);
        if (calls > 1) current.roles.next.generation += 1;
        return current;
    };
    const result = await ExportIv.collectQriOptionIv(value.config);
    assert.equal(result.summary.roles.next.reason, "iv_source_changed_during_export");
    assert.equal(calls, 2);
});

test("projection is deterministic, non-mutating and recursively frozen", async () => {
    const value = await fixture(); const before = structuredClone(value.state);
    const first = await ExportIv.collectQriOptionIv(value.config);
    const second = await ExportIv.collectQriOptionIv(value.config);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.deepEqual(value.state, before);
    assert.equal(Object.isFrozen(first.details.payloads[0].records[0].iv), true);
    assert.throws(() => first.details.payloads.push({}), TypeError);
});

test("module is read-only and independent of network, storage, graph and UI range state", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/fullExportQriOptionIv.js"), "utf8");
    assert.doesNotMatch(code, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|document\.|rangeMode|currentPrice/);
    assert.doesNotMatch(code, /persistCandidate|\.persist\s*\(|\.save\s*\(|\.put\s*\(/);
});
