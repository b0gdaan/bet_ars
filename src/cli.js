import { Store } from './db.js';
import { collect } from './collectors.js';
const args=process.argv.slice(2),input={};
for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined)throw new Error('Формат: --source bo3 --limit 1000 --statsLimit 100');input[args[i].slice(2)]=args[i+1];}
const store=new Store();
try {const report=await collect(store,input,p=>console.log(p.message));console.log(JSON.stringify(report,null,2));}catch(e){console.error(e.message);process.exitCode=1;}finally{store.close();}
