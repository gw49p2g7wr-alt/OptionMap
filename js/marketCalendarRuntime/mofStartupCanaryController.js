"use strict";

// Same hidden-renderer/session/context contract, main-owned single attempt.
const fs=require("node:fs"),path=require("node:path"),{randomUUID}=require("node:crypto");
const A=require("../marketCalendarHistory/formalWriterAuthorityV2.js"),E=require("../marketCalendarHistory/mofStartupCanaryEnvelope.js");
const P=require("../marketCalendarHistory/mofStartupCanaryPlan.js"),Store=require("../marketCalendarHistory/mofStartupCanaryStore.js");
const Core=require("../marketCalendarHistory/formalControlledWriterCore.js"),Schema=require("../marketCalendarHistory/productionSchemaV1.js");
const B=require("../marketCalendarHistory/bootstrapSchemaV1.js"),C=require("../marketCalendar/marketEventCanonicalizer.js");
const Windows=require("./mofHiddenRendererWindow.js"),Reader=require("./formalShadowElectronRead.js"),Cycle=require("./formalShadowCycle.js");
const Renderer=require("./mofStartupCanaryRenderer.js"),Executor=require("../marketCalendarHistory/firstProductionWriteExecutor.js");
const CHANNELS=Object.freeze(["optionmap:mof-controlled:challenge","optionmap:mof-controlled:consume","optionmap:mof-controlled:receipt"]);
const FAULTS=Object.freeze(["after_authorization","before_window","before_load","after_load","after_challenge","started_before_permit","permit_lost",
  "after_permit","after_token","during_tx","commit_ambiguous","commit_before_readback","readback_before_completion",
  "wrong_sender","wrong_frame","wrong_challenge","reload","replay_challenge","replay_consume","second_tx"]);
function artifactIdentity(){return A.hash([Windows.artifactIdentity(),...[
  "../marketCalendarHistory/mofStartupCanaryEnvelope.js","../marketCalendarHistory/mofStartupCanaryPlan.js",
  "../marketCalendarHistory/mofStartupCanaryStore.js","./mofStartupCanaryRenderer.js","./mofStartupCanaryController.js"]
  .map(p=>fs.readFileSync(path.resolve(__dirname,p)).toString("base64"))]);}
