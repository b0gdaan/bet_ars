import { setTimeout as sleep } from 'node:timers/promises';
import { matchFixture } from './matcher.js';
import { normalizeOdds } from './normalize.js';

export function resolveMatchMarket(markets){
  const found=markets.filter(m=>Number(m.sportId)===17&&m.playerProp===false&&Number(m.marketLength)===2&&m.marketName?.trim().toLowerCase()==='winner');
  if(found.length!==1)throw new Error('Нужно однозначно подтвердить CS2 Winner в каталоге рынков OddsPapi');
  const m=found[0],a=m.outcomes.find(o=>o.outcomeName==='1'),b=m.outcomes.find(o=>o.outcomeName==='2');
  if(!a||!b)throw new Error('Неизвестное соответствие outcomes 1/2 сторонам; импорт остановлен');
  return {marketId:String(m.marketId),outcomeA:String(a.outcomeId),outcomeB:String(b.outcomeId)};
}
export function normalizeHistory(fixture,history,market){
  if(history.fixtureId!==fixture.fixtureId)throw new Error('История коэффициентов другого fixtureId');
  const rows=[];
  for(const [bookmaker,board]of Object.entries(history.bookmakers||{})){
    const outcomes=board.markets?.[market.marketId]?.outcomes;if(!outcomes)continue;
    const a=outcomes[market.outcomeA]?.players?.['0'],b=outcomes[market.outcomeB]?.players?.['0'];if(!Array.isArray(a)||!Array.isArray(b))continue;
    const timeline=new Map();for(const [side,entries]of [['A',a],['B',b]])for(const entry of entries){if(!Number.isFinite(Date.parse(entry.createdAt))||typeof entry.active!=='boolean')throw new Error('Некорректная временная метка или active в OddsPapi');const t=new Date(entry.createdAt).toISOString();if(!timeline.has(t))timeline.set(t,[]);timeline.get(t).push({side,...entry});}
    const state={};for(const [time,updates]of [...timeline].sort(([a],[b])=>a.localeCompare(b))){const seen=new Map();for(const e of updates){
      if(seen.has(e.side)&&JSON.stringify(seen.get(e.side))!==JSON.stringify(e))throw new Error('Противоречивые котировки одного outcome в один момент');
      seen.set(e.side,e);
      if(e.active&&!(typeof e.price==='number'&&Number.isFinite(e.price)&&e.price>1))throw new Error('Некорректная активная цена OddsPapi');
      state[e.side]={...e,price:e.price>1?e.price:state[e.side]?.price};
    }
      if(!(state.A?.price>1&&state.B?.price>1))continue;
      rows.push({provider:'oddspapi',externalMatchId:fixture.fixtureId,bookmaker,teamA:fixture.participant1Name,teamB:fixture.participant2Name,startsAt:fixture.trueStartTime||fixture.startTime,capturedAt:time,oddsA:state.A.price,oddsB:state.B.price,active:state.A.active&&state.B.active,marketType:'match_winner',providerMarketId:market.marketId,event:fixture.tournamentName||'',observation:'provider-change-history'});
    }
  }
  return normalizeOdds(rows);
}
export class OddsPapiProvider {
  constructor(store,{key=process.env.ODDSPAPI_API_KEY,fetcher=fetch,pause=sleep,maxRequests=10}={}){Object.assign(this,{store,key,fetcher,pause,maxRequests});this.requests=0;this.last=0;}
  async get(path,params={}){
    if(!this.key)throw new Error('Добавьте бесплатный ODDSPAPI_API_KEY в локальный .env. Без ключа реальные котировки не загружаются.');
    const safe=new URL('https://api.oddspapi.io/v4/'+path);for(const [k,v]of Object.entries(params))safe.searchParams.set(k,String(v));
    const saved=this.store.cached(safe.href,30*86400000);if(saved)return JSON.parse(saved);
    const request=new URL(safe);request.searchParams.set('apiKey',this.key);
    for(let attempt=0;attempt<3;attempt++){
      if(this.requests>=this.maxRequests)throw new Error('Достигнут заданный лимит бесплатных API-запросов; загруженное сохранено');
      await this.pause(Math.max(0,5100-(Date.now()-this.last)));this.last=Date.now();this.requests++;
      let r;try{r=await this.fetcher(request,{redirect:'error',signal:AbortSignal.timeout(45000)});}catch{throw new Error('Не удалось подключиться к OddsPapi; ключ и URL запроса не записаны в ошибку');}
      if(r.status===429){await this.pause(10000);continue;}
      if(!r.ok)throw new Error(`OddsPapi ${path}: HTTP ${r.status}. Платное подключение автоматически не выполняется.`);
      const body=await r.text(),parsed=JSON.parse(body);this.store.cache(safe.href,body);return parsed;
    }throw new Error('OddsPapi: rate limit, повторите позже');
  }
  async collect({from,to,bookmaker='pinnacle',limit=5},onRows){
    const start=Date.parse(from),end=Date.parse(to);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>=10*86400000||start<Date.parse('2026-01-01')||!Number.isInteger(limit)||limit<1||limit>100||!/^[-a-z0-9]+$/.test(bookmaker))throw new Error('Нужен период от 2026 года короче 10 дней, limit 1–100 и один bookmaker slug');
    const market=resolveMatchMarket(await this.get('markets',{language:'en'}));
    const fixtures=await this.get('fixtures',{sportId:17,from:new Date(start).toISOString(),to:new Date(end).toISOString(),statusId:2});
    if(!Array.isArray(fixtures))throw new Error('Неожиданный формат списка fixtures');
    const matches=this.store.all('bo3');let events=0,quotes=0;const skipped=[];
    for(const f of fixtures){if(events>=limit)break;const link=matchFixture({teamA:f.participant1Name,teamB:f.participant2Name,startsAt:f.trueStartTime||f.startTime},matches);
      if(link.status!=='matched'){skipped.push({id:f.fixtureId,status:link.status});continue;}
      const history=await this.get('historical-odds',{fixtureId:f.fixtureId,bookmakers:bookmaker});const rows=normalizeHistory(f,history,market);await onRows(rows);events++;quotes+=rows.length;
    }return {provider:'oddspapi',events,quotes,requests:this.requests,skipped};
  }
}
