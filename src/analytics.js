import { walkForward, predictMatchup, score, DEFAULTS, FEATURES, mean } from './model.js';
import { createHash } from 'node:crypto';

const ENGINES=['winrate','elo','eloPlus','glicko','logistic','stacked'];
const LABELS={winrate:'Доля побед (наивная база)',elo:`Elo K=${DEFAULTS.k}`,eloPlus:'Elo + margin of victory',glicko:'Glicko-2',logistic:'Логистическая регрессия',stacked:'Регрессия + рейтинги'};
const PRODUCTION='logistic';

// One walk-forward pass per loaded sample, reused by every endpoint.
let cache={key:null,model:null};
export function model(matches) {
  // Historical corrections and newly collected rosters must invalidate the fit too.
  const hash=createHash('sha256');
  for(const m of matches)hash.update(JSON.stringify([m.id,m.source,m.kind,m.start,m.end,m.winner,m.scoreA,m.scoreB,m.teamA,m.teamB,m.players.map(p=>[p.id,p.teamId])]));
  const key=hash.digest('hex');
  if(cache.key!==key)cache={key,model:walkForward(matches)};
  return cache.model;
}

export function backtest(matches) {
  const m=model(matches);
  const rows=m.test;
  const bins=Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,items:[]}));
  for(const r of rows)bins[Math.min(9,Math.floor(r.probs[PRODUCTION]*10))].items.push(r);
  const table=ENGINES.map(name=>({name,label:LABELS[name],production:name===PRODUCTION,...(score(rows,name)||{})}));
  const coin=rows.length?{count:rows.length,accuracy:0.5,logLoss:Math.log(2),brier:0.25,auc:rows.some(r=>r.y===1)&&rows.some(r=>r.y===0)?0.5:null}:null;
  return {
    total:m.rows.length,warmup:m.train.length,testFrom:m.boundary,purgedLabels:m.rows.length-m.excluded-m.train.length-m.test.length,
    models:table,metrics:score(rows,PRODUCTION),baseline:coin,
    experienced:score(rows.filter(r=>r.experience>=10),PRODUCTION),
    cold:rows.filter(r=>r.experience<5).length,excluded:m.excluded,
    weights:FEATURES.map((name,i)=>({name,weight:m.blend.weights[i]})),
    calibration:bins.map(({from,to,items})=>({from,to,count:items.length,predicted:mean(items.map(i=>i.probs[PRODUCTION])),actual:mean(items.map(i=>i.y))})),
    estimatedEnds:matches.filter(x=>!Number.isFinite(Date.parse(x.end))||Date.parse(x.end)<=Date.parse(x.start)).length,
    note:'Walk-forward: первые 80% истории — разогрев и обучение регрессии, последние 20% — оценка. Рейтинги обновляются после окончания матча. Из обучения исключены исходы, ещё недоступные к первому прогнозу теста. Веса регрессии подобраны без тестовой выборки. Ничья вероятностей 50/50 даёт 0.5 в accuracy.'};
}

export function teamRows(matches) {
  const m=model(matches),now=Date.now(),teams=new Map();
  for(const x of matches)for(const t of [x.teamA,x.teamB])teams.set(t.id,t);
  return [...teams.values()].map(t=>{
    const s=m.teams.get(t.id)||{played:0,wins:0,recent:[],last:null};
    const g=m.engines.glicko.at(t.id,now);
    return {...t,played:s.played,wins:s.wins,recent:s.recent,last:s.last?new Date(s.last).toISOString():null,
      elo:m.engines.elo.rating([t.id],now),rating:g.r,rd:g.rd,
      winRate:s.played?s.wins/s.played:null,form:s.recent.length?mean(s.recent):null};
  }).sort((a,b)=>b.rating-a.rating);
}

