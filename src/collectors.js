import { Client, ApiError } from './http.js';
import { bo3Match, bo3Players, pandaMatch, faceitMatch } from './adapters.js';
import { CS2_SINCE } from './config.js';

const BO='https://api.bo3.gg/api/v1', FACE='https://open.faceit.com/data/v4', PANDA='https://api.pandascore.co';
const integer=(v,fallback,min,max)=>{const n=Number(v??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Число должно быть от ${min} до ${max}`);return n;};
export function options(input={}) {
  const source=input.source||'bo3';
  if(!['bo3','faceit','pandascore'].includes(source))throw new Error('Неизвестный источник');
  const from=input.from||new Date(Date.now()-90*86400_000).toISOString().slice(0,10);
  const to=input.to||new Date().toISOString().slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||from>to||from<CS2_SINCE.slice(0,10))throw new Error('Укажите корректный период CS2, начиная с 27.09.2023');
  if(new Date(from).toISOString().slice(0,10)!==from||new Date(to).toISOString().slice(0,10)!==to)throw new Error('Несуществующая календарная дата');
  const nicks=String(input.nicknames||'').split(/[,;\n]/).map(x=>x.trim()).filter(Boolean);
  if(source==='faceit'&&(!nicks.length||nicks.length>10||nicks.some(n=>n.length>100)))throw new Error('Укажите от 1 до 10 FACEIT-ников через запятую');
  return {source,from,to,limit:integer(input.limit,500,1,10000),statsLimit:integer(input.statsLimit,100,0,2000),nicknames:nicks,teamId:input.teamId?String(input.teamId):null};
}

export async function collect(store,input,onProgress=()=>{},{client=new Client(store),keys=process.env}={}) {
  const o=options(input);
  const key=o.source==='faceit'?keys.FACEIT_API_KEY:keys.PANDASCORE_API_KEY;
  if(o.source!=='bo3'&&!key)throw new Error(`Добавьте ${o.source==='faceit'?'FACEIT_API_KEY':'PANDASCORE_API_KEY'} в .env и перезапустите приложение. Ключ бесплатный.`);
  const run=store.startRun(o.source);
  const report={source:o.source,seen:0,added:0,updated:0,skipped:0,withStats:0,warnings:[],from:o.from,to:o.to,limit:o.limit,limited:false};
  const update=message=>onProgress({...report,requests:client.requests,cacheHits:client.cacheHits,message});
  const save=m=>{if(!m){report.skipped++;return;}if(store.put(m))report.added++;else report.updated++;};
  const inRange=m=>m&&m.start>=o.from+'T00:00:00.000Z'&&m.start<=o.to+'T23:59:59.999Z';
  const warn=message=>{if(report.warnings.length<20)report.warnings.push(message);};
  try {
    if(o.source==='bo3') {
      let offset=0;
      const selected=[];
      const seen=new Set();
      while(report.seen<o.limit) {
        update(`BO3: загружаем матчи, ${report.seen} получено`);
        const take=Math.min(100,o.limit-report.seen);
        const data=await client.get(BO,'/matches',{scope:'widget-matches','page[offset]':offset,'page[limit]':take,sort:'-start_date,-id','filter[matches.status][in]':'finished','filter[matches.discipline_id][eq]':1,'filter[matches.game_version][eq]':2,'filter[matches.start_date][gt]':new Date(Date.parse(o.from)-1).toISOString(),'filter[matches.start_date][lt]':new Date(Date.parse(o.to)+86400_000).toISOString(),'filter[matches.team_ids][overlap]':o.teamId,with:'teams,tournament,games'},'',5*60_000);
        if(!Array.isArray(data.results))throw new Error('BO3 изменил формат списка матчей');
        let fresh=0;
        for(const row of data.results){if(seen.has(row.id))continue;seen.add(row.id);fresh++;report.seen++;const m=bo3Match(row);if(!inRange(m)){report.skipped++;continue;}save(m);selected.push(store.get(m.id));}
        offset+=data.results.length;
        if(!fresh||data.results.length<take||offset>=data.total?.count)break;
        if(report.seen>=o.limit)report.limited=true;
      }
      // Stable list refreshes preserve stats; repeated imports fill the next missing records.
      const missing=selected.filter(m=>!m.statsFetchedAt&&(!m.statsCheckedAt||Date.now()-Date.parse(m.statsCheckedAt)>24*3600_000)).slice(0,o.statsLimit);
      for(const [index,m] of missing.entries()) {
        update(`BO3: статистика игроков ${index+1}/${missing.length} · ${m.teamA.name} — ${m.teamB.name}`);
        try {
          if(!m.slug)throw new Error('нет slug матча, статистику запросить нельзя');
          let data=await client.get(BO,`/matches/${encodeURIComponent(m.slug)}/players_stats`);
          m.players=bo3Players(data,m);
          if(!m.players.length) { data=await client.get(BO,`/matches/${encodeURIComponent(m.slug)}/short_players_stats`);m.players=bo3Players(data,m,true); }
          m.statsCheckedAt=new Date().toISOString();
          if(m.players.length) {m.statsFetchedAt=m.statsCheckedAt;report.withStats++;}
          else warn(`${m.id}: статистика игроков пока отсутствует`);
          store.put(m);
        } catch(e) {
          if(e instanceof ApiError&&[401,403,429].includes(e.status))throw e;
          // Mark the attempt so the match waits a day: otherwise it heads the queue every run
          // and spends the stats budget again (a 404 or a persistent 5xx never resolves itself).
          m.statsCheckedAt=new Date().toISOString();store.put(m);
          warn(`${m.id}: ${e.message}`);
        }
      }
    } else if(o.source==='pandascore') {
      let page=1;
      while(report.seen<o.limit) {
        update(`PandaScore: страница ${page}`);
        const take=Math.min(100,o.limit-report.seen);
        const rows=await client.get(PANDA,'/csgo/matches/past',{page,per_page:100,sort:'-begin_at','range[begin_at]':`${o.from}T00:00:00Z,${o.to}T23:59:59Z`},key,5*60_000);
        if(!Array.isArray(rows))throw new Error('PandaScore изменил формат списка');
        for(const row of rows.slice(0,take)){report.seen++;const m=pandaMatch(row);if(inRange(m))save(m);else report.skipped++;}
        if(rows.length<100)break;
        // Keep a constant page size until the final partial page: offsets stay correct.
        if(report.seen>=o.limit){report.limited=true;break;}page++;
      }
      warn('Бесплатный PandaScore: только результаты и справочная информация. Подробная статистика игроков не запрашивается.');
    } else {
      const ids=new Set();
      const from=Math.floor(Date.parse(o.from)/1000),to=Math.floor(Date.parse(o.to+'T23:59:59Z')/1000);
      for(const nickname of o.nicknames) {
        if(ids.size>=o.limit){report.limited=true;break;}
        update(`FACEIT: ищем ${nickname}`);
        const player=await client.get(FACE,'/players',{nickname},key,3600_000);
        if(!player.player_id)throw new Error(`FACEIT: не найден ${nickname}`);
        // Use day windows, recursively bisected if the API's offset ceiling is reached.
        async function historyWindow(lo,hi) {
          if(ids.size>=o.limit){report.limited=true;return;}
          for(let offset=0;offset<=1000;offset+=100) {
            const data=await client.get(FACE,`/players/${encodeURIComponent(player.player_id)}/history`,{game:'cs2',from:lo,to:hi,offset,limit:100},key,5*60_000);
            if(!Array.isArray(data.items))throw new Error('FACEIT изменил формат истории');
            for(const m of data.items)if(m.match_id){ids.add(m.match_id);if(ids.size>=o.limit){report.limited=true;return;}}
            if(data.items.length<100)return;
            if(offset===1000){
              if(lo===hi){warn(`FACEIT: окно ${lo} переполнено, история неполна`);return;}
              const mid=Math.floor((lo+hi)/2);await historyWindow(mid+1,hi);await historyWindow(lo,mid);
            }
          }
        }
        await historyWindow(from,to);
      }
      for(const id of ids) {
        update(`FACEIT: матч ${report.seen+1}/${ids.size}`);
        const m=await client.get(FACE,`/matches/${encodeURIComponent(id)}`,{},key);
        let stats={};
        if(report.seen<o.statsLimit)try {stats=await client.get(FACE,`/matches/${encodeURIComponent(id)}/stats`,{},key);}catch(e){if([401,403,429].includes(e.status))throw e;warn(`${id}: ${e.message}`);}
        report.seen++;
        const normalized=faceitMatch(m,stats);
        if(inRange(normalized)){if(stats.rounds?.length){normalized.statsFetchedAt=new Date().toISOString();report.withStats++;}save(normalized);}else report.skipped++;
      }
    }
    report.requests=client.requests;report.cacheHits=client.cacheHits;
    store.endRun(run,'done',report);update('Загрузка завершена');return report;
  } catch(e) {
    report.error=e.message;store.endRun(run,'error',report);update(`Загрузка остановлена: ${e.message}`);throw e;
  }
}
