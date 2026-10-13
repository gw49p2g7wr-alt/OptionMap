"use strict";

// Private preload/main handshake. Notification is NOT proof: main reopens the
// renderer-owned store read-only and binds it to its own acquisition + epoch.
const {randomUUID}=require("node:crypto"),fs=require("node:fs"),path=require("node:path");
const {pathToFileURL}=require("node:url");
const A=require("../marketCalendarHistory/formalWriterAuthorityV2.js"),E=require("../marketCalendarHistory/mofStartupCanaryEnvelope.js");
const B1=require("./sourceUpdateState.js"),proofs=new WeakMap();
const CLAIM="optionmap:mof-startup:claim",PERSISTED="optionmap:mof-startup:persisted";
const DOCUMENTS=Object.freeze(["index.html","scripts/marketCalendarD2d4ReadOnlyProbe.html"].map(p=>
  pathToFileURL(path.resolve(__dirname,"../..",p)).href));
function runtimeReader(wc){
  const files=["../marketCalendar/sourceRegistry.js","./sourceUpdateState.js","../storage/marketCalendarRuntimeStateStore.js"],
    code=files.map(p=>fs.readFileSync(path.resolve(__dirname,p),"utf8")).join("\n");
  return ()=>wc.executeJavaScriptInIsolatedWorld(1743,[{code:`(async()=>{${code}\n
    const s=window.OptionMapCalendarRuntimeStateStore.createRuntimeStateStore({indexedDB,targetEnvironment:'browser_runtime'});
    return s.read(${JSON.stringify(E.SOURCE)});})()`}]);
}
function build(wc,readRuntime,onPersisted,production){
  let claimed=false,invalid=false,ticket=null,target=null,material=null,priorState=null,phase="idle",result=null;
  const audit={claims:0,normalStarts:0,baselineReads:0,persistenceReads:0,proofs:0,runtimeWrites:0,replays:0};
  const epoch=randomUUID();
  const invalidate=()=>{if(claimed)invalid=true;};
  wc.on("did-start-navigation",invalidate);wc.on("render-process-gone",invalidate);wc.on("destroyed",invalidate);
  function binding(){const frame=wc.mainFrame;return {documentUrl:wc.getURL(),webContentsId:wc.id,osProcessId:wc.getOSProcessId(),
    frameProcessId:frame.processId,frameRoutingId:frame.routingId,frameToken:frame.frameToken,documentEpoch:epoch};}
  function sender(event){if(invalid||wc.isDestroyed()||event?.sender!==wc||event.senderFrame!==wc.mainFrame||
    !DOCUMENTS.includes(wc.getURL())||event.senderFrame.url!==wc.getURL()||target&&A.hash(binding())!==A.hash(target))throw Error("startup_epoch_invalid");}
  function claim(event){sender(event);if(claimed)throw Error("startup_claim_replayed");claimed=true;target=binding();
    ticket=A.freeze({schemaVersion:1,sourceId:E.SOURCE,operation:E.OPERATION,attemptIdentity:A.hash({epoch,nonce:randomUUID()}),
      targetIdentity:A.hash(target),nonce:randomUUID()});audit.claims++;phase="armed";return ticket;}
  async function start(event,value,runtimeStates={}){sender(event);if(phase!=="armed"||!ticket||A.hash(value)!==A.hash(ticket))throw Error("startup_ticket_invalid");
    phase="checking_baseline";audit.baselineReads++;const loaded=await readRuntime();sender(event);
    priorState=loaded.value??null;
    if(!["ok","absent"].includes(loaded.status)||priorState&&!B1.validateCompatibleRuntimeState(priorState,E.SOURCE).valid||
      A.hash(runtimeStates[E.SOURCE]??null)!==A.hash(priorState))throw Error("startup_runtime_prestate_mismatch");
    phase="acquiring";audit.normalStarts++;}
  function capture(normal,source){
    if(phase!=="acquiring")throw Error("startup_capture_invalid");
    const own=normal.sources?.find(s=>s.sourceId===E.SOURCE);
    if(own?.acquisitionStatus==="not_attempted"&&own.reasonClass==="already_succeeded_today"){
      phase="skipped";result=A.freeze({status:"PASS",reason:"already_succeeded_today",writerAttempts:0});return null;}
    if(!own||own.status!=="success"||own.acquisitionStatus!=="succeeded"||!source||source.sourceId!==E.SOURCE||
      !Number.isFinite(Date.parse(normal.checkedAt)))throw Error("startup_normal_acquisition_required");
    material=A.freeze({normal:structuredClone(normal),source:structuredClone(source),sourceOutcome:structuredClone(own),checkedAt:normal.checkedAt});
    phase="awaiting_persistence";return ticket;
  }
  async function persisted(event,value){sender(event);if(phase!=="awaiting_persistence"||A.hash(value)!==A.hash(ticket)){
      audit.replays++;throw Error("startup_persistence_replayed_or_invalid");}phase="verifying";
    audit.persistenceReads++;const loaded=await readRuntime();sender(event);
    const r=loaded?.value,expected={sourceId:E.SOURCE,lastAttemptAt:material.checkedAt,lastSuccessAt:material.checkedAt,lastOutcome:"success",
      retryAfter:null,lastHttpStatus:material.sourceOutcome.lastHttpStatus??null,lastDiagnosticClass:null,coordinatorVersion:1};
    if(loaded.status!=="ok"||!B1.validateCompatibleRuntimeState(r,E.SOURCE).valid||A.hash(r)!==A.hash(expected)||
      priorState&&(A.hash(priorState)===A.hash(r)||Date.parse(r.lastAttemptAt)<=Date.parse(priorState.lastAttemptAt))){
      phase="stopped";throw Error("startup_fresh_persistence_required");}
    const acquisitionIdentity=A.hash({source:material.source,runtimeState:r,checkedAt:material.checkedAt}),
      binding={...ticket,target,sourceId:E.SOURCE,checkedAt:material.checkedAt,acquisitionIdentity,runtimeIdentity:A.hash(r),
        cycleIdentity:A.hash({attempt:ticket.attemptIdentity,target,acquisitionIdentity})};
    const token=Object.freeze({});proofs.set(token,{binding:A.freeze(binding),spent:false,production});audit.proofs++;phase="spent";
    try{result=await onPersisted({proof:token,...material,runtimeState:r});return {accepted:true};}
    catch(e){result={status:"FAIL",reason:e.message,writerAttempts:0};throw e;}
  }
  function close(){invalid=true;for(const event of ["did-start-navigation","render-process-gone","destroyed"])wc.removeListener(event,invalidate);}
  return Object.freeze({claim,start,capture,persisted,close,diagnostics:()=>A.freeze({phase,result,audit:{...audit},target})});
}
function createProductionBridge(context,wc,onPersisted){
  if(process.type!=="browser"||!process.versions.electron||typeof onPersisted!=="function")throw Error("native_main_required");
  if(!require("./mofStartupCanaryProductionRuntime.js").validateProductionContext(context))throw Error("production_context_invalid");
  return build(wc,runtimeReader(wc),onPersisted,true);
}
function createIsolatedBridge({targetEnvironment,webContents,readRuntimeState,onPersisted}){
  if(targetEnvironment!=="isolated_test"||typeof readRuntimeState!=="function"||typeof onPersisted!=="function")throw Error("isolated_bridge_required");
  return build(webContents,readRuntimeState,onPersisted,false);
}
function consumeProof(token,production=false){const p=proofs.get(token);if(!p||p.spent||production&&!p.production)throw Error("startup_proof_unknown_or_spent");
  p.spent=true;return p.binding;}
module.exports=Object.freeze({CLAIM,PERSISTED,DOCUMENTS,createProductionBridge,createIsolatedBridge,consumeProof});
