"use strict";

// All authority receipts here are synthetic isolated fixtures, not production evidence.
const A = require("../../../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const Old = require("../../../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const L = require("../../../js/marketCalendarHistory/writerSafetyControlledLifecycle.js");
const OldPlan = require("../../../js/marketCalendarHistory/mofControlledSemanticPlan.js");
const OldAuth = require("../../../js/marketCalendarHistory/mofControlledAuthorization.js");
const E = require("../../../js/marketCalendarHistory/mofStartupCanaryEnvelope.js");
const Integrity = require("../../../js/marketCalendarHistory/historyIntegrity.js");
const F = require("./mofControlledFixture.js"), Safety = require("./safetySourceSetFixture.js"), AF = require("./automaticShadowFixture.js");
const Registry = require("../../../js/marketCalendar/sourceRegistry.js");
const CHECKED = "2026-10-14T00:00:00.000Z", GATE = A.hash("G1.7-isolated-only");
async function setup({ newEvents = 1 } = {}) {
  const old = Safety.complete(Safety.historical(), A.hash("fixture-machinery-readback"));
  const base = Old.migrateSourceSet(old, Old.requestFor(old, Safety.GATE));
  const oldPreparation = await OldPlan.prepareNativeMaterial({ source: await F.source("historic-mof"),
    snapshot: (await AF.fixture()).snapshot, attemptIdentity: A.hash("historic-mof-attempt") });
  const data = OldPlan.inspectNativeMaterial(oldPreparation);
  const auth = OldAuth.createControlledAuthorization({record:base,preparation:oldPreparation});
  const binding = OldAuth.consume(auth,{record:base,preparation:oldPreparation,sourceId:E.SOURCE,operation:OldPlan.OPERATION}).binding;
  const common = Object.fromEntries(["sourceId","operation","attemptIdentity","authorizationIdentity","planIdentity","counts"].map(k=>[k,binding[k]]));
  let historical = base;
  for(const phase of L.PHASES) {
    const proof = ["prepared","formal_write_started"].includes(phase) ? null : phase === "commit_observed" ?
      {...common,readwriteTransactions:1,committedTransactions:1,abortedTransactions:0} :
      {...common,freshReadonlyReopen:true,integrity:true,otherSourcesUnchanged:true,
        expectedFormalIdentity:binding.expectedFormalIdentity,actualFormalIdentity:binding.expectedFormalIdentity};
    historical = L.append(base,historical,phase,binding,proof);
  }
  const record = E.activate(historical,GATE), source = await F.source("normal-startup");
  const newRecords = [];
  for(let n=0;n<newEvents;n++) {
    const r=structuredClone(source.canonicalRecords.find(r=>r.logical.auctionIdentity.maturity==="10Y" && r.schedule.sourceLocal.startDate.startsWith("2026-12")));
    const date=`2026-12-${28+n}`;r.logical.auctionIdentity.auctionDate=date;r.schedule.sourceLocal.startDate=date;
    r.eventKey=["JP","MOF","JP_JGB_AUCTION","normal_fixed_rate_jgb","10Y",date].join("|");r.logical.eventKey=r.eventKey;
    r.canonicalContentHash=A.hash(Integrity.semanticContent(r));r.revisionKey=`${r.eventKey}|sha256:${r.canonicalContentHash}`;newRecords.push(r);
  }
  source.canonicalRecords.push(...newRecords);
  for(const r of source.canonicalRecords) {
    r.acquisitionEvidence.fetchedAt=CHECKED;r.acquisitionEvidence.requestId="normal-startup";r.source=r.acquisitionEvidence;
    r.acquisitionEvidenceHash=A.hash(r.acquisitionEvidence);r.acquisitionEvidenceKey=`${E.SOURCE}|sha256:${r.acquisitionEvidenceHash}`;
  }
  const meta=Registry.getSource(E.SOURCE);
  source.candidateIdentity=A.hash({sourceId:E.SOURCE,parserId:meta.parserId,parserVersion:meta.parserVersion,candidateSchemaVersion:1,
    revisionKeys:source.canonicalRecords.map(r=>r.revisionKey).sort()});
  const runtimeState={sourceId:E.SOURCE,lastAttemptAt:CHECKED,lastSuccessAt:CHECKED,lastOutcome:"success",retryAfter:null,
    lastHttpStatus:200,lastDiagnosticClass:null,coordinatorVersion:1};
  const sourceOutcome={sourceId:E.SOURCE,status:"success",acquisitionStatus:"succeeded",planningDecision:"update"};
  return {historical,record,snapshot:data.expected,source,runtimeState,sourceOutcome,checkedAt:CHECKED,gate:GATE};
}
module.exports=Object.freeze({setup,CHECKED,GATE});
