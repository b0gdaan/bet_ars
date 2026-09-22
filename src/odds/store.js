import { normalizeOdds } from './normalize.js';
import { matchOdds } from './matcher.js';
export function importOdds(store,raw,options={}){
  const normalized=normalizeOdds(raw),result=matchOdds(normalized,store.all('bo3'),options);
  const stmt=store.db.prepare('INSERT INTO odds(provider,external_match_id,bookmaker,captured_at,starts_at,market_type,match_id,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,external_match_id,bookmaker,captured_at,market_type) DO UPDATE SET match_id=excluded.match_id,starts_at=excluded.starts_at,data=excluded.data');
  store.db.exec('BEGIN IMMEDIATE');try{for(const r of result.rows)stmt.run(r.provider,r.externalMatchId,r.bookmaker,r.capturedAt,r.startsAt,r.marketType,r.matchId,JSON.stringify(r));store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
  return {...result.report,quotes:result.rows.length};
}
// Quotes whose match is known exactly (same source, same id) skip fuzzy name matching.
export function importKnownOdds(store,raw,matchIds){
  const rows=normalizeOdds(raw);
  if(rows.length!==matchIds.length)throw new Error('Каждой котировке нужен свой matchId');
  const stmt=store.db.prepare('INSERT INTO odds(provider,external_match_id,bookmaker,captured_at,starts_at,market_type,match_id,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider,external_match_id,bookmaker,captured_at,market_type) DO NOTHING');
  let added=0;store.db.exec('BEGIN IMMEDIATE');
  try{rows.forEach((r,i)=>{added+=stmt.run(r.provider,r.externalMatchId,r.bookmaker,r.capturedAt,r.startsAt,r.marketType,matchIds[i],JSON.stringify({...r,matchId:matchIds[i],matchStatus:'matched',reversed:false})).changes;});store.db.exec('COMMIT');}
  catch(e){store.db.exec('ROLLBACK');throw e;}
  return {quotes:rows.length,added};
}
export function allOdds(store){return store.db.prepare('SELECT data FROM odds ORDER BY captured_at,id').all().map(r=>JSON.parse(r.data));}
