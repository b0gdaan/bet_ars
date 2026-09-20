import { createHash } from 'node:crypto';
import { finalTime,rocAuc } from './model.js';
import { model as baselineModel } from './analytics.js';
import { sigmoid,lineupChange,validateLineups } from './lineups.js';

const lambdas=[1,5,20,80];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const avg=x=>x.length?x.reduce((s,v)=>s+v,0)/x.length:null;
export function probabilityMetrics(rows,ps) {
  if(!rows.length)return null;
  return {count:rows.length,logLoss:avg(rows.map((r,i)=>{const p=Math.max(1e-12,Math.min(1-1e-12,ps[i]));return -r.y*Math.log(p)-(1-r.y)*Math.log(1-p);})),brier:avg(rows.map((r,i)=>(ps[i]-r.y)**2)),accuracy:avg(rows.map((r,i)=>Math.abs(ps[i]-.5)<1e-10?.5:Number((ps[i]>.5)===(r.y===1)))),auc:rocAuc(rows.map(r=>r.y),ps)};
}

export function matchLineup(m) {
  const a=m.players.filter(p=>p.teamId===m.teamA.id).map(p=>p.id),b=m.players.filter(p=>p.teamId===m.teamB.id).map(p=>p.id);
  try{if(m.players.length!==10)return null;validateLineups(a,b);return {a:a.sort(),b:b.sort()};}catch{return null;}
}

export function rapmRows(matches,rounds=[],mode='series',asOf=new Date().toISOString()) {
  const cutoff=Date.parse(asOf);if(!Number.isFinite(cutoff))throw new Error('Некорректный asOf');
  const byId=new Map(matches.map(m=>[m.id,m])),rows=[],skipped={unavailable:0,lineup:0,context:0};
  if(mode==='series')for(const m of matches){
    if(Date.parse(finalTime(m))>=cutoff){skipped.unavailable++;continue;}
    const lineup=matchLineup(m);if(!lineup){skipped.lineup++;continue;}
    rows.push({id:m.id,matchId:m.id,start:m.start,available:finalTime(m),a:lineup.a,b:lineup.b,y:Number(m.winner===m.teamA.id),context:{}});
  }else if(mode==='round')for(const r of rounds){
    const m=byId.get(r.matchId);if(!m||Date.parse(finalTime(m))>=cutoff){skipped.unavailable++;continue;}
    if(r.map!=='de_mirage')continue;
    try{validateLineups(r.playersA,r.playersB);}catch{skipped.lineup++;continue;}
    if(!finite(r.equipmentA)||!finite(r.equipmentB)||!['CT','T'].includes(r.sideA)||![m.teamA.id,m.teamB.id].includes(r.winner)){skipped.context++;continue;}
    rows.push({id:r.id||`${r.matchId}/${r.mapId}/${r.round}`,matchId:m.id,start:m.start,available:finalTime(m),a:r.playersA,b:r.playersB,y:Number(r.winner===m.teamA.id),context:{'ct:de_mirage':r.sideA==='CT'?1:-1,economy:(r.equipmentA-r.equipmentB)/10000}});
  }else throw new Error('Режим RAPM: series | round');
  rows.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.matchId.localeCompare(b.matchId)||a.id.localeCompare(b.id));
  return {rows,skipped};
}

