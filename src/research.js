import { finalTime, mean } from './model.js';

export const ROLES=['entry','support','awp','lurker','rifler','igl'];
const DAY=86400_000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const ratio=(a,b)=>b>0?a/b:null;
export function validateRoles(rows) {
  if(!Array.isArray(rows))throw new Error('Роли должны быть массивом записей');
  for(const r of rows){
    if(!r||typeof r.playerId!=='string'||!r.playerId.trim()||!ROLES.includes(r.role)||typeof r.evidence!=='string'||!r.evidence.trim()||!Number.isFinite(Date.parse(r.from))||!Number.isFinite(Date.parse(r.to))||Date.parse(r.from)>=Date.parse(r.to))throw new Error('Роль: нужны playerId, role, from < to, evidence');
    if(rows.some(x=>x!==r&&x.playerId===r.playerId&&Date.parse(x.from)<Date.parse(r.to)&&Date.parse(r.from)<Date.parse(x.to)))throw new Error(`Пересекающиеся интервалы ролей: ${r.playerId}`);
  }
  return rows;
}
const roleAt=(roles,id,time)=>roles.find(r=>r.playerId===id&&Date.parse(r.from)<=time&&time<Date.parse(r.to))?.role||'unknown';

export function dataAudit(matches,rounds=[]) {
  const periods=new Map(),players=new Set();let stats=0,full=0,playerRows=0,missingCore=0,mirage=0;
  const fields={adr:0,kast:0,firstKills:0,firstDeaths:0,tradeKills:0,tradedDeaths:0,flashAssists:0,utilityDamage:0};
  for(const m of matches){
    const month=m.start.slice(0,7);if(!periods.has(month))periods.set(month,{month,matches:0,withStats:0,completeRosters:0});const row=periods.get(month);row.matches++;
    const has=m.players.some(p=>finite(p.kills));stats+=Number(has);row.withStats+=Number(has);
    const complete=m.players.length===10&&[m.teamA.id,m.teamB.id].every(id=>new Set(m.players.filter(p=>p.teamId===id).map(p=>p.id)).size===5)&&new Set(m.players.map(p=>p.id)).size===10;
    full+=Number(complete);row.completeRosters+=Number(complete);mirage+=m.maps.filter(g=>g.name==='de_mirage').length;
    for(const p of m.players){players.add(p.id);playerRows++;if(!finite(p.kills)||!finite(p.deaths)||!finite(p.adr))missingCore++;for(const key of Object.keys(fields))fields[key]+=Number(finite(p[key]));}
  }
  const mirageRounds=rounds.filter(r=>r.map==='de_mirage');
  const byMap=new Map();for(const r of mirageRounds){const key=JSON.stringify([r.matchId,r.mapId]);if(!byMap.has(key))byMap.set(key,[]);byMap.get(key).push(r);}
  const completeDemos=new Set();let incompleteMaps=0;
  for(const m of matches)for(const g of m.maps.filter(g=>g.name==='de_mirage')){
    const rows=byMap.get(JSON.stringify([m.id,g.id]));if(!rows)continue;
    const expected=finite(g.scoreA)&&finite(g.scoreB)?g.scoreA+g.scoreB:0;
    const numbers=new Set(rows.map(r=>r.round));
    if(expected>0&&rows.length===expected&&numbers.size===expected&&rows.every(r=>r.round>=1&&r.round<=expected)&&rows.filter(r=>r.winner===m.teamA.id).length===g.scoreA)completeDemos.add(m.id);else incompleteMaps++;
  }
  const demoMatches=completeDemos.size;
  const roundMissing=mirageRounds.filter(r=>!finite(r.equipmentA)||!finite(r.equipmentB)).length;
  const roundMissingRate=ratio(roundMissing,mirageRounds.length);
  return {matches:matches.length,withStats:stats,statsCoverage:ratio(stats,matches.length),completeRosters:full,players:players.size,playerRows,missingCore,missingCoreRate:ratio(missingCore,playerRows),fields,mirageMaps:mirage,rounds:mirageRounds.length,demoMatches,incompleteMaps,roundMissingRate,
    first:matches[0]?.start||null,last:matches.at(-1)?.start||null,periods:[...periods.values()].sort((a,b)=>a.month.localeCompare(b.month)),
    gates:[
      {name:'Гипотеза',status:'ready',detail:'Проверить добавочную ценность player-level признаков на будущих матчах.'},
      {name:'Данные раундов Mirage',status:demoMatches>=300&&incompleteMaps===0&&roundMissingRate!==null&&roundMissingRate<.05?'ready':'blocked',detail:`${demoMatches}/300 матчей с полными раундами Mirage; неполных карт ${incompleteMaps}; пропуски стартовой экономики ${roundMissingRate===null?'не измерены':(roundMissingRate*100).toFixed(1)+'%'}. Полнота проверяется по счёту карты. Матчевые агрегаты не заменяют раунды.`},
      {name:'Рейтинг игроков',status:'research',detail:'Доступен описательный индекс формы. Для RAPM ещё нужны раундовые данные, модель и независимая проверка.'},
      {name:'Сравнение с рынком',status:'blocked',detail:'Нужны closing odds с временем снимка, точным исходом и совпадающей выборкой. Без них market edge не рассчитан.'},
    ]};
}

