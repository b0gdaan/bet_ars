// Market-only benchmark from Kaunitz, Zhong & Kreiner (2017), "Beating the bookies with
// their own numbers", arXiv:1710.02824. No model of the game: the consensus of several
// bookmakers is the fair price, and a bet is placed where one book pays clearly more.
//   p_cons = 1 / mean(odds across bookmakers)                 (their Eq. 1)
//   bet the outcome if max(odds) > 1 / (p_cons - alpha)       (their Eq. 7, alpha = 0.05)
// Over ten years of football closing odds this returned +3.5% on 56,435 flat bets, against
// -3.3% for random bets at the same prices; bookmakers then limited the authors' accounts.
// alpha is the paper's value and is deliberately not tuned on our data.
import { finalTime } from '../model.js';
import { internalQuote } from './matcher.js';
import { selectQuote,marketProbabilities } from './market.js';
import { blockInterval } from './simulate.js';
import { SETTINGS } from '../settings.js';

const avg=x=>x.length?x.reduce((s,v)=>s+v,0)/x.length:null;

// quotes: one tradable quote per bookmaker, already oriented to the match sides.
export function consensusSignal(quotes,{alpha=SETTINGS.betting.consensusAlpha,minBooks=2}={}) {
  if(!(alpha>=0&&alpha<0.5))throw new Error('alpha должна быть в [0; 0.5)');
  if(quotes.length<minBooks)return null;
  return ['A','B'].map(side=>{
    const odds=quotes.map(q=>side==='A'?q.oddsA:q.oddsB);
    const pCons=1/avg(odds),best=quotes[odds.indexOf(Math.max(...odds))];
    const maxOdds=Math.max(...odds),fair=pCons-alpha>0?1/(pCons-alpha):Infinity;
    return {side,pCons,maxOdds,book:best.bookmaker,threshold:fair,bet:maxOdds>fair,books:quotes.length};
  });
}

export function consensusBacktest(matches,quotes,{alpha=SETTINGS.betting.consensusAlpha,minBooks=2,leadMinutes=SETTINGS.betting.leadMinutes,maxAgeMinutes=SETTINGS.betting.maxQuoteAgeMinutes,commission=0,fee=0,stake=100}={}) {
  const byMatch=new Map(matches.map(m=>[m.id,m])),grouped=new Map();
  for(const q of quotes){
    if(q.matchStatus!=='matched'||q.marketType!=='match_winner')continue;
    if(!grouped.has(q.matchId))grouped.set(q.matchId,new Map());
    const books=grouped.get(q.matchId);
    if(!books.has(q.bookmaker))books.set(q.bookmaker,[]);
    books.get(q.bookmaker).push(internalQuote(q));
  }
  const bets=[],skipped={fewBooks:0,noMatch:0};let evaluated=0;
  for(const [matchId,books] of grouped){
    const m=byMatch.get(matchId);if(!m){skipped.noMatch++;continue;}
    // Either source may carry a scheduled rather than actual start: stop at the earlier one.
    const cutoff=Math.min(Date.parse(m.start),...[...books.values()].flat().map(q=>Date.parse(q.startsAt)));
    const decisionAt=new Date(cutoff-leadMinutes*60000).toISOString();
    const tradable=[...books.values()].map(qs=>selectQuote(qs.filter(q=>Date.parse(q.capturedAt)<cutoff),decisionAt,{maxAgeMs:maxAgeMinutes*60000})).filter(Boolean);
    const signal=consensusSignal(tradable,{alpha,minBooks});
    if(!signal){skipped.fewBooks++;continue;}
    evaluated++;
    const y=m.winner===m.teamA.id?1:0,settledAt=finalTime(m);
    for(const s of signal){
      if(!s.bet)continue;
      // The closing price of the same book, used only to measure CLV after the decision.
      const own=books.get(s.book).filter(q=>Date.parse(q.capturedAt)<cutoff);
      const close=selectQuote(own,new Date(cutoff-1).toISOString(),{maxAgeMs:maxAgeMinutes*60000,closing:true});
      const closeOdds=close?(s.side==='A'?close.oddsA:close.oddsB):null;
      const won=s.side==='A'?y===1:y===0;
      const profit=won?stake*(s.maxOdds-1)*(1-commission)-stake*fee:-stake*(1+fee);
      const book=tradable.find(q=>q.bookmaker===s.book);
      bets.push({matchId,teamA:m.teamA.name,teamB:m.teamB.name,decisionAt,capturedAt:book.capturedAt,startsAt:m.start,settledAt,side:s.side,book:s.book,books:s.books,
        pCons:s.pCons,odds:s.maxOdds,threshold:s.threshold,shin:marketProbabilities(book.oddsA,book.oddsB)[s.side==='A'?'shinA':'shinB'],
        closing:closeOdds,clv:closeOdds?s.maxOdds/closeOdds-1:null,won,stake,profit});
    }
  }
  bets.sort((a,b)=>Date.parse(a.decisionAt)-Date.parse(b.decisionAt)||a.matchId.localeCompare(b.matchId));
  for(const b of bets)if(!(Date.parse(b.capturedAt)<=Date.parse(b.decisionAt)&&Date.parse(b.decisionAt)<Date.parse(b.startsAt)))throw new Error('Утечка будущего в консенсус-стратегии');
  // ROI over the stake itself, as in the bankroll simulation; the fee is already inside profit.
  const staked=bets.reduce((s,b)=>s+b.stake,0),profit=bets.reduce((s,b)=>s+b.profit,0),clvs=bets.map(b=>b.clv).filter(x=>x!==null);
  const status=!grouped.size?'needs_odds':evaluated?'evaluated':'needs_more_books';
  return {status,alpha,minBooks,leadMinutes,matchesWithQuotes:grouped.size,evaluated,skipped,bets:bets.length,wins:bets.filter(b=>b.won).length,
    hitRate:avg(bets.map(b=>Number(b.won))),expectedHitRate:avg(bets.map(b=>b.pCons)),staked,profit,roi:staked?profit/staked:null,
    roi95:blockInterval(bets,b=>b.profit,b=>b.stake),averageOdds:avg(bets.map(b=>b.odds)),averageCLV:avg(clvs),positiveCLV:avg(clvs.map(x=>Number(x>0))),clvCount:clvs.length,
    trades:bets,
    note:'Консенсус нескольких букмекеров на момент решения — справедливая цена; ставка там, где одна контора платит заметно больше. Модель матча не используется. alpha = 0,05 взята из статьи и на наших данных не подбиралась. Каждая ставка — фиксированные 100 ₽ по максимальному доступному коэффициенту; closing той же конторы используется только для CLV.'};
}
