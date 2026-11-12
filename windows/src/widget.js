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
(async () => { applyTheme((await window.api.setting.get('theme')) || 'light'); })();
window.api.onTheme((m) => applyTheme(m));

const COLORS = { work: '#1F6F78', life: '#BF6F3E', study: '#6B5B95' };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

const today = ymd(new Date());
let selected = today;
let cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let dayCache = [];

function isoWeek(dateStr) {
  const d = parseYmd(dateStr);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function gridStart(d) {
  const first = monthStart(d);
  const wd = (first.getDay() + 6) % 7;
  const s = new Date(first);
  s.setDate(first.getDate() - wd);
  return s;
}

async function renderGrid() {
  const start = gridStart(cursor);
  const from = ymd(start);
  const to = addDays(from, 41);
  const counts = await window.api.counts(from, to);

  document.getElementById('w-month').textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  document.getElementById('w-week').textContent = `第 ${isoWeek(selected)} 周`;

  let html = '';
  for (let i = 0; i < 42; i++) {
    const key = addDays(from, i);
    const d = parseYmd(key);
    const out = d.getMonth() !== cursor.getMonth();
    const wd = (d.getDay() + 6) % 7;
    const c = counts[key] || { total: 0, lists: [] };
    const dots = c.lists.slice(0, 3).map((id) => `<i style="background:${COLORS[id] || '#9AA39F'}"></i>`).join('');
    const cls = ['w-cell', out ? 'out' : '', wd >= 5 ? 'weekend' : '', key === today ? 'today' : '', key === selected ? 'sel' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" data-date="${key}"><span class="num">${d.getDate()}</span><span class="w-dots">${dots}</span></div>`;
  }
  document.getElementById('w-grid').innerHTML = html;
}

function renderHead() {
  const label = document.getElementById('w-day-label');
  const ratio = document.getElementById('w-ratio');
  const ratioLabel = document.getElementById('w-ratio-label');
  if (selected === today) {
    label.textContent = `今天 · 周${WD[parseYmd(selected).getDay()]}`;
    const done = dayCache.filter((e) => e.status === 'done').length;
    ratio.textContent = `${done}/${dayCache.length}`;
    ratioLabel.textContent = '已完成';
  } else {
    const d = parseYmd(selected);
    label.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 周${WD[d.getDay()]}`;
    ratio.textContent = `${dayCache.length}`;
    ratioLabel.textContent = '件';
  }
  document.getElementById('w-week').textContent = `第 ${isoWeek(selected)} 周`;
}

function renderList() {
  const ul = document.getElementById('w-list');
  const items = dayCache.slice(0, 4);
  if (!items.length) {
    ul.innerHTML = '<li class="w-empty">这天还没有安排</li>';
    return;
  }
  ul.innerHTML = items.map((e) => `
    <li class="w-item ${e.status === 'done' ? 'done' : ''}" data-id="${e.id}">
      <span class="w-check ${e.status === 'done' ? 'on' : ''}" data-toggle="${e.id}"></span>
      <span class="t">${e.start || '--:--'}</span>
      <span class="ti">${escapeHtml(e.title)}</span>
      ${dayCache.length > 4 && items.indexOf(e) === 3 ? `<span class="badge">+${dayCache.length - 4}</span>` : ''}
    </li>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadDay() {
  dayCache = await window.api.range(selected, selected);
  renderHead();
  renderList();
}

async function refresh() {
  await Promise.all([renderGrid(), loadDay()]);
}

document.getElementById('w-grid').addEventListener('click', async (e) => {
  const cell = e.target.closest('.w-cell');
  if (!cell) return;
  selected = cell.dataset.date;
  if (parseYmd(selected).getMonth() !== cursor.getMonth()) cursor = monthStart(parseYmd(selected));
  await refresh();
});

document.getElementById('w-grid').addEventListener('dblclick', (e) => {
  const cell = e.target.closest('.w-cell');
  if (cell) window.api.capture(cell.dataset.date);
});

document.getElementById('w-grid').addEventListener('wheel', async (e) => {
  e.preventDefault();
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + (e.deltaY > 0 ? 1 : -1), 1);
  await renderGrid();
}, { passive: false });

document.getElementById('w-list').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  await window.api.toggle(t.dataset.toggle);
  await refresh();
});

document.getElementById('w-add').addEventListener('click', () => window.api.capture(selected));
document.getElementById('w-menu').addEventListener('click', () => window.api.openMain());
document.getElementById('w-today').addEventListener('click', async () => {
  selected = today;
  cursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  await refresh();
});

let reminderId = null;
window.api.onReminder((r) => {
  reminderId = r.id;
  document.getElementById('rb-title').textContent = `${r.start} ${r.title}`;
  document.getElementById('rb-sub').textContent = r.mins > 0 ? `还有 ${r.mins} 分钟` : '现在开始';
  document.getElementById('reminder-bar').hidden = false;
});
document.getElementById('rb-close').addEventListener('click', () => {
  document.getElementById('reminder-bar').hidden = true;
});
document.getElementById('rb-done').addEventListener('click', async () => {
  if (reminderId) await window.api.toggle(reminderId);
  document.getElementById('reminder-bar').hidden = true;
  await refresh();
});

window.api.onChanged(() => refresh());
refresh();
