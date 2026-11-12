"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const W1 = require("../../js/weeklyAcquisitionAuthorityContract.js");
const W2 = require("../../js/weeklyRawTransportShadow.js");
const W3 = require("../../js/weeklyEvidenceVaultShadow.js");
const W4 = require("../../js/weeklySemanticEvidencePromotionShadow.js");
const Production = require("../../js/weeklyProductionAcquisition.js");
const SetStore = require("../../js/storage/weeklyEvidenceSetStore.js");
const BindingStore = require("../../js/storage/weeklySemanticEvidenceBindingStore.js");
const Vault = require("../../js/sourceEvidence/sourceEvidenceVault.js");
const FuturesHistory = require("../../js/weeklyFuturesHistory.js");
const OptionsHistory = require("../../js/weeklyOptionsHistory.js");
const Fixture = require("./weeklySemanticEvidenceFixture.js");

const NOW = new Date("2026-11-13T06:00:00.000Z");
const response = bytes => new Response(bytes, { status: 200, headers: {
  "content-type": W2.OBSERVED_JPX_MIME, "content-length": String(bytes.byteLength) } });

function listing(dates, tag = "") {
  return new TextEncoder().encode(JSON.stringify({ UpdateDate: "2026/11/13 15:31", tag,
    TableDatas: dates.map(sourceDate => {
      const compact = sourceDate.replaceAll("-", ""), year = sourceDate.slice(0, 4);
      return { TradeDate: compact,
        IndexFutures: `/automation/markets/derivatives/open-interest/files/${year}/` +
          `${compact}_indexfut_oi_by_tp.xlsx`,
        IndexOptions: `/automation/markets/derivatives/open-interest/files/${year}/` +
          `${compact}_nk225op_oi_by_tp.xlsx` };
    }) }));
}

function createHarness(t, configuration = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
    "optionmap-weekly-w5-"))), authority = W1.createMainAuthority({
      keyId: "weekly-w5-authority", secret: Buffer.alloc(32, 0x75) }),
    vault = Vault.createIsolatedVault({ root, targetEnvironment: "isolated_test", crashAt: null }),
    setStore = SetStore.createIsolatedWeeklyEvidenceSetStore({ root,
      targetEnvironment: "isolated_test" }), bindingStore =
      BindingStore.createIsolatedWeeklySemanticEvidenceBindingStore({ root,
        targetEnvironment: "isolated_test" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let scenario = { dates: ["2026-11-06"], futuresValue: 100, optionsValue: 100,
    listingTag: "", futuresTag: "", optionsTag: "", failListing: false,
    failFutures: false, failOptions: false, badFutures: false, badOptions: false,
    listingDelayMs: 0, rejectParserRole: null, ...configuration };
  let histories = { futures: FuturesHistory.createEmptyHistory(),
    options: OptionsHistory.createEmptyWeeklyOptionsHistory() }, sequence = 0;

  const fetchImpl = async url => {
    if (scenario.listingDelayMs) await new Promise(resolve =>
      setTimeout(resolve, scenario.listingDelayMs));
    if (url.includes("/json/")) return scenario.failListing ? new Response(null,
      { status: 503 }) : response(listing(scenario.dates, scenario.listingTag));
    const match = /\/(20\d{6})_(indexfut_oi_by_tp|nk225op_oi_by_tp)\.xlsx$/.exec(url);
    if (!match) return new Response(null, { status: 404 });
    const date = `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6)}`;
    if (match[2].startsWith("indexfut")) {
      if (scenario.failFutures) return new Response(null, { status: 503 });
      return response(Fixture.xlsx(Fixture.futuresRows(date,
        scenario.badFutures ? NaN : scenario.futuresValue), scenario.futuresTag));
    }
    if (scenario.failOptions) return new Response(null, { status: 503 });
    return response(Fixture.xlsx(Fixture.optionsRows(date,
      scenario.badOptions ? NaN : scenario.optionsValue), scenario.optionsTag));
  };

  function service() {
    const transport = W2.createWeeklyRawTransportShadow({ fetchImpl, authority,
      now: () => NOW }), evidence = W3.createWeeklyEvidenceVaultShadow({
      transportShadow: transport, vault, setStore, authority,
      testHooks: scenario.rejectParserRole === undefined ? null : {
        rejectParserRole: scenario.rejectParserRole } }), promotion =
      W4.createWeeklySemanticEvidencePromotionShadow({ vault, evidenceSetStore: setStore,
        bindingStore, authority });
    return Production.createWeeklyProductionAcquisition({ authority, evidenceShadow: evidence,
      promotion, readHistories: async () => structuredClone(histories), now: () => NOW,
      createRequestId: () => `weekly-w5-request-${++sequence}` });
  }
  let activeService = service();
  function configure(patch) { scenario = { ...scenario, ...patch }; }
  function commit(result) {
    for (const run of result.runs || []) {
      if (run.futures.status === "available" && run.futures.semanticRevisionWriteCount > 0)
        histories.futures = structuredClone(run.futures.history);
      if (run.options.status === "available" && run.options.semanticRevisionWriteCount > 0)
        histories.options = structuredClone(run.options.history);
    }
  }
  return { root, authority, vault, setStore, bindingStore, get service() { return activeService; },
    configure, commit, histories: () => structuredClone(histories), scenario: () => scenario };
}

module.exports = Object.freeze({ createHarness, listing });