function program(data,invitation,fault){const core=fs.readFileSync(require.resolve("../marketCalendarHistory/formalControlledWriterCore.js"),"utf8");
  return `(async()=>{const Schema=${JSON.stringify({DATABASE_NAME:Schema.DATABASE_NAME,STORES:Schema.STORES,EXPECTED_FINGERPRINT:Schema.EXPECTED_FINGERPRINT})},
    stable=(${C.stable.toString()}),module={exports:{}},deps={'./productionSchemaV1.js':Schema,'./bootstrapSchemaV1.js':{STORE_ORDER:${JSON.stringify(Core.STORE_ORDER)}},'../marketCalendar/marketEventCanonicalizer.js':{stable}};
    ((module,require)=>{${core}\n})(module,k=>{if(!Object.hasOwn(deps,k))throw Error('canary_core_dependency_invalid');return deps[k];});
    return (${Renderer.runRenderer.toString()})(${JSON.stringify(data)},${JSON.stringify(invitation)},module.exports,(${Executor.machineryCanaryExecutionSource}),Schema,
      (${B.inspect.toString()}),(${Schema.fingerprint.toString()}),stable,${JSON.stringify(E.COUNTS)},${JSON.stringify(fault)});})()`;
}
function validateReceipt(r,invitation,consumeIdentity,data){
  if(!A.exact(r,["schemaVersion","sourceId","operation","attemptIdentity","consumeIdentity","status","reason","localToken","transactions","counts","preIdentity","postIdentity","snapshot","audit"])||
    r.schemaVersion!==1||r.sourceId!==E.SOURCE||r.operation!==E.OPERATION||r.attemptIdentity!==data.attemptIdentity||r.consumeIdentity!==consumeIdentity||
    r.status!=="verified"||r.reason!==null||!Core.same(r.localToken,{minted:1,writerCalls:1,success:true})||
    !Core.same(r.transactions,{readwrite:1,commit:1,abort:0})||!Core.same(r.counts,E.COUNTS)||r.preIdentity!==A.hash(data.before)||
    r.postIdentity!==invitation.binding.expectedFormalIdentity||!Core.same(Core.sorted(r.snapshot),data.expected)||
    !Core.same(r.audit,{create:0,upgrade:0,deletes:0,network:0,handles:0,readbackReopens:1}))throw Error("canary_receipt_invalid");
  const context=Cycle.create(r.snapshot,Schema.EXPECTED_FINGERPRINT);Cycle.close(context);
}
function createIsolatedController(options){
  if(process.type!=="browser"||!process.versions.electron||!A.exact(options,["targetEnvironment","fixtureRoot","preparation","fault"])||
    options.targetEnvironment!=="isolated_test"||options.fault!==null&&!FAULTS.includes(options.fault))throw Error("isolated_canary_controller_required");
  const data=P.inspect(options.preparation),store=Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:options.fixtureRoot,
    crashAt:options.fault==="after_authorization"?options.fault:null});
  return build(data,store,()=>Windows.createIsolatedWindow({targetEnvironment:"isolated_test",fixtureRoot:options.fixtureRoot,
    crashAt:options.fault==="before_load"?"before_load":null}),options.preparation,options.fault);
}
function createProductionController(options){
  if(process.type!=="browser"||!process.versions.electron||!A.exact(options,["preparation"]))throw Error("production_canary_controller_invalid");
  const data=P.inspect(options.preparation);
  if(data.productionStartup!==true)throw Error("production_startup_proof_required");
  return build(data,Store.createProductionStore(),()=>Windows.createProductionWindow(),options.preparation,null);
}
function build(data,store,openWindow,preparation,fault){
  let started=false,window=null,collector=null,frame=null,attempt=null,invitation=null,phase="idle",nonceChallenge=null,rendererChallenge=null,consumeIdentity=null,receipt=null;
  let handlers=0,grants=0,invalid=false;const phases=[],windowAudits=[];
  const point=n=>{if(fault===n){process.kill(process.pid,"SIGKILL");throw Error("fixture_crash_failed");}};
  const observe=()=>{const s=store.load();if(s.status!=="valid")throw Error(s.reason);phases.push({sequence:s.record.safety.sequence,
    generation:s.generation,phase:s.record.lifecycleAudit.at(-1)?.phase||"idle",checksum:s.record.checksum});return s;};
  function sender(event){if(invalid||!window?.valid(event)||artifactIdentity()!==invitation.artifactIdentity)throw Error("canary_sender_invalid");}
  function packet(p,extra=[]){if(!A.exact(p,["attemptIdentity","invitationIdentity","nonce","rendererChallenge","materialIdentity",...extra])||
    p.attemptIdentity!==data.attemptIdentity||p.invitationIdentity!==invitation.identity||p.nonce!==invitation.nonce||p.materialIdentity!==invitation.materialIdentity||
    !/^[a-f0-9-]{36}$/.test(p.rendererChallenge))throw Error("canary_challenge_invalid");}
  function fresh(){const s=store.load();if(s.status!=="valid"||s.generation!==invitation.preparedGeneration||
    s.record.checksum!==invitation.preparedChecksum||s.record.safety.sequence!==invitation.preparedSequence||
    s.record.safety.pendingFence?.phase!=="prepared"||!Core.same(s.record.safety.pendingFence.binding,invitation.binding))throw Error("canary_binding_stale");return s;}
  async function challenge(event,p){sender(event);if(phase!=="invited")throw Error("canary_challenge_replayed");phase="challenge_spent";
    packet(p);fresh();rendererChallenge=p.rendererChallenge;nonceChallenge=A.hash({invitation:invitation.identity,rendererChallenge,challenge:randomUUID()});
    phase="challenged";point("after_challenge");return {challengeIdentity:nonceChallenge};}
  async function consume(event,p){sender(event);if(phase!=="challenged")throw Error("canary_consume_replayed");phase="consume_locked";
    packet(p,["challengeIdentity"]);if(p.challengeIdentity!==nonceChallenge||p.rendererChallenge!==rendererChallenge)throw Error("canary_challenge_invalid");fresh();
    store.markWriteStarted(attempt);const s=observe();phase="spent";consumeIdentity=A.hash({invitation:invitation.identity,challenge:nonceChallenge,checksum:s.record.checksum});
    point("started_before_permit");if(fault==="permit_lost")throw Error("fixture_permit_lost");
    return {schemaVersion:1,attemptIdentity:data.attemptIdentity,consumeIdentity,startedSequence:s.record.safety.sequence,startedGeneration:s.generation,startedChecksum:s.record.checksum};}
  async function submit(event,value){sender(event);if(phase!=="spent"||receipt)throw Error("canary_receipt_replayed");phase="receipt_spent";
    validateReceipt(value,invitation,consumeIdentity,data);receipt=A.freeze(structuredClone(value));
    store.markCommitObserved(attempt,receipt.transactions);observe();phase="commit_observed";point("commit_before_readback");return {accepted:true};}
  async function cleanup(){if(frame){for(const channel of CHANNELS){try{frame.ipc.removeHandler(channel);}catch(e){if(!frame.detached)throw e;}}frame=null;handlers=0;}
    if(window){await window.close();windowAudits.push(window.audit());window=null;}grants=0;}
  async function start(...args){if(args.length||started)throw Error("canary_attempt_replayed");started=true;
    try{
      const before=store.load();if(before.status!=="valid"||before.owned||before.record.lifecycleAudit.length)throw Error("canary_authority_unavailable");
      const prepared=store.begin(preparation);attempt=prepared.token;const saved=observe();point("before_window");
      window=await openWindow();point("after_load");
      const body={schemaVersion:1,nonce:randomUUID(),binding:prepared.binding,preparedGeneration:saved.generation,preparedChecksum:saved.record.checksum,
        preparedSequence:saved.record.safety.sequence,target:window.target,artifactIdentity:artifactIdentity(),materialIdentity:A.hash(data)};
      invitation=A.freeze({...body,identity:A.hash(body)});grants=1;phase="invited";frame=window.wc.mainFrame;
      [challenge,consume,submit].forEach((fn,i)=>{frame.ipc.handle(CHANNELS[i],fn);handlers++;});
      if(fault==="reload"){await new Promise(resolve=>{window.wc.once("did-finish-load",resolve);window.wc.reload();});}
      if(fault==="wrong_frame"){if(window.valid({sender:window.wc,senderFrame:null}))throw Error("fixture_wrong_frame_accepted");throw Error("canary_wrong_frame_rejected");}
      if(fault==="wrong_sender"){const other=await openWindow();
        try{await other.run(program(data,invitation,null));}finally{await other.close();windowAudits.push(other.audit());}throw Error("fixture_wrong_sender_accepted");}
      await window.run(program(data,invitation,fault));if(phase!=="commit_observed"||!receipt)throw Error("canary_receipt_missing");
      const prior=window.target;await cleanup();collector=await openWindow();
      if(collector.target.osProcessId===prior.osProcessId||collector.target.webContentsId===prior.webContentsId)throw Error("canary_fresh_renderer_required");
      const loaded=await Reader.createReader(collector.wc)();if(loaded.status!=="ok"||loaded.audit.readwrite||loaded.audit.writes||loaded.audit.handles)throw Error("canary_readback_failed");
      store.markReadbackVerified(attempt,loaded.snapshot,true);observe();point("readback_before_completion");const final=store.complete(attempt);observe();phase="completed";
      return {status:"PASS",receipt,phases,final,freshRenderer:{prior,next:collector.target,audit:loaded.audit}};
    }catch(e){invalid=true;phase="stopped";return {status:"FAIL",reason:e.message,receipt,phases,final:store.load()};}
    finally{await cleanup();if(collector){await collector.close();windowAudits.push(collector.audit());collector=null;}store.close();}
  }
  return Object.freeze({start,audit:()=>({handlers,grants,windows:window||collector?1:0,phase,mainExecutionTokens:0,windowAudits,store:store.audit()})});
}
module.exports=Object.freeze({CHANNELS,FAULTS,validateReceipt,createIsolatedController,createProductionController});
