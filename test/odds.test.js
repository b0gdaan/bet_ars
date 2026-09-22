import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { createApp } from '../src/server.js';
import { normalizeOdds } from '../src/odds/normalize.js';
import { matchFixture,internalQuote } from '../src/odds/matcher.js';
import { importOdds,allOdds } from '../src/odds/store.js';
import { valueAtOdds,marketProbabilities,selectQuote,assertDecision } from '../src/odds/market.js';
import { simulate,STRATEGIES,stakeSize,blockInterval,chooseSide } from '../src/odds/simulate.js';
import { joinPredictions,bettingReport,marketBlend } from '../src/odds/backtest.js';
import { OddsPapiProvider,normalizeHistory,resolveMatchMarket } from '../src/odds/provider.js';
import { walkForward } from '../src/model.js';
import { buildMaps } from '../src/maps.js';
import { predictMap } from '../src/map-contract.js';

const t=(day=0,hour=10,minute=0)=>new Date(Date.UTC(2026,0,1+day,hour,minute)).toISOString();
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
function match(i=0){return {id:'bo3:'+i,source:'bo3',kind:'pro',start:t(i,12),end:t(i,14),teamA:{id:'bo3:a',name:'Natus Vincere'},teamB:{id:'bo3:b',name:'Beta'},winner:i%2?'bo3:b':'bo3:a',scoreA:2,scoreB:1,bestOf:3,players:[],maps:[],event:'Synthetic test'};}
function quote(i=0){return {provider:'fixture',externalMatchId:'event'+i,bookmaker:'test',capturedAt:t(i,11,30),startsAt:t(i,12),teamA:'NaVi',teamB:'Beta',oddsA:1.8,oddsB:2.1,active:true,marketType:'match_winner'};}
function row(i=0){return {matchId:'bo3:'+i,p:.65,marketA:.5,y:1,predictedAt:t(i,11,45),decisionAt:t(i,11,45),capturedAt:t(i,11,30),trainedThrough:t(-1),startsAt:t(i,12),settledAt:t(i,14),oddsA:2,oddsB:2,closingA:1.8,closingB:2.2};}

