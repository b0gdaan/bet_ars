// Rating engines and a logistic blend for pre-match prediction.
// Every number that enters a prediction is known strictly before that match starts:
// a result reaches the engines only after its own end time (see the pending queue).
// A side is a list of ids: one team id for professional matches, five player ids for
// a FACEIT lineup, where identity travels with the players and not with the name.
const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
export const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const DAY=86400_000;
const SCALE=173.7178;
const logit=p=>{const q=clamp(p,1e-6,1-1e-6);return Math.log(q/(1-q));};
const pairKey=(a,b)=>a<b?`${a}|${b}`:`${b}|${a}`;
export const finalTime=m=>m.end&&Date.parse(m.end)>=Date.parse(m.start)?m.end:new Date(Date.parse(m.start)+DAY).toISOString();

// Naive baseline from Bober-Irizar et al. (arXiv:2410.02831): E = (1 + w(A) - w(B)) / 2.
export class WinRate {
  constructor(){this.s=new Map();}
  at(id){if(!this.s.has(id))this.s.set(id,{played:0,wins:0});return this.s.get(id);}
  rate(ids){return mean(ids.map(id=>{const x=this.at(id);return x.played?x.wins/x.played:0.5;}))??0.5;}
  p(a,b){return clamp((1+this.rate(a)-this.rate(b))/2,0.02,0.98);}
  update(a,b,y){for(const [ids,result] of [[a,y],[b,1-y]])for(const id of ids){const x=this.at(id);x.played++;x.wins+=result;}}
}

// Elo. halfLife>0 regresses an idle side toward the mean; mov scales K by series margin.
export class Elo {
  constructor({k=24,start=1500,halfLife=0,mov=false}={}){Object.assign(this,{k,start,halfLife,mov});this.s=new Map();}
  at(id,now){
    if(!this.s.has(id))this.s.set(id,{elo:this.start,played:0,last:null});
    const s=this.s.get(id);
    if(this.halfLife&&s.last&&now>s.last){s.elo=this.start+(s.elo-this.start)*Math.exp(-(now-s.last)/(this.halfLife*DAY));s.last=now;}
    return s;
  }
  rating(ids,now){return mean(ids.map(id=>this.at(id,now).elo))??this.start;}
  p(a,b,now){return 1/(1+10**((this.rating(b,now)-this.rating(a,now))/400));}
  update(a,b,y,now,m){
    const p=this.p(a,b,now);
    let k=this.k;
    if(this.mov&&Number.isFinite(m?.scoreA)&&Number.isFinite(m?.scoreB))k*=1+0.5*Math.log(1+Math.abs(m.scoreA-m.scoreB));
    const delta=k*(y-p);
    for(const [ids,sign] of [[a,1],[b,-1]])for(const id of ids){const s=this.at(id,now);s.elo+=sign*delta;s.played++;s.last=Math.max(s.last??now,now);}
  }
}

