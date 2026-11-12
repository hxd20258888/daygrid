'use strict';

/* =========================================================
   日格 · 移动端
   本地优先：所有数据先写 IndexedDB，再按需与电脑同步。
   ========================================================= */

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const TODAY = ymd(new Date());
const $ = (id) => document.getElementById(id);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());

/* ---------------- IndexedDB ---------------- */
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('daygrid', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('entries')) {
        const s = d.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('logs')) d.createObjectStore('logs', { keyPath: 'date' });
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'op_id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function ask(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function get(name, key) { return ask(store(name).get(key)); }
function put(name, val) { return ask(store(name, 'readwrite').put(val)); }
function del(name, key) { return ask(store(name, 'readwrite').delete(key)); }
function all(name) { return ask(store(name).getAll()); }

async function metaGet(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
async function metaSet(key, value) { await put('meta', { key, value }); }

/* ---------------- 数据 ---------------- */
const FIELD_TS_DEFAULT = {};

function newEntry(input) {
  const now = Date.now();
  const e = {
    id: uuid(),
    title: input.title || '未命名',
    notes: input.notes || '',
    date: input.date || TODAY,
    start: input.start || null,
    end: input.end || null,
    allDay: !!input.allDay,
    status: 'todo',
    priority: input.priority || 0,
    listId: input.listId || 'work',
    tags: input.tags || [],
    remindOffset: input.remindOffset == null ? 10 : input.remindOffset,
    estimate: input.estimate || null,
    postponed: 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    field_ts: {},
  };
  for (const k of Object.keys(e)) if (k !== 'id' && k !== 'field_ts') e.field_ts[k] = now;
  return e;
}

async function queueOp(op, entity, entityId, fields, ts) {
  await put('outbox', { op_id: uuid(), entity, entity_id: entityId, op, fields, updated_at: ts, created_at: Date.now() });
  scheduleSync();
}

async function createEntry(input) {
  const e = newEntry(input);
  await put('entries', e);
  const fields = {};
  for (const k of Object.keys(e)) {
    if (['id', 'field_ts', 'created_at', 'updated_at', 'deleted_at'].includes(k)) continue;
    fields[k] = e[k];
  }
  await queueOp('upsert', 'entry', e.id, fields, e.updated_at);
  return e;
}

async function patchEntry(id, patch) {
  const e = await get('entries', id);
  if (!e) return null;
  const now = Date.now();
  const ts = e.field_ts || {};
  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    e[k] = v;
    ts[k] = now;
    fields[k] = v;
  }
  e.updated_at = now;
  e.field_ts = ts;
  await put('entries', e);
  await queueOp('upsert', 'entry', id, fields, now);
  return e;
}

async function toggleEntry(id) {
  const e = await get('entries', id);
  if (!e) return;
  await patchEntry(id, { status: e.status === 'done' ? 'todo' : 'done' });
}

async function removeEntry(id) {
  const e = await get('entries', id);
  if (!e) return;
  const now = Date.now();
  e.deleted_at = now;
  e.updated_at = now;
  await put('entries', e);
  await queueOp('delete', 'entry', id, {}, now);
}

async function setLog(date, patch) {
  const cur = (await get('logs', date)) || { date, mood: null, summary: '', highlight: '', updated_at: 0 };
  const now = Date.now();
  const fields = {};
  for (const [k, v] of Object.entries(patch)) { cur[k] = v; fields[k] = v; }
  cur.updated_at = now;
  await put('logs', cur);
  await queueOp('upsert', 'log', date, fields, now);
}

async function rangeEntries(from, to) {
  const rows = await all('entries');
  return rows
    .filter((e) => !e.deleted_at && e.date >= from && e.date <= to)
    .sort((a, b) => (a.start || '99:99').localeCompare(b.start || '99:99'));
}

