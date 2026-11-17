'use strict';

/* 主题 */
let themeMode = 'light';
function paintTheme(mode) {
  document.body.dataset.theme = mode === 'dark' ? 'dark' : 'light';
  document.body.dataset.transparent = mode === 'transparent' ? '1' : '0';
}
try { const c = localStorage.getItem('theme'); if (c) paintTheme(c); } catch (_) {}
function applyTheme(mode) {
  if (mode) themeMode = mode;
  paintTheme(themeMode);
  try { localStorage.setItem('theme', themeMode); } catch (_) {}
}

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
// 主窗口会长期开着：「今天」不能是加载时算死的常量，翻日后由 checkDateRollover 更新
let todayStr = ymd(new Date());
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (id) => document.getElementById(id);

/* 列表色（数据库里存的是浅色主题下的深色）在深色主题下必须提亮，否则暗底上认不出来 */
function mixHex(hex, to, t) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const a = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function accent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex || 'var(--teal2)';
  return document.body.dataset.theme === 'dark' ? mixHex(hex, '#ffffff', 0.55) : hex;
}

const state = {
  view: 'today',
  date: todayStr,
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  entries: [],
  stats: null,
  logs: [],
  editing: null,
  allForSearch: [],
};

/* ---------------- 基础 ---------------- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => t.classList.remove('on'), 1800);
}

function hhmmToMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
function timeLabel(e) { return e.start ? `${e.start}${e.end ? ' – ' + e.end : ''}` : '无时间'; }

/* ---------------- 视图切换 ---------------- */
const VIEW_PATH = { today: '今天', month: '日历', review: '复盘', settings: '设置' };
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('on'));
  $('view-' + v).classList.add('on');
  document.querySelectorAll('.nav a[data-view], .side-bottom a[data-view]').forEach((a) => {
    a.classList.toggle('on', a.dataset.view === v);
  });
  $('tb-path').textContent = '/ ' + VIEW_PATH[v];
  if (v === 'today') loadToday();
  if (v === 'month') loadMonth();
  if (v === 'review') loadReview();
  if (v === 'settings') loadSettings();
}

/* ---------------- 今天 ---------------- */
/* 待办卡片（今天页的两列网格） */
function tcardHtml(e) {
  const note = (e.notes || '').trim();
  const sub = `${e.listName} · ${e.start || '无时间'}${e.end ? '–' + e.end : ''}`;
  const tip = ` data-tip="${esc(e.title)}" data-sub="${esc(sub)}"` + (note ? ` data-note="${esc(note)}"` : "");
  return `<li class="tcard" data-id="${e.id}" style="--accent:${accent(e.listColor)}">
    <i class="c" data-toggle="${e.id}"></i>
    <div class="tx">
      <div class="tt"${tip}>${esc(e.title)}</div>
      <div class="tm"><i style="background:${accent(e.listColor)}"></i>${esc(e.listName)} · ${e.start || '无时间'}${e.priority >= 2 ? '<span class="tag">高</span>' : ''}</div>
    </div>
  </li>`;
}

/* 已完成卡片里的一行：点圆点可以取消完成，点标题打开编辑 */
function doneRowHtml(e) {
  const note = (e.notes || '').trim();
  const sub = `${e.listName} · ${e.start || '无时间'} · 已完成`;
  const tip = ` data-tip="${esc(e.title)}" data-sub="${esc(sub)}"` + (note ? ` data-note="${esc(note)}"` : "");
  return `<li class="drow" data-id="${e.id}">
    <i class="dot" data-toggle="${e.id}" title="点一下取消完成"></i>
    <span class="dt"${tip}>${esc(e.title)}</span>
    <span class="dw">${e.start || ''}</span>
  </li>`;
}