// Minimize SUM Bernoulli log loss + lambda/2 * ||beta||².
// Signed player columns adjust simultaneously for all teammates and opponents.
// Cyclic coordinate Newton steps with backtracking, no intercept: side swap is exact.
export function fitRapm(rows,lambda=20,{iterations=400,tolerance=1e-6}={}) {
  if(!finite(lambda)||lambda<=0)throw new Error('Регуляризация должна быть положительной');
  const keys=[...new Set(rows.flatMap(r=>[...r.a,...r.b].map(id=>'p:'+id).concat(Object.keys(r.context).map(k=>'c:'+k))))].sort();
  const indices=new Map(keys.map((key,i)=>[key,i])),columns=keys.map(()=>[]),z=new Float64Array(rows.length),beta=new Float64Array(keys.length);
  rows.forEach((r,i)=>{for(const [id,value]of [...r.a.map(id=>['p:'+id,1]),...r.b.map(id=>['p:'+id,-1]),...Object.entries(r.context).map(([k,v])=>['c:'+k,v])])columns[indices.get(id)].push([i,value]);});
  const softplus=x=>Math.max(0,x)+Math.log1p(Math.exp(-Math.abs(x)));
  let converged=false,maxStep=0,passes=0;
  for(;passes<iterations;passes++){
    maxStep=0;
    for(let j=0;j<keys.length;j++){
      let grad=lambda*beta[j],hess=lambda;
      for(const [i,v]of columns[j]){const p=sigmoid(z[i]);grad+=v*(p-rows[i].y);hess+=v*v*p*(1-p);}
      let delta=-grad/hess;
      for(let attempt=0;attempt<25;attempt++){
        let difference=lambda*(beta[j]*delta+delta*delta/2);
        for(const [i,v]of columns[j]){const next=z[i]+v*delta;difference+=softplus(next)-softplus(z[i])-rows[i].y*v*delta;}
        if(difference<=1e-12)break;delta*=.5;
      }
      beta[j]+=delta;for(const [i,v]of columns[j])z[i]+=v*delta;maxStep=Math.max(maxStep,Math.abs(delta));
    }
    if(maxStep<tolerance){converged=true;passes++;break;}
  }
  const coefficients=Object.fromEntries(keys.map((k,i)=>[k,beta[i]]));
  return {lambda,coefficients,converged,passes,maxStep,predict:r=>sigmoid(r.a.reduce((s,id)=>s+(coefficients['p:'+id]||0),0)-r.b.reduce((s,id)=>s+(coefficients['p:'+id]||0),0)+Object.entries(r.context).reduce((s,[k,v])=>s+v*(coefficients['c:'+k]||0),0))};
}

// Match groups, not round rows, define the split. Purge unfinished labels at both boundaries.
export function temporalSplit(rows) {
  const groups=[...new Map(rows.map(r=>[r.matchId,r])).values()].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.matchId.localeCompare(b.matchId));
  const validationFrom=groups[Math.floor(groups.length*.6)]?.start,testFrom=groups[Math.floor(groups.length*.8)]?.start;
  if(!validationFrom||!testFrom)return {train:[],validation:[],fit:[],test:[],validationFrom:null,testFrom:null,purged:0};
  const v=Date.parse(validationFrom),t=Date.parse(testFrom);
  const train=rows.filter(r=>Date.parse(r.start)<v&&Date.parse(r.available)<v);
  const validation=rows.filter(r=>Date.parse(r.start)>=v&&Date.parse(r.start)<t&&Date.parse(r.available)<t);
  const fit=rows.filter(r=>Date.parse(r.start)<t&&Date.parse(r.available)<t),test=rows.filter(r=>Date.parse(r.start)>=t);
  return {train,validation,fit,test,validationFrom,testFrom,purged:rows.length-fit.length-test.length};
}

function groupBootstrap(rows,p,q) {
  const grouped=new Map();rows.forEach((r,i)=>{if(!grouped.has(r.matchId))grouped.set(r.matchId,[]);grouped.get(r.matchId).push((p[i]-r.y)**2-(q[i]-r.y)**2);});
  const blocks=[...grouped.values()];if(blocks.length<20)return null;
  let seed=91373;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296),samples=[];
  for(let k=0;k<300;k++){let total=0,n=0;for(let j=0;j<blocks.length;j++){const b=blocks[Math.floor(random()*blocks.length)];for(const d of b){total+=d;n++;}}samples.push(total/n);}
  samples.sort((a,b)=>a-b);return {lower:samples[7],upper:samples[292],replicates:300,unit:'match',note:'Интервал bootstrap по матчам; зависимость внутри турниров может делать его слишком узким.'};
}