// Glicko-2 (Glickman), one match per rating period, with idle-time deviation growth.
export class Glicko2 {
  constructor({start=1500,rd=350,sigma=0.06,tau=0.5,periodDays=7,maxRd=350}={}){Object.assign(this,{start,rd,sigma,tau,periodDays,maxRd});this.s=new Map();}
  at(id,now){
    if(!this.s.has(id))this.s.set(id,{r:this.start,rd:this.rd,sigma:this.sigma,played:0,last:null});
    const s=this.s.get(id);
    if(s.last&&now>s.last){
      const periods=(now-s.last)/(this.periodDays*DAY);
      s.rd=Math.min(this.maxRd,Math.sqrt(s.rd**2+periods*(s.sigma*SCALE)**2));s.last=now;
    }
    return s;
  }
  static g(phi){return 1/Math.sqrt(1+3*phi*phi/Math.PI**2);}
  side(ids,now){
    const members=ids.map(id=>this.at(id,now));
    return {r:mean(members.map(x=>x.r))??this.start,rd:mean(members.map(x=>x.rd))??this.rd,played:members.length?Math.min(...members.map(x=>x.played)):0};
  }
  // A shaky opponent widens the combined deviation and pulls the estimate toward 0.5.
  p(a,b,now){
    const x=this.side(a,now),y=this.side(b,now);
    const phi=Math.sqrt((x.rd/SCALE)**2+(y.rd/SCALE)**2);
    return 1/(1+Math.exp(-Glicko2.g(phi)*(x.r-y.r)/SCALE));
  }
  static volatility(sigma,delta,phi,v,tau){
    const a=Math.log(sigma*sigma);
    const f=x=>{const e=Math.exp(x);return e*(delta*delta-phi*phi-v-e)/(2*(phi*phi+v+e)**2)-(x-a)/(tau*tau);};
    let A=a,B;
    if(delta*delta>phi*phi+v)B=Math.log(delta*delta-phi*phi-v);
    else{let k=1;while(f(a-k*tau)<0&&k<100)k++;B=a-k*tau;}
    let fa=f(A),fb=f(B);
    for(let i=0;i<100&&Math.abs(B-A)>1e-6;i++){
      const C=A+(A-B)*fa/(fb-fa),fc=f(C);
      if(fc*fb<=0){A=B;fa=fb;}else fa/=2;
      B=C;fb=fc;
    }
    return Math.exp(A/2);
  }
  step(s,opponent,outcome){
    const mu=(s.r-this.start)/SCALE,phi=s.rd/SCALE;
    const muJ=(opponent.r-this.start)/SCALE,phiJ=opponent.rd/SCALE;
    const g=Glicko2.g(phiJ),E=1/(1+Math.exp(-g*(mu-muJ)));
    const v=1/(g*g*E*(1-E)),delta=v*g*(outcome-E);
    const sigma=Glicko2.volatility(s.sigma,delta,phi,v,this.tau);
    const phiStar=Math.sqrt(phi*phi+sigma*sigma);
    const phiNew=1/Math.sqrt(1/(phiStar*phiStar)+1/v);
    return {r:this.start+SCALE*(mu+phiNew*phiNew*g*(outcome-E)),rd:Math.min(this.maxRd,SCALE*phiNew),sigma};
  }
  update(a,b,y,now){
    const sideA=this.side(a,now),sideB=this.side(b,now);
    for(const [ids,opponent,outcome] of [[a,sideB,y],[b,sideA,1-y]])
      // A result can be applied after the side was already read at a later time (overlapping
      // matches); keep `last` monotonic so idle-time growth is never counted twice.
      for(const id of ids){const s=this.at(id,now);Object.assign(s,this.step({...s},opponent,outcome),{played:s.played+1,last:Math.max(s.last??now,now)});}
  }
}

// Logistic regression, no intercept, trained on mirrored rows so that p(A,B) = 1 - p(B,A).
export function fitLogistic(X,y,{iterations=400,rate=0.5,l2=1e-3}={}) {
  const n=X[0]?.length||0;
  if(!X.length||!n)return {weights:[],scale:[],predict:()=>0.5,rows:0};
  const scale=Array.from({length:n},(_,j)=>{
    const col=X.map(r=>r[j]),m=mean(col);
    const sd=Math.sqrt(mean(col.map(v=>(v-m)**2))||0);
    return sd>1e-9?sd:1;
  });
  const Z=X.map(r=>r.map((v,j)=>v/scale[j]));
  const rows=[...Z,...Z.map(r=>r.map(v=>-v))],labels=[...y,...y.map(v=>1-v)];
  const w=new Array(n).fill(0);
  for(let it=0;it<iterations;it++){
    const grad=new Array(n).fill(0);
    for(let i=0;i<rows.length;i++){
      let z=0;for(let j=0;j<n;j++)z+=w[j]*rows[i][j];
      const e=1/(1+Math.exp(-z))-labels[i];
      for(let j=0;j<n;j++)grad[j]+=e*rows[i][j];
    }
    for(let j=0;j<n;j++)w[j]-=rate*(grad[j]/rows.length+l2*w[j]);
  }
  const predict=f=>{let z=0;for(let j=0;j<n;j++)z+=w[j]*(f[j]/scale[j]);return 1/(1+Math.exp(-z));};
  return {weights:w,scale,predict,rows:y.length};
}

