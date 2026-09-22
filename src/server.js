import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root } from './config.js';
import { Store } from './db.js';
import { collect, options } from './collectors.js';
import { summary, teamRows, playerRows, headToHead, predict, backtest } from './analytics.js';
import { dataAudit,scouting } from './research.js';
import { loadRoles } from './features.js';
import { buildRapm } from './rapm.js';
import { buildMaps } from './maps.js';
import { bettingReport } from './odds/backtest.js';
import { allOdds } from './odds/store.js';
import { liveEvaluation,upcomingBoard } from './upcoming.js';

const sources=new Set(['bo3','faceit','pandascore']);
const csvCell=v=>{let s=v===null||v===undefined?'':String(v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
export function csv(rows) { if(!rows.length)return '';const fields=Object.keys(rows[0]);return '\ufeff'+[fields,...rows.map(r=>fields.map(f=>r[f]))].map(row=>row.map(csvCell).join(',')).join('\r\n'); }
export function createApp(store=new Store()) {
  let job=null;
  // Parsing every match costs ~0.3 s; reuse it until the table changes.
  const loaded=new Map();
  const loadMatches=source=>{const key=store.version(source),hit=loaded.get(source);if(hit?.key===key)return hit.rows;const rows=store.all(source);loaded.set(source,{key,rows});return rows;};
  const csrf=randomBytes(24).toString('hex');
  async function body(req) {let value='';for await(const c of req){value+=c;if(value.length>16000)throw new Error('Слишком большой запрос');}return JSON.parse(value||'{}');}
  function json(res,data,status=200) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||''))return json(res,{error:'Invalid host'},403);
      const url=new URL(req.url,'http://localhost');
      if(url.pathname.startsWith('/api/')){
        const source=url.searchParams.get('source')||'bo3';if(!sources.has(source))return json(res,{error:'Неизвестный источник'},400);
        if(req.method==='POST'){
          if(req.headers['x-csrf-token']!==csrf)return json(res,{error:'Обновите страницу перед загрузкой'},403);
          if(url.pathname!=='/api/sync')return json(res,{error:'Не найдено'},404);
          if(job?.status==='running')return json(res,{error:'Загрузка уже выполняется'},409);
          const input=await body(req);options(input);
          if(input.source==='faceit'&&!process.env.FACEIT_API_KEY)throw new Error('Добавьте FACEIT_API_KEY в .env и перезапустите сервер');
          if(input.source==='pandascore'&&!process.env.PANDASCORE_API_KEY)throw new Error('Добавьте PANDASCORE_API_KEY в .env и перезапустите сервер');
          job={status:'running',source:input.source||'bo3',message:'Начинаем загрузку',started:new Date().toISOString()};
          collect(store,input,p=>{job={...job,...p};}).then(report=>{job={...job,...report,status:'done'};}).catch(e=>{job={...job,status:'error',error:e.message};});
          return json(res,job,202);
        }
        if(req.method!=='GET')return json(res,{error:'Метод не поддерживается'},405);
        if(url.pathname==='/api/status')return json(res,{csrf,job,counts:store.counts(),runs:store.runs(),keys:{faceit:!!process.env.FACEIT_API_KEY,pandascore:!!process.env.PANDASCORE_API_KEY}});
        const matches=loadMatches(source);
        if(url.pathname==='/api/upcoming'){const log=store.forecasts();return json(res,source==='bo3'?{upcoming:upcomingBoard(store.upcoming('bo3'),log),live:liveEvaluation(matches,log)}:{upcoming:[],live:liveEvaluation([],[])});}
        if(url.pathname==='/api/market-lab')return json(res,{betting:bettingReport(matches,source==='bo3'?allOdds(store):[]),maps:buildMaps(matches)});
        if(url.pathname==='/api/rapm')return json(res,buildRapm(matches,store.rounds(source)));
        const scoutingOptions=()=>({roles:loadRoles(),...(url.searchParams.has('asOf')?{asOf:url.searchParams.get('asOf')}:{}),...(url.searchParams.has('days')?{days:Number(url.searchParams.get('days'))}:{}),...(url.searchParams.has('minMatches')?{minMatches:Number(url.searchParams.get('minMatches'))}:{})});
        if(url.pathname==='/api/research')return json(res,dataAudit(matches,store.rounds(source)));
        if(url.pathname==='/api/scouting')return json(res,scouting(matches,scoutingOptions()));
        if(url.pathname==='/api/summary')return json(res,summary(matches,source));
        if(url.pathname==='/api/teams')return json(res,teamRows(matches));
        if(url.pathname==='/api/players')return json(res,playerRows(matches));
        if(url.pathname==='/api/backtest')return json(res,backtest(matches));
        if(url.pathname==='/api/h2h')return json(res,headToHead(matches,url.searchParams.get('type'),url.searchParams.get('a'),url.searchParams.get('b')));
        if(url.pathname==='/api/predict')return json(res,predict(matches,url.searchParams.get('a'),url.searchParams.get('b')));
        if(url.pathname==='/api/matches'){
          const q=(url.searchParams.get('q')||'').toLowerCase(),team=url.searchParams.get('team'),player=url.searchParams.get('player');
          const page=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1)),size=30;
          const rows=[...matches].reverse().filter(m=>(!q||`${m.teamA.name} ${m.teamB.name} ${m.event} ${m.players.map(p=>p.name).join(' ')}`.toLowerCase().includes(q))&&(!team||[m.teamA.id,m.teamB.id].includes(team))&&(!player||m.players.some(p=>p.id===player)));
          return json(res,{items:rows.slice((page-1)*size,page*size),total:rows.length,page,pages:Math.ceil(rows.length/size)});
        }
        if(url.pathname==='/api/match'){const m=store.get(url.searchParams.get('id')||'');return m?json(res,m):json(res,{error:'Матч не найден'},404);}
        if(url.pathname==='/api/export'){
          const type=url.searchParams.get('type')||'matches';let rows;
          if(type==='scouting'){const snapshot=scouting(matches,scoutingOptions());rows=snapshot.rows.map(r=>({asOf:snapshot.asOf,days:snapshot.days,minMatches:snapshot.minMatches,source,playerId:r.id,name:r.name,role:r.role,matches:r.matches,effectiveMatches:r.effectiveMatches,formScore:r.formScore,adr:r.values.adr,kast:r.values.kast,kd:r.values.kd,opening:r.values.opening,tradeShare:r.values.tradeShare,tradedDeathRate:r.values.tradedDeathRate,normalization:r.normalization}));}
          else if(type==='players')rows=matches.flatMap(m=>m.players.map(p=>({matchId:m.id,start:m.start,source:m.source,playerId:p.id,name:p.name,teamId:p.teamId,won:Number(m.winner===p.teamId),kills:p.kills,deaths:p.deaths,assists:p.assists,adr:p.adr,kast:p.kast,rating:p.rating,ratingSystem:p.ratingSystem,firstKills:p.firstKills,firstDeaths:p.firstDeaths,tradeKills:p.tradeKills,tradedDeaths:p.tradedDeaths,flashAssists:p.flashAssists,clutchWins:p.clutchWins,damage:p.damage,utilityDamage:p.utilityDamage,moneySpent:p.moneySpent,moneySaved:p.moneySaved})));
          else if(type==='maps')rows=matches.flatMap(m=>m.maps.map(g=>({matchId:m.id,source:m.source,start:m.start,...g})));
          else rows=matches.map(m=>({id:m.id,source:m.source,start:m.start,end:m.end,teamAId:m.teamA.id,teamA:m.teamA.name,teamBId:m.teamB.id,teamB:m.teamB.name,winner:m.winner,scoreA:m.scoreA,scoreB:m.scoreB,bestOf:m.bestOf,event:m.event,playerCount:m.players.length,url:m.url}));
          res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="cs2-${source}-${['players','maps','scouting'].includes(type)?type:'matches'}.csv"`});return res.end(csv(rows));
        }
        return json(res,{error:'Не найдено'},404);
      }
      if(req.method!=='GET')return json(res,{error:'Метод не поддерживается'},405);
      // The lineup contract is served from src: one file, shared by Node and the browser.
      const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml'],
        '/research.js':['research.js','text/javascript; charset=utf-8'],'/rapm.js':['rapm.js','text/javascript; charset=utf-8'],
        '/rapm.css':['rapm.css','text/css; charset=utf-8'],'/lineups.js':['lineups.js','text/javascript; charset=utf-8','src'],
        '/market-lab.js':['market-lab.js','text/javascript; charset=utf-8'],'/upcoming.js':['upcoming-view.js','text/javascript; charset=utf-8'],
        '/map-contract.js':['map-contract.js','text/javascript; charset=utf-8','src'],
        '/odds-market.js':['odds/market.js','text/javascript; charset=utf-8','src']};
      const file=assets[url.pathname];if(!file){res.writeHead(404);return res.end('Not found');}
      const content=await readFile(join(root,file[2]||'public',file[0]));res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-cache'});res.end(content);
    }catch(e){json(res,{error:e.message},400);}
  });
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT)||3210;
  const server=createApp();server.listen(port,'127.0.0.1',()=>console.log(`CS2 Match Lab: http://localhost:${port}`));
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} занят. Укажите другой PORT в .env.`:e.message);process.exitCode=1;});
}
