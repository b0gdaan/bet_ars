import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

export class Store {
  constructor(path) {
    if (!path) { mkdirSync(dataDir, { recursive: true }); path = join(dataDir, 'cs2.sqlite'); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, source TEXT NOT NULL, start TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS matches_source_start ON matches(source,start);
      CREATE TABLE IF NOT EXISTS cache (url TEXT PRIMARY KEY, fetched INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, source TEXT, started TEXT, ended TEXT, status TEXT, summary TEXT);
    `);
  }
  put(m) {
    if (!m || !m.id || !m.source || !m.teamA?.id || !m.teamB?.id || m.teamA.id === m.teamB.id || !Number.isFinite(Date.parse(m.start))) throw new Error('Некорректная запись матча');
    if (![m.teamA.id, m.teamB.id].includes(m.winner)) throw new Error('Победитель не совпадает с участниками');
    const old = this.get(m.id);
    if(old?.statsCheckedAt&&!m.statsCheckedAt)m.statsCheckedAt=old.statsCheckedAt;
    // Listing refresh must not erase separately collected historical statistics.
    if (old?.players?.length && !m.players?.length) { m.players = old.players; m.statsFetchedAt = old.statsFetchedAt; }
    if (old?.statsFetchedAt && !m.statsFetchedAt && m.players?.length) {
      m.players=m.players.map(p=>({...p,...(old.players.find(x=>x.id===p.id)||{})}));m.statsFetchedAt=old.statsFetchedAt;
    }
    if (old?.maps?.length && !m.maps?.length) m.maps = old.maps;
    this.db.prepare('INSERT INTO matches VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,start=excluded.start,data=excluded.data,updated=excluded.updated')
      .run(m.id, m.source, m.start, JSON.stringify(m), new Date().toISOString());
    return !old;
  }
  get(id) { const row = this.db.prepare('SELECT data FROM matches WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  all(source) {
    const rows = source ? this.db.prepare('SELECT data FROM matches WHERE source=? ORDER BY start,id').all(source) : this.db.prepare('SELECT data FROM matches ORDER BY start,id').all();
    return rows.map(r => JSON.parse(r.data));
  }
  cached(url, ttl) { const r = this.db.prepare('SELECT * FROM cache WHERE url=?').get(url); return r && Date.now()-r.fetched < ttl ? r.body : null; }
  cache(url, body) { this.db.prepare('INSERT INTO cache VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET fetched=excluded.fetched,body=excluded.body').run(url,Date.now(),body); }
  startRun(source) { return Number(this.db.prepare('INSERT INTO runs(source,started,status) VALUES(?,?,?)').run(source,new Date().toISOString(),'running').lastInsertRowid); }
  endRun(id,status,summary) { this.db.prepare('UPDATE runs SET ended=?,status=?,summary=? WHERE id=?').run(new Date().toISOString(),status,JSON.stringify(summary),id); }
  runs() { return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 15').all().map(x=>({...x,summary:x.summary?JSON.parse(x.summary):null})); }
  counts() { return Object.fromEntries(this.db.prepare('SELECT source,COUNT(*) AS count FROM matches GROUP BY source').all().map(r=>[r.source,r.count])); }
  close() { this.db.close(); }
}
