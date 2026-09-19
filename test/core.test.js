import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { Client, parseJSON } from '../src/http.js';
import { bo3Match, bo3Players, faceitMatch, pandaMatch } from '../src/adapters.js';
import { backtest, headToHead, playerRows, predict, teamRows } from '../src/analytics.js';
import { walkForward, score, fitLogistic, Glicko2 } from '../src/model.js';
import { collect, options } from '../src/collectors.js';
import { createApp, csv } from '../src/server.js';

function match(id='1',start='2026-01-01T10:00:00Z',end='2026-01-01T11:00:00Z',winner='bo3:a'){
  return {id:`bo3:${id}`,source:'bo3',kind:'pro',start:new Date(start).toISOString(),end:end?new Date(end).toISOString():null,teamA:{id:'bo3:a',name:'Alpha'},teamB:{id:'bo3:b',name:'Beta'},winner,scoreA:2,scoreB:1,bestOf:3,event:'Test fixture',maps:[],players:[]};
}
function boRaw(id=1){return {id,status:'finished',game_version:2,start_date:'2026-01-01T10:00:00Z',end_date:'2026-01-01T12:00:00Z',team1:{id:10,name:'Alpha'},team2:{id:20,name:'Beta'},team1_id:10,team2_id:20,winner_team_id:20,team1_score:0,team2_score:2,bo_type:3,slug:`alpha-beta-${id}`,games:[{id:1,state:'done',map_name:'de_nuke',number:1,winner_team_clan:{team_id:20},winner_clan_score:13,loser_clan_score:7}]};}
const proPlayer=(id,teamId,kills=null,deaths=null)=>({id,name:id,teamId,kills,deaths,adr:null,kast:null});