/* 复盘页的顺延列表还用行式 */
function taskHtml(e) {
  const note = (e.notes || '').trim();
  const sub = `${e.listName} · ${e.start || '无时间'}`;
  return `<li class="task" data-id="${e.id}" style="--accent:${accent(e.listColor)}">
    <i class="c" data-toggle="${e.id}"></i>
    <div class="tx">
      <div class="tt" data-tip="${esc(e.title)}" data-sub="${esc(sub)}"${note ? ` data-note="${esc(note)}"` : ''}>${esc(e.title)}</div>
      <div class="tm"><i style="background:${accent(e.listColor)}"></i>${esc(e.listName)} · ${e.start || '无时间'}</div>
    </div>
  </li>`;
}

async function loadToday() {
  const date = state.date;
  const entries = await window.api.range(date, date);
  state.entries = entries;
  const d = parseYmd(date);
  $('today-title').innerHTML = `${d.getMonth() + 1}月${d.getDate()}日<small>${date === todayStr ? '今天 · ' : ''}周${WD[d.getDay()]} · 第 ${isoWeek(date)} 周</small>`;

  const done = entries.filter((e) => e.status === 'done');
  const open = entries.filter((e) => e.status !== 'done');
  const postponed = entries.reduce((a, e) => a + e.postponed, 0);
  const next = entries.filter((e) => e.start && e.status !== 'done').sort((a, b) => a.start.localeCompare(b.start))[0];
  const rate = entries.length ? Math.round((done.length / entries.length) * 100) : 0;

  $('kpi-row').innerHTML = `
    <div class="kpi-card next">
      <div class="k">下一件</div>
      <div class="v">${next
    ? `${next.start} <em${` data-tip="${esc(next.title)}" data-sub="${esc(`${next.start} · ${next.listName}`)}"`}>${esc(next.title)}</em>`
    : '<em>今天没有排时间的了</em>'}</div>
    </div>
    <div class="kpi-card">
      <div class="k">今天完成</div>
      <div class="v">${done.length} <em>/ ${entries.length} 件</em></div>
      <div class="track"><i style="width:${rate}%"></i></div>
    </div>
    <div class="kpi-card">
      <div class="k">顺延</div>
      <div class="v" style="color:${postponed ? 'var(--amber)' : 'inherit'}">${postponed} <em>次</em></div>
      <div class="k" style="margin-top:5px">第 ${isoWeek(date)} 周</div>
    </div>`;

  $('task-list').innerHTML = (open.length
    ? open.map(tcardHtml).join('')
    : '<li class="todo-empty">今天还没有待办，点下面的「＋ 添加一件事」或按 N 新建</li>')
    + '<li class="ghost-card" id="btn-add-card">＋ 添加一件事</li>';
  $('done-list').innerHTML = done.length ? done.map(doneRowHtml).join('') : '<li class="done-empty">还没有完成的事</li>';
  $('task-count').textContent = `${open.length} 件`;
  $('done-count').textContent = `${done.length} 件`;

  const log = await window.api.log.get(date);
  $('daily-summary').value = log.summary || '';
  document.querySelectorAll('.mood').forEach((m) => m.classList.toggle('on', Number(m.dataset.mood) === log.mood));
  $('log-hint').textContent = log.summary ? '已记录' : '写点什么';

  updateSidebar(entries);
}