function playerCoefficients(rows,fit,names) {
  const acc=new Map();rows.forEach((r,i)=>{for(const [own,other,sign]of [[r.a,r.b,1],[r.b,r.a,-1]])for(const id of own){
    if(!acc.has(id))acc.set(id,{id,name:names.get(id)||id,matchesSet:new Set(),opponents:new Set(),teammates:new Set(),signature:[],observations:0,last:r.start});
    const a=acc.get(id);a.matchesSet.add(r.matchId);a.observations++;a.last=r.start;a.signature.push(`${i}:${sign}`);other.forEach(x=>a.opponents.add(x));own.filter(x=>x!==id).forEach(x=>a.teammates.add(x));
  }});
  const counts=new Map();for(const a of acc.values()){a.signature=a.signature.join(',');counts.set(a.signature,(counts.get(a.signature)||0)+1);}
  return [...acc.values()].map(a=>({id:a.id,name:a.name,coefficient:fit.coefficients['p:'+a.id],neutralEffect:100*(sigmoid(fit.coefficients['p:'+a.id])-.5),matches:a.matchesSet.size,observations:a.observations,teammates:a.teammates.size,opponents:a.opponents.size,inseparable:counts.get(a.signature),last:a.last})).sort((a,b)=>b.coefficient-a.coefficient||a.id.localeCompare(b.id));
}

export function rosterHistory(matches,asOf=new Date().toISOString()) {
  const teams=new Map(),events=[],names=new Map(),until=Date.parse(asOf);
  for(const m of [...matches].sort((a,b)=>Date.parse(finalTime(a))-Date.parse(finalTime(b))||a.id.localeCompare(b.id))){
    if(Date.parse(finalTime(m))>=until)continue;
    const lineup=matchLineup(m);m.players.forEach(p=>names.set(p.id,p.name));
    for(const [team,ids]of [[m.teamA,lineup?.a],[m.teamB,lineup?.b]]){
      const previous=teams.get(team.id);const row={...previous,id:team.id,name:team.name,lastTeamMatch:m.start,unobservedMatches:(previous?.unobservedMatches||0)+1};
      if(ids){
        const diff=previous?.players?lineupChange(previous.players,ids):null;
        if(diff?.in.length)events.push({teamId:team.id,team:team.name,start:m.start,previousMatch:previous.matchId,matchId:m.id,...diff});
        Object.assign(row,{players:ids,observedAt:finalTime(m),matchId:m.id,unobservedMatches:0,streak:previous?.players&&!diff.in.length?(previous.streak||0)+1:1});
      }
      teams.set(team.id,row);
    }
  }
  return {teams:[...teams.values()].filter(t=>t.players).sort((a,b)=>b.observedAt.localeCompare(a.observedAt)),changes:events.reverse(),names};
}