test('Net EV, no-vig and Kelly use the payout after fees, not the probability edge',()=>{
  near(valueAtOdds(.65,1.5).ev,-.025);near(valueAtOdds(.65,1.5).breakEven,2/3);
  const v=valueAtOdds(.65,2,.05,.01);near(v.ev,.2575);near(v.breakEven,1.01/1.95);near(v.kelly,.2575/(.94*1.01));
  const m=marketProbabilities(1.5,2.7);near(m.a+m.b,1);assert.ok(.65-m.a>0);assert.ok(valueAtOdds(.65,1.5).ev<0);
  assert.throws(()=>valueAtOdds(.5,2,-.01));assert.throws(()=>bettingReport([],[],{fee:NaN}));
});
test('Normalize strict market, timezone and active; match aliases, reversal and ambiguity',()=>{
  const q=normalizeOdds([quote()])[0];assert.equal(matchFixture(q,[match()]).status,'matched');
  const reversed={...q,teamA:'Beta',teamB:'NaVi'};assert.equal(matchFixture(reversed,[match()]).reversed,true);
  near(internalQuote({...reversed,reversed:true}).oddsA,2.1);
  assert.equal(matchFixture(q,[match(),{...match(),id:'other'}]).status,'ambiguous');
  assert.equal(matchFixture({...q,teamA:'NaVi Junior'},[match()]).status,'unmatched');
  assert.equal(matchFixture({...q,startsAt:t(2)},[match()]).status,'unmatched');
  for(const change of [{marketType:'map_winner'},{capturedAt:'2026-01-01T10:00:00'},{active:undefined},{oddsA:1}])assert.throws(()=>normalizeOdds([{...q,...change}]));
});
test('Odds storage is idempotent per provider/event/book/time and preserves snapshots',()=>{
  const s=new Store(':memory:');try{s.put(match());const q=quote();importOdds(s,[q]);importOdds(s,[q]);assert.equal(allOdds(s).length,1);
    importOdds(s,[{...q,capturedAt:t(0,11,40)},{...q,provider:'second'}]);assert.equal(allOdds(s).length,3);assert.ok(allOdds(s).every(r=>r.matchStatus==='matched'));
  }finally{s.close();}
});
test('Latest suspended quote cannot revive older price; future closing only affects CLV',()=>{
  const q=quote(),future={...q,capturedAt:t(0,11,55),oddsA:1.4};
  assert.equal(selectQuote([q,future],t(0,11,45)),q);
  assert.equal(selectQuote([q,{...q,capturedAt:t(0,11,40),active:false}],t(0,11,45)),null);
  assert.equal(selectQuote([q],t(0,13)),null);
  const pred={...row(),trainedThrough:t(-1)},qs=[q,future].map(q=>({...q,matchId:'bo3:0',matchStatus:'matched'}));
  const joined=joinPredictions([pred],[match()],qs).rows[0];near(joined.oddsA,1.8);near(joined.closingA,1.4);
  const old=chooseSide(joined,STRATEGIES[1]),changed=chooseSide({...joined,closingA:10},STRATEGIES[1]);near(old.ev,changed.ev);assert.equal(old.side,changed.side);
  assert.equal(joinPredictions([pred],[match()],qs.map(q=>({...q,startsAt:t(0,11,40)}))).rows.length,0);
  assert.equal(joinPredictions([pred],[match()],[...qs,{...qs[0],externalMatchId:'duplicate'}]).excluded.duplicateProviderEvent,1);
});
test('Temporal guard rejects future quotes, training outcomes and invalid timestamps',()=>{
  assertDecision(row());
  for(const change of [{capturedAt:t(0,11,46)},{trainedThrough:t(0,11,45)},{predictedAt:t(0,12)},{settledAt:t(0,11)},{decisionAt:'bad'}])assert.throws(()=>assertDecision({...row(),...change}),/Утечка/);
});
test('Bankroll accounting reserves concurrent stakes and settles in chronological order',()=>{
  const rows=Array.from({length:21},(_,i)=>({...row(),matchId:String(i),y:0}));
  const s=simulate(rows,STRATEGIES[0]);assert.equal(s.bets,20);assert.equal(s.liquiditySkips,1);near(s.finalBankroll,0);near(s.maxDrawdown,2000);assert.ok(s.bankrupt);assert.equal(s.longestLosingStreak,20);assert.ok(s.curve.every(p=>p.cash>=0));near(s.curve[0].bankroll,2000);
  const sequential=simulate(Array.from({length:21},(_,i)=>({...row(i),y:0})),STRATEGIES[0]);assert.equal(sequential.bets,20);assert.ok(sequential.bankrupt);
  const win=simulate([row()],STRATEGIES[0],{commission:.05,fee:.01});near(win.finalBankroll,2094);near(win.netProfit,94);near(win.roi,.94);near(win.trades[0].profit,94);near(win.averageCLV,2/1.8-1);
  assert.equal(stakeSize('percent1',2000,{}),20);assert.equal(stakeSize('percent2',2000,{}),40);assert.equal(stakeSize('kelly50',2000,{kelly:1}),100);assert.equal(stakeSize('kelly25',2000,{kelly:.1}),50);
});
test('Bootstrap requires eight time blocks; empty odds cannot invent profitability',()=>{
  assert.equal(blockInterval([row()],r=>r.p),null);const rows=Array.from({length:10},(_,i)=>row(i*7));const ci=blockInterval(rows,r=>r.p);near(ci.low,.65);near(ci.high,.65);
  const b=bettingReport([match()],[]);assert.equal(b.status,'needs_odds');assert.deepEqual(b.books,[]);assert.equal(b.matchedOos,0);
});
test('15-minute forecast cannot use results arriving between decision and start',()=>{
  const a={...match(0),end:t(1,11,50)},b=match(1),w=walkForward([a,b],{forecastLeadMs:15*60000});assert.equal(w.rows[1].experience,0);assert.equal(w.train.length,0);assert.equal(walkForward([a,b]).rows[1].experience,1);
});
test('Combined market model purges labels crossing its test boundary',()=>{
  const rows=Array.from({length:100},(_,i)=>({...row(i),y:i%2,p:i%2?.7:.3,marketA:i%2?.6:.4}));
  const baseline=marketBlend(rows);assert.equal(baseline.status,'evaluated');assert.equal(baseline.test,50);
  rows[49].settledAt=t(99);const purged=marketBlend(rows);assert.equal(purged.train,49);assert.equal(purged.test,50);
  const altered=rows.map((r,i)=>i>=50?{...r,y:1-r.y}:r);assert.deepEqual(marketBlend(altered).weights,purged.weights);
});
test('Provider aligns asynchronous outcomes and keeps suspension with missing price',()=>{
  const market=resolveMatchMarket([{sportId:17,playerProp:false,marketLength:2,marketName:'Winner',marketId:171,outcomes:[{outcomeName:'1',outcomeId:'a'},{outcomeName:'2',outcomeId:'b'}]}]);
  const fixture={fixtureId:'e',participant1Name:'NaVi',participant2Name:'Beta',startTime:t(0,12)};
  const history={fixtureId:'e',bookmakers:{test:{markets:{171:{outcomes:{a:{players:{0:[{createdAt:t(0,11),price:2,active:true},{createdAt:t(0,11,40),price:null,active:false}]}},b:{players:{0:[{createdAt:t(0,11,10),price:2,active:true},{createdAt:t(0,11,50),price:2.2,active:true}]}}}}}}}};
  const rows=normalizeHistory(fixture,history,market);assert.equal(rows.length,3);assert.equal(rows[0].capturedAt,t(0,11,10));assert.equal(rows[1].active,false);assert.equal(rows[2].active,false);assert.equal(selectQuote(rows,t(0,11,45)),null);
  assert.throws(()=>resolveMatchMarket([]));assert.throws(()=>normalizeHistory(fixture,{...history,fixtureId:'other'},market));
});
test('Provider key is query-authenticated but never cached in URL or network errors',async()=>{
  const s=new Store(':memory:');try{let calls=0;const p=new OddsPapiProvider(s,{key:'fake-secret',pause:async()=>{},maxRequests:2,fetcher:async url=>{calls++;assert.equal(url.searchParams.get('apiKey'),'fake-secret');return new Response('{"ok":true}');}});
    assert.deepEqual(await p.get('fixture',{id:1}),{ok:true});await p.get('fixture',{id:1});assert.equal(calls,1);
    assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM cache').all()).includes('fake-secret'));
    const bad=new OddsPapiProvider(s,{key:'fake-secret',pause:async()=>{},fetcher:async()=>{throw new Error('https://test?apiKey=fake-secret');}});await assert.rejects(()=>bad.get('fail'),e=>!e.message.includes('fake-secret'));
  }finally{s.close();}
});
test('Map experiment keeps a series together and does not train on test labels',()=>{
  const rows=Array.from({length:20},(_,i)=>({...match(i),maps:[{id:'x',name:'de_nuke',winner:i%3?'bo3:a':'bo3:b'},{id:'y',name:'de_nuke',winner:'bo3:b'}]}));
  const a=buildMaps(rows);assert.equal(a.report.train,32);assert.equal(a.report.withMaps.count,8);assert.equal(a.report.base.count,8);
  const altered=structuredClone(rows);for(let i=16;i<20;i++)for(const g of altered[i].maps)g.winner=g.winner==='bo3:a'?'bo3:b':'bo3:a';
  assert.deepEqual(buildMaps(altered).model,a.model);
  near(predictMap(a,'bo3:a','bo3:b','de_nuke').p+predictMap(a,'bo3:b','bo3:a','de_nuke').p,1);assert.throws(()=>predictMap(a,'bo3:a','bo3:a','de_nuke'));
  const overlapping=rows.map(m=>({...m,end:t(99)})),b=buildMaps(overlapping);assert.equal(b.report.train,0);near(b.report.withMaps.brier,.25);assert.equal(b.model,null);
});
test('Local market endpoint and browser contracts work without quotes or maps',async()=>{
  const s=new Store(':memory:'),server=createApp(s);server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  try{const r=await fetch(base+'/api/market-lab');assert.equal(r.status,200);const data=await r.json();assert.equal(data.betting.status,'needs_odds');assert.equal(data.maps.model,null);
    for(const path of ['/market-lab.js','/map-contract.js','/odds-market.js']){const r=await fetch(base+path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);}
  }finally{await new Promise(resolve=>server.close(resolve));s.close();}
});