/* ---------------- 同步（云端盲存储 + 端到端加密） ---------------- */
const SYNC_KEY = 'daygrid.sync';
const syncCfg = {
  get() { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch (_) { return null; } },
  set(v) { localStorage.setItem(SYNC_KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(SYNC_KEY); },
};

let syncKey = null;
let syncing = false;
let syncTimer = null;

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKey() {
  const c = syncCfg.get();
  if (!c || !c.pass) return null;
  if (syncKey) return syncKey;
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(c.pass), 'PBKDF2', false, ['deriveKey']);
  syncKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('daygrid|' + c.space), iterations: 150000, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return syncKey;
}

async function encryptObj(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: b64(iv), data: b64(ct) };
}

async function decryptObj(key, ivB64, dataB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(dataB64));
  return JSON.parse(new TextDecoder().decode(pt));
}

function scheduleSync() {
  if (!syncCfg.get()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch(() => {}), 2500);
}

async function applySnapshotEncrypted(key, snap) {
  const payload = await decryptObj(key, snap.iv, snap.data);
  for (const raw of payload.entries || []) {
    const e = {
      id: raw.id,
      title: raw.title,
      notes: raw.notes || '',
      date: raw.date,
      start: raw.start !== undefined ? raw.start : raw.start_time,
      end: raw.end !== undefined ? raw.end : raw.end_time,
      allDay: raw.allDay !== undefined ? !!raw.allDay : !!raw.all_day,
      status: raw.status || 'todo',
      priority: raw.priority || 0,
      listId: raw.listId || raw.list_id || 'work',
      tags: typeof raw.tags === 'string' ? raw.tags.split(',').filter(Boolean) : (raw.tags || []),
      remindOffset: raw.remindOffset !== undefined ? raw.remindOffset : raw.remind_offset,
      estimate: raw.estimate !== undefined ? raw.estimate : raw.estimate_min,
      postponed: raw.postponed || 0,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      deleted_at: raw.deleted_at || null,
      field_ts: raw.field_ts && typeof raw.field_ts === 'object' ? raw.field_ts : {},
    };
    const cur = await get('entries', e.id);
    if (!cur || (e.updated_at || 0) > (cur.updated_at || 0)) await put('entries', e);
  }
  for (const l of payload.logs || []) {
    const cur = await get('logs', l.date);
    if (!cur || (l.updated_at || 0) > (cur.updated_at || 0)) await put('logs', l);
  }
  await metaSet('hasSnapshot', 1);
}

async function applyChange(ch) {
  if (ch.entity === 'entry') {
    const cur = await get('entries', ch.entity_id);
    const f = ch.fields || {};
    if (ch.op === 'delete') {
      if (cur) { cur.deleted_at = ch.updated_at; cur.updated_at = Math.max(cur.updated_at || 0, ch.updated_at); await put('entries', cur); }
      return;
    }
    if (!cur) {
      const e = { id: ch.entity_id, title: '未命名', notes: '', date: TODAY, start: null, end: null, allDay: false,
        status: 'todo', priority: 0, listId: 'work', tags: [], postponed: 0, deleted_at: null, field_ts: {} };
      Object.assign(e, f);
      if (typeof e.tags === 'string') e.tags = e.tags.split(',').filter(Boolean);
      e.created_at = ch.updated_at;
      e.updated_at = ch.updated_at;
      for (const k of Object.keys(f)) e.field_ts[k] = ch.updated_at;
      await put('entries', e);
      return;
    }
    const ts = cur.field_ts || {};
    let changed = false;
    for (const [k, v] of Object.entries(f)) {
      if ((ch.updated_at || 0) > (ts[k] || 0)) {
        cur[k] = (k === 'tags' && typeof v === 'string') ? v.split(',').filter(Boolean) : v;
        ts[k] = ch.updated_at;
        changed = true;
      }
    }
    if (changed) {
      cur.field_ts = ts;
      cur.updated_at = Math.max(cur.updated_at || 0, ch.updated_at);
      await put('entries', cur);
    }
  } else if (ch.entity === 'log') {
    const cur = await get('logs', ch.entity_id);
    const f = ch.fields || {};
    if (ch.op === 'delete') { if (cur) await del('logs', ch.entity_id); return; }
    if (!cur) {
      await put('logs', { date: ch.entity_id, mood: f.mood || null, summary: f.summary || '', highlight: f.highlight || '', updated_at: ch.updated_at });
    } else if ((ch.updated_at || 0) > (cur.updated_at || 0)) {
      cur.mood = f.mood !== undefined ? f.mood : cur.mood;
      cur.summary = f.summary !== undefined ? f.summary : cur.summary;
      cur.highlight = f.highlight !== undefined ? f.highlight : cur.highlight;
      cur.updated_at = ch.updated_at;
      await put('logs', cur);
    }
  }
}