function trainMode(matches,rounds,mode,asOf,names,baseline) {
  const {rows,skipped}=rapmRows(matches,rounds,mode,asOf),split=temporalSplit(rows),matchCount=new Set(rows.map(r=>r.matchId)).size;
  const common={mode,unit:mode==='series'?'исход серии':'исход раунда Mirage',asOf,observations:rows.length,matches:matchCount,skipped,players:[],context:{},status:'insufficient_data'};
  if(matchCount<50||!split.train.length||!split.validation.length||!split.test.length||new Set(split.train.map(r=>r.y)).size<2)return {...common,note:'Нужно ≥50 полных матчей и непустые временные train/validation/test; для исследовательской готовности раундов ориентир ≥300 матчей.'};
  const candidates=lambdas.map(lambda=>{const fit=fitRapm(split.train,lambda);return {lambda,...probabilityMetrics(split.validation,split.validation.map(r=>fit.predict(r))),converged:fit.converged};}).sort((a,b)=>a.logLoss-b.logLoss||b.lambda-a.lambda);
  const selected=candidates.find(c=>c.converged)?.lambda;if(!selected)throw new Error('RAPM: оптимизатор не сошёлся ни для одного значения регуляризации');
  const testFit=fitRapm(split.fit,selected),ps=split.test.map(r=>testFit.predict(r));
  const baselinePs=split.test.map(r=>mode==='series'?(baseline.get(r.matchId)??.5):.5);
  const known=new Set(Object.keys(testFit.coefficients));
  const cold=split.test.filter(r=>[...r.a,...r.b].some(id=>!known.has('p:'+id))).length;
  const live=fitRapm(rows,selected),test=probabilityMetrics(split.test,ps),reference=probabilityMetrics(split.test,baselinePs);
  if(!live.converged||!testFit.converged)throw new Error('RAPM: итоговая модель не сошлась; снимок не опубликован');
  const changed=new Set(rosterHistory(matches,asOf).changes.map(e=>e.matchId));
  const changeIndices=split.test.map((r,i)=>changed.has(r.matchId)?i:-1).filter(i=>i>=0);
  const bins=Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,indices:[]}));ps.forEach((p,i)=>bins[Math.min(9,Math.floor(p*10))].indices.push(i));
  return {...common,status:'trained',lambda:selected,players:playerCoefficients(rows,live,names),context:Object.fromEntries(Object.entries(live.coefficients).filter(([k])=>k.startsWith('c:')).map(([k,v])=>[k.slice(2),v])),optimizer:{converged:live.converged,passes:live.passes,maxStep:live.maxStep},
    evaluation:{train:split.train.length,validation:split.validation.length,fit:split.fit.length,validationFrom:split.validationFrom,testFrom:split.testFrom,purged:split.purged,candidates,test,reference:{name:mode==='series'?'Glicko-2 на тех же матчах':'50/50 на тех же раундах',...reference},afterChanges:{rapm:probabilityMetrics(changeIndices.map(i=>split.test[i]),changeIndices.map(i=>ps[i])),reference:probabilityMetrics(changeIndices.map(i=>split.test[i]),changeIndices.map(i=>baselinePs[i]))},coldStartRows:cold,deltaBrier:test.brier-reference.brier,deltaBrier95:groupBootstrap(split.test,ps,baselinePs),testOptimizerConverged:testFit.converged,calibration:bins.filter(b=>b.indices.length).map(b=>({from:b.from,to:b.to,count:b.indices.length,predicted:avg(b.indices.map(i=>ps[i])),actual:avg(b.indices.map(i=>split.test[i].y))}))},
    note:mode==='series'?'L2-регуляризованная логистическая модель ±1 индикаторов игроков по исходам серий. Это матчевый вариант adjusted plus-minus, без CT/T и экономики.':'L2-регуляризованная логистическая модель игроков + CT/T Mirage + разница стоимости экипировки на freeze end. Вероятность раунда, не серии.',
    limitations:['Коэффициенты условны относительно состава и соперников; причинный эффект замены не установлен.','Игроки, всегда выступающие вместе, неотделимы по этим данным; L2 делит общий сигнал.','Состав целевого матча берётся из исторической записи: это backtest при известной пятёрке, не доказательство доступности анонса до старта.','Текущие коэффициенты переобучены на всей доступной истории после отдельной проверки; их нельзя использовать для восстановления прошлых прогнозов.','Роли, взаимодействия игроков и коммуникация IGL не моделируются.']};
}

let cached={key:null,value:null};
export function buildRapm(matches,rounds=[],asOf=new Date().toISOString()) {
  const cutoff=Date.parse(asOf);if(!Number.isFinite(cutoff))throw new Error('Некорректный asOf');
  const eligible=matches.filter(m=>Date.parse(finalTime(m))<cutoff);
  const hash=createHash('sha256');for(const m of eligible)hash.update(JSON.stringify([m.id,m.start,m.end,m.winner,m.teamA,m.teamB,m.players.map(p=>[p.id,p.teamId,p.name])]));hash.update(JSON.stringify(rounds));
  const key=hash.digest('hex');if(cached.key===key)return {...cached.value,asOf};
  const history=rosterHistory(eligible,asOf);
  const baseline=new Map(baselineModel(eligible).rows.map(r=>[r.id,r.probs.glicko]));
  const series=trainMode(eligible,rounds,'series',asOf,history.names,baseline),round=trainMode(eligible,rounds,'round',asOf,history.names,baseline);
  const result={version:'rapm-1',asOf,source:eligible[0]?.source||matches[0]?.source||'bo3',series,round,rosters:history.teams,changes:history.changes,changeCount:history.changes.length,methodology:'logit(pA) = Σ β игроков A − Σ β игроков B + контекст. Штраф λ/2 × Σβ². λ выбирается на validation 60–80%, тест — последние 20% матчей; незавершённые метки исключены. Новые игроки в backtest получают prior 0; на сайте неизвестную пятёрку прогнозировать нельзя.'};
  cached={key,value:result};return result;
}
