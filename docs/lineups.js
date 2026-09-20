// Pure prediction contract shared by Node and the static site. No team-name ratings.
export const sigmoid=x=>1/(1+Math.exp(-Math.max(-35,Math.min(35,x))));
export function validateLineups(a,b) {
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==5||b.length!==5||[...a,...b].some(id=>typeof id!=='string'||!id))throw new Error('Нужны две пятёрки игроков.');
  if(new Set([...a,...b]).size!==10)throw new Error('Игрок не может занимать два места или играть за обе стороны.');
}
export function lineupChange(before,after) {
  return {out:before.filter(id=>!after.includes(id)),in:after.filter(id=>!before.includes(id)),retained:after.filter(id=>before.includes(id)).length};
}
export function predictLineups(model,a,b,{sideA='CT',equipmentA=null,equipmentB=null,map='de_mirage'}={}) {
  validateLineups(a,b);
  if(model.status!=='trained')throw new Error('Модель ещё не обучена на реальных данных этого режима.');
  const players=new Map(model.players.map(p=>[p.id,p]));
  const unknown=[...a,...b].filter(id=>!players.has(id));
  if(unknown.length)throw new Error('Для выбранного игрока нет обученного коэффициента. Нельзя подставлять неизвестному средний рейтинг.');
  let z=a.reduce((s,id)=>s+players.get(id).coefficient,0)-b.reduce((s,id)=>s+players.get(id).coefficient,0);
  if(model.mode==='round'){
    if(!['CT','T'].includes(sideA)||![equipmentA,equipmentB].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0))throw new Error('Для раунда нужны сторона и обе стартовые стоимости экипировки.');
    if(!Object.hasOwn(model.context,`ct:${map}`))throw new Error('Эта карта не входила в обучение.');
    z+=(sideA==='CT'?1:-1)*model.context[`ct:${map}`]+((equipmentA-equipmentB)/10000)*(model.context.economy||0);
  }
  return {p:sigmoid(z),logit:z,lowSample:[...a,...b].filter(id=>players.get(id).matches<10),confounded:[...a,...b].filter(id=>players.get(id).inseparable>1)};
}
