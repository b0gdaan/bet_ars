// Upcoming matches, forward forecasts and their live evaluation.
// A forecast is logged before the match with a timestamp and is never rewritten, so the live
// score below cannot see the result it is judged on: it is the one test that cannot leak.
import { walkForward,predictMatchup } from './model.js';
import { marketProbabilities,valueAtOdds } from './odds/market.js';
import { probabilityMetrics } from './rapm.js';

const BO='https://api.bo3.gg/api/v1',DAY=86400_000;
const iso=x=>Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;
const num=x=>x===null||x===undefined||x===''||!Number.isFinite(Number(x))?null:Number(x);

export async function fetchUpcoming(client,{days=7,max=400,now=Date.now()}={}) {
  const out=[];let offset=0;
  while(out.length<max){
    const data=await client.get(BO,'/matches',{scope:'widget-matches','page[offset]':offset,'page[limit]':100,sort:'start_date,id',
      'filter[matches.status][in]':'upcoming','filter[matches.discipline_id][eq]':1,'filter[matches.game_version][eq]':2,
      'filter[matches.start_date][lt]':new Date(now+days*DAY).toISOString(),with:'teams,tournament'},'',5*60_000);
    if(!Array.isArray(data.results))throw new Error('BO3 изменил формат списка предстоящих матчей');
    out.push(...data.results);offset+=data.results.length;
    if(data.results.length<100||offset>=(data.total?.count??0))break;
  }
  return out.slice(0,max);
}

// BO3 shows one partner bookmaker's price. For finished matches that price is the last in-play
// quote (a /live/ link, odds like 1.01) and would leak the result, so only a pre-match /line/
// price captured before the scheduled start is kept.
export function prematchLine(m,capturedAt) {
  const b=m.bet_updates;
  if(!b||typeof b.path!=='string'||!b.path.includes('/line/')||m.status!=='upcoming')return null;
  if(!(Date.parse(capturedAt)<Date.parse(m.start_date)))return null;
  let x=b.team_1,y=b.team_2;
  if(x?.team_id===m.team2?.id&&y?.team_id===m.team1?.id)[x,y]=[y,x];
  else if(x?.team_id!==m.team1?.id||y?.team_id!==m.team2?.id)return null;
  if(!(x.active===true&&y.active===true&&num(x.coeff)>1&&num(y.coeff)>1))return null;
  return {oddsA:num(x.coeff),oddsB:num(y.coeff),capturedAt,provider:'bo3.gg',bookmaker:'bo3-line'};
}

export function normalizeUpcoming(m,capturedAt) {
  const start=iso(m.start_date);
  if(m.status!=='upcoming'||!start||!m.team1?.id||!m.team2?.id||m.team1.id===m.team2.id)return null;
  return {id:`bo3:${m.id}`,externalId:String(m.id),source:'bo3',start,bestOf:num(m.bo_type),stars:num(m.stars)??0,
    event:m.tournament?.name||'',url:m.slug?`https://bo3.gg/matches/${encodeURIComponent(m.slug)}`:null,
    teamA:{id:`bo3:${m.team1.id}`,name:m.team1.name||String(m.team1.id)},teamB:{id:`bo3:${m.team2.id}`,name:m.team2.name||String(m.team2.id)},
    line:prematchLine(m,capturedAt)};
}

// The same line as a timestamped quote: over time these build a free pre-match odds history.
export function lineQuote(m) {
  if(!m.line)return null;
  return {provider:m.line.provider,externalMatchId:m.externalId,bookmaker:m.line.bookmaker,teamA:m.teamA.name,teamB:m.teamB.name,
    startsAt:m.start,capturedAt:m.line.capturedAt,oddsA:m.line.oddsA,oddsB:m.line.oddsB,active:true,marketType:'match_winner'};
}

// Production fit: ratings run through every finished match and the regression weights are
// refit on all available labels. The honest backtest keeps its own 80/20 split elsewhere.
export function productionModel(matches) {
  const model=walkForward(matches,{split:1});
  const through=model.train.length?Math.max(...model.train.map(r=>r.available)):null;
  return {model,trainedThrough:through?new Date(through).toISOString():null,trainRows:model.train.length};
}

