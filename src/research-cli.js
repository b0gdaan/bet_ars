import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db.js';
import { dataDir } from './config.js';
import { dataAudit,scouting } from './research.js';
import { backtest } from './analytics.js';
import { backupStore,enrichFromCache,importRounds,validateRounds,loadRoles } from './features.js';

const [command='audit',file]=process.argv.slice(2),store=new Store();
try {
  if(command==='enrich'){
    console.log('Резервная копия:',await backupStore(store));
    console.log(JSON.stringify(enrichFromCache(store),null,2));
  }else if(command==='import-rounds'){
    if(!file)throw new Error('Укажите путь к JSON-файлу раундов');
    const rows=JSON.parse(readFileSync(file,'utf8'));validateRounds(rows,store);
    console.log('Резервная копия:',await backupStore(store));
    console.log(JSON.stringify(importRounds(rows,store),null,2));
  }else if(command==='audit'){
    const source=file||'bo3';if(!['bo3','faceit','pandascore'].includes(source))throw new Error('Источник: bo3 | faceit | pandascore');
    const matches=store.all(source),form=scouting(matches,{roles:loadRoles()}),{rows,...scoutingSummary}=form;
    const report={generatedAt:new Date().toISOString(),source,audit:dataAudit(matches,store.rounds(source)),scouting:scoutingSummary,backtest:backtest(matches)};
    const dir=join(dataDir,'reports');mkdirSync(dir,{recursive:true});const path=join(dir,`${source}-research.json`);writeFileSync(path,JSON.stringify(report,null,2));
    console.log(JSON.stringify({path,...report},null,2));
  }else throw new Error('Команды: audit [source], enrich, import-rounds <file.json>');
}catch(e){console.error(e.message);process.exitCode=1;}finally{store.close();}
