import { walkForward,finalTime } from '../model.js';
import { probabilityMetrics,fitRapm } from '../rapm.js';
import { internalQuote } from './matcher.js';
import { selectQuote,marketProbabilities,assertDecision,valueAtOdds } from './market.js';
import { simulate,STRATEGIES,STAKING,blockInterval } from './simulate.js';
import { consensusBacktest } from './consensus.js';
import { SETTINGS } from '../settings.js';

const logit=p=>Math.log(Math.max(1e-6,p)/Math.max(1e-6,1-p));
const avg=x=>x.length?x.reduce((s,v)=>s+v,0)/x.length:null;
export function calibration(rows,key){return Array.from({length:10},(_,i)=>{const group=rows.filter(r=>Math.min(9,Math.floor(r[key]*10))===i);return {from:i/10,to:(i+1)/10,count:group.length,predicted:avg(group.map(r=>r[key])),actual:avg(group.map(r=>r.y))};}).filter(b=>b.count);}
function comparison(rows){return {model:probabilityMetrics(rows,rows.map(r=>r.p)),market:probabilityMetrics(rows,rows.map(r=>r.marketA)),marketShin:probabilityMetrics(rows,rows.map(r=>r.shinA)),deltaBrier:avg(rows.map(r=>(r.p-r.y)**2-(r.marketA-r.y)**2)),deltaBrier95:blockInterval(rows,r=>(r.p-r.y)**2-(r.marketA-r.y)**2),calibration:{model:calibration(rows,'p'),market:calibration(rows,'marketA')}};}
export function marketBlend(rows){
  const sorted=[...rows].sort((a,b)=>Date.parse(a.decisionAt)-Date.parse(b.decisionAt)),boundary=sorted[Math.floor(sorted.length*.5)]?.decisionAt;
  const train=sorted.filter(r=>r.decisionAt<boundary&&r.settledAt<boundary),test=sorted.filter(r=>r.decisionAt>=boundary);
  if(train.length<30||test.length<30||new Set(train.map(r=>r.y)).size<2)return {status:'insufficient_data',train:train.length,test:test.length};
  const input=r=>({a:[],b:[],context:{intercept:1,market:logit(r.marketA),model:logit(r.p)},y:r.y});
  const fit=fitRapm(train.map(input),5),evaluated=test.map(r=>({...r,blend:fit.predict(input(r))}));
  if(!fit.converged)return {status:'not_converged'};
  return {status:'evaluated',train:train.length,test:test.length,testFrom:boundary,weights:fit.coefficients,...comparison(evaluated),blend:probabilityMetrics(evaluated,evaluated.map(r=>r.blend)),blendCalibration:calibration(evaluated,'blend'),blendDeltaBrier:avg(evaluated.map(r=>(r.blend-r.y)**2-(r.marketA-r.y)**2)),blendDeltaBrier95:blockInterval(evaluated,r=>(r.blend-r.y)**2-(r.marketA-r.y)**2)};
}
export function joinPredictions(predictions,matches,quotes,{maxAgeMs=3600000}={}){
  const byMatch=new Map(matches.map(m=>[m.id,m])),group=new Map();
  for(const q of quotes){if(q.matchStatus!=='matched'||q.marketType!=='match_winner')continue;const key=JSON.stringify([q.provider,q.bookmaker,q.matchId]);if(!group.has(key))group.set(key,[]);group.get(key).push(internalQuote(q));}
  const byPrediction=new Map(predictions.map(p=>[p.matchId,p])),rows=[],excluded={noOosPrediction:0,noTradableQuote:0,duplicateProviderEvent:0};
  for(const qs of group.values()){
    if(new Set(qs.map(q=>q.externalMatchId)).size!==1){excluded.duplicateProviderEvent++;continue;}
    const prediction=byPrediction.get(qs[0].matchId),m=byMatch.get(qs[0].matchId);if(!prediction||!m){excluded.noOosPrediction++;continue;}
    // Either source may carry a scheduled rather than actual start: stop at the earlier one.
    const cutoff=Math.min(Date.parse(m.start),...qs.map(q=>Date.parse(q.startsAt)));
    if(Date.parse(prediction.predictedAt)>=cutoff){excluded.noTradableQuote++;continue;}
    const prematch=qs.filter(q=>Date.parse(q.capturedAt)<cutoff);
    const q=selectQuote(prematch,prediction.predictedAt,{maxAgeMs});if(!q){excluded.noTradableQuote++;continue;}
    const close=selectQuote(prematch,new Date(cutoff-1).toISOString(),{maxAgeMs,closing:true});
    const probability=marketProbabilities(q.oddsA,q.oddsB);
    const row={...prediction,provider:q.provider,bookmaker:q.bookmaker,startsAt:m.start,settledAt:finalTime(m),decisionAt:prediction.predictedAt,capturedAt:q.capturedAt,oddsA:q.oddsA,oddsB:q.oddsB,marketA:probability.a,shinA:probability.shinA,rawA:probability.rawA,rawB:probability.rawB,overround:probability.overround,edge:prediction.p-probability.a,closingA:close?.oddsA||null,closingB:close?.oddsB||null,closingCapturedAt:close?.capturedAt||null,teamA:m.teamA.name,teamB:m.teamB.name};
    assertDecision(row);rows.push(row);
  }
  return {rows:rows.sort((a,b)=>Date.parse(a.decisionAt)-Date.parse(b.decisionAt)||a.matchId.localeCompare(b.matchId)),excluded};
}
export function bettingReport(matches,quotes,{commission=0,fee=0,leadMinutes=SETTINGS.betting.leadMinutes,maxAgeMinutes=SETTINGS.betting.maxQuoteAgeMinutes,includeTrades=false}={}){
  valueAtOdds(.5,2,commission,fee);
  if(!Number.isFinite(leadMinutes)||leadMinutes<0||leadMinutes>1440||!Number.isFinite(maxAgeMinutes)||maxAgeMinutes<=0)throw new Error('Некорректное время прогноза/свежести котировок');
  const events=new Map(quotes.map(q=>[JSON.stringify([q.provider,q.externalMatchId]),q]));
  const config={initialBankroll:2000,commission,fee,leadMinutes,maxAgeMinutes,maxKellyFraction:.05,strategies:STRATEGIES,staking:STAKING};
  const coverage={quotes:quotes.length,events:events.size,matchedEvents:[...events.values()].filter(q=>q.matchStatus==='matched').length,ambiguous:[...events.values()].filter(q=>q.matchStatus==='ambiguous').length,unmatched:[...events.values()].filter(q=>q.matchStatus==='unmatched').length};
  const consensus=consensusBacktest(matches,quotes,{commission,fee,leadMinutes,maxAgeMinutes});if(!includeTrades)delete consensus.trades;
  if(!quotes.length)return {status:'needs_odds',coverage,config,books:[],consensus,matchedOos:0,note:'Исторические котировки не загружены. ROI, банк и CLV не рассчитаны. Нужен бесплатный ключ OddsPapi или JSON-архив с timestamps.'};
  const wf=walkForward(matches,{forecastLeadMs:leadMinutes*60000}),through=wf.train.length?new Date(Math.max(...wf.train.map(r=>r.available))).toISOString():null;
  if(!through)return {status:'needs_predictions',coverage,config,books:[],consensus,matchedOos:0};
  const predictions=wf.test.map(r=>({matchId:r.id,p:r.probs.logistic,y:r.y,predictedAt:r.predictedAt,trainedThrough:through}));
  const {rows,excluded}=joinPredictions(predictions,matches,quotes,{maxAgeMs:maxAgeMinutes*60000});
  const books=new Map();for(const r of rows){const key=r.provider+'/'+r.bookmaker;if(!books.has(key))books.set(key,[]);books.get(key).push(r);}
  return {status:rows.length?'evaluated':'no_matched_oos',coverage,config,consensus,excluded,oosMatches:predictions.length,matchedOos:new Set(rows.map(r=>r.matchId)).size,oosMatchRate:predictions.length?new Set(rows.map(r=>r.matchId)).size/predictions.length:null,books:[...books].map(([book,rs])=>({book,matches:rs.length,comparison:comparison(rs),combined:marketBlend(rs),strategies:STRATEGIES.flatMap(strategy=>STAKING.map(method=>{const result=simulate(rs,strategy,{method,commission,fee});if(!includeTrades)delete result.trades;return result;}))})),...(includeTrades?{predictions,comparisons:rows}:{}),
    note:'Решение за фиксированное число минут до начала. Только доступные активные пары котировок; closing используется лишь после решения для CLV. Каждый букмекер оценивается отдельно, лучшая цена задним числом не выбирается. Банк резервирует средства до завершения матча. Комиссия на выигрыш применяется к отдельной позиции: не моделирует неттинг биржи. Пороговые стратегии заданы заранее; сравнение многих стратегий не подтверждает прибыльность.'};
}
