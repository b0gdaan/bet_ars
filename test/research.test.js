import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { rocAuc,walkForward } from '../src/model.js';
import { model } from '../src/analytics.js';
import { scouting,dataAudit,validateRoles,spearman } from '../src/research.js';
import { enrichFromCache,importRounds } from '../src/features.js';
import { createApp } from '../src/server.js';

const sample=(day=1)=>({id:`bo3:${day}`,slug:`fixture-${day}`,source:'bo3',kind:'pro',start:`2026-01-${String(day).padStart(2,'0')}T10:00:00Z`,end:`2026-01-${String(day).padStart(2,'0')}T12:00:00Z`,teamA:{id:'bo3:10',name:'Alpha'},teamB:{id:'bo3:20',name:'Beta'},winner:'bo3:10',scoreA:1,scoreB:0,maps:[{id:'map1',name:'de_mirage',scoreA:13,scoreB:5}],players:Array.from({length:10},(_,i)=>({id:`bo3:${i+100}`,name:`Player ${i}`,teamId:i<5?'bo3:10':'bo3:20',kills:10+i,deaths:10,adr:50+i*3,kast:60+i,firstKills:i,firstDeaths:2,tradeKills:i,tradedDeaths:2,rating:1+i/10,ratingSystem:'BO3'}))});
const round=(n=1)=>({matchId:'bo3:1',mapId:'map1',map:'de_mirage',round:n,sideA:'CT',winner:n<=13?'bo3:10':'bo3:20',playersA:sample().players.slice(0,5).map(p=>p.id),playersB:sample().players.slice(5).map(p=>p.id),equipmentA:20000,equipmentB:18000,startedAt:'2026-01-01T10:01:00Z',endedAt:'2026-01-01T10:03:00Z',demoSha256:'a'.repeat(64),parserVersion:'test-fixture',tickRate:64,freezeEndTick:100,endTick:8000});

