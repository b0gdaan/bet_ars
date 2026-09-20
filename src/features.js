import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { dataDir } from './config.js';
import { validateRoles } from './research.js';
import { bo3Players } from './adapters.js';
import { parseJSON } from './http.js';

export function loadRoles(path=join(dataDir,'roles.json')) {
  try { return validateRoles(JSON.parse(readFileSync(path,'utf8'))); }
  catch(e) { if(e.code==='ENOENT')return [];throw e; }
}

// Interchange format for a demo parser, not a fabricated round reconstruction.
export function validateRounds(rows,store) {
  if(!Array.isArray(rows)||!rows.length)throw new Error('Нужен непустой JSON-массив раундов');
  const keys=new Set(),matches=new Map();
  return rows.map(r=>{
    if(!r||typeof r!=='object')throw new Error('Некорректный раунд');
    if(!matches.has(r.matchId))matches.set(r.matchId,store.get(r.matchId));
    const m=matches.get(r.matchId),map=m?.maps.find(g=>g.id===r.mapId&&g.name===r.map);
    if(!m||!map)throw new Error('Раунд должен ссылаться на существующий matchId и mapId с совпадающей картой');
    if(!Number.isInteger(r.round)||r.round<1||r.round>200||!['CT','T'].includes(r.sideA)||![m.teamA.id,m.teamB.id].includes(r.winner))throw new Error('Некорректный номер раунда, сторона или победитель');
    const ids=[...(r.playersA||[]),...(r.playersB||[])];
    if(!Array.isArray(r.playersA)||!Array.isArray(r.playersB)||r.playersA.length!==5||r.playersB.length!==5||new Set(ids).size!==10||ids.some(id=>typeof id!=='string'||!id.startsWith(m.source+':')))throw new Error('Нужны 5 + 5 уникальных player ID того же источника');
    for(const [side,team]of [[r.playersA,m.teamA.id],[r.playersB,m.teamB.id]])for(const id of side){const known=m.players.find(p=>p.id===id);if(known&&known.teamId!==team)throw new Error('Игрок указан не на своей стороне исторического состава');}
    for(const key of ['equipmentA','equipmentB'])if(r[key]!==null&&!(typeof r[key]==='number'&&Number.isFinite(r[key])&&r[key]>=0))throw new Error('Экономика: неотрицательное число или null, не ноль вместо пропуска');
    if(!Number.isFinite(Date.parse(r.startedAt))||!Number.isFinite(Date.parse(r.endedAt))||Date.parse(r.endedAt)<=Date.parse(r.startedAt)||Date.parse(r.startedAt)<Date.parse(m.start)||(m.end&&Date.parse(r.endedAt)>Date.parse(m.end)))throw new Error('Время раунда должно лежать внутри матча');
    if(!/^[a-f0-9]{64}$/i.test(r.demoSha256||'')||typeof r.parserVersion!=='string'||!r.parserVersion.trim()||!Number.isFinite(r.tickRate)||r.tickRate<=0||!Number.isInteger(r.freezeEndTick)||!Number.isInteger(r.endTick)||r.freezeEndTick<0||r.endTick<=r.freezeEndTick)throw new Error('Нужны provenance: demoSha256, parserVersion, tickRate, freezeEndTick < endTick');
    const id=JSON.stringify([m.id,r.mapId,r.round]);if(keys.has(id))throw new Error('Дубликат раунда в файле');keys.add(id);
    return {...r,id,source:m.source,teamAId:m.teamA.id,teamBId:m.teamB.id};
  });
}
export function importRounds(rows,store) {
  const valid=validateRounds(rows,store),stmt=store.db.prepare('INSERT INTO round_features VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  store.db.exec('BEGIN IMMEDIATE');
  try{for(const r of valid)stmt.run(r.id,r.source,r.matchId,JSON.stringify(r));store.db.exec('COMMIT');}
  catch(e){store.db.exec('ROLLBACK');throw e;}
  return {rounds:valid.length,matches:new Set(valid.map(r=>r.matchId)).size};
}
export async function backupStore(store) {
  const dir=join(dataDir,'backups');mkdirSync(dir,{recursive:true});
  const path=join(dir,'cs2-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
  await backup(store.db,path);return path;
}

export const EXTRA_FIELDS=['tradeKills','tradedDeaths','flashAssists','clutchWins','damage','utilityDamage','moneySpent','moneySaved'];
export function enrichFromCache(store) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
  const matches=new Map(store.all('bo3').map(m=>[m.slug,m])),updates=new Map();let changedPlayers=0;
  // Full statistics take precedence over the limited fallback. Existing non-null values survive.
  const cached=store.db.prepare("SELECT url,body FROM cache WHERE url LIKE '%/players_stats%' OR url LIKE '%/short_players_stats%'").all().sort((a,b)=>Number(a.url.includes('/short_players_stats'))-Number(b.url.includes('/short_players_stats')));
  for(const c of cached){const u=new URL(c.url);if(u.hostname!=='api.bo3.gg')continue;const hit=u.pathname.match(/\/matches\/([^/]+)\/(short_)?players_stats$/);if(!hit)continue;
    const m=matches.get(decodeURIComponent(hit[1]));if(!m)continue;
    const parsed=bo3Players(parseJSON(c.body),m,!!hit[2]);
    for(const p of parsed){const old=m.players.find(x=>x.id===p.id&&x.teamId===p.teamId);if(!old)continue;let changed=false;
      for(const key of EXTRA_FIELDS)if(old[key]==null&&typeof p[key]==='number'&&Number.isFinite(p[key])){old[key]=p[key];changed=true;}
      if(changed){old.statsLevel='match';changedPlayers++;updates.set(m.id,m);}
    }
  }
  // Update only JSON and timestamp; do not run listing merge logic over an enrichment.
  const stmt=store.db.prepare('UPDATE matches SET data=?,updated=? WHERE id=?');for(const m of updates.values())stmt.run(JSON.stringify(m),new Date().toISOString(),m.id);store.db.exec('COMMIT');
  return {cachedResponses:cached.length,updatedMatches:updates.size,updatedPlayerRows:changedPlayers};
  }catch(e){store.db.exec('ROLLBACK');throw e;}
}
