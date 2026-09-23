import test from 'node:test';
import assert from 'node:assert/strict';
import { valueAtOdds,kellyPlan,FLAG_EV } from '../src/odds/market.js';

const near=(a,b,eps=1e-12)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
// A forecast row as the upcoming board stores it: p is P(team A), bestSide is the side to back.
function row(id,pA,side,odds){
  const q=side==='A'?pA:1-pA;
  return {matchId:id,p:pA,bestSide:{side,odds,ev:q*odds-1}};
}

test('Kelly fraction is (q·p − 1)/(p − 1) and positive only when q > 1/p',()=>{
  // The worked example: q = 0.6 at odds 2.0 -> f* = 0.2 of the bank.
  near(valueAtOdds(.6,2).kelly,(.6*2-1)/(2-1));near(valueAtOdds(.6,2).kelly,.2);
  near(valueAtOdds(.6,2).ev,.6*2-1);
  for(const [q,p] of [[.55,1.9],[.3,4],[.7,1.5],[.2,6.5]])near(valueAtOdds(q,p).kelly,Math.max(0,(q*p-1)/(p-1)));
  // At or below the break-even q = 1/p there is no bet at all, not a negative one.
  assert.equal(valueAtOdds(1/1.5,1.5).kelly,0);assert.equal(valueAtOdds(.65,1.5).kelly,0);
  near(valueAtOdds(.65,1.5).breakEven,1/1.5);
});

test('The plan applies fractional Kelly, the per-bet cap and skips flagged or losing rows',()=>{
  const rows=[
    row('a',.57,'A',2),     // EV 14%, f* = 0.14 -> ¼ Kelly 3.5%
    row('b',.55,'A',1.9),   // f* = (1.045-1)/0.9 = 0.05 -> ¼ Kelly 1.25%
    row('c',.65,'A',1.5),   // EV < 0 -> no bet
    row('d',.7,'A',2),      // EV = 40% -> flagged as model ignorance
    {matchId:'e',p:.5,bestSide:null},
  ];
  const plan=kellyPlan(rows,{bank:2000,k:.25,cap:.05,totalCap:1});
  const by=Object.fromEntries(plan.items.map(x=>[x.f.matchId,x]));
  near(by.a.full,.14);near(by.a.fraction,.035);assert.equal(by.a.stake,70);
  near(by.b.fraction,.0125);assert.equal(by.b.stake,25);
  assert.equal(by.c.status,'no-edge');assert.equal(by.c.stake,0);
  assert.equal(by.d.status,'flagged');assert.ok(rows[3].bestSide.ev>FLAG_EV);assert.equal(by.d.stake,0);
  assert.equal(by.e.status,'no-line');
  assert.equal(plan.bets,2);assert.equal(plan.total,by.a.stake+25);near(plan.exposure,plan.total/2000);
  // The per-bet cap binds: half Kelly on row a wants 7% but gets 5%.
  near(kellyPlan([rows[0]],{bank:2000,k:.5,cap:.05,totalCap:1}).items[0].fraction,.05);
  // Opting in to flagged rows sizes them like any other bet.
  assert.equal(kellyPlan([rows[3]],{bank:2000,k:.25,cap:.05,totalCap:1,skipFlagged:false}).items[0].status,'bet');
});

test('Simultaneous bets are scaled down together to the total cap',()=>{
  const rows=Array.from({length:10},(_,i)=>row('m'+i,.57,'A',2));
  const plan=kellyPlan(rows,{bank:2000,k:.25,cap:.05,totalCap:.3});
  // Ten bets at 3.5% want 35% of the bank at once; each is scaled by 0.30/0.35.
  near(plan.wanted,.35);near(plan.scale,.3/.35);
  assert.ok(plan.items.every(x=>Math.abs(x.fraction-.03)<1e-12&&x.stake===60));
  assert.equal(plan.total,600);assert.ok(plan.exposure<=.3+1e-12);
  // Under the cap nothing is scaled.
  assert.equal(kellyPlan(rows.slice(0,3),{bank:2000,k:.25,cap:.05,totalCap:.3}).scale,1);
  // A stake that rounds below one ruble is not placed.
  assert.equal(kellyPlan([row('x',.51,'A',2)],{bank:10,k:.25,cap:.05,totalCap:1}).items[0].status,'tiny');
  assert.throws(()=>kellyPlan(rows,{bank:0}),/Банк/);
  assert.throws(()=>kellyPlan(rows,{k:1.5}),/Келли/);
  assert.throws(()=>kellyPlan(rows,{cap:2}),/лимиты/);
});

test('Tunable numbers come from settings.js and reach the model and the stake plan',async()=>{
  const { SETTINGS }=await import('../src/settings.js');
  const { DEFAULTS }=await import('../src/model.js');
  assert.equal(DEFAULTS.k,SETTINGS.model.eloK);
  assert.equal(DEFAULTS.glicko.rd,SETTINGS.model.glickoStartRd);
  assert.equal(DEFAULTS.glicko.periodDays,SETTINGS.model.glickoPeriodDays);
  // Every share is a fraction, not a percent: 0.15 means 15%.
  for(const [k,v] of Object.entries({...SETTINGS.betting,testShare:SETTINGS.model.testShare}))
    if(!['bank','leadMinutes','maxQuoteAgeMinutes'].includes(k))assert.ok(v>0&&v<=1,`${k} = ${v} должно быть долей от 0 до 1`);
  // The ⚠ threshold is a parameter of the plan, so a changed setting changes which rows are skipped.
  const r=row('z',.57,'A',2);
  assert.equal(kellyPlan([r],{flagEv:.15,totalCap:1}).items[0].status,'bet');
  assert.equal(kellyPlan([r],{flagEv:.10,totalCap:1}).items[0].status,'flagged');
});
