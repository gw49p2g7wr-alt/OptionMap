"use strict";
const {test}=require('node:test'), A=require('node:assert/strict');
const F=require('./fixtures/marketCalendar/bojShouldFixture.js'), Must=require('./fixtures/marketCalendar/bojCoverageFixture.js');
const P=require('../js/marketCalendarRuntime/bojShouldParser.js'), C=require('../js/marketCalendar/marketEventCanonicalizer.js'),
  I=require('../js/marketCalendar/marketEventIdentity.js'), Coverage=require('../js/marketCalendarRuntime/bojCoverageAcquisition.js'),
  N=require('../js/marketCalendarRuntime/calendarNetworkPolicy.js');
const context={sourceId:'jp-boj-calendar',sourceUrl:N.BOJ_COVERAGE_V3.documents[3].url,fetchedAt:'2026-10-13T01:00:00Z',
  sourcePublishedAt:'2026-10-13T09:59:00Z',sourceUpdatedAt:'2026-10-13T10:00:00Z',parserId:'jp-boj-calendar-parser',parserVersion:1,rawContentHash:'a'.repeat(64)};
const meetings=()=>P.parseMeetings(F.meetings(),context), cgpi=()=>P.parseCgpi(F.workbook(),{...context,sourceUrl:N.BOJ_COVERAGE_V3.documents[2].url});
for(const [id,type,count]of [['S1','BOJ_SUMMARY_OF_OPINIONS',16],['S2','BOJ_OUTLOOK_REPORT',8],['S3','BOJ_MPM_MINUTES',15],['S4','JP_CGPI',12]])
  test(`${id} official schedule family ${type}`,()=>{const p=type==='JP_CGPI'?cgpi():meetings();A.deepEqual(p.diagnostics,[]);A.equal(p.records.filter(r=>r.eventType===type).length,count);});
for(const type of P.TYPES)test(`${type} deterministic typed key, URL/title/update independent`,async()=>{
  const r=(type==='JP_CGPI'?cgpi():meetings()).records.find(r=>r.eventType===type), a=await C.canonicalize(r),
    b=await C.canonicalize({...r,titleJa:'alternative punctuation！',sourceUrl:'https://www.boj.or.jp/about/calendar/',sourceUpdatedAt:'2026-10-15T00:00:00Z'});
  A.equal(a.ok,true,a.reason);A.equal(b.ok,true,b.reason);A.equal(a.event.eventKey,b.event.eventKey);
  A.deepEqual(I.create(a.event.logical),a.event.logical);A.equal(a.event.absenceAuthority,'none');
});
test('Summary/Minutes bind exact meeting interval; not the publication month',()=>{
  const r=meetings().records.find(r=>r.eventType==='BOJ_MPM_MINUTES'&&r.bojPublicationIdentity.publicationDate==='2027-01-27');
  A.equal(r.bojPublicationIdentity.meetingStartDate,'2026-12-17');A.equal(r.bojPublicationIdentity.meetingEndDate,'2026-12-18');
});
test('different meeting minutes remain distinct even with same publication date',()=>{
  const r=meetings().records.find(r=>r.eventType==='BOJ_MPM_MINUTES'), s={...r,bojPublicationIdentity:{...r.bojPublicationIdentity,meetingStartDate:'2026-01-20',meetingEndDate:'2026-01-21'}};
  A.equal(P.dedupe([r,s]).records.length,2);
});
test('Outlook basic view is date-only and distinct from policy meeting',async()=>{
  const r=meetings().records.find(r=>r.eventType==='BOJ_OUTLOOK_REPORT');A.equal(r.sourceLocalSchedule.startTime,null);A.equal(r.sourceLocalSchedule.kind,'date_only');
  A.equal(r.bojPublicationIdentity.reportType,'basic_view');A.doesNotMatch((await C.canonicalize(r)).event.eventKey,/BOJ_MPM\|/);
});
test('official 08:50 note used; update/publication metadata never schedules events',()=>{
  for(const r of meetings().records){A.equal(r.sourcePublishedAt,null);A.equal(r.sourceUpdatedAt,null);if(r.eventType!=='BOJ_OUTLOOK_REPORT')A.equal(r.sourceLocalSchedule.startTime,'08:50');}
  A.equal(cgpi().records[6].bojPublicationIdentity.referencePeriod,'2026-12');A.equal(cgpi().records[6].sourceLocalSchedule.startDate,'2027-01-10');
});
test('unannounced minutes has no inferred date or cancellation',()=>{A.equal(meetings().unpublished,1);A.ok(meetings().records.every(r=>r.sourceStatus==='scheduled'));});
test('typed index/detail dedupe keeps exact one candidate and reference evidence',()=>{
  const r=meetings().records[0], detail={...r,sourceTitle:'alternate label',httpMetadata:{...r.httpMetadata,scheduleReferences:[r.sourceUrl,'https://www.boj.or.jp/mopo/outlook/gor2601b.pdf']}};
  const d=P.dedupe([r,detail]);A.equal(d.deduped,1);A.equal(d.records.length,1);A.equal(d.records[0].httpMetadata.scheduleReferences.length,2);
  A.throws(()=>P.dedupe([r,{...r,sourceLocalSchedule:{...r.sourceLocalSchedule,startTime:'09:00'}}]),/schedule_conflict/);
});
for(const [label,from,to]of [['Summary','主な意見','Unknown opinions'],['Outlook','経済・物価情勢の展望','Unknown outlook'],['Minutes','議事要旨','Unknown minutes'],['time note','：8時50分','：9時00分'],['cells','<td>-</td>','']])
  test(`${label} malformed structure fails closed`,()=>{const p=P.parseMeetings(F.meetings().replace(from,to),context);A.equal(p.records.length,0);A.ok(p.diagnostics.length);});
