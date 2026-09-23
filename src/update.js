// One refresh cycle: fresh results in, model refit on everything, forecasts for upcoming
// matches logged before they start, pre-match lines saved as quotes, static site rebuilt.
//   npm run update                     results for the last 3 days, next 7 days of fixtures
//   npm run update -- --push           also commit and push docs/ (publishes the snapshot)
//   options: --days 3 --ahead 7 --stats 300 --no-site
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './config.js';
import { Store } from './db.js';
import { Client } from './http.js';
import { collect } from './collectors.js';
import { fetchUpcoming,normalizeUpcoming,lineQuote,productionModel,forecastUpcoming,liveEvaluation } from './upcoming.js';
import { importKnownOdds } from './odds/store.js';
import { SETTINGS } from './settings.js';

const DAY=86400_000,args=process.argv.slice(2);
const flag=name=>args.includes(name);
const option=(name,fallback,min,max)=>{
  const i=args.indexOf(name),value=i>=0?Number(args[i+1]):fallback;
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name}: целое число от ${min} до ${max}`);
  return value;
};

export async function refresh({days=3,ahead=7,stats=300,now=Date.now(),store}={}) {
  const from=new Date(now-days*DAY).toISOString().slice(0,10),to=new Date(now).toISOString().slice(0,10);
  const results=await collect(store,{source:'bo3',from,to,limit:2000,statsLimit:stats});
  const capturedAt=new Date().toISOString();
  const raw=await fetchUpcoming(new Client(store),{days:ahead,now});
  const upcoming=raw.map(m=>normalizeUpcoming(m,capturedAt)).filter(Boolean);
  store.replaceUpcoming('bo3',upcoming,capturedAt);
  const lines=upcoming.filter(m=>m.line);
  const odds=lines.length?importKnownOdds(store,lines.map(lineQuote),lines.map(m=>m.id)):{quotes:0,added:0};
  const matches=store.all('bo3');
  const production=productionModel(matches);
  const forecasts=forecastUpcoming(production,upcoming,Date.now());
  let logged=0;for(const f of forecasts)if(store.addForecast(f))logged++;
  const live=liveEvaluation(matches,store.forecasts());
  return {results:{added:results.added,updated:results.updated,withStats:results.withStats},
    upcoming:upcoming.length,withLine:lines.length,quotesAdded:odds.added,forecastsLogged:logged,
    trainedThrough:production.trainedThrough,trainRows:production.trainRows,
    live:{scored:live.scored,accuracy:live.model?.accuracy??null,logLoss:live.model?.logLoss??null}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const store=new Store();let report;
  try{
    const U=SETTINGS.update;
    report=await refresh({days:option('--days',U.resultsDays,1,30),ahead:option('--ahead',U.aheadDays,1,14),stats:option('--stats',U.statsLimit,0,2000),store});
    console.log(JSON.stringify(report,null,2));
  }catch(e){console.error(e.message);process.exitCode=1;}
  finally{store.close();}
  if(report&&!flag('--no-site')){
    execFileSync(process.execPath,['--disable-warning=ExperimentalWarning',join(root,'src','export-site.js')],{stdio:'inherit'});
    if(flag('--push')){
      const git=(...a)=>execFileSync('git',a,{cwd:root,stdio:'inherit'});
      git('add','docs');
      try{git('diff','--cached','--quiet');console.log('Снимок не изменился, публиковать нечего.');}
      catch{git('commit','-q','-m',`Update snapshot ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC`);git('push','-q','origin','main');console.log('Снимок опубликован.');}
    }
  }
}