async function syncNow() {
  const c = syncCfg.get();
  if (!c) return { ok: false, error: '还没有连接电脑' };
  if (syncing) return { ok: false, error: '正在同步' };
  syncing = true;
  setSyncBadge('同步中');
  try {
    const key = await getKey();
    if (!key) throw new Error('同步口令不对');
    const outbox = await all('outbox');
    const batch = outbox.slice(0, 200);
    const ops = [];
    for (const op of batch) {
      const enc = await encryptObj(key, { entity: op.entity, entity_id: op.entity_id, op: op.op, fields: op.fields || {} });
      ops.push({ op_id: op.op_id, ts: op.updated_at, iv: enc.iv, data: enc.data });
    }
    const cursor = Number(await metaGet('cursor', 0)) || 0;
    const needSnapshot = (await metaGet('hasSnapshot', 0)) !== 1;
    const res = await fetch(c.url.replace(/\/$/, '') + '/v1/spaces/' + encodeURIComponent(c.space) + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': c.deviceId, 'X-Device-Token': c.token },
      body: JSON.stringify({ cursor, ops, needSnapshot }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error === 'unauthorized' ? '设备被吊销，请重新配对' : ('同步失败 HTTP ' + res.status));

    if (data.snapshot) await applySnapshotEncrypted(key, data.snapshot);

    let pulled = 0;
    for (const op of data.ops || []) {
      try {
        const payload = await decryptObj(key, op.iv, op.data);
        await applyChange({ ...payload, updated_at: op.ts });
        pulled++;
      } catch (e) { /* 口令不一致或数据损坏则跳过 */ }
    }
    for (const op of batch) await del('outbox', op.op_id);
    await metaSet('cursor', data.cursor || 0);
    await metaSet('lastSync', Date.now());
    await refreshAll();
    updateSyncUi();
    return { ok: true, pushed: batch.length, pulled };
  } catch (e) {
    setSyncBadge('同步失败');
    if ($('last-sync')) $('last-sync').textContent = e.message;
    return { ok: false, error: e.message };
  } finally {
    syncing = false;
  }
}

async function pairDevice(url, code, pass) {
  const res = await fetch(url.replace(/\/$/, '') + '/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device: '手机' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error === 'bad_code' ? '配对码无效或已过期' : '配对失败');
  syncCfg.set({ url: url.replace(/\/$/, ''), space: data.space, deviceId: data.deviceId, token: data.token, pass });
  syncKey = null;
  await metaSet('cursor', 0);
  await metaSet('hasSnapshot', 0);
  const r = await syncNow();
  if (!r.ok) throw new Error(r.error);
  return data;
}

function setSyncBadge(text) {
  const b = $('sync-badge');
  if (b) b.textContent = text;
}

async function updateSyncUi() {
  const c = syncCfg.get();
  document.body.classList.toggle('unpaired', !c);
  const bar = $('offline-bar');
  if (!c) {
    if (bar) bar.classList.add('on');
    if ($('sync-status')) $('sync-status').textContent = '未连接电脑';
    if ($('sync-sub')) $('sync-sub').textContent = '本机数据 · 未连接';
    setSyncBadge('未同步');
    if ($('row-disconnect')) $('row-disconnect').style.display = 'none';
    return;
  }
  if (bar) bar.classList.remove('on');
  if ($('sync-sub')) $('sync-sub').textContent = '已连接 · ' + (c.space || '');
  if ($('space-name')) $('space-name').textContent = c.space || '我';
  if ($('sync-url')) $('sync-url').value = c.url;
  if ($('row-disconnect')) $('row-disconnect').style.display = '';
  const t = await metaGet('lastSync');
  const pending = (await all('outbox')).length;
  if ($('sync-status')) $('sync-status').textContent = t ? `上次同步 ${new Date(t).toLocaleTimeString()}` : '已连接，等待同步';
  if ($('last-sync')) $('last-sync').textContent = t ? `上次同步 ${new Date(t).toLocaleString()}` : '还没有同步过';
  setSyncBadge(pending ? `待同步 ${pending}` : '已同步');
}

/* ---------------- 渲染：今天 ---------------- */
const COLORS = { work: 'var(--teal2)', life: 'var(--amber)', study: 'var(--violet)' };

function rowHtml(e) {
  return `<div class="row ${e.status === 'done' ? 'done' : ''}" data-id="${e.id}">
    ${e.priority >= 2 ? '<div class="pri"></div>' : ''}
    <button class="check ${e.status === 'done' ? 'on' : ''}" data-check="${e.id}" aria-label="完成"></button>
    <div class="time">${e.start || ''}</div>
    <div class="body">
      <div class="title">${esc(e.title)}</div>
      <div class="meta"><i class="dot-${e.listId}"></i>${listName(e.listId)}${e.status === 'done' ? ' · 已完成' : ''}</div>
    </div>
    ${e.status !== 'done' && e.start && isNow(e) ? '<span class="pill">进行中</span>' : ''}
  </div>`;
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function listName(id) { return ({ work: '工作', life: '生活', study: '学习' })[id] || '未分类'; }
function isNow(e) {
  if (!e.start) return false;
  const [h, m] = e.start.split(':').map(Number);
  const now = new Date();
  const mins = h * 60 + m;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= mins && cur < mins + 60;
}

async function renderToday() {
  const list = await rangeEntries(TODAY, TODAY);
  const timed = list.filter((e) => e.start);
  const anytime = list.filter((e) => !e.start);
  const done = list.filter((e) => e.status === 'done').length;
  const total = list.length;
  $('ring-label').textContent = `${done}/${total}`;
  const C = 2 * Math.PI * 24;
  const ring = $('ring-bar');
  ring.setAttribute('stroke-dasharray', `${(C * (total ? done / total : 0)).toFixed(1)} ${C.toFixed(1)}`);
  ring.setAttribute('stroke-linecap', total ? 'round' : 'butt');
  const open = total - done;
  $('pc-title').textContent = open ? `今天还有 ${open} 件` : (total ? '今天都清完了' : '今天还没有安排');
  const next = timed.find((e) => e.status !== 'done');
  $('pc-sub').textContent = next ? `${next.start} ${next.title}` : (total ? '没有排时间的了' : '点右下角加一件');
  const rowsAll = await all('entries');
  const doneDays = new Set(rowsAll.filter((e) => e.status === 'done' && !e.deleted_at).map((e) => e.date));
  const logsAll = await all('logs');
  const logDays = new Set(logsAll.filter((l) => l.summary && l.summary.trim()).map((l) => l.date));
  let streak = 0;
  let d = TODAY;
  for (let i = 0; i < 365; i++) {
    if (doneDays.has(d) || logDays.has(d)) streak++;
    else if (i > 0) break;
    d = addDays(d, -1);
  }
  if ($('streak')) $('streak').textContent = streak;

  $('timed-count').textContent = `${timed.length} 件`;
  $('anytime-count').textContent = `${anytime.length} 件`;
  $('timed-list').innerHTML = timed.length ? timed.map(rowHtml).join('') : '<div class="empty-mini">今天没有排时间的</div>';
  $('anytime-list').innerHTML = anytime.length ? anytime.map(rowHtml).join('') : '<div class="empty-mini">没有随手记的事</div>';
}

/* ---------------- 渲染：日历 ---------------- */
let calCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calSelected = TODAY;

async function renderCal() {
  const first = new Date(calCursor.getFullYear(), calCursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const from = ymd(start);
  const to = addDays(from, 41);
  const list = await rangeEntries(from, to);
  const byDate = {};
  for (const e of list) (byDate[e.date] = byDate[e.date] || []).push(e);

  let html = '';
  for (let i = 0; i < 42; i++) {
    const key = addDays(from, i);
    const d = parseYmd(key);
    const out = d.getMonth() !== calCursor.getMonth();
    const es = byDate[key] || [];
    const dots = es.slice(0, 3).map((e) => `<i class="dot-${e.listId}"></i>`).join('');
    html += `<div class="cell ${out ? 'out' : ''} ${key === TODAY ? 'today' : ''} ${key === calSelected ? 'sel' : ''}" data-date="${key}">
      <div class="n">${d.getDate()}</div><div class="dots">${dots}</div></div>`;
  }
  $('cal-grid').innerHTML = html;
  document.querySelector('.cal-head .m').textContent = `${calCursor.getFullYear()} 年 ${calCursor.getMonth() + 1} 月`;
  const dt = parseYmd(calSelected);
  $('day-title').textContent = `${dt.getMonth() + 1}月${dt.getDate()}日 · 周${WD[dt.getDay()]}`;
  const day = list.filter((e) => e.date === calSelected);
  $('day-count').textContent = `${day.length} 件`;
  $('day-list').innerHTML = day.length ? day.slice(0, 6).map(rowHtml).join('') : '<div class="empty-mini" style="padding:16px 12px">这天还没有安排</div>';
}

/* ---------------- 渲染：收集箱 ---------------- */
async function renderInbox() {
  const rows = await all('entries');
  const items = rows.filter((e) => !e.deleted_at && !e.start && e.status !== 'done')
    .sort((a, b) => b.created_at - a.created_at);
  $('inbox-count').textContent = `${items.length} 件待安排`;
  $('inbox-list').innerHTML = items.length ? items.map((e) => `
    <div class="inbox-card" data-id="${e.id}">
      <div class="ic"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 13l3 4h10l3-4V6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg></div>
      <div class="tx"><b>${esc(e.title)}</b><small>${listName(e.listId)} · 未安排</small></div>
      <button class="go" data-plan="${e.id}">安排</button>
    </div>`).join('') : `<div class="empty"><div class="art"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 13l3 4h10l3-4V6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/></svg></div><b>收集箱是空的</b><p>没想好放哪天的事，先扔这儿。</p></div>`;
}

/* ---------------- 渲染：复盘 ---------------- */
async function renderReview() {
  const from = addDays(TODAY, -((parseYmd(TODAY).getDay() + 6) % 7));
  const to = addDays(from, 6);
  const list = (await rangeEntries(from, to)).filter((e) => e.status !== 'canceled');
  const done = list.filter((e) => e.status === 'done').length;
  const planned = list.length;
  const rate = planned ? Math.round((done / planned) * 100) : 0;
  const postponed = list.reduce((a, e) => a + (e.postponed || 0), 0);
  const kpis = document.querySelectorAll('.kpis .kpi .v');
  if (kpis.length >= 3) {
    kpis[0].innerHTML = `${rate}<small>%</small>`;
    kpis[1].innerHTML = `${done}<small>/${planned}</small>`;
    kpis[2].innerHTML = `${postponed}<small>次</small>`;
  }
  document.querySelector('.topbar h1').innerHTML = `第 ${isoWeek(TODAY)} 周<small>${from.slice(5)} – ${to.slice(5)}</small>`;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    const es = list.filter((e) => e.date === d);
    days.push({ total: es.length, done: es.filter((e) => e.status === 'done').length });
  }
  const max = Math.max(1, ...days.map((d) => d.done));
  document.querySelectorAll('.bars .bar').forEach((bar, i) => {
    const fill = bar.querySelector('i');
    if (fill && days[i]) fill.style.height = `${Math.max(8, Math.round((days[i].done / max) * 100))}%`;
  });
  const logs = await all('logs');
  const week = logs.filter((l) => l.date >= from && l.date <= to && l.summary && l.summary.trim()).sort((a, b) => a.date.localeCompare(b.date));
  const last = week[week.length - 1];
  const q = document.querySelector('.quote');
  if (q) q.textContent = last ? last.summary : '这周还没有写。在「今天」页右栏写一句，这里会自动汇总。';
}

function isoWeek(dateStr) {
  const d = parseYmd(dateStr);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

/* ---------------- 页面切换 ---------------- */
function go(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  const fab = $('fab');
  fab.style.display = name === 'today' || name === 'inbox' ? 'grid' : 'none';
  const app = document.querySelector('.app');
  const sc = document.querySelector('.page.on .scroll');
  if (sc) sc.scrollTop = 0;
  if (name === 'today') renderToday();
  if (name === 'calendar') renderCal();
  if (name === 'inbox') renderInbox();
  if (name === 'review') renderReview();
  if (name === 'me') updateSyncUi();
}

async function refreshAll() {
  await renderToday();
  if (document.querySelector('.page[data-page="calendar"]').classList.contains('on')) await renderCal();
  if (document.querySelector('.page[data-page="inbox"]').classList.contains('on')) await renderInbox();
}

/* ---------------- 速记 ---------------- */
let dest = 'today';

function openSheet(prefill) {
  $('dim').classList.add('on');
  $('sheet').classList.add('on');
  if (prefill) { $('cap-input').value = prefill; renderChips(); }
  setTimeout(() => $('cap-input').focus(), 150);
}
function closeSheet() {
  $('dim').classList.remove('on');
  $('sheet').classList.remove('on');
}

function parseInput(text) {
  const out = { date: TODAY, start: null, tags: [], listId: 'work' };
  let rest = text;
  if (/今天/.test(rest)) { out.date = TODAY; rest = rest.replace('今天', ' '); }
  else if (/明天/.test(rest)) { out.date = addDays(TODAY, 1); rest = rest.replace('明天', ' '); }
  else if (/后天/.test(rest)) { out.date = addDays(TODAY, 2); rest = rest.replace('后天', ' '); }
  const m = rest.match(/(上午|下午|晚上)?\s*(\d{1,2})[:：点](\d{0,2})/);
  if (m) {
    let h = +m[2];
    if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12;
    out.start = `${pad(h)}:${pad(m[3] ? +m[3] : 0)}`;
    rest = rest.replace(m[0], ' ');
  }
  const tags = [...rest.matchAll(/#([^\s#]+)/g)].map((x) => x[1]);
  if (tags.length) { out.tags = tags; rest = rest.replace(/#[^\s#]+/g, ' '); }
  out.title = rest.replace(/\s+/g, ' ').trim() || text.trim();
  return out;
}

function renderChips() {
  const val = $('cap-input').value.trim();
  if (!val) { $('cap-chips').innerHTML = '<span class="chip ghost">输入后自动识别日期、时间与标签</span>'; return; }
  const p = parseInput(val);
  const d = parseYmd(p.date);
  const dl = p.date === TODAY ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  let html = `<span class="chip">📅 <b>${dl}</b></span>`;
  if (p.start) html += `<span class="chip">🕒 <b>${p.start}</b></span>`;
  if (p.tags.length) html += `<span class="chip tag"># ${p.tags.join(' ')}</span>`;
  $('cap-chips').innerHTML = html;
  const target = p.date === TODAY ? 'today' : (p.date === addDays(TODAY, 1) ? 'tomorrow' : 'inbox');
  dest = target;
  document.querySelectorAll('.quick button').forEach((b) => b.classList.toggle('on', b.dataset.dest === target));
}

async function saveCapture() {
  const val = $('cap-input').value.trim();
  if (!val) { closeSheet(); return; }
  const p = parseInput(val);
  await createEntry({
    title: p.title,
    date: dest === 'inbox' ? TODAY : p.date,
    start: dest === 'inbox' ? null : p.start,
    tags: p.tags,
    listId: 'work',
  });
  $('cap-input').value = '';
  renderChips();
  closeSheet();
  go('today');
}

/* ---------------- 语音（模拟识别，真机接系统语音） ---------------- */
let voiceTimer = null;
function openVoice() {
  closeSheet();
  $('voice').classList.add('on');
  const el = $('v-text');
  el.textContent = '';
  $('v-status').textContent = '正在听…';
  $('v-ok').disabled = true;
  const full = '明天下午3点 和设计对稿';
  let i = 0;
  clearInterval(voiceTimer);
  voiceTimer = setInterval(() => {
    el.textContent = full.slice(0, i++);
    if (i > full.length) {
      clearInterval(voiceTimer);
      $('v-status').textContent = '识别完成，确认后保存';
      $('v-ok').disabled = false;
    }
  }, 90);
}
function closeVoice() {
  clearInterval(voiceTimer);
  $('voice').classList.remove('on');
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.tab)));
  $('go-review').addEventListener('click', () => {
    go('review');
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  });
  $('rev-back').addEventListener('click', () => go('me'));
  $('fab').addEventListener('click', () => openSheet());
  $('dim').addEventListener('click', closeSheet);
  $('cap-input').addEventListener('input', renderChips);
  $('cap-save').addEventListener('click', saveCapture);
  $('sheet-mic').addEventListener('click', openVoice);
  $('btn-voice').addEventListener('click', openVoice);
  $('v-close').addEventListener('click', closeVoice);
  $('v-cancel').addEventListener('click', closeVoice);
  $('v-ok').addEventListener('click', () => {
    const t = $('v-text').textContent.trim();
    closeVoice();
    openSheet(t);
  });
  document.querySelectorAll('.quick button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.quick button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    dest = b.dataset.dest;
  }));

  document.addEventListener('click', async (e) => {
    const check = e.target.closest('[data-check]');
    if (check) {
      e.stopPropagation();
      await toggleEntry(check.dataset.check);
      await refreshAll();
      return;
    }
    const plan = e.target.closest('[data-plan]');
    if (plan) {
      await patchEntry(plan.dataset.plan, { date: TODAY, start: null });
      await refreshAll();
      await renderInbox();
      toast('已放到今天');
      return;
    }
    const cell = e.target.closest('.cell');
    if (cell) { calSelected = cell.dataset.date; await renderCal(); }
  });

  $('cal-prev').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); renderCal(); });
  $('cal-next').addEventListener('click', () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); renderCal(); });
  $('cal-add').addEventListener('click', () => openSheet());

  $('btn-pair').addEventListener('click', async () => {
    const url = $('sync-url').value.trim();
    const code = $('pair-code').value.trim();
    const pass = $('sync-pass').value;
    if (!/^https?:\/\//.test(url)) { toast('地址要以 http:// 开头'); return; }
    if (!/^\d{6}$/.test(code)) { toast('配对码是 6 位数字'); return; }
    if (pass.length < 6) { toast('同步口令至少 6 位，要和电脑一致'); return; }
    $('btn-pair').disabled = true;
    try {
      await pairDevice(url, code, pass);
      toast('已连接');
      await refreshAll();
      await updateSyncUi();
    } catch (e) {
      toast(e.message);
    } finally {
      $('btn-pair').disabled = false;
    }
  });
  $('btn-sync').addEventListener('click', async () => {
    if (!syncCfg.get()) { toast('先连接'); return; }
    const r = await syncNow();
    toast(r.ok ? `同步完成 · 推送 ${r.pushed}，拉取 ${r.pulled}` : (r.error || '同步失败'));
  });
  $('btn-disconnect').addEventListener('click', () => {
    if (!confirm('断开后本机数据还在，只是不再同步。')) return;
    syncCfg.clear();
    syncKey = null;
    updateSyncUi();
    toast('已断开');
  });
  $('go-sync').addEventListener('click', () => go('me'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); closeVoice(); }
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); go('today'); }
  });

  window.addEventListener('online', () => { if (syncCfg.get()) syncNow().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && syncCfg.get()) syncNow().catch(() => {});
  });
}

function toast(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.querySelector('.screen').appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => t.classList.remove('on'), 1800);
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  db = await openDB();
  bind();
  await renderToday();
  updateSyncUi();
  if (syncCfg.get()) {
    syncNow().catch(() => {});
    setInterval(() => { if (document.visibilityState === 'visible') syncNow().catch(() => {}); }, 60000);
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
