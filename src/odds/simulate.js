import { valueAtOdds,assertDecision } from './market.js';
const mean=x=>x.length?x.reduce((s,v)=>s+v,0)/x.length:null;
const median=x=>{if(!x.length)return null;const a=[...x].sort((a,b)=>a-b),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
export const STRATEGIES=[{id:'favorite',label:'Фаворит модели',threshold:null},...[0,.02,.05,.075,.10].map(x=>({id:'ev'+x,label:`EV > ${x*100}%`,threshold:x}))];
export const STAKING=['flat100','percent1','percent2','kelly25','kelly50'];
export function chooseSide(r,strategy,commission=0,fee=0){
  assertDecision(r);
  const a={side:'A',p:r.p,market:r.marketA,odds:r.oddsA,closing:r.closingA,...valueAtOdds(r.p,r.oddsA,commission,fee)};
  const b={side:'B',p:1-r.p,market:1-r.marketA,odds:r.oddsB,closing:r.closingB,...valueAtOdds(1-r.p,r.oddsB,commission,fee)};
  if(strategy.id==='favorite')return r.p===.5?null:r.p>.5?a:b;
  if(Math.abs(a.ev-b.ev)<1e-12)return null;
  const best=a.ev>b.ev?a:b;return best.ev>strategy.threshold?best:null;
}
export function stakeSize(method,equity,bet,{maxStakeFraction=.05}={}){
  if(!STAKING.includes(method))throw new Error('Неизвестный способ размера ставки');
  const raw=method==='flat100'?100:method==='percent1'?equity*.01:method==='percent2'?equity*.02:equity*Math.min(maxStakeFraction,bet.kelly*(method==='kelly25'?.25:.5));
  return Math.max(0,Math.floor((raw+1e-10)*100)/100);
}
export function blockInterval(items,numerator,denominator=()=>1){
  // Resample whole seven-day blocks to preserve some dependence between nearby bets.
  const groups=new Map();for(const r of items){const week=Math.floor(Date.parse(r.decisionAt)/(7*86400000));if(!groups.has(week))groups.set(week,[]);groups.get(week).push(r);}
  const blocks=[...groups.values()];if(blocks.length<8)return null;
  let seed=99281;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296),values=[];
  for(let k=0;k<400;k++){let sum=0,den=0;for(let i=0;i<blocks.length;i++)for(const r of blocks[Math.floor(random()*blocks.length)]){sum+=numerator(r);den+=denominator(r);}if(den)values.push(sum/den);}
  values.sort((a,b)=>a-b);return {low:values[Math.floor(values.length*.025)],high:values[Math.floor(values.length*.975)],blocks:blocks.length,unit:'seven-day-block',replicates:400};
}
export function simulate(rows,strategy,{method='flat100',initialBankroll=2000,commission=0,fee=0,maxStakeFraction=.05}={}){
  if(!(initialBankroll>0)||!(maxStakeFraction>0&&maxStakeFraction<=1))throw new Error('Некорректный банк или лимит ставки');
  let cash=initialBankroll,peak=initialBankroll,min=initialBankroll,maxDD=0,maxDDPct=0,liquiditySkips=0,bankrupt=false,bankruptcy=null,winRun=0,lossRun=0,longestWin=0,longestLoss=0;
  const pending=[],bets=[],curve=[];
  const equity=()=>cash+pending.reduce((s,b)=>s+b.stake,0);
  const mark=(time,event,matchId)=>{const bank=equity();peak=Math.max(peak,bank);min=Math.min(min,bank);maxDD=Math.max(maxDD,peak-bank);maxDDPct=Math.max(maxDDPct,(peak-bank)/peak);curve.push({time,event,matchId,bankroll:bank,cash,exposure:bank-cash,drawdown:peak-bank,drawdownPct:(peak-bank)/peak});};
  if(rows.length)mark(rows.reduce((a,r)=>a<r.decisionAt?a:r.decisionAt,rows[0].decisionAt),'initial',null);
  const settle=before=>{pending.sort((a,b)=>Date.parse(a.settledAt)-Date.parse(b.settledAt)||a.matchId.localeCompare(b.matchId));while(pending.length&&Date.parse(pending[0].settledAt)<before){const b=pending.shift();const win=b.side==='A'?b.y===1:b.y===0;
    const payout=win?b.stake*(1+(b.odds-1)*(1-commission)):0;cash+=payout;b.won=win;b.grossReturn=win?b.stake*b.odds:0;b.netReturn=payout;b.profit=payout-b.stake*(1+fee);bets.push(b);
    if(win){winRun++;lossRun=0;}else{lossRun++;winRun=0;}longestWin=Math.max(longestWin,winRun);longestLoss=Math.max(longestLoss,lossRun);mark(b.settledAt,'settled',b.matchId);
  }};
  for(const r of [...rows].sort((a,b)=>Date.parse(a.decisionAt)-Date.parse(b.decisionAt)||a.matchId.localeCompare(b.matchId))){
    assertDecision(r);settle(Date.parse(r.decisionAt));if(bankrupt)continue;
    const bet=chooseSide(r,strategy,commission,fee);if(!bet)continue;
    let stake=stakeSize(method,equity(),bet,{maxStakeFraction});if(stake<=0)continue;
    if(stake*(1+fee)>cash+1e-9){if(method==='flat100'){
      if(!pending.length){bankrupt=true;bankruptcy={matchId:r.matchId,date:r.decisionAt,reason:'Недостаточно средств для обязательных 100 ₽ и комиссии'};}else liquiditySkips++;continue;
    }stake=Math.floor(cash/(1+fee)*100)/100;}
    if(stake<=0){liquiditySkips++;continue;}cash=Math.max(0,cash-stake*(1+fee));
    pending.push({...r,...bet,stake,clv:bet.closing?bet.odds/bet.closing-1:null});mark(r.decisionAt,'opened',r.matchId);
  }
  settle(Infinity);
  if(method==='flat100'&&cash+1e-9<100*(1+fee)&&!bankrupt){bankrupt=true;bankruptcy={date:bets.at(-1)?.settledAt||null,reason:'После расчёта не хватает средств для следующей ставки 100 ₽ и комиссии'};}
  const totalStaked=bets.reduce((s,b)=>s+b.stake,0),netProfit=cash-initialBankroll,clvs=bets.map(b=>b.clv).filter(x=>x!==null),months=new Map();
  for(const b of bets){const month=b.decisionAt.slice(0,7);if(!months.has(month))months.set(month,[]);months.get(month).push(b);}
  return {strategy:strategy.id,label:strategy.label,method,initialBankroll,finalBankroll:cash,bets:bets.length,wins:bets.filter(b=>b.won).length,losses:bets.filter(b=>!b.won).length,winRate:mean(bets.map(b=>Number(b.won))),totalStaked,grossReturn:bets.reduce((s,b)=>s+b.grossReturn,0),netProfit,roi:totalStaked?netProfit/totalStaked:null,roi95:blockInterval(bets,b=>b.profit,b=>b.stake),maxBankroll:peak,minBankroll:min,maxDrawdown:maxDD,maxDrawdownPct:maxDDPct,longestWinningStreak:longestWin,longestLosingStreak:longestLoss,bankrupt,bankruptcy,liquiditySkips,averageOdds:mean(bets.map(b=>b.odds)),medianOdds:median(bets.map(b=>b.odds)),averageModelProbability:mean(bets.map(b=>b.p)),averageMarketProbability:mean(bets.map(b=>b.market)),averageEV:mean(bets.map(b=>b.ev)),averageCLV:mean(clvs),medianCLV:median(clvs),positiveCLV:mean(clvs.map(x=>Number(x>0))),clvCount:clvs.length,periods:[...months].map(([period,bs])=>({period,bets:bs.length,roi:bs.reduce((s,b)=>s+b.profit,0)/bs.reduce((s,b)=>s+b.stake,0),winRate:mean(bs.map(b=>Number(b.won))),clv:mean(bs.map(b=>b.clv).filter(x=>x!==null))})),curve,trades:bets};
}
