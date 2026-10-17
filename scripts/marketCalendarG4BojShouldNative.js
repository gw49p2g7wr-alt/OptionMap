"use strict";

// Explicit diagnostic entry. Default disposable profile; production mode is
// read-only and never imports normal startup, Runtime State, or safety readers.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), cp = require("node:child_process"),
  A = require("node:assert/strict"), crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, ".."), sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const Filesystem = require("../js/marketCalendarHistory/crossPlatformFilesystemSafety.js");
const Lifecycle = require("../test/fixtures/nativeElectronFixtureLifecycle.js");
const MODES = ["isolated", "live-readonly", "production-readonly"];
function guard(root, production) {
  const profile = "/Users/natsu/Library/Application Support/OptionMap", inside = (p,b) => p===b || p.startsWith(b+path.sep);
  const audit = { forbiddenAttempts:0, repositoryWrites:0, productionContentAttempts:0, productionWrites:0, touches:[] };
  function check(p, name, write) {
    if (typeof p!=="string" && !Buffer.isBuffer(p)) return;
    const v=path.resolve(String(p)), metadata=production && !write && (name==="lstatSync" &&
      ["/Users/natsu/Library","/Users/natsu/Library/Application Support",profile].includes(v) || name==="realpathSync" && v===profile);
    const ok=inside(v,root) || !write && inside(v,ROOT) || metadata;
    audit.touches.push({path:v,operation:name,write,allowed:ok});
    if(!ok){audit.forbiddenAttempts++;if(write&&inside(v,ROOT))audit.repositoryWrites++;
      if(inside(v,profile)){audit.productionContentAttempts++;if(write)audit.productionWrites++;}throw Error("g4_filesystem_forbidden");}
  }
  for(const name of ["readFileSync","writeFileSync","openSync","statSync","lstatSync","realpathSync","existsSync","readdirSync","mkdirSync",
    "renameSync","unlinkSync","rmSync","readFile","writeFile","open","stat","lstat","realpath","readdir","mkdir","rename","unlink","rm",
    "copyFileSync","symlinkSync","linkSync","truncateSync"]){
    const raw=fs[name];if(typeof raw!=="function")continue;
    fs[name]=function(p,...args){const write=/^(write|mkdir|rename|unlink|rm|copy|symlink|link|truncate)/.test(name)||name.startsWith("open")&&
      !["r",fs.constants.O_RDONLY,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW].includes(args[0]);
      check(p,name,write);if(/^(rename|copy|symlink|link)/.test(name))check(args[0],name,true);return raw.call(this,p,...args);};
  }
  for(const name of ["open","readFile","writeFile","stat","lstat","realpath","readdir","mkdir","rename","unlink","rm"]){
    const raw=fs.promises[name];fs.promises[name]=function(p,...args){check(p,name,/^(write|mkdir|rename|unlink|rm)/.test(name)||name==="open"&&args[0]!=="r");
      if(name==="rename")check(args[0],name,true);return raw.call(this,p,...args);};
  }
  return audit;
}
async function worker() {
  const {app,net,session,BrowserWindow}=require("electron"),pack=app.getAppPath(),config=JSON.parse(fs.readFileSync(path.join(pack,"guard.json"),"utf8"));
  if(!Filesystem.samePath(path.dirname(config.root),fs.realpathSync(os.tmpdir()))||!path.basename(config.root).startsWith("optionmap-g4-boj-")||
    !Filesystem.samePath(pack,path.join(config.root,"package"))||!MODES.includes(config.mode))throw Error("g4_self_contained_guard_invalid");
  const production=config.mode==="production-readonly",profile=production?require("./marketCalendarG14bFilesystemGuard.js").createProductionPolicy().profile:path.join(config.root,"profile");
  if(!production){fs.mkdirSync(profile,{recursive:true});app.setPath("appData",path.join(config.root,"appData"));}
  app.setPath("userData",profile);app.setPath("sessionData",profile);app.setPath("crashDumps",path.join(config.root,"crashes"));
  app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-background-networking");
  const access=guard(config.root,production),hold=()=>{};app.on("window-all-closed",hold);let window,read,before,after,report;
  try{
    const Coverage=require("../js/marketCalendarRuntime/bojCoverageAcquisition.js"),Policy=require("../js/marketCalendarRuntime/calendarNetworkPolicy.js"),
      Should=require("../js/marketCalendarRuntime/bojShouldParser.js"),Canonical=require("../js/marketCalendar/marketEventCanonicalizer.js");
    await app.whenReady();
    if(production){
      const W=require("../js/marketCalendarRuntime/mofHiddenRendererWindow.js");window=await W.createProductionWindow();
      await window.wc.executeJavaScript(`(()=>{globalThis.__g4={writeAttempts:0,forbiddenDatabase:0};
        const open=indexedDB.open.bind(indexedDB);indexedDB.open=function(name,...args){if(name!=='optionMapMarketCalendarHistory'){__g4.forbiddenDatabase++;throw Error('g4_database_forbidden');}return open(name,...args);};
        const tx=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...args){if(mode&&mode!=='readonly'){__g4.writeAttempts++;throw Error('g4_write_forbidden');}return tx.call(this,names,mode,...args);};
        for(const name of ['put','add','delete','clear'])IDBObjectStore.prototype[name]=function(){__g4.writeAttempts++;throw Error('g4_mutation_forbidden');};return true;})()`);
      read=require("../js/marketCalendarRuntime/formalShadowElectronRead.js").createReader(window.wc);before=await read();A.equal(before.status,"ok",before.reason);
    }
    const allowed=Policy.BOJ_COVERAGE_V3.documents.map(d=>d.url),agents=new Set();let requests=0,observer=0,deniedNetwork=0;
    session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*","ws://*/*","wss://*/*"]},(d,done)=>{
      observer++;const ok=config.mode!=="isolated"&&allowed.includes(d.url)&&(!window||d.webContentsId!==window.wc.id);if(!ok)deniedNetwork++;done({cancel:!ok});});
    session.defaultSession.webRequest.onBeforeSendHeaders((d,done)=>{agents.add(d.requestHeaders["User-Agent"]||"");done({requestHeaders:d.requestHeaders});});
    const Fixture=config.mode==="isolated"?require("../test/fixtures/marketCalendar/bojShouldFixture.js"):null;
    const acquired=await Coverage.createShould({fetchImpl:(u,o)=>{requests++;A(allowed.includes(u));return Fixture?Fixture.response(u):net.fetch(u,o);}})
      .acquire({sourceId:Coverage.SOURCE_ID,operation:Policy.OPERATION});
    A.equal(acquired.success,true,acquired.reason);A.equal(requests,4);A.equal(observer,Fixture?0:4);A.equal(deniedNetwork,0);
    const records=acquired.candidate.canonicalRecords,summary=Object.fromEntries([...new Set(records.map(r=>r.logical.eventType))].map(type=>{
      const rows=records.filter(r=>r.logical.eventType===type),dates=rows.map(r=>r.schedule.sourceLocal.startDate).sort();
      return [type,{count:rows.length,first:dates[0],last:dates.at(-1),time:rows[0].schedule.sourceLocal.startTime}];}));
    for(const type of Should.TYPES)A(summary[type]?.count>0,`category_missing:${type}`);
    if(Fixture)A.equal(records.length,65);
    let comparison=null,nativeAudit=null;
    if(production){
      const X=require("../js/marketCalendarRuntime/formalExactComparison.js").createNormal13Comparison();
      const all=await X.compare({sourceResults:X.SOURCE_IDS.map(sourceId=>({sourceId,canonicalRecords:sourceId===Coverage.SOURCE_ID?records:[]})),formalSnapshot:before.snapshot});
      A.equal(all.status,"compared",all.reason);comparison=all.summaries.find(s=>s.sourceId===Coverage.SOURCE_ID);A.equal(comparison.ambiguity,0);
      after=await read();A.equal(after.status,"ok",after.reason);A.deepEqual(before.snapshot,after.snapshot);
      nativeAudit=await window.wc.executeJavaScript("__g4");A.deepEqual(nativeAudit,{writeAttempts:0,forbiddenDatabase:0});
    }
    report={gate:"G4",mode:config.mode,status:"PASS",package:{name:app.getName(),version:app.getVersion(),electron:process.versions.electron},
      requests,observer,agents:[...agents],manualUAOverride:0,deniedNetwork,documents:acquired.documents,coverage:acquired.coverageAudit,summary,
      candidateCount:records.length,must:records.filter(r=>!Should.TYPES.includes(r.logical.eventType)).length,
      should:records.filter(r=>Should.TYPES.includes(r.logical.eventType)).length,comparison,
      candidateIdentity:await Canonical.sha256(records.map(r=>[r.eventKey,r.canonicalContentHash]).sort()),
      ...(production?{formalCounts:Object.fromEntries(Object.entries(before.snapshot).map(([k,v])=>[k,v.length])),
        formalIdentityBefore:await Canonical.sha256(before.snapshot),formalIdentityAfter:await Canonical.sha256(after.snapshot),formalAudits:[before.audit,after.audit],nativeAudit}:{}),
      runtimeStateAccess:0,runtimeStateWrites:0,safetyContentAccess:0,safetyWrites:0,authorization:0,grant:0,token:0,writer:0,formalReadwrite:0,formalWrites:0,retry:0};
  }finally{
    session.defaultSession.webRequest.onBeforeRequest(null);session.defaultSession.webRequest.onBeforeSendHeaders(null);
    if(window)await window.close();await session.defaultSession.closeAllConnections();app.removeListener("window-all-closed",hold);
  }
  A.equal(access.forbiddenAttempts,0);report.guard=access;report.cleanup={windows:BrowserWindow.getAllWindows().length,dbHandles:0,ipcHandlers:0,grants:0};
  const bytes=Buffer.from(JSON.stringify(report)),destination=path.join(config.root,"receipt.json");
  fs.writeFileSync(destination+".tmp",bytes,{flag:"wx"});fs.renameSync(destination+".tmp",destination);
  fs.writeFileSync(path.join(config.root,"receipt.complete"),JSON.stringify({length:bytes.length,sha256:sha(bytes)}),{flag:"wx"});app.exit(0);
}
function run(mode="isolated") {
  if(!MODES.includes(mode))throw Error("g4_mode_invalid");
  if(mode==="production-readonly" && (cp.execFileSync("git",["diff","--name-only"],{cwd:ROOT,encoding:"utf8"}).trim()||
      cp.execFileSync("git",["diff","--cached","--name-only"],{cwd:ROOT,encoding:"utf8"}).trim()))throw Error("g4_committed_clean_baseline_required");
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"optionmap-g4-boj-"));
  try{
    const pack=path.join(root,"package");fs.mkdirSync(pack);
    const identity=JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8"));
    fs.writeFileSync(path.join(pack,"package.json"),JSON.stringify({name:identity.name,version:identity.version,main:"entry.cjs"}));
    fs.writeFileSync(path.join(pack,"entry.cjs"),`require(${JSON.stringify(__filename)}).worker().catch(e=>{console.error(e.stack);require('electron').app.exit(1)});`);
    fs.writeFileSync(path.join(pack,"guard.json"),JSON.stringify({root,mode}));
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_TEST_CONTEXT;
    const child=Lifecycle.withNativeElectronLaunchLock(()=>cp.spawnSync(require("electron"),[pack],
      {cwd:ROOT,env,encoding:"utf8",timeout:90000,maxBuffer:40960}));
    A.equal(child.status,0,child.stderr||"g4_native_failed");
    const bytes=fs.readFileSync(path.join(root,"receipt.json")),marker=JSON.parse(fs.readFileSync(path.join(root,"receipt.complete")));
    A.equal(bytes.length,marker.length);A.equal(sha(bytes),marker.sha256);
    return {...JSON.parse(bytes),transport:marker,tempDeleted:true};
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports=Object.freeze({worker,run});
if(require.main===module&&process.type!=="browser"){try{console.log(JSON.stringify(run(process.argv[2]||"isolated")));}catch(e){console.error(e.stack);process.exitCode=1;}}