export const FEATURES=['eloDiff','glickoLogit','winRateDiff','formDiff','h2hDiff','experienceDiff','restDiff'];
export const DEFAULTS={k:40,plus:{k:40,mov:true,halfLife:0},glicko:{tau:0.5,rd:350,periodDays:7}};

// Sides: one team id per side for pro matches, the five player ids for a FACEIT lineup.
export function sides(m) {
  if(m.kind!=='pug')return {a:[m.teamA.id],b:[m.teamB.id],eligible:true};
  const pick=id=>[...new Set(m.players.filter(p=>p.teamId===id).map(p=>p.id))];
  const a=pick(m.teamA.id),b=pick(m.teamB.id);
  return {a,b,eligible:a.length===5&&b.length===5};
}

// Pre-match feature row for an arbitrary pair, from state known at `now`.
export function featureRow(ctx,A,B,idsA,idsB,now) {
  const {engines,book,h2h}=ctx;
  const a=book(A),b=book(B);
  const ga=engines.glicko.side(idsA,now),gb=engines.glicko.side(idsB,now);
  const phi=Math.sqrt((ga.rd/SCALE)**2+(gb.rd/SCALE)**2);
  const rest=x=>x.last?clamp((now-x.last)/DAY,0,60):60;
  const h=h2h.get(pairKey(A,B))||[0,0],[hA,hB]=A<B?h:[h[1],h[0]];
  return [
    (engines.eloPlus.rating(idsA,now)-engines.eloPlus.rating(idsB,now))/400,
    Glicko2.g(phi)*(ga.r-gb.r)/SCALE,
    (a.played?a.wins/a.played:0.5)-(b.played?b.wins/b.played:0.5),
    (a.recent.length?mean(a.recent):0.5)-(b.recent.length?mean(b.recent):0.5),
    (hA-hB)/(1+hA+hB),
    Math.log1p(a.played)-Math.log1p(b.played),
    (rest(a)-rest(b))/30,
  ];
}

