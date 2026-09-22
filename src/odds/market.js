const valid=x=>typeof x==='number'&&Number.isFinite(x);
export function marketProbabilities(a,b){
  if(!valid(a)||!valid(b)||a<=1||b<=1)throw new Error('Десятичные коэффициенты должны быть >1');
  const rawA=1/a,rawB=1/b,overround=rawA+rawB;
  return {rawA,rawB,overround,margin:overround-1,a:rawA/overround,b:rawB/overround};
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