test('detail URL is validated as Evidence, never fetched or identity-derived',()=>{
  const html=F.meetings().replace('<td>1月23日（金）</td>','<td><a href="/mopo/outlook/gor2601b.pdf">1月23日（金）</a></td>');
  const p=P.parseMeetings(html,context);A.deepEqual(p.diagnostics,[]);A.equal(p.records[0].httpMetadata.scheduleReferences.length,2);
  for(const url of ['https://evil.org/a.pdf','/mopo/outlook/gor2601b.pdf?x=1','javascript:alert(1)'])A.ok(P.parseMeetings(html.replace('/mopo/outlook/gor2601b.pdf',url),context).diagnostics.length);
});
test('CGPI only monthly scheduled release, not timeseries or other statistics',()=>{const p=cgpi();A.equal(p.records.length,12);A.ok(p.records.every(r=>r.bojPublicationIdentity.reportType==='monthly_release'));});
test('CGPI malformed label/formula/period/date/1904/unknown sheet rejected',()=>{
  for(const m of [b=>b.Sheets.統計データ.B237.v='企業向けサービス価格指数',b=>b.Sheets.統計データ.E238.f='NOW()',
    b=>b.Sheets.統計データ.E237.v='(5月分)',b=>b.Sheets.統計データ.E238.v=0,b=>{b.Workbook={WBProps:{date1904:true}}},
    b=>{b.SheetNames.push('unknown');b.Sheets.unknown={}}]){
    const p=P.parseCgpi(F.workbook(m),context);A.equal(p.records.length,0);A.ok(p.diagnostics.length);
  }
});
test('typed contract rejects missing/extra/fuzzy/foreign/old generic fields',async()=>{
  const r=meetings().records[0];for(const patch of [{bojPublicationIdentity:undefined},{referencePeriod:'2026-01'},
    {bojPublicationIdentity:{...r.bojPublicationIdentity,extra:1}},{bojPublicationIdentity:{...r.bojPublicationIdentity,authority:'FED'}},
    {bojPublicationIdentity:{...r.bojPublicationIdentity,family:'outlook'}},{sourceLocalSchedule:{...r.sourceLocalSchedule,startDate:'2026-01-24'}}])A.equal((await C.canonicalize({...r,...patch})).ok,false);
});
test('fixed exact V3 route set, no lookalike/foreign/query/broad route',()=>{
  A.ok(Object.isFrozen(I.BOJ_PUBLICATIONS));A.ok(Object.values(I.BOJ_PUBLICATIONS).every(Object.isFrozen));
  A.equal(I.validateBojPublicationIdentity('constructor',meetings().records[0].bojPublicationIdentity),false);
  A.equal(N.getPolicy(Coverage.SOURCE_ID).documents.length,1);A.equal(N.BOJ_COVERAGE_V2.documents.length,3);A.equal(N.BOJ_COVERAGE_V3.documents.length,4);
  A.equal(N.getPolicy(Coverage.SOURCE_ID,{...N.BOJ_COVERAGE_V3}),null);A.equal(N.getPolicy('us-bls-calendar',N.BOJ_COVERAGE_V3),null);
  for(const d of N.BOJ_COVERAGE_V3.documents)for(const u of [d.url+'?x=1',d.url.replace('https:','http:'),'https://example.org/'])A.equal(N.validateUrl(Coverage.SOURCE_ID,d,u).valid,false);
});
test('S8 MUST byte/identity regression and raw nonpersistence, four requests only',async()=>{
  let requests=0;const old=await Coverage.create({fetchImpl:async u=>Must.response(u),now:()=>context.fetchedAt}).acquire({sourceId:Coverage.SOURCE_ID,operation:N.OPERATION});
  const next=await Coverage.createShould({fetchImpl:async (u,o)=>{requests++;A.equal(o.redirect,'manual');A.equal(o.credentials,'omit');return F.response(u);},now:()=>context.fetchedAt}).acquire({sourceId:Coverage.SOURCE_ID,operation:N.OPERATION});
  A.equal(next.success,true,next.reason);A.equal(requests,4);A.equal(next.candidate.recordCount,65);
  A.deepEqual(next.candidate.canonicalRecords.filter(r=>!P.TYPES.includes(r.logical.eventType)).map(r=>[r.eventKey,r.canonicalContentHash]),old.candidate.canonicalRecords.map(r=>[r.eventKey,r.canonicalContentHash]));
  A.equal(next.coverageAudit.unpublished,1);A.ok(next.documents.every(d=>!Object.hasOwn(d,'parserInput')));
});
test('one malformed SHOULD category blocks complete BOJ candidate without retry',async()=>{
  let requests=0;const r=await Coverage.createShould({fetchImpl:async u=>{requests++;return u.endsWith('index.htm')&&u.includes('mpmsche')?new Response(F.meetings().replace('主な意見','broken'),{headers:{'content-type':'text/html; charset=utf-8'}}):F.response(u);}}).acquire({sourceId:Coverage.SOURCE_ID,operation:N.OPERATION});
  A.equal(r.success,false);A.equal(r.candidate.canonicalRecords.length,0);A.equal(requests,4);
});
test('S9-S12 retained candidate comparison + BOJ ineligible plan; no Formal mutation or authority drift',async()=>{
  const X=require('../js/marketCalendarRuntime/formalExactComparison.js'),Plan=require('../js/marketCalendarHistory/formalShadowWritePlan.js'),Schema=require('../js/marketCalendarHistory/productionSchemaV1.js');
  const ac=await Coverage.createShould({fetchImpl:async u=>F.response(u),now:()=>context.fetchedAt}).acquire({sourceId:Coverage.SOURCE_ID,operation:N.OPERATION});
  const snapshot={entries:[],revisions:[],evidence:[],observations:[],runs:[],cursors:[]}, before=structuredClone(snapshot);
  const sourceResult={sourceId:Coverage.SOURCE_ID,canonicalRecords:ac.candidate.canonicalRecords,acquisitionOutcome:'complete',candidateStatus:'available',failedRoles:[],absenceAuthority:'none',
    documentHealth:ac.documents.map(d=>({role:d.role,fetchOutcome:'success',parseOutcome:'success'}))};
  const comparison=await X.compare({sourceResults:X.SOURCE_IDS.map(sourceId=>sourceId===Coverage.SOURCE_ID?sourceResult:{sourceId,canonicalRecords:[]}),formalSnapshot:snapshot});
  A.equal(comparison.status,'compared');A.equal(comparison.totals.new,65);A.equal(comparison.ambiguityCount,0);
  const plan=await Plan.buildSourceShadowPlan({sourceId:Coverage.SOURCE_ID,sourceResult,comparison,formalSnapshot:snapshot,schemaFingerprint:Schema.EXPECTED_FINGERPRINT});
  A.equal(plan.reason,'writer_ineligible_identity_transition');A.ok(Object.values(plan.counts).every(n=>n===0));A.deepEqual(snapshot,before);
  const permissions=require('../js/marketCalendarHistory/writerSafetySourceSetPermission.js').PERMISSIONS.entries;
  A.equal(permissions.find(p=>p.sourceId===Coverage.SOURCE_ID).permission,'writer_ineligible');
  A.equal(permissions.find(p=>p.sourceId==='jp-mof-jgb-auction-calendar').permission,'not_approved');
});
test('native isolated four-document acquisition, no production access or public network',()=>{
  const r=require('../scripts/marketCalendarG4BojShouldNative.js').run();A.equal(r.status,'PASS');A.equal(r.requests,4);A.equal(r.observer,0);
  A.equal(r.candidateCount,65);A.equal(r.must,14);A.equal(r.should,51);A.equal(r.guard.forbiddenAttempts,0);A.equal(r.tempDeleted,true);
  for(const key of ['runtimeStateAccess','runtimeStateWrites','safetyContentAccess','safetyWrites','authorization','grant','token','writer','formalReadwrite','formalWrites','retry'])A.equal(r[key],0);
  A.equal(r.cleanup.windows,0);A.equal(r.cleanup.dbHandles,0);
});
