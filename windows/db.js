'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const initSqlJs = require('./vendor/sqljs/sql-wasm.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  space_id TEXT DEFAULT 'personal',
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  all_day INTEGER DEFAULT 0,
  status TEXT DEFAULT 'todo',
  priority INTEGER DEFAULT 0,
  list_id TEXT,
  tags TEXT DEFAULT '',
  repeat_rule TEXT,
  remind_offset INTEGER,
  estimate_min INTEGER,
  actual_min INTEGER,
  postponed INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  deleted_at INTEGER,
  field_ts TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_logs (
  space_id TEXT NOT NULL DEFAULT 'personal',
  date TEXT NOT NULL,
  mood INTEGER,
  summary TEXT,
  highlight TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (space_id, date)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS fired_reminders (
  entry_id TEXT NOT NULL,
  date TEXT NOT NULL,
  fired_at INTEGER,
  PRIMARY KEY (entry_id, date)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT,
  created_at INTEGER,
  last_seen INTEGER,
  revoked INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  expires_at INTEGER,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT UNIQUE,
  space_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  fields TEXT,
  updated_at INTEGER,
  device_id TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_changes_space ON changes(space_id, seq);
`;

const FIELD_COL = {
  title: 'title', notes: 'notes', date: 'date', start: 'start_time', end: 'end_time',
  allDay: 'all_day', status: 'status', priority: 'priority', listId: 'list_id',
  tags: 'tags', remindOffset: 'remind_offset', estimate: 'estimate_min', actual: 'actual_min',
  postponed: 'postponed',
};

const LISTS = [
  { id: 'work', name: '工作', color: '#1F6F78' },
  { id: 'life', name: '生活', color: '#BF6F3E' },
  { id: 'study', name: '学习', color: '#6B5B95' },
];

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function mondayOf(s) {
  const d = parseYmd(s);
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - wd);
  return ymd(d);
}

class Store {
  constructor() {
    this.db = null;
    this.dataDir = null;
    this.file = null;
    this.saveTimer = null;
    this.dirty = false;
    this.spaceId = 'personal';
    this.deviceId = null;
  }

  async init(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    this.file = path.join(dataDir, 'daygrid.db');

    const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, 'vendor', 'sqljs', f) });
    if (fs.existsSync(this.file)) {
      this.db = new SQL.Database(fs.readFileSync(this.file));
    } else {
      this.db = new SQL.Database();
    }
    this.db.exec(SCHEMA);
    this.migrate();
    this.ensureIdentity();
    this.seedLists();
    this.backupIfNeeded();
    this.seedDemoIfFirstRun();
    this.persistNow();
    this.backupIfNeeded();
  }

  migrate() {
    const cols = this.all('PRAGMA table_info(entries)').map((r) => r.name);
    if (!cols.includes('postponed')) this.db.exec('ALTER TABLE entries ADD COLUMN postponed INTEGER DEFAULT 0');
    if (!cols.includes('tags')) this.db.exec("ALTER TABLE entries ADD COLUMN tags TEXT DEFAULT ''");
    if (!cols.includes('space_id')) this.db.exec("ALTER TABLE entries ADD COLUMN space_id TEXT DEFAULT 'personal'");
    if (!cols.includes('field_ts')) this.db.exec("ALTER TABLE entries ADD COLUMN field_ts TEXT DEFAULT '{}'");

    const logCols = this.all('PRAGMA table_info(daily_logs)').map((r) => r.name);
    if (logCols.length && !logCols.includes('space_id')) {
      this.db.exec(`
        CREATE TABLE daily_logs_new (
          space_id TEXT NOT NULL DEFAULT 'personal',
          date TEXT NOT NULL,
          mood INTEGER,
          summary TEXT,
          highlight TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          PRIMARY KEY (space_id, date)
        );
        INSERT INTO daily_logs_new (space_id,date,mood,summary,highlight,created_at,updated_at)
          SELECT 'personal',date,mood,summary,highlight,created_at,updated_at FROM daily_logs;
        DROP TABLE daily_logs;
        ALTER TABLE daily_logs_new RENAME TO daily_logs;
      `);
    }
  }

  ensureIdentity() {
    this.db.run("INSERT OR IGNORE INTO spaces (id,name,created_at) VALUES ('personal','我',?)", [Date.now()]);
    let pcId = this.setting('pcDeviceId', null);
    if (!pcId) {
      pcId = 'pc-' + crypto.randomUUID().slice(0, 8);
      this.setSetting('pcDeviceId', pcId);
      this.db.run('INSERT OR IGNORE INTO devices (id,space_id,name,token_hash,created_at,last_seen,revoked) VALUES (?,?,?,?,?,?,0)',
        [pcId, 'personal', 'Windows 电脑', null, Date.now(), Date.now()]);
    }
    this.deviceId = pcId;
    this.spaceId = this.setting('activeSpace', 'personal') || 'personal';
  }

  seedLists() {
    for (const l of LISTS) {
      this.db.run('INSERT OR IGNORE INTO lists (id,name,color,sort) VALUES (?,?,?,?)', [l.id, l.name, l.color, LISTS.indexOf(l)]);
    }
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistNow(); }, 250);
  }

  persistNow() {
    if (!this.db) return;
    const data = Buffer.from(this.db.export());
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  backupIfNeeded() {
    if (!fs.existsSync(this.file)) return;
    const target = path.join(this.dataDir, 'backups', 'daygrid-' + ymd(new Date()) + '.db');
    if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    const files = fs.readdirSync(path.join(this.dataDir, 'backups')).filter((f) => f.startsWith('daygrid-')).sort();
    while (files.length > 30) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(this.dataDir, 'backups', f)); } catch (_) {}
    }
  }

  seedDemoIfFirstRun() {
    const flag = this.get('SELECT value FROM meta WHERE key = ?', ['seeded']);
    if (flag) return;
    if (this.get('SELECT COUNT(*) AS n FROM entries').n > 0) {
      this.run('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)', ['seeded', '1']);
      return;
    }
    const today = ymd(new Date());
    const now = Date.now();
    const add = (title, date, start, end, list, status, priority = 0) => {
      this.run(
        `INSERT INTO entries (id,title,notes,date,start_time,end_time,all_day,status,priority,list_id,tags,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), title, '', date, start, end, 0, status, priority, list, '', now, now]
      );
    };
    add('周会', today, '09:30', '10:00', 'work', 'done');
    add('改预算表', today, '11:00', '12:00', 'work', 'done');
    add('和张总过方案', today, '14:00', '15:00', 'work', 'todo', 2);
    add('取快递', today, '18:00', '18:20', 'life', 'todo');
    add('读《深度工作》30 页', today, '21:00', '21:40', 'study', 'todo');
    add('交电费', today, null, null, 'life', 'todo');
    add('给妈妈打电话', today, null, null, 'life', 'todo');
    add('季度总结', addDays(today, 1), null, null, 'work', 'todo', 2);
    add('整理报销单', addDays(today, 2), null, null, 'life', 'todo');
    add('月度复盘', addDays(today, 15), null, null, 'work', 'todo');
    this.run('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)', ['seeded', '1']);
    this.setSetting('demoData', '1');
  }

  listOf(id) {
    return LISTS.find((l) => l.id === id) || { name: '未分类', color: '#9AA39F' };
  }

  shape(r) {
    const l = this.listOf(r.list_id);
    return {
      id: r.id,
      title: r.title,
      notes: r.notes || '',
      date: r.date,
      start: r.start_time,
      end: r.end_time,
      allDay: !!r.all_day,
      status: r.status,
      priority: r.priority || 0,
      listId: r.list_id,
      listName: l.name,
      listColor: l.color,
      tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
      postponed: r.postponed || 0,
      estimate: r.estimate_min || 0,
    };
  }

  range(from, to) {
    return this.all(
      'SELECT * FROM entries WHERE space_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date, COALESCE(start_time, \'99:99\')',
      [this.spaceId, from, to]
    ).map((r) => this.shape(r));
  }

  day(date) {
    return this.range(date, date);
  }

  create(input) {
    const now = Date.now();
    const id = crypto.randomUUID();
    const fields = {
      title: input.title || '未命名',
      notes: input.notes || '',
      date: input.date || ymd(new Date()),
      start: input.start || null,
      end: input.end || null,
      allDay: input.allDay ? 1 : 0,
      status: 'todo',
      priority: input.priority || 0,
      listId: input.listId || 'work',
      tags: (input.tags || []).join(','),
      remindOffset: input.remindOffset == null ? 10 : input.remindOffset,
      estimate: input.estimate || null,
    };
    const ts = {};
    for (const k of Object.keys(fields)) ts[k] = now;
    this.run(
      `INSERT INTO entries (id,space_id,title,notes,date,start_time,end_time,all_day,status,priority,list_id,tags,remind_offset,estimate_min,created_at,updated_at,field_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, this.spaceId, fields.title, fields.notes, fields.date, fields.start, fields.end, fields.allDay,
       fields.status, fields.priority, fields.listId, fields.tags, fields.remindOffset, fields.estimate, now, now, JSON.stringify(ts)]
    );
    this.recordChange('entry', id, 'upsert', fields, now);
    return this.shape(this.get('SELECT * FROM entries WHERE id = ?', [id]));
  }

  update(id, patch) {
    const row = this.get('SELECT * FROM entries WHERE id = ?', [id]);
    if (!row) return null;
    const fields = {};
    for (const k of Object.keys(FIELD_COL)) {
      if (patch[k] !== undefined) fields[k] = patch[k];
    }
    if (patch.tags !== undefined) fields.tags = (patch.tags || []).join(',');
    if (!Object.keys(fields).length) return this.shape(row);
    const now = Date.now();
    if (patch.date && patch.date !== row.date) fields.postponed = (row.postponed || 0) + 1;
    const ts = JSON.parse(row.field_ts || '{}');
    for (const k of Object.keys(fields)) ts[k] = now;
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${FIELD_COL[k] || k} = ?`);
      vals.push(v);
    }
    sets.push('field_ts = ?');
    vals.push(JSON.stringify(ts));
    sets.push('updated_at = ?');
    vals.push(now);
    vals.push(id);
    this.run(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`, vals);
    this.recordChange('entry', id, 'upsert', fields, now);
    return this.shape(this.get('SELECT * FROM entries WHERE id = ?', [id]));
  }

  toggle(id) {
    const row = this.get('SELECT * FROM entries WHERE id = ?', [id]);
    if (!row) return null;
    const status = row.status === 'done' ? 'todo' : 'done';
    return this.update(id, { status });
  }

  remove(id) {
    const now = Date.now();
    this.run('UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    this.recordChange('entry', id, 'delete', {}, now);
  }

  dueReminders(now = new Date()) {
    const date = ymd(now);
    const mins = now.getHours() * 60 + now.getMinutes();
    const rows = this.all(
      "SELECT * FROM entries WHERE space_id = ? AND date = ? AND start_time IS NOT NULL AND status != 'done' AND deleted_at IS NULL",
      [this.spaceId, date]
    );
    return rows
      .filter((r) => {
        const [h, m] = r.start_time.split(':').map(Number);
        const start = h * 60 + m;
        const offset = r.remind_offset == null ? 10 : r.remind_offset;
        const fire = start - offset;
        if (mins < fire || mins > start) return false;
        return !this.get('SELECT 1 FROM fired_reminders WHERE entry_id = ? AND date = ?', [r.id, date]);
      })
      .map((r) => this.shape(r));
  }

  markFired(entryId, date) {
    this.run('INSERT OR REPLACE INTO fired_reminders (entry_id, date, fired_at) VALUES (?,?,?)', [entryId, date, Date.now()]);
  }

  getLog(date) {
    const r = this.get('SELECT * FROM daily_logs WHERE space_id = ? AND date = ?', [this.spaceId, date]);
    return r ? { date: r.date, mood: r.mood, summary: r.summary, highlight: r.highlight } : { date, mood: null, summary: '', highlight: '' };
  }

  logsRange(from, to) {
    return this.all('SELECT * FROM daily_logs WHERE space_id = ? AND date >= ? AND date <= ? ORDER BY date', [this.spaceId, from, to])
      .map((r) => ({ date: r.date, mood: r.mood, summary: r.summary, highlight: r.highlight }));
  }

  setLog(date, { mood, summary, highlight }) {
    const now = Date.now();
    const cur = this.get('SELECT * FROM daily_logs WHERE space_id = ? AND date = ?', [this.spaceId, date]);
    const fields = {};
    if (mood !== undefined) fields.mood = mood;
    if (summary !== undefined) fields.summary = summary;
    if (highlight !== undefined) fields.highlight = highlight;
    if (cur) {
      this.run('UPDATE daily_logs SET mood = ?, summary = ?, highlight = ?, updated_at = ? WHERE space_id = ? AND date = ?',
        [fields.mood === undefined ? cur.mood : fields.mood,
         fields.summary === undefined ? cur.summary : fields.summary,
         fields.highlight === undefined ? cur.highlight : fields.highlight,
         now, this.spaceId, date]);
    } else {
      this.run('INSERT INTO daily_logs (space_id,date,mood,summary,highlight,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [this.spaceId, date, fields.mood || null, fields.summary || '', fields.highlight || '', now, now]);
    }
    this.recordChange('log', date, 'upsert', fields, now);
    return this.getLog(date);
  }

  weekStats(startDate) {
    const from = mondayOf(startDate);
    const to = addDays(from, 6);
    const list = this.range(from, to).filter((e) => e.status !== 'canceled');
    const done = list.filter((e) => e.status === 'done').length;
    const planned = list.length;
    const postponed = list.reduce((a, e) => a + e.postponed, 0);
    const byList = {};
    for (const e of list) {
      const key = e.listId || 'none';
      byList[key] = byList[key] || { name: e.listName, color: e.listColor, min: 0, done: 0 };
      byList[key].min += e.estimate || 30;
      if (e.status === 'done') byList[key].done += 1;
    }
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(from, i);
      const es = list.filter((e) => e.date === d);
      days.push({ date: d, done: es.filter((e) => e.status === 'done').length, total: es.length });
    }
    const streak = this.streak(ymd(new Date()));
    return { from, to, planned, done, rate: planned ? Math.round((done / planned) * 100) : 0, postponed, byList, days, streak };
  }

  streak(endDate) {
    let n = 0;
    let d = endDate;
    for (let i = 0; i < 365; i++) {
      const rows = this.all("SELECT COUNT(*) AS n FROM entries WHERE space_id = ? AND date = ? AND status = 'done' AND deleted_at IS NULL", [this.spaceId, d]);
      const log = this.get('SELECT summary FROM daily_logs WHERE space_id = ? AND date = ?', [this.spaceId, d]);
      if (rows[0].n > 0 || (log && log.summary)) n++;
      else if (i > 0) break;
      d = addDays(d, -1);
    }
    return n;
  }

  heat(days) {
    const end = ymd(new Date());
    const start = addDays(end, -(days - 1));
    const rows = this.all(
      "SELECT date, COUNT(*) AS n FROM entries WHERE space_id = ? AND deleted_at IS NULL AND status = 'done' AND date >= ? AND date <= ? GROUP BY date",
      [this.spaceId, start, end]
    );
    const m = {};
    for (const r of rows) m[r.date] = r.n;
    const out = [];
    for (let i = 0; i < days; i++) out.push({ date: addDays(start, i), n: m[addDays(start, i)] || 0 });
    return out;
  }

  exportAll() {
    return {
      app: 'daygrid',
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: this.all('SELECT * FROM entries WHERE deleted_at IS NULL'),
      lists: this.all('SELECT * FROM lists'),
      dailyLogs: this.all('SELECT * FROM daily_logs'),
      settings: this.all('SELECT * FROM settings'),
    };
  }

  countsByDate(from, to) {
    const rows = this.all(
      'SELECT date, list_id, status FROM entries WHERE space_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ?',
      [this.spaceId, from, to]
    );
    const m = {};
    for (const r of rows) {
      m[r.date] = m[r.date] || { total: 0, lists: [], done: 0 };
      m[r.date].total++;
      if (!m[r.date].lists.includes(r.list_id)) m[r.date].lists.push(r.list_id);
      if (r.status === 'done') m[r.date].done++;
    }
    return m;
  }

  recordChange(entity, entityId, op, fields, updatedAt) {
    const opId = crypto.randomUUID();
    this.db.run(
      `INSERT OR IGNORE INTO changes (op_id,space_id,entity,entity_id,op,fields,updated_at,device_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [opId, this.spaceId, entity, entityId, op, JSON.stringify(fields || {}), updatedAt || Date.now(), this.deviceId, Date.now()]
    );
    this.markDirty();
    return opId;
  }

  changesSince(cursor, excludeDevice) {
    return this.all(
      'SELECT * FROM changes WHERE space_id = ? AND seq > ? AND (device_id IS NULL OR device_id != ?) ORDER BY seq LIMIT 500',
      [this.spaceId, cursor || 0, excludeDevice || '']
    ).map((r) => ({
      seq: r.seq, op_id: r.op_id, space_id: r.space_id, entity: r.entity,
      entity_id: r.entity_id, op: r.op, fields: JSON.parse(r.fields || '{}'),
      updated_at: r.updated_at, device_id: r.device_id,
    }));
  }

  latestSeq() {
    const r = this.get('SELECT MAX(seq) AS s FROM changes WHERE space_id = ?', [this.spaceId]);
    return (r && r.s) || 0;
  }

  applyRemoteOps(ops, fromDevice, record = true) {
    let applied = 0;
    for (const op of ops) {
      if (!op || !op.entity) continue;
      if (op.entity === 'entry') { this.applyEntryOp(op); applied++; }
      else if (op.entity === 'log') { this.applyLogOp(op); applied++; }
      if (record) {
        this.db.run(
          `INSERT OR IGNORE INTO changes (op_id,space_id,entity,entity_id,op,fields,updated_at,device_id,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [op.op_id || crypto.randomUUID(), op.space_id || this.spaceId, op.entity, op.entity_id,
           op.op, JSON.stringify(op.fields || {}), op.updated_at || Date.now(), op.device_id || fromDevice, Date.now()]
        );
      }
    }
    if (applied) this.markDirty();
    return applied;
  }

  applyEntryOp(op) {
    const tsNow = op.updated_at || Date.now();
    const row = this.get('SELECT * FROM entries WHERE id = ?', [op.entity_id]);
    if (op.op === 'delete') {
      if (row) this.db.run('UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?',
        [tsNow, Math.max(row.updated_at || 0, tsNow), op.entity_id]);
      return;
    }
    const f = op.fields || {};
    if (Array.isArray(f.tags)) f.tags = f.tags.join(',');
    if (!row) {
      const ts = {};
      for (const k of Object.keys(f)) ts[k] = tsNow;
      this.db.run(
        `INSERT INTO entries (id,space_id,title,notes,date,start_time,end_time,all_day,status,priority,list_id,tags,remind_offset,estimate_min,created_at,updated_at,field_ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [op.entity_id, this.spaceId, f.title || '未命名', f.notes || '', f.date || ymd(new Date()),
         f.start || null, f.end || null, f.allDay || 0, f.status || 'todo', f.priority || 0,
         f.listId || 'work', f.tags || '', f.remindOffset == null ? 10 : f.remindOffset,
         f.estimate || null, tsNow, tsNow, JSON.stringify(ts)]
      );
      return;
    }
    const ts = JSON.parse(row.field_ts || '{}');
    const sets = [];
    const vals = [];
    let changed = false;
    for (const [k, v] of Object.entries(f)) {
      if (tsNow > (ts[k] || 0)) {
        sets.push(`${FIELD_COL[k] || k} = ?`);
        vals.push(v);
        ts[k] = tsNow;
        changed = true;
      }
    }
    if (!changed) return;
    sets.push('field_ts = ?');
    vals.push(JSON.stringify(ts));
    sets.push('updated_at = ?');
    vals.push(Math.max(row.updated_at || 0, tsNow));
    vals.push(op.entity_id);
    this.db.run(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  applyLogOp(op) {
    const f = op.fields || {};
    const cur = this.get('SELECT * FROM daily_logs WHERE space_id = ? AND date = ?', [this.spaceId, op.entity_id]);
    if (op.op === 'delete') {
      if (cur) this.db.run('DELETE FROM daily_logs WHERE space_id = ? AND date = ?', [this.spaceId, op.entity_id]);
      return;
    }
    if (!cur) {
      this.db.run('INSERT INTO daily_logs (space_id,date,mood,summary,highlight,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        [this.spaceId, op.entity_id, f.mood || null, f.summary || '', f.highlight || '', op.updated_at, op.updated_at]);
    } else if ((op.updated_at || 0) > (cur.updated_at || 0)) {
      this.db.run('UPDATE daily_logs SET mood = ?, summary = ?, highlight = ?, updated_at = ? WHERE space_id = ? AND date = ?',
        [f.mood !== undefined ? f.mood : cur.mood,
         f.summary !== undefined ? f.summary : cur.summary,
         f.highlight !== undefined ? f.highlight : cur.highlight,
         op.updated_at, this.spaceId, op.entity_id]);
    }
  }

  createPairingCode() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.db.run('INSERT OR REPLACE INTO pairing_codes (code,space_id,expires_at,used) VALUES (?,?,?,0)',
      [code, this.spaceId, Date.now() + 10 * 60 * 1000]);
    this.markDirty();
    return { code, expiresAt: Date.now() + 10 * 60 * 1000 };
  }

  pairDevice(code, name) {
    const row = this.get('SELECT * FROM pairing_codes WHERE code = ? AND used = 0', [String(code)]);
    if (!row || row.expires_at < Date.now()) return null;
    const token = crypto.randomBytes(24).toString('hex');
    const id = 'dev-' + crypto.randomUUID().slice(0, 8);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    this.db.run('INSERT INTO devices (id,space_id,name,token_hash,created_at,last_seen,revoked) VALUES (?,?,?,?,?,?,0)',
      [id, row.space_id || this.spaceId, String(name || '手机').slice(0, 40), hash, Date.now(), Date.now()]);
    this.db.run('UPDATE pairing_codes SET used = 1 WHERE code = ?', [code]);
    this.markDirty();
    return { deviceId: id, token, spaceId: row.space_id || this.spaceId };
  }

  verifyToken(deviceId, token) {
    const row = this.get('SELECT * FROM devices WHERE id = ? AND revoked = 0', [deviceId]);
    if (!row || !row.token_hash) return null;
    const hash = crypto.createHash('sha256').update(token || '').digest('hex');
    if (hash !== row.token_hash) return null;
    this.db.run('UPDATE devices SET last_seen = ? WHERE id = ?', [Date.now(), deviceId]);
    return row;
  }

  devices(spaceId) {
    return this.all('SELECT id,name,created_at,last_seen,revoked FROM devices WHERE space_id = ? ORDER BY created_at', [spaceId || this.spaceId]);
  }

  revokeDevice(id) {
    this.db.run('UPDATE devices SET revoked = 1 WHERE id = ?', [id]);
    this.markDirty();
  }

  space() {
    return this.get('SELECT * FROM spaces WHERE id = ?', [this.spaceId]);
  }

  setting(key, fallback) {
    const r = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return r ? r.value : fallback;
  }

  setSetting(key, value) {
    this.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, String(value)]);
  }

  clearAll() {
    this.db.exec('DELETE FROM entries; DELETE FROM daily_logs; DELETE FROM meta;');
    this.run('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)', ['seeded', '1']);
    this.persistNow();
  }

  info() {
    const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    return { dataDir: this.dataDir, file: this.file, size, backups: fs.readdirSync(path.join(this.dataDir, 'backups')).length };
  }
}

module.exports = { Store, ymd, addDays, mondayOf, parseYmd };
