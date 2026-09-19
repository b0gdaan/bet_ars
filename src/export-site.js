// Builds the static GitHub Pages snapshot in docs/ from the local database.
// The page has no server: it carries the fitted weights and the per-team state
// as of the snapshot moment, and recomputes the same probability in the browser.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './config.js';
import { Store } from './db.js';
import { walkForward, predictMatchup, FEATURES } from './model.js';
import { backtest, teamRows, playerRows, summary } from './analytics.js';

const TEAM_LIMIT=400;
const store=new Store();
const matches=store.all('bo3');
store.close();
if(!matches.length)throw new Error('Пустая база: сначала загрузите историю.');

const now=Date.now();
const model=walkForward(matches);
const report=backtest(matches);
const teams=teamRows(matches);
const players=playerRows(matches);
const s=summary(matches,'bo3');

const top=teams.filter(t=>t.played>=5).slice(0,TEAM_LIMIT);
const ids=new Set(top.map(t=>t.id));
const h2h={};
for(const [key,[a,b]] of model.h2h){
  const [x,y]=key.split('|');
  if(ids.has(x)&&ids.has(y)&&(a||b))h2h[key]=[a,b];
}
const day=86400_000;
const snapshot={
  generated:new Date(now).toISOString(),
  source:'bo3',
  totals:{matches:matches.length,teams:teams.length,players:players.length,maps:s.maps,withStats:s.withStats,coverage:s.coverage,
    first:matches[0].start,last:matches.at(-1).start},
  model:{features:FEATURES,weights:model.blend.weights,scale:model.blend.scale},
  backtest:{testFrom:report.testFrom,warmup:report.warmup,models:report.models,baseline:report.baseline,
    experienced:report.experienced,cold:report.cold,calibration:report.calibration.filter(b=>b.count),note:report.note},
  // The blend reads the margin-of-victory Elo, not the plain one shown in the table.
  teams:top.map(t=>({id:t.id,name:t.name,rating:t.rating,rd:t.rd,elo:model.engines.eloPlus.rating([t.id],now),played:t.played,wins:t.wins,
    winRate:t.winRate,form:t.form===null?0.5:t.form,
    idle:t.last?Math.min(60,Math.max(0,(now-Date.parse(t.last))/day)):60,
    last:t.last})),
  h2h,
  recent:[...matches].slice(-12).reverse().map(m=>({start:m.start,teamA:m.teamA.name,teamB:m.teamB.name,
    scoreA:m.scoreA,scoreB:m.scoreB,winnerA:m.winner===m.teamA.id,event:m.event,bestOf:m.bestOf})),
  topPlayers:players.slice(0,15).map(p=>({name:p.name,played:p.played,winRate:p.winRate,kd:p.kd,adr:p.adr,kast:p.kast})),
  days:s.days.slice(-120),
};

// Sanity check: the exported numbers must reproduce the server's own probability.
const [a,b]=top;
const SCALE=173.7178,g=phi=>1/Math.sqrt(1+3*phi*phi/Math.PI**2);
const pair=(x,y)=>{
  const key=x.id<y.id?`${x.id}|${y.id}`:`${y.id}|${x.id}`;
  const raw=h2h[key]||[0,0],[hA,hB]=x.id<y.id?raw:[raw[1],raw[0]];
  const phi=Math.sqrt((x.rd/SCALE)**2+(y.rd/SCALE)**2);
  const f=[(x.elo-y.elo)/400,g(phi)*(x.rating-y.rating)/SCALE,x.winRate-y.winRate,
    (x.form??0.5)-(y.form??0.5),(hA-hB)/(1+hA+hB),Math.log1p(x.played)-Math.log1p(y.played),
    (Math.min(60,x.idle)-Math.min(60,y.idle))/30];
  let z=0;for(let i=0;i<f.length;i++)z+=snapshot.model.weights[i]*(f[i]/snapshot.model.scale[i]);
  return 1/(1+Math.exp(-z));
};
const mine=pair(snapshot.teams[0],snapshot.teams[1]);
const live=predictMatchup(model,a.id,b.id,now).p;
if(Math.abs(mine-live)>1e-6)throw new Error(`Снимок расходится с моделью: ${mine} против ${live}`);
console.log(`Проверка: ${a.name} vs ${b.name} = ${(mine*100).toFixed(2)}% (совпадает с сервером)`);
console.log(`Тест модели: ${report.metrics.count} матчей, accuracy ${(report.metrics.accuracy*100).toFixed(1)}%, log loss ${report.metrics.logLoss.toFixed(4)}`);

const dir=join(root,'docs');
mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'data.json'),JSON.stringify(snapshot));
console.log(`Снимок записан: docs/data.json, команд ${snapshot.teams.length}, пар ${Object.keys(h2h).length}`);
