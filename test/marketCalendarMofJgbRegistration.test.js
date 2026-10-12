"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), Module = require("node:module");
const vm = require("node:vm"), { webcrypto } = require("node:crypto");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Taxonomy = require("../js/marketCalendar/eventTaxonomy.js"), Policy = require("../js/marketCalendar/authorityPolicy.js");
const Identity = require("../js/marketCalendar/marketEventIdentity.js"), Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Contract = require("../js/marketCalendar/sourceContract.js");
const Coordinator = require("../js/marketCalendarRuntime/updateCoordinator.js"), Manual = require("../js/marketCalendarRuntime/calendarManualCheckService.js");
const Network = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js"), Routes = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const V1 = require("../js/marketCalendarHistory/formalWriterAuthority.js"), A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Safety = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js"), Envelope = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Old = require("../js/marketCalendarHistory/writerSafetyFileSchema.js"), Mvp = require("../js/marketCalendarMvp.js");
const F = require("./fixtures/marketCalendar/mofJgbRegistrationFixture.js"), Legacy = require("./fixtures/marketCalendar/sourceFixtures.js");
const SOURCE = F.SOURCE_ID, AT = "2026-10-07T00:00:00.000Z", root = path.resolve(__dirname, "..");
const canonical = r => Canon.canonicalize(r || F.typed());
const key = r => Identity.create({ jurisdiction: "JP", authority: "MOF", eventType: "JP_JGB_AUCTION",
    auctionIdentity: r.auctionIdentity, issueNumber: r.issueNumber, sourceUrl: r.sourceUrl,
    issueAmount: r.issueAmount, publicationTime: r.publicationTime, resultTime: r.resultTime }).eventKey;
const reject = async r => { const c = await canonical(r); assert.equal(c.ok, false); assert.equal(c.event, null); return c; };
const historical = [...Legacy.allSources.map(f => f.sourceId)].sort();

