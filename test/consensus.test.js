import test from 'node:test';
import assert from 'node:assert/strict';
import { marketProbabilities } from '../src/odds/market.js';
import { consensusSignal,consensusBacktest } from '../src/odds/consensus.js';
import { OddsPapiProvider } from '../src/odds/provider.js';

const near=(a,b,eps=1e-10)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const t=(day,hour,minute=0)=>new Date(Date.UTC(2026,1,1+day,hour,minute)).toISOString();
function match(i,winnerA=true){return {id:'bo3:'+i,source:'bo3',kind:'pro',start:t(i,12),end:t(i,14),teamA:{id:'bo3:a',name:'Alpha'},teamB:{id:'bo3:b',name:'Beta'},winner:winnerA?'bo3:a':'bo3:b',scoreA:2,scoreB:0,bestOf:3,players:[],maps:[],event:'Synthetic'};}
function quote(i,bookmaker,oddsA,oddsB,{hour=11,minute=40,active=true,reversed=false}={}){
  return {provider:'fixture',externalMatchId:'e'+i,bookmaker,teamA:'Alpha',teamB:'Beta',startsAt:t(i,12),capturedAt:t(i,hour,minute),oddsA,oddsB,active,marketType:'match_winner',matchId:'bo3:'+i,matchStatus:'matched',reversed};
}

test('Shin probabilities remove an equal share of the margin in a two-way market',()=>{
  const m=marketProbabilities(1.5,2.7);
  near(m.margin,1/1.5+1/2.7-1);
  near(m.shinA,1/1.5-m.margin/2);near(m.shinA+m.shinB,1);
  // Against proportional scaling the favourite keeps more probability: the longshot is shaded.
  assert.ok(m.shinA>m.a);
  // With no margin every method agrees.
  const fair=marketProbabilities(2,2);near(fair.shinA,.5);near(fair.a,.5);
});

test('Consensus rule fires only when one book pays above 1/(p_cons - alpha)',()=>{
  // Mean A odds = 2.0 -> p_cons = 0.5 -> threshold 1/0.45 = 2.222.
  const quiet=consensusSignal([{bookmaker:'x',oddsA:1.9,oddsB:1.9},{bookmaker:'y',oddsA:2.1,oddsB:1.8}]);
  near(quiet[0].pCons,.5);near(quiet[0].threshold,1/.45);assert.equal(quiet[0].bet,false);
  const loud=consensusSignal([{bookmaker:'x',oddsA:1.8,oddsB:2},{bookmaker:'y',oddsA:1.8,oddsB:2},{bookmaker:'soft',oddsA:2.4,oddsB:1.6}]);
  near(loud[0].pCons,3/6);assert.equal(loud[0].bet,true);assert.equal(loud[0].book,'soft');assert.equal(loud[0].maxOdds,2.4);
  assert.equal(loud[1].bet,false);
  assert.equal(consensusSignal([{bookmaker:'x',oddsA:2,oddsB:2}]),null,'одна контора — это не консенсус');
  assert.throws(()=>consensusSignal([],{alpha:.7}),/alpha/);
});

test('Consensus backtest uses only quotes available at decision time; closing only moves CLV',()=>{
  const m=[match(0,true)];
  const q=[quote(0,'x',1.8,2),quote(0,'y',1.8,2),quote(0,'soft',2.4,1.6),
    // After the decision (start 12:00, lead 15 min -> 11:45): must not create or change a bet.
    quote(0,'soft',5,1.1,{hour:11,minute:50}),
    quote(0,'x',9,1.01,{hour:11,minute:55})];
  const r=consensusBacktest(m,q,{stake:100});
  assert.equal(r.status,'evaluated');assert.equal(r.bets,1);
  const bet=r.trades[0];
  assert.equal(bet.odds,2.4,'ставка по цене на момент решения, а не по более поздней');
  assert.equal(bet.book,'soft');assert.equal(bet.side,'A');
  near(bet.clv,2.4/5-1);
  near(r.profit,140);near(r.roi,1.4);
  assert.ok(Date.parse(bet.capturedAt)<=Date.parse(bet.decisionAt));
});

test('Consensus backtest settles losses with the fee and orients reversed provider sides',()=>{
  const m=[match(1,false)];
  // Provider lists the teams the other way round: internal A is provider B.
  const q=[quote(1,'x',2,1.8,{reversed:true}),quote(1,'y',2,1.8,{reversed:true}),quote(1,'soft',1.6,2.4,{reversed:true})];
  const r=consensusBacktest(m,q,{stake:100,fee:.01});
  assert.equal(r.bets,1);assert.equal(r.trades[0].side,'A');assert.equal(r.trades[0].won,false);
  near(r.profit,-101);
});

test('Consensus backtest reports why nothing was evaluated',()=>{
  assert.equal(consensusBacktest([match(2)],[]).status,'needs_odds');
  const single=consensusBacktest([match(2)],[quote(2,'pinnacle',1.8,2)]);
  assert.equal(single.status,'needs_more_books');assert.equal(single.skipped.fewBooks,1);
  // A suspended latest quote cannot count as a tradable price.
  const suspended=consensusBacktest([match(3)],[quote(3,'x',1.8,2),quote(3,'y',1.8,2,{minute:30}),quote(3,'y',1.8,2,{minute:44,active:false})]);
  assert.equal(suspended.status,'needs_more_books');
});

test('OddsPapi sync accepts one to three bookmakers per request and no more',async()=>{
  const store={cached:()=>null,cache:()=>{},all:()=>[]};
  const provider=new OddsPapiProvider(store,{key:'k',fetcher:async()=>{throw new Error('network must not be reached');},pause:async()=>{}});
  const window={from:'2026-09-01T00:00:00Z',to:'2026-09-05T00:00:00Z',limit:1};
  await assert.rejects(provider.collect({...window,bookmaker:'a,b,c,d'}),/от 1 до 3/);
  await assert.rejects(provider.collect({...window,bookmaker:'Pinnacle'}),/от 1 до 3/);
  // Valid lists pass validation and only then reach the network.
  await assert.rejects(provider.collect({...window,bookmaker:'pinnacle,ggbet,1xbet'}),/OddsPapi/);
});
