import test from 'node:test';
import assert from 'node:assert/strict';
import { rapmRows, fitRapm, temporalSplit, buildRapm, matchLineup, rosterHistory } from '../src/rapm.js';
import { predictLineups, lineupChange, validateLineups } from '../src/lineups.js';

const roster=(team,n=5)=>Array.from({length:n},(_,i)=>`${team}#${i}`);
function match(id,teamA,teamB,winnerIsA,day,{players=null,end=true}={}) {
  const start=new Date(Date.UTC(2026,0,1+day,10)).toISOString();
  return {id:`bo3:${id}`,source:'bo3',kind:'pro',start,end:end?new Date(Date.UTC(2026,0,1+day,12)).toISOString():null,
    teamA:{id:`t:${teamA}`,name:teamA},teamB:{id:`t:${teamB}`,name:teamB},
    winner:winnerIsA?`t:${teamA}`:`t:${teamB}`,scoreA:winnerIsA?2:0,scoreB:winnerIsA?0:2,bestOf:3,event:'Synthetic',maps:[],
    players:players??[...roster(teamA).map(pid=>({id:pid,name:pid,teamId:`t:${teamA}`})),...roster(teamB).map(pid=>({id:pid,name:pid,teamId:`t:${teamB}`}))]};
}
// Eight teams, strength by index; the stronger side wins except on a fixed upset cycle.
function league(count=140) {
  const teams=['a','b','c','d','e','f','g','h'],out=[];
  for(let i=0;i<count;i++){
    const x=teams[i%teams.length],y=teams[(i*3+1)%teams.length];
    if(x===y)continue;
    const stronger=teams.indexOf(x)<teams.indexOf(y);
    out.push(match(i,x,y,i%7===0?!stronger:stronger,Math.floor(i/2)));
  }
  return out;
}

test('RAPM rows require a finished match and two complete lineups',()=>{
  const full=match(1,'a','b',true,0);
  const short={...match(2,'a','b',true,1)};short.players=short.players.slice(0,9);
  const future=match(3,'a','b',true,40);
  const {rows,skipped}=rapmRows([full,short,future],[],'series',new Date(Date.UTC(2026,0,10)).toISOString());
  assert.equal(rows.length,1);assert.equal(rows[0].matchId,'bo3:1');
  assert.equal(skipped.lineup,1);assert.equal(skipped.unavailable,1);
  assert.equal(matchLineup(short),null);
  assert.deepEqual(matchLineup(full).a,roster('a').sort());
  // A player listed on both sides is not a valid observation.
  const doubled=match(4,'a','b',true,1);doubled.players[9]={...doubled.players[0],teamId:'t:b'};
  assert.equal(matchLineup(doubled),null);
});

test('A stronger roster gets a higher coefficient and the fit is side-symmetric',()=>{
  const {rows}=rapmRows(league(),[],'series',new Date(Date.UTC(2027,0,1)).toISOString());
  const fit=fitRapm(rows,5);
  assert.ok(fit.converged,'оптимизатор должен сходиться');
  const strong=fit.coefficients['p:a#0'],weak=fit.coefficients['p:h#0'];
  assert.ok(strong>weak,`сильный состав должен получить больший коэффициент: ${strong} против ${weak}`);
  const a=roster('a'),h=roster('h');
  assert.ok(Math.abs(fit.predict({a,b:h,context:{}})+fit.predict({a:h,b:a,context:{}})-1)<1e-12);
  assert.throws(()=>fitRapm(rows,0),/положительной/);
});

test('Stronger regularization pulls every coefficient toward zero',()=>{
  const {rows}=rapmRows(league(),[],'series',new Date(Date.UTC(2027,0,1)).toISOString());
  const light=fitRapm(rows,1),heavy=fitRapm(rows,80);
  const norm=f=>Object.values(f.coefficients).reduce((s,v)=>s+v*v,0);
  assert.ok(norm(heavy)<norm(light));
});

