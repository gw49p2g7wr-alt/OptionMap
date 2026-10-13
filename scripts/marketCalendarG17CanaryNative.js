"use strict";

// Disposable package/profile only. No production reader, issuer or activation.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),cp=require("node:child_process"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const ROOT=path.resolve(__dirname,".."),sha=b=>crypto.createHash("sha256").update(b).digest("hex");
function sentinel(){const audit={productionAttempts:0,networkAttempts:0};
  const check=p=>{if(typeof p!=="string"&&!Buffer.isBuffer(p))return;const v=path.resolve(String(p));
    if(v==="/Users/natsu/Library"||v.startsWith("/Users/natsu/Library/")){audit.productionAttempts++;throw Error("isolated_production_path_forbidden");}};
  for(const k of ["readFileSync","writeFileSync","openSync","statSync","lstatSync","realpathSync","existsSync","readdirSync","mkdirSync","renameSync","unlinkSync","rmSync",
    "readFile","writeFile","open","stat","lstat","realpath","readdir","mkdir","rename","unlink"]){const raw=fs[k];fs[k]=function(p,...args){check(p);if(k.startsWith("rename"))check(args[0]);return raw.call(this,p,...args);};}
  for(const k of Object.keys(fs.promises))if(typeof fs.promises[k]==="function"){const raw=fs.promises[k];fs.promises[k]=function(p,...args){check(p);if(k==="rename")check(args[0]);return raw.call(this,p,...args);};}
  const noNetwork=()=>{audit.networkAttempts++;throw Error("isolated_network_forbidden");};global.fetch=noNetwork;
  for(const m of ["node:http","node:https"])for(const k of ["get","request"])require(m)[k]=noNetwork;return audit;
}
async function worker(){
  const {app,BrowserWindow,session}=require("electron"),pack=app.getAppPath();
  const config=JSON.parse(fs.readFileSync(path.join(pack,"fixture.json"),"utf8"));
  const Guard=require("./marketCalendarG14bFilesystemGuard.js"),policy=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:config.root});
  assert.equal(pack,path.join(config.root,"package"));app.setPath("appData",policy.parents[1]);app.setPath("userData",policy.profile);app.setPath("sessionData",policy.profile);
  app.setPath("crashDumps",path.join(config.root,"crashes"));app.commandLine.appendSwitch("disable-background-networking");app.disableHardwareAcceleration();
  const guard=sentinel();app.on("window-all-closed",()=>{});
  let stage="modules";const watchdog=setTimeout(()=>{console.error("isolated_watchdog: "+stage);app.exit(3);},40000);
  const corePath=require.resolve("../js/marketCalendarHistory/formalControlledWriterCore.js"),core=require(corePath);let mainTokenAttempts=0;
  require.cache[corePath].exports=Object.freeze({...core,prepareExecution(){mainTokenAttempts++;throw Error("isolated_main_token_forbidden");}});
  const E=require("../js/marketCalendarHistory/mofStartupCanaryEnvelope.js"),P=require("../js/marketCalendarHistory/mofStartupCanaryPlan.js"),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js");
  const W=require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js"),C=require("../js/marketCalendarRuntime/mofStartupCanaryController.js");
  const Reader=require("../js/marketCalendarRuntime/formalShadowElectronRead.js"),Schema=require("../js/marketCalendarHistory/productionSchemaV1.js"),A=require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
  await app.whenReady();stage="app_ready";let result,window;
  if(config.wiring&&config.mode==="execute")Store.createProductionStore().activate(A.hash("G1.7-production-factory-isolated-fixture"));
  const s=Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:config.root,crashAt:null}),loaded=s.load();assert.equal(loaded.status,"valid",loaded.reason);
  if(config.mode==="read"){
    stage="read_window";
    window=await W.createIsolatedWindow({targetEnvironment:"isolated_test",fixtureRoot:config.root});
    stage="read_snapshot";
    try{result={status:"READ",loaded,formal:await Reader.createReader(window.wc)()};}finally{await window.close();}
  }else{
    const f=config.fixture;
    window=await W.createIsolatedWindow({targetEnvironment:"isolated_test",fixtureRoot:config.root});
    let security,parity;
    try{
      const prefs=window.wc.getLastWebPreferences(),ui=await window.wc.executeJavaScript("({node:typeof require,bridge:typeof __mofPrivateGrant})");
      security={nodeIntegration:prefs.nodeIntegration,contextIsolation:prefs.contextIsolation,sandbox:prefs.sandbox,mainWorldNode:ui.node,mainWorldBridge:ui.bridge};
      parity=await window.run(`(async()=>{const schema=${JSON.stringify(Schema.definition())},snapshot=${JSON.stringify(f.snapshot)},order=${JSON.stringify(core.STORE_ORDER)};
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(schema.databaseName,schema.version);r.onupgradeneeded=()=>{for(const [name,d]of Object.entries(schema.stores)){
          const st=r.result.createObjectStore(name,{keyPath:d.keyPath});for(const [n,k,u]of d.indexes)st.createIndex(n,k,{unique:u});}};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        await new Promise((resolve,reject)=>{const tx=db.transaction(order.map(x=>x[1]),'readwrite');for(const [f,n]of order)for(const row of snapshot[f])tx.objectStore(n).add(row);
          tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});const out={name:db.name,version:db.version,origin:location.origin,url:location.href,realChromium:true};db.close();return out;})()`);
    }finally{await window.close();}
    if(config.wiring){result=await wiringCycle(f,config.wiring);}
    else{
    const context=P.createIsolatedStartupContext({targetEnvironment:"isolated_test",cycleIdentity:A.hash("native-startup"),checkedAt:f.checkedAt});
    const planned=await P.prepare({...f,record:loaded.record,context});
    if(planned.status==="skipped")result={status:"PASS",skip:planned,writerAttempts:0,storeAudit:s.audit()};
    else{const controller=C.createIsolatedController({targetEnvironment:"isolated_test",fixtureRoot:config.root,preparation:planned.preparation,fault:config.fault});
      result=await controller.start();result.audit=controller.audit();await assert.rejects(controller.start(),/attempt_replayed/);}
    }
    result.security=security;result.parity=parity;
  }
  stage="cleanup";s.close();assert.equal(BrowserWindow.getAllWindows().length,0);await session.defaultSession.closeAllConnections();clearTimeout(watchdog);
  assert.equal(guard.productionAttempts,0);assert.equal(guard.networkAttempts,0);assert.equal(mainTokenAttempts,0);
  result.guard=guard;result.mainTokenAttempts=mainTokenAttempts;result.cleanup={windows:0,handles:0,ipcHandlers:0};
  const bytes=Buffer.from(JSON.stringify(result)),file=path.join(pack,"result.json");
  fs.writeFileSync(file+".tmp",bytes,{flag:"wx",mode:0o600});fs.renameSync(file+".tmp",file);
  fs.writeFileSync(file+".complete",JSON.stringify({bytes:bytes.length,sha256:sha(bytes)}),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({mode:config.mode,status:result.status,bytes:bytes.length}));app.exit(0);
}
function launch(root,profile,fixture,mode,fault,wiring=false){
  const pack=path.join(root,"package");fs.mkdirSync(pack,{recursive:true});
  fs.writeFileSync(path.join(pack,"package.json"),JSON.stringify({name:"optionmap",version:"1.1.0-beta.6",main:__filename}));
  fs.writeFileSync(path.join(pack,"fixture.json"),JSON.stringify({root,fixture,mode,fault,wiring}));
  for(const name of ["result.json","result.json.complete"]){const p=path.join(pack,name);if(fs.existsSync(p))fs.unlinkSync(p);}
  const env={...process.env};for(const k of ["ELECTRON_RUN_AS_NODE","NODE_TEST_CONTEXT","NODE_CHANNEL_FD","NODE_CHANNEL_SERIALIZATION_MODE"])delete env[k];
  const out=fs.openSync(path.join(pack,"stdout.log"),"w"),err=fs.openSync(path.join(pack,"stderr.log"),"w");let child;
  try{child=cp.spawnSync(require("electron"),[pack,"--user-data-dir="+profile],{cwd:ROOT,env,detached:true,stdio:["ignore",out,err],timeout:45000,killSignal:"SIGKILL"});}
  finally{fs.closeSync(out);fs.closeSync(err);}
  const hard=["after_authorization","before_window","before_load","after_load","after_challenge","started_before_permit","commit_before_readback","readback_before_completion"];
  const crash=mode==="execute"&&(child.status===86&&fault==="after_authorization"||child.signal==="SIGKILL"&&hard.includes(fault));
  if(child.error||crash){try{process.kill(-child.pid,"SIGKILL");}catch(e){if(e.code!=="ESRCH")throw e;}}
  if(child.error||child.signal&&!crash)throw Error("isolated_native_child_failed: "+fs.readFileSync(path.join(pack,"stderr.log"),"utf8"));
  let result=null;if(child.status===0){const b=fs.readFileSync(path.join(pack,"result.json")),m=JSON.parse(fs.readFileSync(path.join(pack,"result.json.complete")));
    assert.equal(b.length,m.bytes);assert.equal(sha(b),m.sha256);result=JSON.parse(b);}
  return {code:crash?86:child.status,result,stderr:fs.readFileSync(path.join(pack,"stderr.log"),"utf8")};
}
async function nativeCase(fault=null,newEvents=1,wiring=false){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"optionmap-g14bg-fixture-g17-native-"));
  try{
    const Guard=require("./marketCalendarG14bFilesystemGuard.js"),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js"),
      F=require("../test/fixtures/marketCalendar/mofStartupCanaryFixture.js"),A=require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
    const policy=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:root}),fixture=await F.setup({newEvents});
    fs.mkdirSync(policy.profile,{recursive:true,mode:0o700});const s=Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt:null});
    if(wiring)require("../test/fixtures/marketCalendar/mofStartupWiringFixture.js").seedHistorical(policy.profile,fixture.historical);
    else s.activateHistorical(fixture.historical,fixture.gate);s.close();const history=A.hash(fixture.historical);
    const executed=launch(root,policy.profile,fixture,"execute",fault,wiring),reload=launch(root,policy.profile,null,"read",null,wiring);
    assert.equal(reload.code,0,reload.stderr);assert.equal(reload.result.loaded.status,"valid",reload.result.loaded.reason);
    assert.equal(A.hash(reload.result.loaded.record.historicalRecord),history);assert.equal(reload.result.formal.audit.readwrite,0);
    if(!fault&&wiring!=="stale")assert.equal(executed.result?.status,"PASS",executed.result?.reason||executed.stderr);
    const processes=cp.spawnSync("ps",["-axo","pid=,command="],{encoding:"utf8"});assert.equal(processes.status,0);
    assert.equal(processes.stdout.split("\n").filter(r=>r.includes(policy.profile)).length,0,"isolated_process_leftover");
    return {executed,reload,historyUnchanged:true,cleanup:{profiles:0,children:0}};
  }finally{fs.rmSync(root,{recursive:true});}
}
async function wiringCycle(f,mode){
  const {BrowserWindow,ipcMain}=require("electron"),W=require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js"),
    Reader=require("../js/marketCalendarRuntime/formalShadowElectronRead.js"),Bridge=require("../js/marketCalendarRuntime/mofStartupPersistenceBridge.js"),
    Production=require("../js/marketCalendarRuntime/mofStartupCanaryProductionRuntime.js"),Normal=require("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js");
  const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:path.join(ROOT,"preload.js")}});
  let composition,resolveDone;const done=new Promise(r=>{resolveDone=r;});
  try{
    const nf=await require("../test/fixtures/marketCalendar/mofNormalFixture.js").setup({readFormal:Reader.createReader(win.webContents),
      compose:c=>Normal.create({...c,webContents:win.webContents,runtimeStateOwner:"renderer",now:()=>new Date().toISOString()})});
    if(f.source.canonicalRecords.length>16){const u="https://www.mof.go.jp/jgbs/auction/calendar/2612.htm";
      nf.documents[u]=nf.documents[u].replace("</tbody>",require("../test/fixtures/marketCalendar/mofJgbFixture.js").row("12月28日","10年利付国債")+"</tbody>");}
    const context=Production.initializeProductionContext();assert(context);assert.equal(Production.validateProductionContext({}),false);
    composition=Production.createProductionRuntime(context,win.webContents,nf.runtime);
    ipcMain.handle(Bridge.CLAIM,e=>composition.claim(e));
    ipcMain.handle("check-market-calendar-sources",(e,r)=>composition.check(e,r));
    ipcMain.handle(Bridge.PERSISTED,async(e,r)=>{try{const v=await composition.persisted(e,r);resolveDone(null);return v;}catch(error){resolveDone(error.message);throw error;}});
    await win.loadFile(W.DOCUMENT);
    for(const p of ["js/marketCalendar/sourceRegistry.js","js/marketCalendarRuntime/sourceUpdateState.js","js/storage/marketCalendarRuntimeStateStore.js",
      "js/marketCalendarRuntime/calendarRuntimeStateIntegration.js","js/marketCalendarRuntime/calendarStartupRuntime.js"])
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(ROOT,p),"utf8"));
    if(mode==="stale")await win.webContents.executeJavaScript(`(()=>{const m=OptionMapCalendarRuntimeStateStore,c=m.createRuntimeStateStore;
      m.createRuntimeStateStore;globalThis.__staleStore={...m,createRuntimeStateStore:o=>{const s=c(o);return {...s,write:(id,r)=>s.write(id,id==='jp-mof-jgb-auction-calendar'?{...r,lastSuccessAt:'2026-10-09T00:00:00.000Z'}:r)};}};return true;})()`);
    const startup=mode==="stale"?await win.webContents.executeJavaScript(`(async()=>{const s=__staleStore.createRuntimeStateStore({indexedDB,targetEnvironment:'browser_runtime'});
      const rt=OptionMapCalendarRuntimeStateIntegration.createRuntimeStateIntegration({store:s,targetEnvironment:'browser_runtime',service:{check:r=>optionMapBridge.checkCalendarSources(r)}});return rt.startup();})()`):
      await win.webContents.executeJavaScript("OptionMapCalendarStartupRuntime.create({bridge:optionMapBridge}).startup()");
    const reason=await done,diagnostics=composition.diagnostics();
    return {status:reason?"FAIL":"PASS",reason,diagnostics,normal:startup,requests:nf.requests.length,
      safety:require("../js/marketCalendarRuntime/writerSafetyReadOnly.js").createReader(require("electron").app.getPath("userData")).load()};
  }finally{composition?.close();for(const c of [Bridge.CLAIM,Bridge.PERSISTED,"check-market-calendar-sources"])ipcMain.removeHandler(c);win.destroy();}
}
async function atomicWorker(mode,root,crashAt){
  const guard=sentinel(),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js"),P=require("../js/marketCalendarHistory/mofStartupCanaryPlan.js"),
    F=require("../test/fixtures/marketCalendar/mofStartupCanaryFixture.js"),A=require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
  const s=Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt});
  if(mode==="read")return {loaded:s.load(),guard,audit:s.audit(),receiptFixturesOnly:true};
  const f=await F.setup(),record=s.load().record,context=P.createIsolatedStartupContext({targetEnvironment:"isolated_test",cycleIdentity:A.hash("atomic-fixture-cycle"),checkedAt:f.checkedAt});
  const p=await P.prepare({...f,record,context}),d=P.inspect(p.preparation),h=s.begin(p.preparation);
  s.markWriteStarted(h.token);s.markCommitObserved(h.token,{readwrite:1,commit:1,abort:0});s.markReadbackVerified(h.token,d.expected,true);s.complete(h.token);
  return {loaded:s.load(),guard,audit:s.audit(),receiptFixturesOnly:true};
}
async function atomicCase(crashAt){
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"optionmap-g14bg-fixture-g17-atomic-"));
  try{const Guard=require("./marketCalendarG14bFilesystemGuard.js"),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js"),
    F=require("../test/fixtures/marketCalendar/mofStartupCanaryFixture.js");
    const profile=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:root}).profile,f=await F.setup();fs.mkdirSync(profile,{recursive:true,mode:0o700});
    const activationFault=/^activation:|_activation$/.test(crashAt);
    if(!activationFault)Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt:null}).activateHistorical(f.historical,f.gate);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const run=(mode,fault)=>cp.spawnSync(process.execPath,[__filename,"--atomic-"+mode,root,fault||"none"],{env,encoding:"utf8",timeout:20000});
    const executed=run(activationFault?"activate":"lifecycle",crashAt);assert.equal(executed.status,86,executed.stderr);
    const fresh=run("read",null);assert.equal(fresh.status,0,fresh.stderr);const result=JSON.parse(fresh.stdout);
    assert(["valid","missing"].includes(result.loaded.status));if(result.loaded.status==="valid")assert.equal(result.loaded.owned,true);
    assert.equal(result.loaded.retryAllowed,false);assert.deepEqual(result.guard,{productionAttempts:0,networkAttempts:0});return result;
  }finally{fs.rmSync(root,{recursive:true});}
}
if(process.type==="browser")worker().catch(e=>{console.error(e.stack);require("electron").app.exit(1);});
else if(require.main===module&&process.argv[2]?.startsWith("--atomic-")){
  const mode=process.argv[2].slice(9),root=process.argv[3],fault=process.argv[4]==="none"?null:process.argv[4];
  (mode==="activate"?(async()=>{sentinel();const f=await require("../test/fixtures/marketCalendar/mofStartupCanaryFixture.js").setup();
    require("../js/marketCalendarHistory/mofStartupCanaryStore.js").createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt:fault}).activateHistorical(f.historical,f.gate);})():atomicWorker(mode,root,fault))
    .then(r=>console.log(JSON.stringify(r)),e=>{console.error(e.stack);process.exitCode=1;});
}
else if(require.main===module)nativeCase(process.argv[2]||null).then(r=>console.log(JSON.stringify({status:r.executed.result?.status,code:r.executed.code,
  reason:r.executed.result?.reason,receipt:r.executed.result?.receipt?.counts,sequence:r.reload.result.loaded.record.safety.sequence})),e=>{console.error(e.stack);process.exitCode=1;});
module.exports=Object.freeze({nativeCase,atomicCase});
