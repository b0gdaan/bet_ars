import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db.js';
import { dataDir } from './config.js';
import { backupStore } from './features.js';
import { importOdds,allOdds } from './odds/store.js';
import { normalizeOdds } from './odds/normalize.js';
import { bettingReport } from './odds/backtest.js';
import { OddsPapiProvider } from './odds/provider.js';
import { csv } from './server.js';
const [command='report',...args]=process.argv.slice(2),s=new Store(),dir=join(dataDir,'reports');mkdirSync(dir,{recursive:true});
const save=(name,rows)=>writeFileSync(join(dir,name),csv(rows));
try{
  if(command==='import'){
    const rows=normalizeOdds(JSON.parse(readFileSync(args[0],'utf8')));console.log('Backup:',await backupStore(s));
    const report=importOdds(s,rows);writeFileSync(join(dir,'odds-matching.json'),JSON.stringify(report,null,2));save('odds_matching_report.csv',report.details.map(({candidates,...r})=>({...r,candidates:JSON.stringify(candidates)})));console.log(JSON.stringify({...report,details:undefined},null,2));
  }else if(command==='sync'){
    const [from,to,limit='5',bookmaker='pinnacle']=args;
    if(!process.env.ODDSPAPI_API_KEY)throw new Error('Нужен ODDSPAPI_API_KEY в .env (бесплатный ключ OddsPapi).');
    const provider=new OddsPapiProvider(s,{maxRequests:Number(limit)+3});console.log('Backup:',await backupStore(s));
    console.log(JSON.stringify(await provider.collect({from,to,limit:Number(limit),bookmaker},rows=>importOdds(s,rows)),null,2));
  }else if(command==='report'){
    const [commission='0',fee='0']=args,result=bettingReport(s.all('bo3'),allOdds(s),{commission:Number(commission),fee:Number(fee),includeTrades:true});
    writeFileSync(join(dir,'betting_summary.json'),JSON.stringify(result,null,2));save('match_odds_comparison.csv',result.comparisons||[]);save('oos_predictions.csv',result.predictions||[]);
    save('betting_backtest.csv',result.books.flatMap(b=>b.strategies.flatMap(s=>s.trades.map(t=>({book:b.book,strategy:s.strategy,staking:s.method,...t})))));
    save('equity_curve.csv',result.books.flatMap(b=>b.strategies.flatMap(s=>s.curve.map(p=>({book:b.book,strategy:s.strategy,staking:s.method,...p})))));
    save('calibration.csv',result.books.flatMap(b=>Object.entries(b.comparison.calibration).flatMap(([model,bins])=>bins.map(bin=>({book:b.book,model,...bin})))));
    console.log(JSON.stringify({status:result.status,coverage:result.coverage,matchedOos:result.matchedOos,books:result.books.map(b=>({book:b.book,matches:b.matches})),output:dir},null,2));
  }else throw new Error('Команды: import file.json | sync from to [limit=5] [bookmaker=pinnacle] | report [commission=0] [fee=0]');
}catch(e){console.error(e.message);process.exitCode=1;}finally{s.close();}
