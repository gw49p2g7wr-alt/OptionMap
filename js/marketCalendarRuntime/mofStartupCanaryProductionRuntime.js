"use strict";

// Main-only composition around the unchanged normal acquisition path. Legacy
// Runtime State persistence remains entirely renderer-owned.
const Profile=require("../marketCalendarHistory/writerSafetyInitialProvisioning.js");
const Reader=require("./writerSafetyReadOnly.js"),Formal=require("./formalShadowElectronRead.js");
const Bridge=require("./mofStartupPersistenceBridge.js"),P=require("../marketCalendarHistory/mofStartupCanaryPlan.js");
const E=require("../marketCalendarHistory/mofStartupCanaryEnvelope.js"),Controller=require("./mofStartupCanaryController.js");
const Contracts=require("./normalAcquisitionContract.js"),A=require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const contexts=new WeakMap();
function initializeProductionContext(...args){
  if(args.length||process.type!=="browser"||!process.versions.electron)throw Error("native_main_required");
  let root;
  try{root=Profile.resolveProductionProfile();}catch(e){return null;}
  const token=Object.freeze({});contexts.set(token,root);return token;
}
function validateProductionContext(context){return contexts.has(context);}
function createProductionRuntime(context,wc,normal){
  if(process.type!=="browser"||!process.versions.electron||typeof normal?.check!=="function"||typeof normal?.diagnostics!=="function")throw Error("native_main_required");
  const root=contexts.get(context);
  if(!root||wc.session!==require("electron").session.defaultSession||wc.session.getStoragePath()!==root)throw Error("production_context_invalid");
  const safety=Reader.createReader(root),readFormal=Formal.createReader(wc);
  let controller=null,last=null,normalResult=null;
  const bridge=Bridge.createProductionBridge(context,wc,async evidence=>{
    const loaded=safety.load();
    if(loaded.status!=="valid"||loaded.envelopeVersion!==4)throw Error("production_canary_safety_unavailable");
    const before=await readFormal();if(before.status!=="ok")throw Error("production_canary_formal_unavailable");
    const context=P.createProductionStartupContext(evidence.proof),selected=await P.prepare({...evidence,context,record:loaded.record,snapshot:before.snapshot});
    if(selected.status==="skipped"){last=A.freeze({...selected,status:"PASS",authority:E.AUTHORITY,formalAudit:before.audit});return last;}
    controller=Controller.createProductionController({preparation:selected.preparation});
    last=await controller.start();last.audit=controller.audit();last.normalState=normalResult?.state;return last;
  });
  async function check(event,request={}){
    const {__mofStartupTicket:ticket,...input}=request;
    if(!ticket)return normal.check(input); // renderer trigger alone never enters the writer path.
    if(input.trigger!=="startup"||(input.sourceIds&&A.hash([...input.sourceIds].sort())!==A.hash([...Contracts.resolve(Contracts.NORMAL13)].sort())))
      throw Error("production_startup_scope_invalid");
    await bridge.start(event,ticket,input.runtimeStates);normalResult=await normal.check(input);
    const source=normal.diagnostics().comparison?.sourceResults?.find(s=>s.sourceId===E.SOURCE);
    const formalOwner=normal.diagnostics().formalPartialBootstrap?.coordinator?.ownershipBySource?.[E.SOURCE]||null;
    const pending=bridge.capture(normalResult,source,formalOwner);
    return {__mofStartupResult:normalResult,__mofStartupReceipt:pending};
  }
  function claim(event){const loaded=safety.load();
    if(loaded.status!=="valid"||loaded.envelopeVersion!==4||loaded.safety.pendingFence||loaded.safety.globalSuspend.suspended||
      loaded.safety.sources.some(s=>s.suspended)||loaded.record.lifecycleAudit.length){last={status:"NOT_ACTIVE",reason:loaded.reason||"canary_not_available",writerAttempts:0};return null;}
    return bridge.claim(event);
  }
  return Object.freeze({check,claim,persisted:bridge.persisted,close:bridge.close,
    diagnostics:()=>({canary:last||bridge.diagnostics().result,bridge:bridge.diagnostics(),normal:normal.diagnostics(),normalResult,
      controller:controller?.audit()||null})});
}
module.exports=Object.freeze({initializeProductionContext,validateProductionContext,createProductionRuntime});