function isoWeek(dateStr) {
  const d = parseYmd(dateStr);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

async function updateSidebar(entries) {
  const todayEntries = entries || (await window.api.range(todayStr, todayStr));
  const open = todayEntries.filter((e) => e.status !== 'done').length;
  $('nav-today-count').textContent = open || '';
  const counts = { work: 0, life: 0, study: 0 };
  for (const e of todayEntries) if (counts[e.listId] !== undefined) counts[e.listId]++;
  const colors = { work: '#1F6F78', life: '#BF6F3E', study: '#6B5B95' };
  const names = { work: '工作', life: '生活', study: '学习' };
  $('list-counts').innerHTML = Object.keys(counts).map((k) => `
    <a data-list="${k}"><i class="dot" style="background:${accent(colors[k])}"></i>${names[k]}<span class="count">${counts[k]}</span></a>`).join('');
}

/* ---------------- 日历 ---------------- */
async function loadMonth() {
  const cur = state.month;
  const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
  const wd = (first.getDay() + 6) % 7;
  const start = new Date(first); start.setDate(first.getDate() - wd);
  const from = ymd(start);
  const to = addDays(from, 41);
  const entries = await window.api.range(from, to);
  const byDate = {};
  for (const e of entries) (byDate[e.date] = byDate[e.date] || []).push(e);

  $('month-title').innerHTML = `${cur.getFullYear()} 年 ${cur.getMonth() + 1} 月<small>第 ${isoWeek(from)} – ${isoWeek(to)} 周</small>`;
  // 一格能放几条：按当前行高算，放不下的折成「+N」放进日期行，
  // 否则条目会被 flex 压成一条线（深色下几乎看不见）
  const gridEl = $('month-grid');
  const rowH = gridEl.clientHeight ? (gridEl.clientHeight - 26) / 6 : 56;
  const limit = Math.max(1, Math.min(3, Math.floor((rowH - 23) / 17) + 1));
  let html = ['一', '二', '三', '四', '五', '六', '日'].map((d) => `<div class="mhead">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const key = addDays(from, i);
    const d = parseYmd(key);
    const out = d.getMonth() !== cur.getMonth();
    const es = byDate[key] || [];
    const pills = es.slice(0, limit).map((e) => {
      const note = (e.notes || '').trim();
      return `<span class="pill ${e.status === 'done' ? 'done' : ''}" style="--accent:${accent(e.listColor)}"
        data-tip="${esc(e.title)}" data-sub="${esc(`${d.getMonth() + 1}月${d.getDate()}日 · ${e.listName} · ${e.start || '无时间'}${e.status === 'done' ? ' · 已完成' : ''}`)}"${note ? ` data-note="${esc(note)}"` : ''}>${esc(e.title)}</span>`;
    }).join('');
    const more = es.length > limit ? `<span class="more">+${es.length - limit}</span>` : '';
    const monthTag = out && d.getDate() === 1 ? `<span class="dm">${d.getMonth() + 1}月</span>` : '';
    html += `<div class="mcell ${out ? 'out' : ''} ${key === todayStr ? 'today' : ''}" data-date="${key}">
      <div class="d">${key === todayStr ? `<em>${d.getDate()}</em>` : d.getDate()}${monthTag || more}</div>${pills}</div>`;
  }
  $('month-grid').innerHTML = html;
}

/* ---------------- 复盘 ---------------- */
async function loadReview() {
  const s = await window.api.stats(state.date);
  state.stats = s;
  $('review-title').innerHTML = `第 ${isoWeek(state.date)} 周<small>${s.from} – ${s.to} · 周复盘</small>`;
  $('kpi-rate').innerHTML = `${s.rate}<small>%</small>`;
  $('kpi-rate-d').textContent = s.planned ? `完成 ${s.done} / 计划 ${s.planned}` : '本周还没有计划';
  $('kpi-done').innerHTML = `${s.done}<small>/ ${s.planned}</small>`;
  $('kpi-done-d').textContent = s.planned - s.done > 0 ? `还有 ${s.planned - s.done} 件没完成` : '全部完成';
  $('kpi-post').innerHTML = `${s.postponed}<small>次</small>`;
  $('kpi-post-d').textContent = s.postponed ? '多为一件事反复改期' : '没有顺延';
  $('kpi-streak').innerHTML = `${s.streak}<small>天</small>`;

  const lists = Object.values(s.byList);
  const max = Math.max(1, ...lists.map((l) => l.min));
  $('bars').innerHTML = lists.length ? lists.map((l) => `
    <div class="brow"><span>${esc(l.name)}</span>
      <div class="btrack"><i style="width:${Math.round((l.min / max) * 100)}%;background:${accent(l.color)}"></i></div>
      <span class="bval">${(l.min / 60).toFixed(1)}h</span></div>`).join('') : '<div class="empty">本周还没有条目</div>';

  const heat = await window.api.heat(182);
  const maxHeat = Math.max(1, ...heat.map((h) => h.n));
  $('heat').innerHTML = heat.map((h) => {
    const lv = h.n === 0 ? 0 : Math.min(4, 1 + Math.floor((h.n / maxHeat) * 3));
    return `<i class="${lv ? 'l' + lv : ''}" title="${h.date} · ${h.n} 件"></i>`;
  }).join('');

  const pts = s.days.map((d, i) => {
    const x = 20 + i * 85;
    const y = 52 - (d.total ? (d.done / Math.max(1, d.total)) * 42 : 0);
    return { x, y, ...d };
  });
  $('spark').innerHTML = `<line x1="0" y1="52" x2="560" y2="52" stroke="#EFF2EF" stroke-width="1"/>
    <polyline points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#1F6F78" stroke-width="2" stroke-linejoin="round"/>
    ${pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.6" fill="#1F6F78"><title>${p.date} · ${p.done}/${p.total}</title></circle>`).join('')}`;
  $('spark-note').textContent = `本周完成 ${s.done} 件`;

  const all = await window.api.range(s.from, s.to);
  const postponed = all.filter((e) => e.postponed > 0).sort((a, b) => b.postponed - a.postponed).slice(0, 3);
  $('postponed-list').innerHTML = postponed.length ? postponed.map((e) => `
    <li class="task" data-id="${e.id}"><div class="pri"></div><i class="c"></i>
      <div class="tx"><div class="tt">${esc(e.title)}</div><div class="tm">顺延 ${e.postponed} 次${e.postponed >= 3 ? ' · 建议拆小' : ''}</div></div></li>`).join('')
    : '<li class="empty">本周没有顺延</li>';

  const open = all.filter((e) => e.status !== 'done').slice(0, 3);
  $('mit').innerHTML = open.length ? open.map((e, i) => `<li><b>${i + 1}</b>${esc(e.title)}<span style="color:var(--ink3);font-size:10px;margin-left:6px">${e.date.slice(5)}</span></li>`).join('')
    : '<li style="color:var(--ink3);font-size:12px">本周没有遗留，下周重新开始</li>';

  const logs = await window.api.log.range(s.from, s.to);
  const withText = logs.filter((l) => l.summary && l.summary.trim());
  const last = withText[withText.length - 1];
  $('week-quote').textContent = last ? last.summary : '这周还没有写。在「今天」页右栏写一句，这里会自动汇总。';
  $('quote-date').textContent = last ? last.date.slice(5) : '';
  $('quote-meta').textContent = last ? (last.mood ? `心情：${['', '🙂', '😐', '😴', '🔥', '🌧'][last.mood]} · ` : '') + `记录于 ${last.date}` : '';
  const kw = [...new Set(all.flatMap((e) => e.tags))].slice(0, 4);
  $('kw').innerHTML = kw.map((t) => `<span>${esc(t)}</span>`).join('');
}

/* ---------------- 设置 ---------------- */
async function loadSettings() {
  const info = await window.api.data.info();
  $('data-path').textContent = info.file;
  $('data-size').textContent = `${(info.size / 1024).toFixed(1)} KB · 备份 ${info.backups} 份`;
  $('backup-path').textContent = info.dataDir + '\\backups';
  $('about').textContent = `日格 0.1.0 · Electron ${window.api.versions ? window.api.versions.electron : ''}`;
  const auto = (await window.api.setting.get('launchAtLogin')) === '1';
  $('sw-autostart').classList.toggle('on', auto);
  $('autostart-label').textContent = auto ? '已开启' : '关闭';
  $('backup-hint').textContent = `已备份 · ${info.backups} 份`;

  await loadSync();
  const mode = (await window.api.setting.get('theme')) || 'light';
  document.querySelectorAll('#theme-seg span').forEach((s) => s.classList.toggle('on', s.dataset.themeMode === mode));
  updateWidgetBtn(await window.api.widgetVisible());
}

/* ---------------- 编辑器 ---------------- */
function defaultTimeRange() {
  const d = new Date();
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  if (m > 0) d.setMinutes(m <= 30 ? 30 : 60);
  const start = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const endD = new Date(d.getTime() + 60 * 60000);
  const end = `${pad(endD.getHours())}:${pad(endD.getMinutes())}`;
  return [start, end];
}

function openEditor(entry) {
  state.editing = entry || null;
  const [ds, de] = defaultTimeRange();
  $('editor-title').textContent = entry ? '编辑条目' : '新建条目';
  $('ed-title').value = entry ? entry.title : '';
  $('ed-date').value = entry ? entry.date : state.date;
  $('ed-start').value = entry && entry.start ? entry.start : (entry ? '' : ds);
  $('ed-end').value = entry && entry.end ? entry.end : (entry ? '' : de);
  $('ed-list').value = entry ? entry.listId : 'work';
  $('ed-priority').value = entry ? String(entry.priority || 0) : '0';
  $('ed-notes').value = entry ? entry.notes || '' : '';
  $('ed-delete').style.display = entry ? '' : 'none';
  $('editor-overlay').classList.add('on');
  setTimeout(() => $('ed-title').focus(), 30);
}

function closeEditor() {
  $('editor-overlay').classList.remove('on');
  state.editing = null;
}

async function saveEditor() {
  const title = $('ed-title').value.trim();
  if (!title) { toast('标题不能为空'); return; }
  const patch = {
    title,
    date: $('ed-date').value || todayStr,
    start: $('ed-start').value || null,
    end: $('ed-end').value || null,
    listId: $('ed-list').value,
    priority: Number($('ed-priority').value),
    notes: $('ed-notes').value,
  };
  if (state.editing) {
    await window.api.update(state.editing.id, patch);
    toast('已保存');
  } else {
    await window.api.create(patch);
    toast('已添加');
  }
  closeEditor();
  await refreshCurrent();
}

async function deleteEditing() {
  if (!state.editing) return;
  await window.api.remove(state.editing.id);
  closeEditor();
  toast('已删除');
  await refreshCurrent();
}

/* ---------------- 搜索 ---------------- */
async function openSearch() {
  $('search-overlay').classList.add('on');
  const from = addDays(todayStr, -180);
  state.allForSearch = await window.api.range(from, addDays(todayStr, 365));
  $('search-input').value = '';
  renderSearch('');
  setTimeout(() => $('search-input').focus(), 30);
}

function renderSearch(q) {
  const query = q.trim().toLowerCase();
  const list = !query ? state.allForSearch.slice(0, 20) : state.allForSearch.filter((e) =>
    e.title.toLowerCase().includes(query) || (e.notes || '').toLowerCase().includes(query) || e.tags.some((t) => t.toLowerCase().includes(query))
  ).slice(0, 30);
  $('search-list').innerHTML = list.length ? list.map((e) => `
    <div class="search-item" data-id="${e.id}">
      <span class="d">${e.date.slice(5)}</span>
      <span class="t" data-tip="${esc(e.title)}" data-sub="${esc(`${e.date} · ${e.listName} · ${e.start || '无时间'}${e.status === 'done' ? ' · 已完成' : ''}`)}"${(e.notes || '').trim() ? ` data-note="${esc(e.notes)}"` : ''}>${esc(e.title)}</span>
      <span style="margin-left:auto;font-size:10px;color:${accent(e.listColor)}">${esc(e.listName)}</span>
    </div>`).join('') : '<div class="search-empty">没有找到</div>';
}

/* ---------------- 事件 ---------------- */
function bind() {
  document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => switchView(el.dataset.view)));
  $('open-search').addEventListener('click', openSearch);
  $('nav-search').addEventListener('click', openSearch);

  $('win-min').addEventListener('click', () => window.api.minimize());
  $('win-max').addEventListener('click', () => window.api.maximize());
  $('win-close').addEventListener('click', () => window.api.closeApp());

  $('btn-new').addEventListener('click', () => openEditor(null));
  $('btn-new-month').addEventListener('click', () => openEditor(null));
  $('btn-prev-day').addEventListener('click', async () => {
    state.date = addDays(state.date, -1);
    await loadToday();
  });
  $('today-title').addEventListener('click', async () => { state.date = todayStr; await loadToday(); });

  $('task-list').addEventListener('click', async (e) => {
    if (e.target.closest('#btn-add-card')) { openEditor(null); return; }
    const t = e.target.closest('[data-toggle]');
    if (t) { await window.api.toggle(t.dataset.toggle); await refreshCurrent(); return; }
    const li = e.target.closest('.tcard');
    if (li) { const en = await findEntry(li.dataset.id); if (en) openEditor(en); }
  });
  $('done-list').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { await window.api.toggle(t.dataset.toggle); await refreshCurrent(); return; }
    const li = e.target.closest('.drow');
    if (li) { const en = await findEntry(li.dataset.id); if (en) openEditor(en); }
  });
  // 右键：修改 / 完成 / 删除
  const onEntryCtx = async (e) => {
    const node = e.target.closest('.tcard, .drow');
    if (!node) return;
    e.preventDefault();
    const entry = await entryById(node.dataset.id);
    if (entry) entryMenu(e.clientX, e.clientY, entry);
  };
  $('task-list').addEventListener('contextmenu', onEntryCtx);
  $('done-list').addEventListener('contextmenu', onEntryCtx);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });

  $('month-prev').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); loadMonth(); });
  $('month-next').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); loadMonth(); });
  // 窗口大小变了，一格能放的条目数也变，重排一次
  window.addEventListener('resize', () => {
    if (state.view !== 'month') return;
    clearTimeout(window.__mresize);
    window.__mresize = setTimeout(loadMonth, 150);
  });
  $('month-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.mcell');
    if (!cell) return;
    state.date = cell.dataset.date;
    switchView('today');
  });
  $('month-grid').addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.mcell');
    if (!cell) return;
    state.date = cell.dataset.date;
    openEditor(null);
  });

  $('daily-summary').addEventListener('blur', async () => {
    await window.api.log.set(state.date, { summary: $('daily-summary').value });
    $('log-hint').textContent = $('daily-summary').value ? '已记录' : '写点什么';
  });
  $('moods').addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mood]');
    if (!m) return;
    const mood = Number(m.dataset.mood);
    await window.api.log.set(state.date, { mood });
    document.querySelectorAll('.mood').forEach((x) => x.classList.toggle('on', x === m));
  });

  $('editor-x').addEventListener('click', closeEditor);
  $('ed-cancel').addEventListener('click', closeEditor);
  $('ed-save').addEventListener('click', saveEditor);
  $('ed-delete').addEventListener('click', deleteEditing);
  $('editor-overlay').addEventListener('click', (e) => { if (e.target === $('editor-overlay')) closeEditor(); });

  $('search-input').addEventListener('input', (e) => renderSearch(e.target.value));
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('search-overlay').classList.remove('on');
    if (e.key === 'Enter') {
      const first = $('search-list').querySelector('.search-item');
      if (first) pickSearch(first.dataset.id);
    }
  });
  $('search-list').addEventListener('click', (e) => {
    const it = e.target.closest('.search-item');
    if (it) pickSearch(it.dataset.id);
  });
  $('search-overlay').addEventListener('click', (e) => { if (e.target === $('search-overlay')) $('search-overlay').classList.remove('on'); });

  $('btn-export').addEventListener('click', doExport);
  $('btn-export2').addEventListener('click', doExport);
  $('btn-open-dir').addEventListener('click', () => window.api.data.openDir());
  $('btn-backup').addEventListener('click', async () => { const i = await window.api.data.backup(); toast('已备份'); loadSettings(); });
  $('btn-cloud-save').addEventListener('click', async () => {
    const cfg = { url: $('cloud-url').value.trim() };
    if ($('cloud-space').value.trim()) cfg.space = $('cloud-space').value.trim();
    if ($('cloud-device').value.trim()) cfg.deviceId = $('cloud-device').value.trim();
    if ($('cloud-token').value.trim()) cfg.token = $('cloud-token').value.trim();
    if ($('cloud-pass').value) cfg.pass = $('cloud-pass').value;
    if (!cfg.url) { toast('先填服务器地址'); return; }
    await window.api.syncConfig(cfg);
    const r = await window.api.syncRun();
    await loadSync();
    toast(r.ok ? `同步完成 · 推送 ${r.pushed} 条，拉取 ${r.pulled} 条` : ('同步失败：' + r.error));
  });
  $('btn-cloud-code').addEventListener('click', async () => {
    const r = await window.api.syncCode();
    if (r.ok) {
      $('cloud-code').textContent = r.code;
      toast('配对码 10 分钟内有效');
    } else {
      toast('生成失败：' + r.error);
    }
  });
  $('btn-toggle-widget').addEventListener('click', async () => {
    const visible = await window.api.toggleWidget();
    updateWidgetBtn(visible);
    toast(visible ? '组件已显示' : '组件已隐藏，Ctrl+Alt+D 可再显示');
  });
  window.api.onWidgetVisibility((v) => updateWidgetBtn(v));
  document.querySelectorAll('#theme-seg span').forEach((s) => s.addEventListener('click', async () => {
    await window.api.setTheme(s.dataset.themeMode);
    document.querySelectorAll('#theme-seg span').forEach((x) => x.classList.toggle('on', x === s));
    toast(s.dataset.themeMode === 'transparent' ? '组件已改为透明' : (s.dataset.themeMode === 'dark' ? '已切换为深色' : '已切换为浅色'));
  }));
  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('确定清空所有条目和每日记录？建议先导出备份。')) return;
    await window.api.data.clear();
    toast('已清空');
    await refreshCurrent();
  });
  $('sw-autostart').addEventListener('click', async () => {
    const on = !$('sw-autostart').classList.contains('on');
    await window.api.setting.set('launchAtLogin', on ? '1' : '0');
    $('sw-autostart').classList.toggle('on', on);
    $('autostart-label').textContent = on ? '已开启' : '关闭';
    toast(on ? '已开启开机自启' : '已关闭开机自启');
  });

  document.querySelectorAll('[data-soon]').forEach((el) => el.addEventListener('click', () => toast(el.dataset.soon + ' 还没做')));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape') {
      $('editor-overlay').classList.remove('on');
      $('search-overlay').classList.remove('on');
    }
    if (!e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      openEditor(null);
    }
  });
}

