import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { parseEnv } from '../src/config.js';
import { bo3Match, faceitMatch } from '../src/adapters.js';
import { collect } from '../src/collectors.js';
import { ApiError } from '../src/http.js';
import { csv } from '../src/server.js';

test('.env parsing survives a Notepad BOM, digits in names and quoted values',()=>{
  const v=parseEnv('﻿ODDSPAPI_API_KEY=abc123\r\n# comment\r\nS3_KEY="quoted"\r\nlower=ignored\r\nPORT=3210');
  assert.equal(v.ODDSPAPI_API_KEY,'abc123','BOM не должен прятать первый ключ');
  assert.equal(v.S3_KEY,'quoted');assert.equal(v.PORT,'3210');
  assert.equal(v.lower,undefined);
});

test('A FACEIT match without timestamps is skipped instead of crashing the import',()=>{
  const m={match_id:'x',game:'cs2',status:'FINISHED',results:{winner:'faction1',score:{faction1:13,faction2:5}},
    teams:{faction1:{faction_id:'a',roster:[]},faction2:{faction_id:'b',roster:[]}}};
  assert.doesNotThrow(()=>faceitMatch(m));
  assert.equal(faceitMatch(m),null);
  assert.ok(faceitMatch({...m,started_at:1767261600}),'со временем начала матч разбирается');
});

test('A BO3 match without a slug gets no fake URL',()=>{
  const raw={id:1,status:'finished',game_version:2,start_date:'2026-01-01T10:00:00Z',end_date:'2026-01-01T12:00:00Z',
    team1:{id:10,name:'A'},team2:{id:20,name:'B'},winner_team_id:10,team1_score:2,team2_score:0,bo_type:3,games:[]};
  assert.equal(bo3Match(raw).url,null);
  assert.equal(bo3Match({...raw,slug:'a-vs-b'}).url,'https://bo3.gg/matches/a-vs-b');
});

test('A failed stats request waits a day instead of heading the queue on every run',async()=>{
  const store=new Store(':memory:');
  const row={id:7,slug:'a-vs-b-7',status:'finished',game_version:2,start_date:'2026-01-01T10:00:00Z',end_date:'2026-01-01T12:00:00Z',
    team1:{id:10,name:'A'},team2:{id:20,name:'B'},winner_team_id:10,team1_score:2,team2_score:0,bo_type:3,games:[]};
  let statsCalls=0;
  const client={requests:0,cacheHits:0,async get(base,path){
    if(path==='/matches')return {results:[row],total:{count:1}};
    statsCalls++;throw new ApiError('bo3.gg: Ошибка источника (HTTP 502)',502);
  }};
  const input={source:'bo3',from:'2026-01-01',to:'2026-01-01',limit:10,statsLimit:10};
  const first=await collect(store,input,()=>{},{client});
  assert.equal(statsCalls,1);assert.equal(first.warnings.length,1);
  assert.ok(store.get('bo3:7').statsCheckedAt,'попытка должна быть отмечена');
  await collect(store,input,()=>{},{client});
  assert.equal(statsCalls,1,'повторный запуск в течение суток не тратит бюджет на тот же матч');
  // An authorization failure still stops the whole run.
  const denied={...client,async get(base,path){if(path==='/matches')return {results:[{...row,id:8,slug:'x-8'}],total:{count:1}};throw new ApiError('denied',403);}};
  await assert.rejects(collect(store,input,()=>{},{client:denied}),/denied/);
  store.close();
});

test('CSV keeps negative numbers numeric and still neutralises formula text',()=>{
  const out=csv([{profit:-100,weight:-0.198,name:'=cmd()',note:'-5 text',plain:'Spirit'}]);
  const cells=out.split('\r\n')[1].split(',');
  assert.equal(cells[0],'"-100"','число остаётся числом');
  assert.equal(cells[1],'"-0.198"');
  assert.equal(cells[2],`"'=cmd()"`,'формула в тексте нейтрализуется');
  assert.equal(cells[3],`"'-5 text"`);
  assert.equal(cells[4],'"Spirit"');
});
