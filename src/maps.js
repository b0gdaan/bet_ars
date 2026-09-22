import { createHash } from 'node:crypto';
import { finalTime,fitLogistic,score } from './model.js';
import { mapFeatures } from './map-contract.js';
import { blockInterval } from './odds/simulate.js';
let cache={};
export function buildMaps(matches){
  const key=createHash('sha256').update(JSON.stringify(matches.map(m=>[m.id,m.start,m.end,m.teamA,m.teamB,m.maps]))).digest('hex');if(cache.key===key)return cache.value;
  const teams=new Map(),maps=new Set(),rows=[],pending=[];
  const book=t=>{if(!teams.has(t.id))teams.set(t.id,{id:t.id,name:t.name,elo:1500,played:0,wins:0,maps:{}});return teams.get(t.id);};
  const update=(a,b,y)=>{const p=1/(1+10**((b.elo-a.elo)/400)),delta=24*(y-p);a.elo+=delta;b.elo-=delta;a.played++;b.played++;a.wins+=y;b.wins+=1-y;};
  const apply=entry=>{const a=book(entry.m.teamA),b=book(entry.m.teamB);for(const g of entry.games){const x=a.maps[g.name]??={elo:1500,played:0,wins:0},y=b.maps[g.name]??={elo:1500,played:0,wins:0};update(a,b,Number(g.winner===a.id));update(x,y,Number(g.winner===a.id));x.last=y.last=entry.m.start;}};
  for(const m of [...matches].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id))){
    pending.sort((a,b)=>a.available-b.available);while(pending.length&&pending[0].available<Date.parse(m.start))apply(pending.shift());
    const games=m.maps.filter(g=>/^de_[a-z0-9_]+$/.test(g.name)&&[m.teamA.id,m.teamB.id].includes(g.winner)),a=book(m.teamA),b=book(m.teamB);
    for(const g of games){maps.add(g.name);rows.push({id:m.id+'/'+g.id,matchId:m.id,start:m.start,available:Date.parse(finalTime(m)),map:g.name,y:Number(g.winner===m.teamA.id),features:mapFeatures(a,b,g.name),probs:{}});}
    if(games.length)pending.push({m,games,available:Date.parse(finalTime(m))});
  }
  pending.sort((a,b)=>a.available-b.available);pending.forEach(apply);
  const groups=[...new Map(rows.map(r=>[r.matchId,r])).values()],boundary=groups[Math.floor(groups.length*.8)]?.start;
  const train=boundary?rows.filter(r=>r.start<boundary&&r.available<Date.parse(boundary)):[],test=boundary?rows.filter(r=>r.start>=boundary):[];
  const base=fitLogistic(train.map(r=>r.features.slice(0,2)),train.map(r=>r.y)),withMaps=fitLogistic(train.map(r=>r.features),train.map(r=>r.y));
  for(const r of test){r.probs.base=base.predict(r.features.slice(0,2));r.probs.maps=withMaps.predict(r.features);}
  const delta=r=>(r.probs.maps-r.y)**2-(r.probs.base-r.y)**2;
  const uncertainty={deltaBrier:test.length?test.reduce((s,r)=>s+delta(r),0)/test.length:null,deltaBrier95:blockInterval(test.map(r=>({...r,decisionAt:r.start})),delta)};
  const value={unit:'карта',maps:[...maps].sort(),teams:[...teams.values()].filter(t=>t.played).sort((a,b)=>b.played-a.played),model:train.length?{weights:withMaps.weights,scale:withMaps.scale}:null,report:{total:rows.length,matches:groups.length,train:train.length,testFrom:boundary||null,base:score(test,'base'),withMaps:score(test,'maps'),perMap:[...maps].sort().map(map=>({map,base:score(test.filter(r=>r.map===map),'base'),withMaps:score(test.filter(r=>r.map===map),'maps')}))},
    note:'Отдельный эксперимент, условный на известную карту. В одной серии все прогнозы используют историю до её старта; результаты карт применяются только после окончания серии. Винрейт сглажен Beta(5,5), форма включает все загруженные составы команды. Нет исторических timestamps veto, пиков и старта отдельных карт — это не бэктест ставок после veto.'};
  Object.assign(value.report,uncertainty);cache={key,value};return value;
}
