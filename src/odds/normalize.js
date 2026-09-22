import { marketProbabilities } from './market.js';
const timestamp=x=>typeof x==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
export function normalizeOdds(rows){
  if(!Array.isArray(rows))throw new Error('Ожидается JSON-массив котировок');
  return rows.map((r,i)=>{
    if(!r||['provider','externalMatchId','bookmaker','teamA','teamB'].some(k=>typeof r[k]!=='string'||!r[k].trim()))throw new Error(`Котировка ${i}: нужны provider, externalMatchId, bookmaker, teamA, teamB`);
    if(r.marketType!=='match_winner')throw new Error('Бэктест котировок поддерживает только match_winner; рынок карты нельзя смешивать с серией');
    if(!timestamp(r.capturedAt)||!timestamp(r.startsAt))throw new Error('Нужны ISO timestamps capturedAt/startsAt с часовым поясом');
    if(typeof r.active!=='boolean')throw new Error('Нужен active: true/false, чтобы учитывать снятые котировки');
    return {...r,capturedAt:new Date(r.capturedAt).toISOString(),startsAt:new Date(r.startsAt).toISOString(),teamA:r.teamA.trim(),teamB:r.teamB.trim(),market:marketProbabilities(r.oddsA,r.oddsB)};
  });
}
