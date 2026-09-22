export function mapFeatures(a,b,map){
  const blank={played:0,wins:0,elo:1500},x=a.maps[map]||blank,y=b.maps[map]||blank,rate=s=>(s.wins+5)/(s.played+10);
  return [(a.elo-b.elo)/400,rate(a)-rate(b),(x.elo-y.elo)/400,rate(x)-rate(y),Math.log1p(x.played)-Math.log1p(y.played)];
}
export function predictMap(snapshot,aId,bId,map){
  if(aId===bId)throw new Error('Выберите разные команды');
  const a=snapshot.teams.find(t=>t.id===aId),b=snapshot.teams.find(t=>t.id===bId);
  if(!a||!b||!snapshot.maps.includes(map)||!snapshot.model)throw new Error('Недостаточно данных для прогноза карты');
  const f=mapFeatures(a,b,map),z=f.reduce((s,v,i)=>s+v*snapshot.model.weights[i]/snapshot.model.scale[i],0);
  return {p:1/(1+Math.exp(-z)),a:a.maps[map]||{played:0,wins:0},b:b.maps[map]||{played:0,wins:0}};
}