async function findEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (e) return e;
  const d = state.date;
  const list = await window.api.range(d, d);
  return list.find((x) => x.id === id) || (await window.api.getEntry(id)) || null;
}

async function pickSearch(id) {
  const e = state.allForSearch.find((x) => x.id === id);
  $('search-overlay').classList.remove('on');
  if (!e) return;
  state.date = e.date;
  switchView('today');
  setTimeout(() => openEditor(e), 120);
}

async function doExport() {
  const p = await window.api.data.exportJson();
  if (p) toast('已导出到 ' + p);
}

async function refreshCurrent() {
  if (state.view === 'today') await loadToday();
  if (state.view === 'month') await loadMonth();
  if (state.view === 'review') await loadReview();
  if (state.view === 'settings') await loadSettings();
}

/* 日期翻篇后把“今天”对齐：之前停在今天，就跟着走到新的一天 */
async function checkDateRollover() {
  const now = ymd(new Date());
  if (now === todayStr) return false;
  const followToday = (state.date === todayStr);
  todayStr = now;
  if (followToday) state.date = todayStr;
  await refreshCurrent();
  return true;
}

async function loadSync() {
  const s = await window.api.syncStatus();
  const url = $('cloud-url');
  if (!url) return;
  if (s.url) url.value = s.url;
  if (s.space) $('cloud-space').value = s.space;
  $('cloud-status').textContent = s.configured
    ? `已配置 · ${s.lastSync ? '上次同步 ' + new Date(s.lastSync).toLocaleString() : '还没同步过'} · 待推送 ${s.pendingPush} 条`
    : '未配置。服务器地址、空间 ID、设备令牌来自服务器初始化输出。';
}