export function playerRows(matches) {
  const players=new Map();
  for(const m of matches)for(const p of m.players){
    if(!players.has(p.id))players.set(p.id,{id:p.id,name:p.name,source:m.source,played:0,wins:0,kills:0,deaths:0,kdSamples:0,adrs:[],kasts:[],last:m.start,teams:new Set()});
    const row=players.get(p.id);row.name=p.name;row.played++;row.wins+=Number(p.teamId===m.winner);row.last=m.start;row.teams.add(p.teamId);
    if(p.kills!==null&&p.kills!==undefined&&p.deaths!==null&&p.deaths!==undefined){row.kills+=p.kills;row.deaths+=p.deaths;row.kdSamples++;}
    if(p.adr!==null&&p.adr!==undefined)row.adrs.push(p.adr);if(p.kast!==null&&p.kast!==undefined)row.kasts.push(p.kast);
  }
  return [...players.values()].map(({adrs,kasts,teams,...r})=>({...r,teamCount:teams.size,winRate:r.wins/r.played,kd:r.kdSamples&&r.deaths?r.kills/r.deaths:null,adr:mean(adrs),adrSamples:adrs.length,kast:mean(kasts)})).sort((a,b)=>b.played-a.played);
}
export function summary(matches,source) {
  const players=playerRows(matches),teams=teamRows(matches),stats=matches.filter(m=>m.players.some(p=>p.kills!==null&&p.kills!==undefined)).length;
  const days=new Map();for(const m of matches){const d=m.start.slice(0,10);days.set(d,(days.get(d)||0)+1);}
  return {source,matches:matches.length,teams:teams.length,players:players.length,maps:matches.reduce((s,m)=>s+m.maps.length,0),withStats:stats,coverage:matches.length?stats/matches.length:0,first:matches[0]?.start||null,last:matches.at(-1)?.start||null,days:[...days].map(([date,count])=>({date,count})),topTeams:teams.slice(0,8),topPlayers:players.slice(0,8),recent:[...matches].reverse().slice(0,8),backtest:backtest(matches)};
}
export function headToHead(matches,type,a,b) {
  if(!a||!b||a===b)throw new Error('Выберите двух разных участников');
  let together=0,togetherWins=0,winsA=0,winsB=0;
  const games=[];
  for(const m of matches) {
    if(type==='players') {
      const pa=m.players.find(p=>p.id===a),pb=m.players.find(p=>p.id===b);if(!pa||!pb)continue;
      if(pa.teamId===pb.teamId){together++;togetherWins+=Number(m.winner===pa.teamId);continue;}
      winsA+=Number(m.winner===pa.teamId);winsB+=Number(m.winner===pb.teamId);
    }else {if(![m.teamA.id,m.teamB.id].includes(a)||![m.teamA.id,m.teamB.id].includes(b))continue;winsA+=Number(m.winner===a);winsB+=Number(m.winner===b);}
    games.push(m);
  }
  return {winsA,winsB,played:games.length,together,togetherWins,matches:games.reverse(),note:type==='players'?'Победы команд, когда игроки были соперниками. Это не количество личных убийств друг друга.':'Только встречи из загруженной выборки.'};
}
export function predict(matches,a,b) {
  if(a===b||!a||!b)throw new Error('Выберите две разные команды');
  if(matches.some(m=>m.kind==='pug'))throw new Error('Командный прогноз доступен для профессиональных команд. FACEIT оценивается отдельно по игрокам в разделе проверки модели.');
  const rows=teamRows(matches),ta=rows.find(t=>t.id===a),tb=rows.find(t=>t.id===b);
  if(!ta||!tb)throw new Error('Команда не найдена');
  const m=model(matches),detail=predictMatchup(m,a,b);
  const maps=new Map();
  for(const x of matches)for(const g of x.maps){
    if(!g.winner)continue;
    if(!maps.has(g.name))maps.set(g.name,{name:g.name,a:0,aw:0,b:0,bw:0});
    const cell=maps.get(g.name);
    for(const [id,k]of [[a,'a'],[b,'b']])if([x.teamA.id,x.teamB.id].includes(id)){cell[k]++;cell[k+'w']+=Number(g.winner===id);}
  }
  const warnings=[];
  if(Math.min(ta.played,tb.played)<10)warnings.push('Меньше 10 матчей хотя бы у одной команды: оценка нестабильна.');
  if([ta,tb].some(t=>Math.max(ta.rd,tb.rd)>250))warnings.push('Высокая неопределённость рейтинга (RD): вероятность подтянута к 50%.');
  if([ta,tb].some(t=>!t.last||Date.now()-Date.parse(t.last)>30*86400_000))warnings.push('У одной из команд нет свежих матчей за 30 дней.');
  warnings.push('Прогноз по рейтингам, форме, опыту, паузе и личным встречам. Составы, veto карт, формат серии и сила лиги пока не входят в модель.');
  return {a:ta,b:tb,p:detail.p,alternatives:{glicko:detail.glicko,elo:detail.elo},
    features:FEATURES.map((name,i)=>({name,value:detail.features[i],weight:m.blend.weights[i]})),
    h2h:headToHead(matches,'teams',a,b),maps:[...maps.values()].filter(x=>x.a||x.b),warnings,asOf:new Date().toISOString()};
}