test('Ratings cannot see overlapping matches, equal starts or future outcomes',()=>{
  const a=match('a','2026-01-01T10:00:00Z','2026-01-01T14:00:00Z');
  const b=match('b','2026-01-01T12:00:00Z','2026-01-01T13:00:00Z');
  const c=match('c','2026-01-01T15:00:00Z','2026-01-01T16:00:00Z');
  const d=match('d','2026-01-01T15:00:00Z','2026-01-01T17:00:00Z','bo3:b');
  const w=walkForward([d,c,b,a]);
  for(const engine of ['elo','glicko','winrate']){
    const p=w.rows.map(r=>r.probs[engine]);
    assert.equal(p[0],.5);assert.equal(p[1],.5);assert.ok(p[2]>.5);assert.equal(p[2],p[3]);
  }
  c.winner='bo3:b';
  assert.deepEqual(walkForward([a,b,c,d]).rows.map(r=>r.probs.glicko),w.rows.map(r=>r.probs.glicko));
  // Features see the same delayed state: nothing is counted before it has finished.
  assert.equal(w.rows[1].experience,0);assert.equal(w.rows[2].experience,2);
  assert.deepEqual(w.rows[1].features.slice(2,6),[0,0,0,0]);
});
test('Missing or invalid finish times are delayed 24h',()=>{
  const a=match('a','2026-01-01T10:00:00Z',null),b=match('b','2026-01-01T12:00:00Z','2026-01-01T13:00:00Z');
  assert.equal(walkForward([a,b]).rows[1].probs.glicko,.5);
  a.end='2026-01-01T09:00:00Z';assert.equal(walkForward([a,b]).rows[1].probs.glicko,.5);
});
test('Scores treat 50/50 honestly and the split never cuts simultaneous starts',()=>{
  const m=score([{y:1,probs:{x:.5}},{y:0,probs:{x:.5}}],'x');
  assert.equal(m.accuracy,.5);assert.equal(m.brier,.25);assert.ok(Math.abs(m.logLoss-Math.log(2))<1e-12);
  const matches=Array.from({length:10},(_,i)=>match(String(i),`2026-01-${String(i<7?i+1:8).padStart(2,'0')}T10:00:00Z`,`2026-01-${String(i<7?i+1:8).padStart(2,'0')}T12:00:00Z`));
  const result=backtest(matches);assert.equal(result.warmup,7);assert.equal(result.metrics.count,3);
  assert.equal(result.models.find(x=>x.production).name,'logistic');
});
test('Glicko-2 rewards an upset, widens deviation while idle and stays antisymmetric',()=>{
  const g=new Glicko2(),t0=Date.parse('2026-01-01T00:00:00Z');
  g.update(['a'],['b'],1,t0);
  assert.ok(g.at('a',t0).r>1500&&g.at('b',t0).r<1500);
  assert.ok(g.at('a',t0).rd<350,'a rated match must reduce the deviation');
  const idle=g.at('a',t0+120*86400_000).rd;
  assert.ok(idle>g.at('b',t0).rd,'a long pause must widen the deviation');
  assert.ok(Math.abs(g.p(['a'],['b'],t0)+g.p(['b'],['a'],t0)-1)<1e-12);
});
test('Logistic blend is mirrored: p(A,B) + p(B,A) = 1 for any input',()=>{
  const X=[[1,.2],[-.5,.4],[2,-1],[.1,.1]],y=[1,0,1,0];
  const f=fitLogistic(X,y);
  for(const row of [...X,[3,3],[-2,.5]])assert.ok(Math.abs(f.predict(row)+f.predict(row.map(v=>-v))-1)<1e-12);
});
test('No fabricated metrics for empty data or players with missing stats',()=>{
  assert.equal(backtest([]).metrics,null);
  const m=match();m.players=[proPlayer('p','bo3:a')];const p=playerRows([m])[0];assert.equal(p.kd,null);assert.equal(p.adr,null);assert.equal(p.kdSamples,0);
});
test('BO3 maps align scores to match sides and only historical team membership is used',()=>{
  const m=bo3Match(boRaw());assert.equal(m.maps[0].scoreA,7);assert.equal(m.maps[0].scoreB,13);
  const rows=bo3Players([{kills:20,death:10,kast:.75,adr:90,player_rating:6.5,team_clan:{team_id:20},steam_profile:{player_id:7,player:{id:7,nickname:'Fixture',team_id:99}}}],m);
  assert.equal(rows[0].teamId,'bo3:20');assert.equal(rows[0].kast,75);assert.equal(rows[0].ratingSystem,'BO3');
  const fallback=bo3Players([{player_id:7,team_id:20,player:{nickname:'Fixture'},kills_sum:30,deaths_sum:20,adr_sum:150,games_count:2}],m,true);
  assert.equal(fallback[0].adr,75);assert.equal(fallback[0].kast,null);
  assert.equal(bo3Match({...boRaw(),game_version:1}),null);
  assert.equal(bo3Match({...boRaw(),status:'defwin'}),null);
});
test('Preserve 64-bit Steam IDs exactly',()=>{assert.equal(parseJSON('{"steam_id_64":76561198057282431}').steam_id_64,'76561198057282431');});
test('Store idempotency, source isolation, and detail preservation on listing refresh',()=>{
  const db=new Store(':memory:');const m=match();m.players=[proPlayer('p','bo3:a',25,10)];m.statsFetchedAt='2026-01-02';
  assert.equal(db.put(m),true);assert.equal(db.put(match()),false);assert.equal(db.all('bo3').length,1);assert.equal(db.get(m.id).players[0].kills,25);
  const roster=match();roster.players=[proPlayer('p','bo3:a')];db.put(roster);assert.equal(db.get(m.id).players[0].kills,25);
  assert.equal(db.all('faceit').length,0);db.close();
});
test('Player H2H counts opposing sides separately from playing together',()=>{
  const a=match('a');a.players=[proPlayer('p','bo3:a'),proPlayer('q','bo3:b')];
  const b=match('b');b.players=[proPlayer('p','bo3:a'),proPlayer('q','bo3:a')];
  const h=headToHead([a,b],'players','p','q');assert.equal(h.played,1);assert.equal(h.winsA,1);assert.equal(h.together,1);assert.equal(h.togetherWins,1);
});
test('Prediction is symmetric and disallows self-matches',()=>{
  const rows=[match()];const a=predict(rows,'bo3:a','bo3:b'),b=predict(rows,'bo3:b','bo3:a');assert.ok(Math.abs(a.p+b.p-1)<1e-10);assert.throws(()=>predict(rows,'bo3:a','bo3:a'));
});
function faceRaw(){return {match_id:'room',game:'cs2',status:'FINISHED',started_at:1767261600,finished_at:1767265200,best_of:1,teams:{faction1:{faction_id:'fa',name:'team_a',roster:Array.from({length:5},(_,i)=>({player_id:'a'+i,nickname:'A'+i}))},faction2:{faction_id:'fb',name:'team_b',roster:Array.from({length:5},(_,i)=>({player_id:'b'+i,nickname:'B'+i}))}},results:{winner:'faction2',score:{faction1:8,faction2:13}}};}
test('FACEIT uses roster identity and aggregates map stats without current Elo',()=>{
  const round=(adr,rounds,kills)=>({round_stats:{Map:'de_nuke',Rounds:String(rounds)},teams:[{team_id:'fa',team_stats:{'Team Win':'0','Final Score':'8'},players:[{player_id:'a0',nickname:'A0',player_stats:{Kills:String(kills),Deaths:'10',ADR:String(adr)}}]},{team_id:'fb',team_stats:{'Team Win':'1','Final Score':'13'},players:[]}]});
  const m=faceitMatch(faceRaw(),{rounds:[round(100,20,15),round(50,10,5)]});assert.ok(m.teamA.id.includes('a0+a1+a2+a3+a4'));assert.equal(m.players.length,10);
  const p=m.players.find(p=>p.id==='faceit:a0');assert.equal(p.kills,20);assert.equal(p.deaths,20);assert.ok(Math.abs(p.adr-2500/30)<1e-9);
  assert.equal(m.winner,m.teamB.id);assert.equal(m.maps[0].scoreA,8);assert.equal(walkForward([m]).rows[0].eligible,true);
  // Player ratings carry the lineup: the five winners gain, the five losers lose.
  const w=walkForward([m]);assert.ok(w.engines.glicko.at('faceit:b0',Date.now()).r>w.engines.glicko.at('faceit:a0',Date.now()).r);
  m.players.pop();assert.equal(walkForward([m]).rows[0].eligible,false);
});
test('HTTP retries rate limits, caches successes, never leaks a key in errors or URL',async()=>{
  const store=new Store(':memory:');let calls=0;const waits=[];
  const c=new Client(store,{delay:0,pause:async ms=>waits.push(ms),fetcher:async(url,init)=>{assert.equal(url.searchParams.has('token'),false);assert.equal(init.headers.Authorization,'Bearer secret');calls++;return calls===1?new Response('',{status:429,headers:{'retry-after':'2'}}):new Response('{"ok":true}',{status:200});}});
  assert.deepEqual(await c.get('https://example.test','/data',{},'secret'),{ok:true});await c.get('https://example.test','/data',{},'secret');assert.equal(calls,2);assert.ok(waits.includes(2000));store.close();
});
test('Free PandaScore collector has stable pagination for a partial last page',async()=>{
  const store=new Store(':memory:'),calls=[];
  const client={requests:0,cacheHits:0,get:async(base,path,params)=>{calls.push(params);return Array.from({length:100},(_,i)=>({id:(params.page-1)*100+i,status:'finished',begin_at:'2026-01-01T10:00:00Z',end_at:'2026-01-01T12:00:00Z',opponents:[{opponent:{id:1,name:'A'}},{opponent:{id:2,name:'B'}}],winner_id:1,results:[{team_id:1,score:2},{team_id:2,score:1}]}));}};
  const report=await collect(store,{source:'pandascore',from:'2026-01-01',to:'2026-01-02',limit:150},()=>{},{client,keys:{PANDASCORE_API_KEY:'fixture'}});
  assert.equal(report.added,150);assert.deepEqual(calls.map(c=>[c.page,c.per_page]),[[1,100],[2,100]]);assert.equal(store.all().length,150);store.close();
});
test('FACEIT collector supplies explicit dates and deduplicates overlapping player histories',async()=>{
  const store=new Store(':memory:');let details=0;
  const client={requests:0,cacheHits:0,get:async(base,path,params)=>{
    if(path==='/players')return {player_id:params.nickname};
    if(path.endsWith('/history')){assert.ok(params.from>0);assert.ok(params.to>params.from);assert.equal(params.game,'cs2');return {items:[{match_id:'room'}]};}
    if(path.endsWith('/stats'))return {rounds:[]};
    details++;return faceRaw();
  }};
  const report=await collect(store,{source:'faceit',nicknames:'A,B',from:'2026-01-01',to:'2026-01-02',limit:100,statsLimit:1},()=>{},{client,keys:{FACEIT_API_KEY:'fixture'}});
  assert.equal(details,1);assert.equal(report.added,1);store.close();
});
test('BO3 collector is idempotent and adds historical player stats',async()=>{
  const store=new Store(':memory:');const client={requests:0,cacheHits:0,get:async(base,path,params)=>{if(path==='/matches'){assert.ok(params['filter[matches.start_date][gt]']);assert.ok(params['filter[matches.start_date][lt]']);return {results:[boRaw()],total:{count:1}};}return [{kills:20,death:10,team_clan:{team_id:20},steam_profile:{player_id:7,nickname:'P'}}];}};
  const input={source:'bo3',limit:1,statsLimit:1,from:'2026-01-01',to:'2026-01-02'};
  const first=await collect(store,input,()=>{},{client});const second=await collect(store,input,()=>{},{client});assert.equal(first.added,1);assert.equal(first.withStats,1);assert.equal(second.added,0);assert.equal(store.all()[0].players[0].kills,20);store.close();
});
test('Reject invalid import configuration and missing free API keys',async()=>{
  assert.throws(()=>options({source:'unknown'}));assert.throws(()=>options({limit:-1}));assert.throws(()=>options({source:'faceit'}));assert.throws(()=>options({from:'2020-01-01'}));
  assert.throws(()=>options({from:'2026-02-30',to:'2026-03-01'}));
  const db=new Store(':memory:');await assert.rejects(()=>collect(db,{source:'faceit',nicknames:'A'},()=>{},{keys:{}}),/FACEIT_API_KEY/);db.close();
});
test('Empty BO3 statistics do not starve older records on a repeated sync',async()=>{
  const store=new Store(':memory:');const requests=[];
  const client={requests:0,cacheHits:0,get:async(base,path)=>{requests.push(path);return path==='/matches'?{results:[boRaw(1),boRaw(2)],total:{count:2}}:[];}};
  const input={source:'bo3',limit:2,statsLimit:1,from:'2026-01-01',to:'2026-01-02'};
  await collect(store,input,()=>{},{client});await collect(store,input,()=>{},{client});
  assert.ok(requests.includes('/matches/alpha-beta-1/players_stats'));assert.ok(requests.includes('/matches/alpha-beta-2/players_stats'));
  assert.equal(requests.filter(p=>p==='/matches/alpha-beta-1/players_stats').length,1);store.close();
});
test('CSV exports escape formula prefixes, quotes, Unicode and newlines',()=>{
  const text=csv([{name:'=SUM(1,2)',event:'Тест "A"\nB'}]);assert.ok(text.includes('"\'=SUM(1,2)"'));assert.ok(text.includes('"Тест ""A""\nB"'));assert.ok(text.startsWith('\ufeff'));
});
test('HTTP application serves analytics, exports and blocks writes without CSRF',async()=>{
  const db=new Store(':memory:');db.put(match());const server=createApp(db);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const s=await(await fetch(base+'/api/summary')).json();assert.equal(s.matches,1);
    assert.equal((await fetch(base+'/api/sync',{method:'POST',body:'{}'})).status,403);
    assert.equal((await fetch(base+'/.env')).status,404);
    assert.equal((await fetch(base+'/api/summary?source=invalid')).status,400);
    const exported=await fetch(base+'/api/export');assert.match(exported.headers.get('content-type'),/csv/);assert.match(await exported.text(),/Alpha/);
    const status=await(await fetch(base+'/api/status')).json();assert.equal(typeof status.csrf,'string');assert.ok(!JSON.stringify(status).includes('Bearer'));
    const same=await fetch(base+'/api/predict?a=bo3:a&b=bo3:a');assert.equal(same.status,400);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