// Descriptive, transparent heuristic. Not RAPM and not a pre-match feature store.
// As-of filtering applies to outcome availability; no target/future stats enter a snapshot.
export function scouting(matches,{asOf=new Date().toISOString(),days=90,minMatches=10,roles=[]}={}) {
  const cutoff=Date.parse(asOf);
  if(!Number.isFinite(cutoff)||!Number.isInteger(days)||days<1||days>1095||!Number.isInteger(minMatches)||minMatches<1||minMatches>500)throw new Error('Некорректные параметры: дата, days 1–1095, minMatches 1–500');
  validateRoles(roles);
  const acc=new Map();let eligibleMatches=0;
  for(const m of matches){const time=Date.parse(finalTime(m));if(time>=cutoff||time<cutoff-days*DAY)continue;eligibleMatches++;
    const w=Math.exp(-Math.log(2)*(cutoff-time)/(30*DAY));
    const counts=new Map();for(const p of m.players)counts.set(p.id,(counts.get(p.id)||0)+1);
    for(const p of m.players){
      if(counts.get(p.id)!==1||![m.teamA.id,m.teamB.id].includes(p.teamId))continue;
      const role=roleAt(roles,p.id,time),key=p.id+'|'+role;
      if(!acc.has(key))acc.set(key,{id:p.id,name:p.name,role,matches:0,weight:0,weight2:0,last:m.start,stats:{},teams:new Set()});
      const a=acc.get(key);a.matches++;a.weight+=w;a.weight2+=w*w;a.last=m.start;a.teams.add(p.teamId);
      const fields={adr:p.adr,kast:p.kast,kd:finite(p.kills)&&finite(p.deaths)?p.kills/Math.max(1,p.deaths):null,opening:finite(p.firstKills)&&finite(p.firstDeaths)?ratio(p.firstKills,p.firstKills+p.firstDeaths):null,tradeShare:finite(p.tradeKills)&&finite(p.kills)?ratio(p.tradeKills,p.kills):null,tradedDeathRate:finite(p.tradedDeaths)&&finite(p.deaths)?ratio(p.tradedDeaths,p.deaths):null,referenceRating:p.ratingSystem==='BO3'?p.rating:null};
      for(const [field,value]of Object.entries(fields))if(finite(value)){const s=a.stats[field]??={sum:0,weight:0,samples:0};s.sum+=value*w;s.weight+=w;s.samples++;}
    }
  }
  const rows=[...acc.values()].map(a=>({id:a.id,name:a.name,role:a.role,matches:a.matches,effectiveMatches:a.weight*a.weight/a.weight2,last:a.last,teamCount:a.teams.size,values:Object.fromEntries(Object.entries(a.stats).map(([k,s])=>[k,s.sum/s.weight])),samples:Object.fromEntries(Object.entries(a.stats).map(([k,s])=>[k,s.samples]))}));
  const definitions=[['adr',.4],['kast',.25],['kd',.2],['opening',.15]];
  const cohorts=new Map();
  for(const r of rows){if(!cohorts.has(r.role))cohorts.set(r.role,{});}
  for(const [role,stats]of cohorts)for(const [metric]of definitions){
    const v=rows.filter(r=>r.role===role&&r.matches>=minMatches&&r.samples[metric]>=minMatches).map(r=>r.values[metric]);
    const mu=mean(v);stats[metric]={n:v.length,mean:mu,sd:v.length?Math.sqrt(mean(v.map(x=>(x-mu)**2))):0};
  }
  for(const r of rows){let z=0,total=0;const evidence=[];r.components=[];
    for(const [metric,weight]of definitions){const c=cohorts.get(r.role)[metric];if(c.n<5||c.sd<1e-9||!finite(r.values[metric])||r.samples[metric]<minMatches)continue;
      const standardized=Math.max(-3,Math.min(3,(r.values[metric]-c.mean)/c.sd));z+=weight*standardized;total+=weight;evidence.push(r.samples[metric]);r.components.push({metric,weight,z:standardized,cohort:c.n});}
    const reliability=Math.min(r.effectiveMatches,...(evidence.length?evidence:[0]));r.shrinkage=reliability/(reliability+10);
    r.formScore=r.matches>=minMatches&&r.components.length>=3?Math.max(0,Math.min(100,50+10*r.shrinkage*z/total)):null;
    r.normalization=r.role==='unknown'?'общая когорта, роль неизвестна':'внутри подтверждённой роли';
  }
  rows.sort((a,b)=>(b.formScore??-1)-(a.formScore??-1)||b.matches-a.matches);
  const comparable=rows.filter(r=>r.formScore!==null&&finite(r.values.referenceRating));
  return {asOf:new Date(cutoff).toISOString(),days,minMatches,eligibleMatches,players:rows.length,ranked:rows.filter(r=>r.formScore!==null).length,knownRoleRows:rows.filter(r=>r.role!=='unknown').length,
    correlation:{reference:'BO3 (не HLTV)',n:comparable.length,spearman:spearman(comparable.map(r=>r.formScore),comparable.map(r=>r.values.referenceRating))},rows,
    methodology:'Описательный индекс 50 + 10 × shrinkage × взвешенный z-score: ADR 40%, KAST 25%, K/D 20%, opening win rate 15%. Полураспад веса 30 дней, shrinkage n_eff/(n_eff+10). Минимум 3 доступных компонента, 5 игроков в когорте. Это не RAPM, не вероятность победы и не оценка IGL-коммуникации.'};
}
export function spearman(a,b){
  if(a.length!==b.length||a.length<3)return null;
  function ranks(x){const sorted=x.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v),out=[];for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sorted[j].v===sorted[i].v)j++;for(let k=i;k<j;k++)out[sorted[k].i]=(i+j-1)/2;i=j;}return out;}
  const x=ranks(a),y=ranks(b),mx=mean(x),my=mean(y);let xy=0,xx=0,yy=0;for(let i=0;i<x.length;i++){xy+=(x[i]-mx)*(y[i]-my);xx+=(x[i]-mx)**2;yy+=(y[i]-my)**2;}return xx&&yy?xy/Math.sqrt(xx*yy):null;
}
