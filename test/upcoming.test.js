import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/db.js';
import { createApp } from '../src/server.js';
import { prematchLine,normalizeUpcoming,lineQuote,productionModel,forecastUpcoming,liveEvaluation,upcomingBoard } from '../src/upcoming.js';
import { importKnownOdds,allOdds } from '../src/odds/store.js';

const H=3600_000,t0=Date.UTC(2026,8,1,12);
const iso=ms=>new Date(ms).toISOString();
function raw({id=1,start=t0+48*H,status='upcoming',path='https://x/en/line/Esports/1',t1=10,t2=20,b1=10,b2=20,c1=1.5,c2=2.6,active=true}={}){
  return {id,slug:'a-vs-b-'+id,status,start_date:iso(start),bo_type:3,stars:1,team1:{id:t1,name:'Alpha'},team2:{id:t2,name:'Beta'},tournament:{name:'Cup'},
    bet_updates:{path,team_1:{team_id:b1,coeff:c1,active},team_2:{team_id:b2,coeff:c2,active}}};
}
function finished(i,start,winnerA=true){
  return {id:'bo3:'+i,source:'bo3',kind:'pro',start:iso(start),end:iso(start+2*H),teamA:{id:'bo3:10',name:'Alpha'},teamB:{id:'bo3:20',name:'Beta'},
    winner:winnerA?'bo3:10':'bo3:20',scoreA:winnerA?2:0,scoreB:winnerA?0:2,bestOf:3,event:'Cup',maps:[],players:[]};
}

test('Only a pre-match /line/ price captured before the start is kept',()=>{
  const at=iso(t0);
  assert.deepEqual(prematchLine(raw(),at),{oddsA:1.5,oddsB:2.6,capturedAt:at,provider:'bo3.gg',bookmaker:'bo3-line'});
  assert.equal(prematchLine(raw({path:'https://x/en/live/Esports/1'}),at),null,'live-цена с завершённого или идущего матча — утечка');
  assert.equal(prematchLine(raw({status:'finished'}),at),null);
  assert.equal(prematchLine(raw({start:t0}),at),null,'снятая в момент старта или позже цена не предматчевая');
  assert.equal(prematchLine(raw({active:false}),at),null);
  assert.equal(prematchLine(raw({c1:1}),at),null);
  // The partner feed may list the teams the other way round: prices follow the teams.
  assert.deepEqual(prematchLine(raw({b1:20,b2:10}),at),{oddsA:2.6,oddsB:1.5,capturedAt:at,provider:'bo3.gg',bookmaker:'bo3-line'});
  assert.equal(prematchLine(raw({b1:30,b2:20}),at),null,'чужая команда в линии — цену не угадываем');
});

test('Upcoming matches normalize to the same ids as finished ones and become exact quotes',()=>{
  const m=normalizeUpcoming(raw({id:7}),iso(t0));
  assert.equal(m.id,'bo3:7');assert.equal(m.teamA.id,'bo3:10');assert.equal(m.teamB.id,'bo3:20');
  assert.equal(normalizeUpcoming(raw({t2:10}),iso(t0)),null,'команда не может играть сама с собой');
  const store=new Store(':memory:');
  const q=lineQuote(m);assert.equal(q.marketType,'match_winner');
  assert.deepEqual(importKnownOdds(store,[q],[m.id]),{quotes:1,added:1});
  assert.deepEqual(importKnownOdds(store,[q],[m.id]),{quotes:1,added:0},'повторный снимок того же момента не дублируется');
  const stored=allOdds(store)[0];assert.equal(stored.matchId,'bo3:7');assert.equal(stored.matchStatus,'matched');
  assert.throws(()=>importKnownOdds(store,[q],[]),/matchId/);
  store.close();
});

test('The forecast log is append-only and the upcoming list is replaced on refresh',()=>{
  const store=new Store(':memory:');
  const f={matchId:'bo3:1',madeAt:iso(t0),model:'m',startsAt:iso(t0+H),p:.6};
  assert.equal(store.addForecast(f),true);
  assert.equal(store.addForecast({...f,p:.9}),false,'записанный прогноз нельзя переписать задним числом');
  assert.equal(store.forecasts()[0].p,.6);
  store.replaceUpcoming('bo3',[normalizeUpcoming(raw({id:1}),iso(t0)),normalizeUpcoming(raw({id:2}),iso(t0))],iso(t0));
  store.replaceUpcoming('bo3',[normalizeUpcoming(raw({id:2}),iso(t0))],iso(t0));
  assert.deepEqual(store.upcoming('bo3').map(m=>m.id),['bo3:2'],'отменённый матч исчезает из списка');
  store.close();
});

