const basic=x=>x.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-zа-яё0-9]/g,'');
const aliases={navi:'natusvincere',natusvincereukraine:'natusvincere'};
export function teamKey(name,extra={}){const key=basic(name);return basic(extra[key]||aliases[key]||key);}
export function matchFixture(record,matches,{toleranceMs=3*3600000,aliases:extra={}}={}){
  const a=teamKey(record.teamA,extra),b=teamKey(record.teamB,extra);
  if(!a||!b||a===b)return {status:'ambiguous',candidates:[]};
  const candidates=matches.filter(m=>Math.abs(Date.parse(m.start)-Date.parse(record.startsAt))<=toleranceMs).flatMap(m=>{
    const x=teamKey(m.teamA.name,extra),y=teamKey(m.teamB.name,extra);
    return a===x&&b===y?[{matchId:m.id,reversed:false}]:a===y&&b===x?[{matchId:m.id,reversed:true}]:[];
  });
  return candidates.length===1?{status:'matched',...candidates[0],candidates}: {status:candidates.length?'ambiguous':'unmatched',candidates};
}
export function matchOdds(rows,matches,options={}){
  const events=new Map(),mapped=[];
  for(const r of rows){const key=JSON.stringify([r.provider,r.externalMatchId]);
    if(!events.has(key))events.set(key,{provider:r.provider,externalMatchId:r.externalMatchId,teamA:r.teamA,teamB:r.teamB,startsAt:r.startsAt,...matchFixture(r,matches,options)});
    const match=matchFixture(r,matches,options),event=events.get(key);
    if(event.status!==match.status||event.matchId!==match.matchId||event.reversed!==match.reversed)throw new Error('Один provider event имеет противоречивые команды/время; нужен ручной разбор');
    mapped.push({...r,matchId:match.matchId||null,matchStatus:match.status,reversed:match.reversed||false});
  }
  const details=[...events.values()],matched=details.filter(r=>r.status==='matched').length;
  return {rows:mapped,report:{events:details.length,matched,ambiguous:details.filter(r=>r.status==='ambiguous').length,unmatched:details.filter(r=>r.status==='unmatched').length,rate:details.length?matched/details.length:null,details}};
}
export function internalQuote(row){return row.reversed?{...row,oddsA:row.oddsB,oddsB:row.oddsA,teamA:row.teamB,teamB:row.teamA}:row;}
