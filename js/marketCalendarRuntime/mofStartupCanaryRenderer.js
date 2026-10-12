"use strict";

// New operation identity, same sandboxed local-token execution pattern. Serialized
// only into the existing private hidden-renderer world. No production entry.
async function runRenderer(data, invitation, Core, execute, Schema, inspect, fingerprint, stable, counts, fault) {
  const SOURCE="jp-mof-jgb-auction-calendar", OP="startup-canary-new-only", bridge=globalThis.__mofPrivateGrant;
  const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).sort().join("|")===keys.slice().sort().join("|");
  const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stable(v)))),n=>n.toString(16).padStart(2,"0")).join("");
  if(globalThis.__mofStartupCanaryAttempt)throw Error("canary_renderer_replay");globalThis.__mofStartupCanaryAttempt=true;
  if(!bridge||!exact(bridge,["challenge","consume","submitReceipt"])||data.plan.sourceId!==SOURCE||invitation.binding.sourceId!==SOURCE||
    invitation.binding.operation!==OP||location.href!==invitation.target.documentUrl||await hash(data)!==invitation.materialIdentity||
    data.planIdentity!==invitation.binding.planIdentity||await hash(data.plan.counts)!==await hash(counts))throw Error("canary_renderer_binding_invalid");
  const packet={attemptIdentity:data.attemptIdentity,invitationIdentity:invitation.identity,nonce:invitation.nonce,
    rendererChallenge:crypto.randomUUID(),materialIdentity:invitation.materialIdentity};
  if(fault==="wrong_challenge")packet.nonce="wrong";
  const challenged=await bridge.challenge(packet);
  if(fault==="replay_challenge")await bridge.challenge(packet);
  const permit=await bridge.consume({...packet,challengeIdentity:challenged.challengeIdentity});
  if(!exact(permit,["schemaVersion","attemptIdentity","consumeIdentity","startedSequence","startedGeneration","startedChecksum"])||
    permit.schemaVersion!==1||permit.attemptIdentity!==data.attemptIdentity||permit.startedSequence!==invitation.preparedSequence+1)
    throw Error("canary_renderer_permit_invalid");
  if(fault==="after_permit")throw Error("fixture_after_permit");
  if(fault==="replay_consume")await bridge.consume({...packet,challengeIdentity:challenged.challengeIdentity});
  let minted=0,calls=0,rw=0,active=false,network=0,deletes=0,observed;
  const actual=Object.fromEntries(Object.keys(counts).map(k=>[k,0])),restore=[];
  const replace=(o,k,f)=>{const raw=o[k];o[k]=f(raw);restore.push(()=>{o[k]=raw;});};
  const names=Object.fromEntries(Core.STORE_ORDER.map(([f,n])=>[n,f]));
  const ops={entries:{add:"eventEntryCreate",put:"eventEntryUpdate"},revisions:{add:"semanticRevisionCreate",put:"semanticRevisionClose"},
    evidence:{add:"evidenceCreate"},observations:{add:"observationCreate"},runs:{add:"sourceRunCreate"},cursors:{put:"sourceCursorUpdate"}};
  replace(IDBDatabase.prototype,"transaction",raw=>function(stores,mode,...args){if(this.name===Schema.DATABASE_NAME&&mode==="readwrite"){
    if(!active||rw++||JSON.stringify([...stores])!==JSON.stringify(Core.STORE_NAMES))throw Error("canary_second_transaction_forbidden");
    const tx=raw.call(this,stores,mode,...args);if(fault==="during_tx")tx.abort();return tx;}return raw.call(this,stores,mode,...args);});
  for(const kind of ["add","put"])replace(IDBObjectStore.prototype,kind,raw=>function(value,...args){
    if(this.transaction.db.name===Schema.DATABASE_NAME){const key=ops[names[this.name]]?.[kind];
      if(!active||!key||value.sourceId!==SOURCE||actual[key]>=counts[key])throw Error("canary_mutation_out_of_scope");actual[key]++;}return raw.call(this,value,...args);});
  for(const kind of ["delete","clear"])replace(IDBObjectStore.prototype,kind,raw=>function(...args){if(this.transaction.db.name===Schema.DATABASE_NAME){deletes++;throw Error("canary_delete_forbidden");}return raw.call(this,...args);});
  const deny=()=>{network++;throw Error("canary_transaction_network_forbidden");};replace(globalThis,"fetch",()=>deny);replace(XMLHttpRequest.prototype,"send",()=>deny);
  replace(globalThis,"WebSocket",()=>function(){deny();});replace(navigator,"sendBeacon",()=>deny);
  try {
    active=true;const guarded=Object.freeze({...Core,prepareExecution(...args){if(minted++)throw Error("canary_second_token_forbidden");return Core.prepareExecution(...args);},
      executePrepared(...args){if(calls++)throw Error("canary_second_writer_forbidden");if(fault==="after_token")throw Error("fixture_after_token");return Core.executePrepared(...args);}});
    const mode="G1_7_isolated_mof_startup_new_only";
    observed=await execute({binding:{databaseName:Schema.DATABASE_NAME,sourceId:SOURCE,invocationId:data.attemptIdentity,authorityMode:mode,plannedReadwriteTransactions:1,
      identities:{schemaFingerprint:Schema.EXPECTED_FINGERPRINT,plan:data.planIdentity},exactMutationCeiling:Object.fromEntries(Object.keys(data.plan.mutations).map(k=>[k,data.plan.mutations[k].length]))},
      before:data.before,plan:data.plan,expectedAfter:data.expected,expiresAt:Date.now()+300000},guarded,Schema,inspect,fingerprint,SOURCE,mode,counts);
    if(fault==="commit_ambiguous")throw Error("fixture_commit_ambiguous");
    if(fault==="second_tx"){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(Schema.DATABASE_NAME);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      try{db.transaction(Core.STORE_NAMES,"readwrite");}finally{db.close();}}
  } finally {active=false;restore.reverse().forEach(f=>f());}
  const receipt={schemaVersion:1,sourceId:SOURCE,operation:OP,attemptIdentity:data.attemptIdentity,consumeIdentity:permit.consumeIdentity,status:observed.status,
    reason:observed.reason,localToken:{minted,writerCalls:calls,success:observed.committed===true},transactions:{readwrite:observed.metrics.readwriteTransactions,
      commit:observed.metrics.committedTransactions,abort:observed.metrics.abortedTransactions},counts:actual,preIdentity:await hash(Core.sorted(data.before)),
    postIdentity:observed.readback?await hash(Core.sorted(observed.readback)):null,snapshot:observed.readback,
    audit:{create:observed.audit.create,upgrade:observed.audit.upgrade,deletes,network,handles:observed.audit.openHandles,readbackReopens:observed.audit.readbackReopens}};
  return bridge.submitReceipt(receipt);
}
module.exports=Object.freeze({runRenderer});