test('Live evaluation scores the last forecast made strictly before the start',()=>{
  const start=t0+10*H,m=finished(1,start,true);
  const log=[
    {matchId:'bo3:1',madeAt:iso(start-5*H),startsAt:iso(start),teamAId:'bo3:10',teamBId:'bo3:20',p:.3,marketA:.4,coldStart:false},
    {matchId:'bo3:1',madeAt:iso(start-1*H),startsAt:iso(start),teamAId:'bo3:10',teamBId:'bo3:20',p:.7,marketA:.6,coldStart:false},
    // Logged after the start: it must never be scored, however good it looks.
    {matchId:'bo3:1',madeAt:iso(start+H),startsAt:iso(start),teamAId:'bo3:10',teamBId:'bo3:20',p:.99,marketA:.99,coldStart:false},
    {matchId:'bo3:unknown',madeAt:iso(start-H),startsAt:iso(start),teamAId:'x',teamBId:'y',p:.5}];
  const r=liveEvaluation([m],log);
  assert.equal(r.scored,1);assert.equal(r.recent[0].p,.7);assert.equal(r.model.accuracy,1);
  assert.equal(r.vsMarket.count,1);assert.equal(r.recent[0].leadHours,1);
  // Forecasts written with the sides reversed are flipped, not dropped or scored backwards.
  const flipped=liveEvaluation([m],[{matchId:'bo3:1',madeAt:iso(start-H),startsAt:iso(start),teamAId:'bo3:20',teamBId:'bo3:10',p:.2,marketA:.3}]);
  assert.ok(Math.abs(flipped.recent[0].p-.8)<1e-12);assert.ok(Math.abs(flipped.recent[0].marketA-.7)<1e-12);
  // A match that actually started earlier than scheduled cuts off forecasts at the real start.
  const early=liveEvaluation([finished(2,start-3*H)],[{matchId:'bo3:2',madeAt:iso(start-2*H),startsAt:iso(start),teamAId:'bo3:10',teamBId:'bo3:20',p:.9}]);
  assert.equal(early.scored,0);
  assert.equal(liveEvaluation([],[]).model,null);
});

test('Production forecasts refit on all history, skip started matches and flag new teams',()=>{
  const history=Array.from({length:30},(_,i)=>finished(i,t0-(40-i)*24*H,i%4!==0));
  const production=productionModel(history);
  assert.equal(production.trainRows,30,'для живого прогноза веса учатся на всей истории');
  const ahead=[normalizeUpcoming(raw({id:100,start:t0+5*H}),iso(t0)),normalizeUpcoming(raw({id:101,start:t0-H}),iso(t0)),
    normalizeUpcoming(raw({id:102,start:t0+6*H,t1:10,t2:99,b2:99}),iso(t0))];
  const f=forecastUpcoming(production,ahead,t0);
  assert.deepEqual(f.map(x=>x.matchId),['bo3:100','bo3:102'],'начавшийся матч не прогнозируется');
  assert.ok(f[0].p>.5,'чаще побеждавшая команда — фаворит');
  assert.equal(f[0].coldStart,false);assert.equal(f[1].coldStart,true);assert.equal(f[1].playedB,0);
  assert.ok(f[0].bestSide&&Number.isFinite(f[0].bestSide.ev));
  assert.ok(f.every(x=>x.madeAt===iso(t0)&&x.model.startsWith('team-glicko-lr@')));
  const board=upcomingBoard(ahead,[...f,{...f[0],madeAt:iso(t0-H),p:.1}],t0);
  assert.equal(board[0].p,f[0].p,'на доске — последний прогноз');
});

test('Store version changes on every write and the upcoming endpoint serves the log',async()=>{
  const store=new Store(':memory:');
  const v0=store.version('bo3');store.put(finished(1,t0));assert.notEqual(store.version('bo3'),v0);
  store.replaceUpcoming('bo3',[normalizeUpcoming(raw({id:5,start:Date.now()+5*H}),new Date().toISOString())],new Date().toISOString());
  store.addForecast({matchId:'bo3:5',madeAt:new Date().toISOString(),model:'m',startsAt:iso(Date.now()+5*H),p:.55,teamA:'Alpha',teamB:'Beta'});
  const server=createApp(store).listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/upcoming?source=bo3`,{headers:{host:'localhost'}});
    const d=await r.json();
    assert.equal(r.status,200);assert.equal(d.upcoming.length,1);assert.equal(d.upcoming[0].p,.55);assert.equal(d.live.scored,0);
    const js=await fetch(`http://127.0.0.1:${server.address().port}/upcoming.js`,{headers:{host:'localhost'}});
    assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
  }finally{server.close();store.close();}
});