test('The temporal split groups by match and purges labels that finish too late',()=>{
  const rows=[
    {id:'r1',matchId:'m1',start:'2026-01-01T10:00:00.000Z',available:'2026-01-01T12:00:00.000Z',a:[],b:[],y:1,context:{}},
    {id:'r2',matchId:'m2',start:'2026-01-02T10:00:00.000Z',available:'2026-01-02T12:00:00.000Z',a:[],b:[],y:0,context:{}},
    {id:'r3',matchId:'m3',start:'2026-01-03T10:00:00.000Z',available:'2026-01-09T12:00:00.000Z',a:[],b:[],y:1,context:{}},
    {id:'r4',matchId:'m4',start:'2026-01-04T10:00:00.000Z',available:'2026-01-04T12:00:00.000Z',a:[],b:[],y:0,context:{}},
    {id:'r5',matchId:'m5',start:'2026-01-05T10:00:00.000Z',available:'2026-01-05T12:00:00.000Z',a:[],b:[],y:1,context:{}},
  ];
  const split=temporalSplit(rows);
  assert.equal(split.testFrom,'2026-01-05T10:00:00.000Z');
  assert.ok(!split.fit.some(r=>r.id==='r3'),'метка, недоступная к началу теста, не должна попасть в обучение');
  assert.equal(split.purged,1);
  assert.ok(split.test.every(r=>r.start>=split.testFrom));
});

test('buildRapm refuses to train on too little data and reports why',()=>{
  const small=league(20);
  const r=buildRapm(small,[],new Date(Date.UTC(2027,0,1)).toISOString());
  assert.equal(r.series.status,'insufficient_data');
  assert.match(r.series.note,/50/);
  assert.equal(r.round.status,'insufficient_data');
  assert.equal(r.round.observations,0);
});

test('buildRapm trains on series, compares against the team baseline and reports uncertainty',()=>{
  const r=buildRapm(league(),[],new Date(Date.UTC(2027,0,1)).toISOString());
  const s=r.series;
  assert.equal(s.status,'trained');
  assert.ok(s.players.length>=40);
  assert.ok(s.evaluation.test.count>0&&s.evaluation.train>0&&s.evaluation.validation>0);
  assert.equal(s.evaluation.reference.count,s.evaluation.test.count,'базовая модель измеряется на тех же наблюдениях');
  assert.ok(Number.isFinite(s.evaluation.deltaBrier));
  assert.ok(s.evaluation.candidates.length===4&&s.evaluation.candidates.every(c=>Number.isFinite(c.logLoss)));
  assert.ok(s.optimizer.converged);
  // Teammates who only ever appear together cannot be told apart.
  assert.ok(s.players.every(p=>p.inseparable>=1));
  assert.ok(s.limitations.length>=3);
});

test('Lineup prediction rejects unknown players and keeps side symmetry',()=>{
  const fit=buildRapm(league(),[],new Date(Date.UTC(2027,0,1)).toISOString()).series;
  const a=roster('a'),b=roster('b');
  const forward=predictLineups(fit,a,b),back=predictLineups(fit,b,a);
  assert.ok(Math.abs(forward.p+back.p-1)<1e-12);
  assert.throws(()=>predictLineups(fit,a,[...b.slice(0,4),'unknown#9']),/коэффициент/);
  assert.throws(()=>predictLineups(fit,a,b.slice(0,4)),/пятёрки/);
  assert.throws(()=>predictLineups({status:'insufficient_data',players:[]},a,b),/не обучена/);
  assert.throws(()=>validateLineups(a,[...a.slice(0,4),b[0]]),/два места|обе стороны/);
});

test('Roster history records a change only after the new lineup has played',()=>{
  const before=match(1,'a','b',true,0);
  const after=match(2,'a','b',true,1,{players:[
    ...roster('a').slice(0,4).map(pid=>({id:pid,name:pid,teamId:'t:a'})),{id:'a#new',name:'newcomer',teamId:'t:a'},
    ...roster('b').map(pid=>({id:pid,name:pid,teamId:'t:b'}))]});
  const history=rosterHistory([before,after],new Date(Date.UTC(2027,0,1)).toISOString());
  assert.equal(history.changes.length,1);
  assert.deepEqual(history.changes[0].in,['a#new']);
  assert.deepEqual(history.changes[0].out,['a#4']);
  assert.equal(history.changes[0].matchId,'bo3:2');
  assert.deepEqual(lineupChange(roster('a'),roster('a')),{out:[],in:[],retained:5});
});