export function forecastUpcoming(production,upcoming,now=Date.now()) {
  const {model,trainedThrough}=production,version=`team-glicko-lr@${trainedThrough?.slice(0,10)||'none'}`;
  const known=id=>model.teams.get(id)?.played||0;
  return upcoming.filter(m=>Date.parse(m.start)>now).map(m=>{
    // Read experience before predicting: the feature builder creates empty books for new teams.
    const playedA=known(m.teamA.id),playedB=known(m.teamB.id);
    const d=predictMatchup(model,m.teamA.id,m.teamB.id,now);
    const market=m.line?marketProbabilities(m.line.oddsA,m.line.oddsB):null;
    const sides=m.line?[['A',d.p,m.line.oddsA],['B',1-d.p,m.line.oddsB]].map(([side,p,odds])=>({side,p,odds,...valueAtOdds(p,odds)})):[];
    const best=sides.length?sides.reduce((a,b)=>b.ev>a.ev?b:a):null;
    return {matchId:m.id,madeAt:new Date(now).toISOString(),model:version,trainedThrough,startsAt:m.start,
      teamAId:m.teamA.id,teamBId:m.teamB.id,teamA:m.teamA.name,teamB:m.teamB.name,event:m.event,stars:m.stars,bestOf:m.bestOf,url:m.url,
      p:d.p,glicko:d.glicko,playedA,playedB,coldStart:Math.min(playedA,playedB)<5,
      line:m.line,marketA:market?.shinA??null,margin:market?.margin??null,
      bestSide:best?{side:best.side,odds:best.odds,ev:best.ev,breakEven:best.breakEven}:null};
  });
}

// Score each match by the last forecast logged strictly before it started.
export function liveEvaluation(matches,forecasts) {
  const byId=new Map(matches.map(m=>[m.id,m])),latest=new Map();
  for(const f of forecasts){
    const m=byId.get(f.matchId);if(!m)continue;
    const cutoff=Math.min(Date.parse(m.start),Date.parse(f.startsAt));
    if(!(Date.parse(f.madeAt)<cutoff))continue;
    const prev=latest.get(f.matchId);if(!prev||prev.madeAt<f.madeAt)latest.set(f.matchId,f);
  }
  const rows=[];
  for(const f of latest.values()){
    const m=byId.get(f.matchId);
    // Orientation guard: the same BO3 match keeps its team order, but never trust it blindly.
    const same=f.teamAId===m.teamA.id&&f.teamBId===m.teamB.id,flipped=f.teamAId===m.teamB.id&&f.teamBId===m.teamA.id;
    if(!same&&!flipped)continue;
    const p=same?f.p:1-f.p,marketA=f.marketA==null?null:same?f.marketA:1-f.marketA;
    rows.push({matchId:f.matchId,madeAt:f.madeAt,start:m.start,teamA:m.teamA.name,teamB:m.teamB.name,p,marketA,y:m.winner===m.teamA.id?1:0,coldStart:f.coldStart,leadHours:(Date.parse(m.start)-Date.parse(f.madeAt))/3600000});
  }
  rows.sort((a,b)=>a.start.localeCompare(b.start));
  const withMarket=rows.filter(r=>r.marketA!=null);
  return {forecasts:forecasts.length,scored:rows.length,since:rows[0]?.start||null,
    model:probabilityMetrics(rows,rows.map(r=>r.p)),
    coin:rows.length?{count:rows.length,logLoss:Math.log(2),brier:.25,accuracy:.5}:null,
    experienced:probabilityMetrics(rows.filter(r=>!r.coldStart),rows.filter(r=>!r.coldStart).map(r=>r.p)),
    vsMarket:withMarket.length?{count:withMarket.length,model:probabilityMetrics(withMarket,withMarket.map(r=>r.p)),market:probabilityMetrics(withMarket,withMarket.map(r=>r.marketA))}:null,
    medianLeadHours:rows.length?[...rows.map(r=>r.leadHours)].sort((a,b)=>a-b)[Math.floor(rows.length/2)]:null,
    recent:rows.slice(-30).reverse()};
}


// What the page shows: the latest logged forecast for each match still ahead.
export function upcomingBoard(upcoming,forecasts,now=Date.now(),{hours=72,max=150}={}) {
  const latest=new Map();
  for(const f of forecasts){const prev=latest.get(f.matchId);if(!prev||prev.madeAt<f.madeAt)latest.set(f.matchId,f);}
  return upcoming.filter(m=>Date.parse(m.start)>now&&Date.parse(m.start)<=now+hours*3600000)
    .map(m=>latest.get(m.id)).filter(Boolean)
    .sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||(b.stars||0)-(a.stars||0))
    .slice(0,max);
}
