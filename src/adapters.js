import { CS2_SINCE } from './config.js';
export const num = x => x===null || x===undefined || x==='' || !Number.isFinite(Number(x)) ? null : Number(x);
const iso = x => Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
const values = x => Array.isArray(x)?x:Object.values(x||{});
const boTeam = t => t?.id ? {id:`bo3:${t.id}`,name:t.name||String(t.id),slug:t.slug||''} : null;

export function bo3Match(m) {
  const start=iso(m.start_date), end=iso(m.end_date);
  if (m.status!=='finished' || m.game_version===1 || !start || start<CS2_SINCE || !m.team1?.id || !m.team2?.id || ![m.team1.id,m.team2.id].includes(m.winner_team_id)) return null;
  const teamA=boTeam(m.team1),teamB=boTeam(m.team2);
  const maps=(m.games||[]).filter(g=>g.state==='done').map(g=>{
    const wid=g.winner_team_clan?.team_id ?? g.winner_team_clan?.team?.id;
    const a=wid===m.team1.id;
    return {id:String(g.id),name:g.map_name,number:g.number,winner:wid?`bo3:${wid}`:null,scoreA:wid?num(a?g.winner_clan_score:g.loser_clan_score):null,scoreB:wid?num(a?g.loser_clan_score:g.winner_clan_score):null};
  });
  return {id:`bo3:${m.id}`,externalId:String(m.id),source:'bo3',kind:'pro',slug:m.slug,start,end,bestOf:num(m.bo_type),teamA,teamB,winner:`bo3:${m.winner_team_id}`,scoreA:num(m.team1_score),scoreB:num(m.team2_score),event:m.tournament?.name||'',url:`https://bo3.gg/matches/${encodeURIComponent(m.slug)}`,maps,players:[],endEstimated:!end};
}
export function bo3Players(data,match,short=false) {
  return values(data).map(p=>{
    const profile=p.steam_profile;
    const player=short?p.player:profile?.player;
    const pid=short?p.player_id:(player?.id ?? profile?.player_id);
    const tid=short?p.team_id:(p.team_clan?.team_id ?? p.team_clan?.team?.id);
    if (!pid || ![match.teamA.id,match.teamB.id].includes(`bo3:${tid}`)) return null;
    const kast=num(p.kast);
    return {id:`bo3:${pid}`,name:player?.nickname||profile?.nickname||String(pid),teamId:`bo3:${tid}`,steamId:profile?.steam_id_64?String(profile.steam_id_64):null,
      kills:num(short?p.kills_sum:p.kills),deaths:num(short?p.deaths_sum:p.death),assists:num(short?p.assists_sum:p.assists),adr:short?(num(p.adr_sum)!==null && num(p.games_count)>0?Number(p.adr_sum)/Number(p.games_count):null):num(p.adr),
      kast:kast===null?null:(kast<=1?kast*100:kast),rating:short?null:num(p.player_rating),ratingSystem:short?null:'BO3',headshots:num(short?p.headshots_sum:p.headshots),firstKills:num(p.first_kills),firstDeaths:num(p.first_death)};
  }).filter(Boolean);
}

export function pandaMatch(m) {
  if (m.status!=='finished' || m.forfeit || m.winner_type==='Player' || m.opponents?.length!==2) return null;
  const start=iso(m.begin_at),end=iso(m.end_at);
  if (!start || start<CS2_SINCE) return null;
  const [a,b]=m.opponents.map(o=>o.opponent);
  if (!a?.id || !b?.id || ![a.id,b.id].includes(m.winner_id)) return null;
  const score=t=>num(m.results?.find(r=>r.team_id===t.id)?.score);
  return {id:`pandascore:${m.id}`,externalId:String(m.id),source:'pandascore',kind:'pro',start,end,endEstimated:!end,bestOf:num(m.number_of_games),teamA:{id:`pandascore:${a.id}`,name:a.name},teamB:{id:`pandascore:${b.id}`,name:b.name},winner:`pandascore:${m.winner_id}`,scoreA:score(a),scoreB:score(b),event:[m.league?.name,m.serie?.full_name,m.tournament?.name].filter(Boolean).join(' · '),url:null,maps:[],players:[]};
}

export function faceitMatch(m,stats={}) {
  if (m.game!=='cs2' || m.status!=='FINISHED' || !m.results?.winner) return null;
  const entries=Object.entries(m.teams||{});
  if (entries.length!==2 || !entries.some(([k])=>k===m.results.winner)) return null;
  const start=new Date((m.started_at||m.finished_at)*1000).toISOString();
  const end=m.finished_at?new Date(m.finished_at*1000).toISOString():null;
  const [aa,bb]=entries;
  // FACEIT factions are not persistent professional teams. Identity is the exact roster.
  const side=([key,t])=>({id:`faceit:lineup:${(t.roster||t.players||[]).map(p=>p.player_id).sort().join('+')||m.match_id+':'+key}`,name:t.name||t.nickname||key,faction:key,externalId:t.faction_id||t.team_id||key});
  const a=side(aa),b=side(bb),byFaction={[aa[0]]:a,[bb[0]]:b};
  const byExternal={[a.externalId]:a,[b.externalId]:b,...byFaction};
  const players=new Map();
  for (const [key,t] of entries) for (const p of t.roster||t.players||[]) players.set(p.player_id,{id:`faceit:${p.player_id}`,name:p.nickname||p.player_id,teamId:byFaction[key].id,kills:null,deaths:null,assists:null,adr:null,kast:null,rating:null,steamId:p.game_player_id?String(p.game_player_id):null});
  const maps=[];
  for (const [i,r] of (stats.rounds||[]).entries()) {
    let winner=null,scoreA=null,scoreB=null;
    for (const t of r.teams||[]) {
      const side=byExternal[t.team_id]; if (!side) continue;
      if (String(t.team_stats?.['Team Win'])==='1') winner=side.id;
      const rounds=num(t.team_stats?.['Final Score']); if(side.id===a.id)scoreA=rounds;else scoreB=rounds;
      for (const p of t.players||[]) {
        const existing=players.get(p.player_id)||{id:`faceit:${p.player_id}`,name:p.nickname||p.player_id,teamId:side.id,kills:null,deaths:null,assists:null,adr:null,kast:null,rating:null};
        const s=p.player_stats||{};
        for (const [field,label] of [['kills','Kills'],['deaths','Deaths'],['assists','Assists'],['headshots','Headshots']]) {
          const n=num(s[label]); if(n!==null)existing[field]=(existing[field]??0)+n;
        }
        const adr=num(s.ADR),roundCount=num(r.round_stats?.Rounds);
        if (adr!==null && roundCount>0) { existing._damage=(existing._damage||0)+adr*roundCount;existing._rounds=(existing._rounds||0)+roundCount;existing.adr=existing._damage/existing._rounds; }
        players.set(p.player_id,existing);
      }
    }
    maps.push({id:String(i+1),number:i+1,name:r.round_stats?.Map||'unknown',winner,scoreA,scoreB});
  }
  return {id:`faceit:${m.match_id}`,externalId:m.match_id,source:'faceit',kind:'pug',start,end,endEstimated:!end,bestOf:num(m.best_of),teamA:a,teamB:b,winner:byFaction[m.results.winner].id,scoreA:num(m.results.score?.[aa[0]]),scoreB:num(m.results.score?.[bb[0]]),event:m.competition_name||'FACEIT',url:`https://www.faceit.com/en/cs2/room/${encodeURIComponent(m.match_id)}`,maps,players:[...players.values()].map(({_damage,_rounds,...p})=>p)};
}