test("R1 registry contains exact MOF metadata without an acquisition binding", () => {
    const s = Registry.getSource(SOURCE);
    assert.equal(Object.keys(Registry.SOURCES).length, 13); assert.equal(s.owner, "MOF");
    assert.equal(s.authority, "MOF"); assert.equal(s.jurisdiction, "JP");
    assert.equal(s.sourceOwner, "財務省理財局国債業務課"); assert.equal(s.absenceAuthority, "none");
    assert.equal(s.parserId, "mof-jgb-month-isolated"); assert.equal(s.canonicalizationContract, "jgb-auction-typed-v1");
    assert(Object.isFrozen(s)); assert.equal(Policy.evaluateFormalEligibility(F.typed(), s).eligible, true);
});
test("R2 normal MOF activation cannot expand legacy transport or writer permission", () => {
    const s = Registry.getSource(SOURCE);
    assert.equal(s.acquisitionEnabled, true); assert.equal(Registry.isAcquisitionEnabled(SOURCE), false);
    assert.equal(s.writerAllowed, false); assert.equal(s.writerPermission, "none");
    assert.equal(V1.selectWriterState(SOURCE).reason, "source_unknown");
    assert.equal(A.PRODUCTION_POLICY.permissions.entries.some(e => e.sourceId === SOURCE), false);
});
test("R3 startup default preserves the twelve historical targets and blocks explicit MOF", () => {
    const plan = Coordinator.planUpdate({ trigger: "startup", requestedAt: AT });
    assert.deepEqual(plan.sourceResults.map(r => r.sourceId), Registry.HISTORICAL_SOURCE_ORDER);
    const denied = Coordinator.planUpdate({ trigger: "startup", requestedAt: AT, sourceIds: [SOURCE] });
    assert.equal(denied.sourceResults[0].reason, "acquisition_disabled"); assert.equal(denied.acquisitionCandidates.length, 0);
});
test("R4 real manual selector rejects MOF before any acquisition/build/preview callback", async () => {
    const calls = { acquisition: 0, build: 0, preview: 0 };
    const service = Manual.createCalendarManualCheckService({ now: () => AT,
        acquire: async () => { calls.acquisition++; throw Error("unexpected_acquisition"); },
        builder: { buildCalendarCandidate: async () => { calls.build++; } },
        simulator: { simulateCalendarTransition: async () => { calls.preview++; } } });
    for (const trigger of ["manual", "startup"]) {
        const result = await service.check({ sourceIds: [SOURCE], trigger });
        assert.equal(result.reasonClass, "source_selection_invalid");
    }
    assert.deepEqual(calls, { acquisition: 0, build: 0, preview: 0 });
});
test("R5 G1 parser facts convert explicitly and production canonicalizer accepts typed date-only JST", async () => {
    const raw = F.isolated(), typed = Canon.toTypedJgbRecord(raw), result = await canonical(typed);
    assert.equal(result.ok, true, result.reason);
    const e = result.event;
    assert.equal(e.eventKey, "JP|MOF|JP_JGB_AUCTION|normal_fixed_rate_jgb|10Y|2026-10-06");
    assert.deepEqual(e.logical.auctionIdentity, { authority: "MOF", eventType: "JP_JGB_AUCTION",
        instrumentClass: "normal_fixed_rate_jgb", maturity: "10Y", auctionDate: "2026-10-06" });
    for (const field of ["referencePeriod", "edition", "scope"]) {
        assert.equal(Object.hasOwn(typed, field), false); assert.equal(Object.hasOwn(e.logical, field), false);
    }
    assert.equal(e.schedule.kind, "date_only"); assert.equal(e.schedule.canonicalStart, null);
    assert.equal(e.schedule.sourceLocal.startTime, null); assert.equal(e.schedule.sourceLocal.timeZone, "Asia/Tokyo");
    assert.equal(e.absenceAuthority, "none"); assert.equal(raw.scope, "10Y");
    assert(Object.isFrozen(e.logical.auctionIdentity));
});
test("R6 unknown maturity is fail-closed", async () => {
    const r = F.typed(); await reject({ ...r, auctionIdentity: { ...r.auctionIdentity, maturity: "7Y" } });
});
for (const [label, product] of [["R7 CT", "10年クライメート・トランジション利付国債"],
    ["R7 inflation-linked", "10年物価連動国債"], ["excluded T-bill", "国庫短期証券（3ヶ月）"],
    ["excluded liquidity", "流動性供給入札"], ["excluded buyback", "買入消却"], ["excluded special account", "特別会計借入金"]])
    test(label + " cannot become a normal fixed-rate event even with forged normal typed fields", async () => {
        await reject(F.typed({ rawLabel: product, sourceTitle: product }));
    });
test("R8 typed identity is deterministic and changes only with its material", () => {
    const r = F.typed(); assert.equal(key(r), key(structuredClone(r)));
    assert.notEqual(key(r), key({ ...r, auctionIdentity: { ...r.auctionIdentity, auctionDate: "2026-10-07" } }));
    assert.notEqual(key(r), key({ ...r, auctionIdentity: { ...r.auctionIdentity, maturity: "5Y" } }));
});
test("R9 issue number and formatting changes do not change key or semantic revision", async () => {
    const a = (await canonical()).event, b = (await canonical(F.typed({ issueNumber: "999",
        rawLabel: "１０年 利付国債（第９９９回）", sourceTitle: "10 年 利付 国債 (第999回)", titleJa: "ignored raw title" }))).event;
    assert(b); assert.equal(a.eventKey, b.eventKey); assert.equal(a.revisionKey, b.revisionKey);
});
test("R10 URL/publication/result time/amount/update metadata remain outside semantic identity", async () => {
    const a = (await canonical()).event, b = (await canonical(F.typed({
        sourceUrl: Registry.getSource(SOURCE).canonicalUrl, rawContentHash: "b".repeat(64), issueAmount: "3 trillion",
        sourcePublishedAt: "2026-10-05T00:00:00Z", sourceUpdatedAt: "2026-10-06T00:00:00Z",
        publicationTime: "10:30", resultTime: "12:35", updatedAt: "2026-10-07T00:00:00Z" }))).event;
    assert(b); assert.equal(a.eventKey, b.eventKey); assert.equal(a.revisionKey, b.revisionKey);
    assert.notEqual(a.acquisitionEvidenceHash, b.acquisitionEvidenceHash);
});

