const valid=x=>typeof x==='number'&&Number.isFinite(x);
// a/b split the margin proportionally. shinA/shinB use Shin's method, which for a two-way
// market reduces to removing an equal share of the margin from each side (the additive
// method) and corrects the favourite-longshot bias (Štrumbelj 2014, IJF 30(4)).
export function marketProbabilities(a,b){
  if(!valid(a)||!valid(b)||a<=1||b<=1)throw new Error('Десятичные коэффициенты должны быть >1');
  const rawA=1/a,rawB=1/b,overround=rawA+rawB,margin=overround-1;
  const shinA=Math.min(1-1e-6,Math.max(1e-6,rawA-margin/2));
  return {rawA,rawB,overround,margin,a:rawA/overround,b:rawB/overround,shinA,shinB:1-shinA};
}
export function valueAtOdds(p,odds,commission=0,fee=0){
  if(!valid(p)||p<0||p>1||!valid(odds)||odds<=1||!valid(commission)||commission<0||commission>=1||!valid(fee)||fee<0||fee>=1)throw new Error('Некорректные вероятность, коэффициент или комиссия');
  const profit=(odds-1)*(1-commission),ev=p*profit-(1-p)-fee;
  return {ev,breakEven:(1+fee)/(1+profit),netWin:profit-fee,netLoss:1+fee,kelly:profit>fee&&ev>0?ev/((profit-fee)*(1+fee)):0};
}
export function selectQuote(quotes,time,{closing=false,maxAgeMs=3600000}={}){
  const t=Date.parse(time);if(!Number.isFinite(t))throw new Error('Некорректное время решения');
  const eligible=quotes.filter(q=>Date.parse(q.capturedAt)<=t).sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt));
  const q=closing?eligible.find(q=>q.active):eligible[0];
  if(!q||!q.active||t-Date.parse(q.capturedAt)>maxAgeMs)return null;
  return q;
}
export function assertDecision(row){
  if(!(Date.parse(row.capturedAt)<=Date.parse(row.decisionAt)&&Date.parse(row.predictedAt)<=Date.parse(row.decisionAt)&&Date.parse(row.trainedThrough)<Date.parse(row.predictedAt)&&Date.parse(row.decisionAt)<Date.parse(row.startsAt)&&Date.parse(row.settledAt)>Date.parse(row.decisionAt)))throw new Error('Утечка будущего: время котировки, прогноза, обучения или результата не соответствует решению');
}

// Rows with a model/market gap this wide usually mean the model is missing information.
export const FLAG_EV=.15;

// Kelly sizing for the bets on screen. f* = (q·p − 1)/(p − 1) comes from valueAtOdds, the same
// function the backtest uses. Kelly assumes one bet at a time; these matches are simultaneous,
// so a per-bet cap and a cap on the total at risk are applied on top of the fractional stake.
// The browser receives these defaults from settings.js through the data snapshot.
export function kellyPlan(rows,{bank=2000,k=.25,cap=.05,totalCap=.3,skipFlagged=true,flagEv=FLAG_EV}={}){
  if(!(bank>0)||!(k>0&&k<=1)||!(cap>0&&cap<=1)||!(totalCap>0&&totalCap<=1))throw new Error('Банк > 0, доля Келли и лимиты — от 0 до 100%');
  const items=rows.map(f=>{
    const b=f.bestSide;
    if(!b)return {f,status:'no-line',full:0,fraction:0,stake:0};
    // No commission on this line: the margin is already inside the odds, as the formula assumes.
    const q=b.side==='A'?f.p:1-f.p,full=valueAtOdds(q,b.odds).kelly;
    if(!(full>0))return {f,status:'no-edge',full:0,fraction:0,stake:0};
    if(skipFlagged&&b.ev>flagEv)return {f,status:'flagged',full,fraction:0,stake:0};
    return {f,status:'bet',full,fraction:Math.min(cap,k*full),stake:0};
  });
  const wanted=items.reduce((s,x)=>s+x.fraction,0),scale=wanted>totalCap?totalCap/wanted:1;
  for(const x of items)if(x.status==='bet'){
    // The epsilon keeps 0.035 × 2000 at 70 rather than 69.999… rounded down to 69.
    x.fraction*=scale;x.stake=Math.floor(x.fraction*bank+1e-9);
    if(x.stake<1){x.status='tiny';x.stake=0;}
  }
  const bets=items.filter(x=>x.status==='bet'),total=bets.reduce((s,x)=>s+x.stake,0);
  return {items,bets:bets.length,total,exposure:total/bank,scale,wanted};
}