// Walk-forward comparison of several engines on one real history.
// Warmup fits the logistic blend; the held-out tail is never seen while fitting.
export function walkForward(matches,{split=0.8,k=DEFAULTS.k,plus=DEFAULTS.plus,glicko=DEFAULTS.glicko,forecastLeadMs=0}={}) {
  if(!Number.isFinite(forecastLeadMs)||forecastLeadMs<0)throw new Error('Некорректный forecastLeadMs');
  const sorted=[...matches].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
  const engines={winrate:new WinRate(),elo:new Elo({k}),eloPlus:new Elo(plus),glicko:new Glicko2(glicko)};
  const teams=new Map(),h2h=new Map();
  const book=id=>{if(!teams.has(id))teams.set(id,{played:0,wins:0,recent:[],last:null});return teams.get(id);};
  const ctx={engines,teams,book,h2h};
  const pending=[],rows=[];
  const apply=p=>{
    const {m,y,available:now,idsA,idsB}=p;
    for(const e of Object.values(engines))e.update(idsA,idsB,y,now,m);
    for(const [id,result] of [[m.teamA.id,y],[m.teamB.id,1-y]]){
      const s=book(id);s.played++;s.wins+=result;s.recent.push(result);s.recent=s.recent.slice(-10);s.last=now;
    }
    const key=pairKey(m.teamA.id,m.teamB.id),h=h2h.get(key)||[0,0];
    h[m.teamA.id<m.teamB.id?(y?0:1):(y?1:0)]++;h2h.set(key,h);
  };
  for(const m of sorted) {
    const now=Date.parse(m.start)-forecastLeadMs-1;
    pending.sort((a,b)=>a.available-b.available);
    while(pending.length&&pending[0].available<now)apply(pending.shift());
    const A=m.teamA.id,B=m.teamB.id,{a:idsA,b:idsB,eligible}=sides(m);
    book(A);book(B);
    const features=featureRow(ctx,A,B,idsA,idsB,now);
    const probs=Object.fromEntries(Object.entries(engines).map(([name,e])=>[name,e.p(idsA,idsB,now)]));
    const y=m.winner===A?1:0;
    rows.push({id:m.id,start:m.start,predictedAt:new Date(now).toISOString(),available:Date.parse(finalTime(m)),y,features,probs,eligible,
      experience:Math.min(teams.get(A).played,teams.get(B).played),
      teamA:m.teamA.name,teamB:m.teamB.name,event:m.event});
    // An incomplete FACEIT roster cannot be credited to individual players.
    if(eligible)pending.push({m,y,now,idsA,idsB,available:Date.parse(finalTime(m))});
  }
  pending.sort((a,b)=>a.available-b.available);
  while(pending.length)apply(pending.shift());
  const usable=rows.filter(r=>r.eligible);
  const boundary=usable[Math.floor(usable.length*split)]?.start||null;
  // Purge training labels that were not yet available at the first test prediction.
  const train=boundary?usable.filter(r=>r.start<boundary&&r.available<Date.parse(boundary)-forecastLeadMs-1):usable;
  const test=boundary?usable.filter(r=>r.start>=boundary):[];
  const blend=fitLogistic(train.map(r=>r.features),train.map(r=>r.y));
  const stackRow=r=>[...r.features,logit(r.probs.glicko),logit(r.probs.eloPlus)];
  const stacked=fitLogistic(train.map(stackRow),train.map(r=>r.y));
  for(const r of rows){r.probs.logistic=blend.predict(r.features);r.probs.stacked=stacked.predict(stackRow(r));}
  return {rows,train,test,boundary,engines,teams,h2h,blend,stacked,ctx,excluded:rows.length-usable.length};
}

// Live prediction from the end of the loaded history, using the fitted blend.
export function predictMatchup(model,a,b,now=Date.now(),idsA=[a],idsB=[b]) {
  const features=featureRow(model.ctx,a,b,idsA,idsB,now);
  return {p:model.blend.predict(features),features,
    glicko:model.engines.glicko.p(idsA,idsB,now),elo:model.engines.elo.p(idsA,idsB,now)};
}

export function score(rows,name) {
  if(!rows.length)return null;
  const ps=rows.map(r=>clamp(r.probs[name],1e-9,1-1e-9));
  return {
    count:rows.length,
    accuracy:mean(rows.map((r,i)=>ps[i]===0.5?0.5:Number((ps[i]>0.5)===(r.y===1)))),
    logLoss:mean(rows.map((r,i)=>-(r.y*Math.log(ps[i])+(1-r.y)*Math.log(1-ps[i])))),
    brier:mean(rows.map((r,i)=>(ps[i]-r.y)**2)),
    auc:rocAuc(rows.map(r=>r.y),ps),
  };
}

// Mann-Whitney rank statistic with average ranks for ties; undefined for one class.
export function rocAuc(labels,probabilities) {
  const rows=labels.map((y,i)=>({y,p:probabilities[i]})).sort((a,b)=>a.p-b.p);
  const positives=labels.filter(y=>y===1).length,negatives=labels.length-positives;
  if(!positives||!negatives)return null;
  let sum=0;
  for(let i=0;i<rows.length;){let j=i+1;while(j<rows.length&&rows[j].p===rows[i].p)j++;
    const rank=(i+1+j)/2;for(let k=i;k<j;k++)if(rows[k].y===1)sum+=rank;i=j;}
  return (sum-positives*(positives+1)/2)/(positives*negatives);
}