function updateWidgetBtn(visible) {
  const b = $('btn-toggle-widget');
  if (b) b.textContent = visible ? '隐藏组件' : '显示组件';
}

async function refreshChrome() {
  try {
    const info = await window.api.data.info();
    $('backup-hint').textContent = `已备份 · ${info.backups} 份`;
    if ((await window.api.setting.get('demoData')) === '1') {
      toast('首次打开已载入示例数据，可在「设置」里清空');
      await window.api.setting.set('demoData', '0');
    }
  } catch (_) {}
}

/* ---------------- 右键菜单：修改 / 完成 / 删除 ---------------- */
function closeCtx() {
  const el = $('ctx');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

function openCtx(x, y, items) {
  const el = $('ctx');
  el.innerHTML = items.map((it, i) => (it.sep
    ? '<div class="sep"></div>'
    : `<button data-i="${i}"${it.danger ? ' class="danger"' : ''}>${it.label}</button>`)).join('');
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  el.onclick = async (ev) => {
    const b = ev.target.closest('button[data-i]');
    if (!b) return;
    const item = items[Number(b.dataset.i)];
    closeCtx();
    if (item && item.act) await item.act();
  };
}

function entryMenu(x, y, entry) {
  const done = entry.status === 'done';
  openCtx(x, y, [
    { label: '修改…', act: () => openEditor(entry) },
    { label: done ? '取消完成' : '标记完成', act: async () => { await window.api.toggle(entry.id); await refreshCurrent(); } },
    { sep: true },
    { label: '删除', danger: true, act: async () => { if (await window.api.removeConfirm(entry.id, entry.title)) await refreshCurrent(); } },
  ]);
}

async function entryById(id) {
  return state.entries.find((x) => x.id === id) || (await window.api.getEntry(id));
}

/* ---------------- 悬浮提示：被截断的文字悬停看全文 ---------------- */
function placeTip(ev) {
  const t = $('tip');
  if (!t || !t.classList.contains('on')) return;
  const r = t.getBoundingClientRect();
  let x = ev.clientX + 14;
  let y = ev.clientY + 18;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - 12;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

function hideTip() {
  const t = $('tip');
  if (t) t.classList.remove('on');
}

function showTipFor(el, ev) {
  const t = $('tip');
  if (!t) return;
  const main = el.getAttribute('data-tip') || '';
  const note = el.getAttribute('data-note') || '';
  if (!main) { hideTip(); return; }
  // 被横着截断（省略号）或竖着截断（两行 clamp）都要弹；两者都没有就不弹
  const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  if (!cut && !note) { hideTip(); return; }
  $('tip-t').textContent = main;
  $('tip-s').textContent = el.getAttribute('data-sub') || '';
  $('tip-n').textContent = note;
  t.classList.add('on');
  placeTip(ev);
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) { hideTip(); return; }
  showTipFor(el, e);
});
document.addEventListener('mousemove', (e) => placeTip(e));
document.addEventListener('scroll', hideTip, true);
document.addEventListener('click', hideTip, true);
window.addEventListener('blur', hideTip);
document.addEventListener('mouseleave', hideTip);

document.addEventListener('click', (e) => { if (!e.target.closest('.ctx')) closeCtx(); });
document.addEventListener('scroll', closeCtx, true);
window.addEventListener('blur', closeCtx);

/* ---------------- 启动 ---------------- */
window.api.onChanged(() => refreshCurrent());
// 换主题时重画一次：列表色/圆点是按主题算出来的内联样式
window.api.onTheme((m) => { applyTheme(m); refreshCurrent(); });
(async () => { applyTheme((await window.api.setting.get('theme')) || 'light'); })();
// 从桌面组件点「修改」进来：切到那一天并弹出编辑框
window.api.onEditRequest(async (id) => {
  const entry = await entryById(id);
  if (!entry) return;
  if (entry.date !== state.date) { state.date = entry.date; await loadToday(); }
  openEditor(entry);
});
setInterval(() => { checkDateRollover().catch(() => {}); }, 10000);
window.addEventListener('focus', () => { checkDateRollover().catch(() => {}); });
bind();
loadToday();
updateSidebar();
refreshChrome();