// Read HEAD raw blobs into a private in-memory CommonJS graph. This compares
// complete old/new canonical material, rather than deriving expectations from new code.
function historicalCanonicalizer() {
    const cache = new Map();
    function load(filename) {
        if (cache.has(filename)) return cache.get(filename).exports;
        const m = new Module(filename); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
        cache.set(filename, m);
        const requireHere = Module.createRequire(filename);
        m.require = id => id.startsWith(".") ? load(requireHere.resolve(id)) : requireHere(id);
        const relative = path.relative(root, filename).split(path.sep).join("/");
        m._compile(cp.execFileSync("git", ["show", "HEAD:" + relative], { cwd: root, encoding: "utf8" }), filename);
        m.loaded = true; return m.exports;
    }
    return load(require.resolve("../js/marketCalendar/marketEventCanonicalizer.js"));
}
test("R11 every historical source canonical event/key/semantic/evidence hash is byte-equivalent to committed HEAD", async () => {
    const old = historicalCanonicalizer();
    for (const document of Legacy.allSources) {
        const r = { ...document.records[0], sourceId: document.sourceId, parserId: document.parserId,
            parserVersion: document.parserVersion, rawContentHash: document.rawContentHash, fetchedAt: document.fetchedAt };
        const before = await old.canonicalize(r), after = await canonical(r);
        assert.equal(before.ok, true); assert.deepEqual(after, before, document.sourceId);
    }
});
test("R12 historical v2/v3 state and audit validation still use twelve and unchanged identities", () => {
    assert.equal(A.PRODUCTION_POLICY.global.identity, "1fd05aefc041d299a1e3c2f0b1fe6c8f47403af11b56fa765d3ca26c7656d58c");
    assert.equal(Envelope.policyFor(3).global.identity, "62d49ff8d78e01daae2bd42a556cca11e6b6a4de38e58a64355fa385bf8ea758");
    const legacy = Old.build(null, Safety.createMemorySafety(), null, "provision_disabled", A.PRODUCTION_POLICY);
    const migrated = Envelope.append(Envelope.migrate(legacy, A.hash("fixture")), { type: "authority_transition",
        expectedAuthorityVersion: 2, nextAuthorityVersion: 3, approvedSourceCeiling: [Envelope.SOURCE], suspendedSourceSet: [] }, A.hash("fixture"));
    assert.equal(Old.validate(legacy).valid, true); assert.equal(Envelope.validateEnvelope(migrated).valid, true);
    assert.deepEqual(migrated.safety.sources.map(s => s.sourceId), historical);
    assert.equal(Registry.getSourceSet(2).candidateOnly, true); assert.equal(Registry.getSourceSet(2).sourceIds.length, 13);
});
test("R13 Machinery-only ceiling and MOF absent writer permission are unchanged", () => {
    assert.deepEqual(Envelope.policyFor(3).global.permittedSources, ["jp-esri-machinery-orders-calendar"]);
    assert.deepEqual(A.SOURCE_IDS, historical); assert.equal(A.SOURCE_IDS.includes(SOURCE), false);
    assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
});
test("R14 BOJ historical ineligibility is not affected by MOF registration", () => {
    assert.equal(V1.selectWriterState("jp-boj-calendar").writeEligible, false);
    assert.equal(Envelope.policyFor(3).permissions.entries.find(e => e.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
});
test("R15 display metadata resolves MOF, tenor, date-only time and deterministic title without a stored event", async () => {
    const e = (await canonical()).event, view = Mvp.viewModel({ ...e, sourceId: SOURCE });
    assert.equal(view.sourceLabel, "財務省・国債入札"); assert.equal(view.shortTitle, "10年国債入札");
    assert.equal(view.title, "10年国債 入札"); assert.equal(view.timeLabel, "時刻未定"); assert.equal(view.calendarDate, "2026-10-06");
    assert.equal(Taxonomy.EVENT_TYPES.JP_JGB_AUCTION.category, "fixed_income");
});
for (const maturity of ["2Y", "5Y", "10Y", "20Y", "30Y", "40Y"]) test("typed maturity " + maturity + " accepted", async () => {
    const r = F.typed(), years = maturity.slice(0, -1), label = years + "年利付国債";
    const c = await canonical({ ...r, maturity, sourceTitle: label, rawLabel: label, auctionIdentity: { ...r.auctionIdentity, maturity } });
    assert.equal(c.ok, true, c.reason);
});
test("exact typed schema rejects missing/unknown fields, wrong authority/type/class and aliases", async () => {
    const r = F.typed();
    for (const change of [{ authority: "BOJ" }, { eventType: "BOJ_MPM" }, { instrumentClass: "inflation_linked" },
        { maturity: "10y" }, { issueNumber: "384" }]) await reject({ ...r, auctionIdentity: { ...r.auctionIdentity, ...change } });
    for (const field of Object.keys(r.auctionIdentity)) {
        const a = { ...r.auctionIdentity }; delete a[field]; await reject({ ...r, auctionIdentity: a });
    }
});
test("malformed/impossible date never throws out of the canonicalizer or generates an event", async () => {
    for (const auctionDate of ["2026-02-30", "2026-99-01", "2026-1-01", "2026-10-06T00:00:00Z", null]) {
        const r = F.typed(); await reject({ ...r, auctionIdentity: { ...r.auctionIdentity, auctionDate } });
    }
});
test("date-only JST contract rejects invented time/timezone/range and date mismatch", async () => {
    const r = F.typed();
    for (const patch of [{ startTime: "12:35" }, { endTime: "12:35" }, { timeZone: "UTC" }, { kind: "instant" },
        { precision: "exact" }, { endDate: "2026-10-07" }, { startDate: "2026-10-07" }])
        await reject({ ...r, sourceLocalSchedule: { ...r.sourceLocalSchedule, ...patch } });
    await reject({ ...r, time: "12:35" });
});
test("statistical identity fields and unconverted isolated projection fail closed", async () => {
    const r = F.typed(); for (const field of ["referencePeriod", "edition", "scope"])
        await reject({ ...r, [field]: "forbidden" });
    await reject(F.isolated());
    assert.throws(() => Canon.toTypedJgbRecord(F.isolated({ scope: "5Y" })), /jgb_isolated_projection_invalid/);
});
test("MOF events cannot borrow another source or its event type/authority", async () => {
    await reject(F.typed({ sourceId: "jp-boj-calendar" })); await reject(F.typed({ sourceId: "unknown" }));
    await reject(F.typed({ eventType: "BOJ_MPM" })); await reject(F.typed({ authority: "BOJ" }));
});
test("parser mismatch and cancellation/absence promotion rejected", async () => {
    for (const patch of [{parserId:"unknown"},{parserVersion:2},{sourceStatus:"cancelled"},{absenceAuthority:"complete"}])
        await reject(F.typed(patch));
});
test("route metadata is variable, strict and disconnected from every executable network selector", () => {
    const s = Registry.getSource(SOURCE), r = s.route;
    assert.equal(r.documentSet.kind, "variable"); assert.equal(r.documentSet.discovery, "validated_index_links_only");
    assert.equal(r.documentSet.coverage, "published_months_only"); assert.equal(r.fetchPolicy.encodingPolicy, "declared_strict_utf8");
    assert.equal(r.fetchPolicy.credentialsAllowed, false); assert.equal(r.fetchPolicy.maxRetries, 0);
    assert.equal(Registry.validateSourceUrl(SOURCE, s.canonicalUrl).valid, true);
    assert.equal(Registry.validateSourceUrl(SOURCE, F.URL).valid, true);
    assert.equal(new RegExp(r.monthPathPattern).test("/jgbs/auction/calendar/2610.htm"), true);
    assert.equal(Network.getPolicy(SOURCE), null); assert.equal(Network.validateRequest({sourceId:SOURCE,operation:Network.OPERATION}).valid, false);
    assert.equal(Routes.selectRoute({sourceId:SOURCE,operation:Network.OPERATION}).acquisitionAllowed, false);
});
test("exact URL metadata rejects auth/query/port/fragment/normalization/redirect-target aliases", () => {
    for (const url of [F.URL+"?x=1",F.URL+"#x",F.URL+"\n",F.URL.replace("www.mof.go.jp","evil.example"),
        F.URL.replace("https:","http:"),F.URL.replace("www.mof.go.jp","u:p@www.mof.go.jp"),
        F.URL.replace("www.mof.go.jp","www.mof.go.jp:443"),F.URL.replace("2610.htm","2613.htm"),
        F.URL.replace("calendar/","calendar/../calendar/"),F.URL.replace("2610","%32%36%31%30"),F.URL+"/extra"])
        assert.equal(Registry.validateSourceUrl(SOURCE,url).valid,false,url);
});
test("metadata/typed normalization import graph contains no transport/storage/writer execution wiring", () => {
    for (const relative of ["sourceRegistry.js","marketEventIdentity.js","sourceContract.js","marketEventCanonicalizer.js"]) {
        const source = fs.readFileSync(path.join(root,"js/marketCalendar",relative),"utf8");
        assert.doesNotMatch(source,/require\([^)]*(?:marketCalendarIsolated|marketCalendarRuntime|marketCalendarHistory)/);
        assert.doesNotMatch(source,/\bfetch\s*\(|indexedDB|localStorage|writerSafety|createObjectStore/);
    }
    assert.equal(Registry.getAcquisitionEnabledSourceIds().length,12);
    assert.equal(require("../js/marketCalendarRuntime/formalExactComparison.js").SOURCE_IDS.includes(SOURCE),false);
    assert.equal(Contract.validateSourceRecord(F.typed()).valid,true);
});
test("disabled metadata also rejects the actual existing acquisition service before its injected transport", async () => {
    let requests = 0;
    const service = require("../js/marketCalendarRuntime/calendarAcquisitionService.js").createCalendarAcquisitionService({
        fetchImpl: async () => { requests++; throw Error("unexpected_transport"); } });
    const result = await service.acquire({ sourceId: SOURCE, operation: Network.OPERATION });
    assert.equal(result.success, false); assert.equal(result.reason, "source_not_allowed"); assert.equal(requests, 0);
});
test("browser UMD typed canonicalization matches Node without a new script dependency", async () => {
    const context = vm.createContext({ document: {}, crypto: webcrypto, TextEncoder, URL });
    vm.runInContext("window = globalThis", context);
    for (const file of ["eventTaxonomy.js", "sourceRegistry.js", "marketEventIdentity.js", "marketEventSchedule.js",
        "authorityPolicy.js", "sourceContract.js", "marketEventCanonicalizer.js"])
        vm.runInContext(fs.readFileSync(path.join(root, "js/marketCalendar", file), "utf8"), context);
    const browser = await context.OptionMapMarketEventCanonicalizer.canonicalize(F.typed());
    const node = await canonical();
    assert.equal(browser.ok, true); assert.equal(browser.event.eventKey, node.event.eventKey);
    assert.equal(browser.event.canonicalContentHash, node.event.canonicalContentHash);
    assert.equal(browser.event.acquisitionEvidenceHash, node.event.acquisitionEvidenceHash);
});
