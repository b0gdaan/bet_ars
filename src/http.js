import { setTimeout as sleep } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(message, status=0) { super(message); this.status=status; }
}
// JSON numbers cannot safely hold 64-bit Steam IDs. Preserve them before parsing.
export function parseJSON(text) { return JSON.parse(text.replace(/("(?:steam_id_64|steamid|steam_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"')); }
export class Client {
  constructor(store, { fetcher=fetch, delay=800, pause=sleep }={}) { this.store=store; this.fetcher=fetcher; this.delay=delay; this.pause=pause; this.last=0; this.requests=0; this.cacheHits=0; }
  async get(base,path,params={},token='',ttl=24*3600_000) {
    const url = new URL(base+path);
    for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null && v!=='') url.searchParams.set(k,String(v));
    const cache = this.store.cached(url.href,ttl);
    if (cache) { this.cacheHits++; return parseJSON(cache); }
    for (let attempt=0;attempt<4;attempt++) {
      await this.pause(Math.max(0,this.delay-(Date.now()-this.last)));
      this.last=Date.now(); this.requests++;
      let r;
      try { r=await this.fetcher(url,{headers:{Accept:'application/json','User-Agent':'CS2MatchLab/0.1 (local research)',...(token?{Authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(25000),redirect:'error'}); }
      catch { throw new ApiError(`Не удалось подключиться к ${url.hostname}. Проверьте интернет и повторите загрузку.`); }
      if ((r.status===429 || r.status>=500) && attempt<3) {
        const retry=r.headers.get('retry-after');
        const seconds=Number(retry) || Math.max(0,(Date.parse(retry)-Date.now())/1000) || 2**attempt;
        await this.pause(Math.min(60,seconds)*1000); continue;
      }
      if (!r.ok) {
        const messages={401:'Ключ отсутствует или недействителен',403:'Источник отказал в доступе; проверьте права ключа',404:'Данные не найдены',429:'Лимит запросов исчерпан; повторите позже'};
        throw new ApiError(`${url.hostname}: ${messages[r.status]||'Ошибка источника'} (HTTP ${r.status})`,r.status);
      }
      const body=await r.text();
      let value;
      try { value=parseJSON(body); } catch { throw new ApiError(`${url.hostname}: вместо JSON получен другой формат ответа`); }
      this.store.cache(url.href,body);
      return value;
    }
  }
}