test('AUC handles ties, reversed order and absent classes',()=>{
  assert.equal(rocAuc([0,0,1,1],[.1,.2,.7,.9]),1);
  assert.equal(rocAuc([0,1],[.9,.1]),0);
  assert.equal(rocAuc([0,1,0,1],[.5,.5,.5,.5]),.5);
  assert.equal(rocAuc([1,1],[.4,.8]),null);
});
test('Training boundary purges outcomes unavailable at first test start',()=>{
  const rows=Array.from({length:10},(_,i)=>sample(i+1));rows[7].end='2026-01-09T11:00:00Z';
  const before=walkForward(rows);assert.equal(before.train.length,7);assert.equal(before.test.length,2);
  rows[7].winner='bo3:20';const after=walkForward(rows);
  assert.deepEqual(after.blend.weights,before.blend.weights);assert.equal(after.test[0].probs.logistic,before.test[0].probs.logistic);
});
test('Changing an old result or lineup invalidates the model cache',()=>{
  const rows=Array.from({length:10},(_,i)=>sample(i+1));const first=model(rows);
  rows[2].winner='bo3:20';const second=model(rows);assert.notEqual(first,second);
  rows[3].players[0].id='bo3:other';assert.notEqual(second,model(rows));
});
test('Scouting uses only finished past matches, no invented roles, and sample thresholds',()=>{
  const rows=[sample(1),sample(2),sample(3)],params={asOf:'2026-01-03T11:00:00Z',days:90,minMatches:2};
  const s=scouting(rows,params);assert.equal(s.ranked,10);assert.equal(s.knownRoleRows,0);assert.equal(s.rows[0].matches,2);
  const before=structuredClone(s);rows[2].players[0].adr=9999;assert.deepEqual(scouting(rows,params),before);
  assert.equal(scouting(rows,{...params,minMatches:3}).ranked,0);
  assert.equal(scouting([]).correlation.spearman,null);
  assert.throws(()=>scouting(rows,{days:NaN}));
  assert.ok(s.rows.every(r=>r.effectiveMatches<=r.matches&&r.formScore>=0&&r.formScore<=100));
  const missing=rows.map(r=>({...r,players:r.players.map(p=>({...p,adr:null,kast:null}))}));assert.equal(scouting(missing,params).ranked,0);
});
test('Roles have bounded historical evidence and cannot overlap',()=>{
  const roles=[{playerId:'bo3:100',role:'awp',from:'2026-01-02',to:'2026-02-01',evidence:'fixture annotation'}];
  const s=scouting([sample(1),sample(2)],{roles,asOf:'2026-01-03'});
  assert.equal(s.rows.filter(r=>r.id==='bo3:100').length,2);assert.equal(s.knownRoleRows,1);
  assert.throws(()=>validateRoles([...roles,{...roles[0]}]),/Пересекающиеся/);
  assert.throws(()=>validateRoles([{...roles[0],evidence:''}]));
  assert.equal(spearman([1,2,3],[3,2,1]),-1);assert.equal(spearman([1,1,2],[2,2,3]),1);
});
test('Cached enrichment preserves outcomes, original stats and null/zero distinction, is idempotent',()=>{
  const store=new Store(':memory:');try{const m=sample();delete m.players[0].tradeKills;store.put(m);
    store.cache('https://api.bo3.gg/api/v1/matches/fixture-1/players_stats',JSON.stringify([{steam_profile:{player:{id:100,nickname:'fixture'}},team_clan:{team_id:10},kills:999,trade_kills:0,trade_death:3,clutches:1,money_spent:75000}]));
    assert.equal(enrichFromCache(store).updatedMatches,1);const next=store.get(m.id);
    assert.equal(next.players[0].kills,10);assert.equal(next.players[0].tradeKills,0);assert.equal(next.players[0].tradedDeaths,2);assert.equal(next.players[0].utilityDamage,undefined);assert.equal(next.winner,m.winner);
    assert.equal(enrichFromCache(store).updatedMatches,0);
  }finally{store.close();}
});
test('Round import is atomic, validates sides/provenance and requires a complete map for the gate',()=>{
  const store=new Store(':memory:');try{store.put(sample());
    assert.throws(()=>importRounds([round(),{...round(2),playersA:round().playersB}],store));assert.equal(store.rounds('bo3').length,0);
    assert.throws(()=>importRounds([{...round(),demoSha256:''}],store));
    assert.throws(()=>importRounds([round(),round()],store));
    importRounds([round()],store);let audit=dataAudit(store.all('bo3'),store.rounds('bo3'));assert.equal(audit.demoMatches,0);assert.equal(audit.incompleteMaps,1);
    importRounds(Array.from({length:18},(_,i)=>round(i+1)),store);audit=dataAudit(store.all('bo3'),store.rounds('bo3'));
    assert.equal(audit.demoMatches,1);assert.equal(audit.rounds,18);assert.equal(audit.gates[1].status,'blocked');assert.equal(store.rounds('faceit').length,0);
    importRounds([{...round(),equipmentA:null}],store);assert.ok(dataAudit(store.all('bo3'),store.rounds('bo3')).roundMissingRate>0);
  }finally{store.close();}
});
test('Research API, validation errors, CSV and frontend module work through HTTP',async()=>{
  const store=new Store(':memory:');store.put(sample());const server=createApp(store);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try{const a=await fetch(base+'/api/research').then(r=>r.json());assert.equal(a.matches,1);assert.equal(a.rounds,0);
    assert.equal((await fetch(base+'/api/scouting?days=bad')).status,400);
    const s=await fetch(base+'/api/scouting?asOf=2026-01-03&minMatches=1').then(r=>r.json());assert.equal(s.rows.length,10);
    assert.match(await fetch(base+'/api/export?type=scouting&asOf=2026-01-03&minMatches=1').then(r=>r.text()),/formScore/);
    assert.equal((await fetch(base+'/research.js')).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
