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

/* 深色主题下把这些列表色提亮，否则暗底上的小圆点几乎看不见 */
function mixHex(hex, to, t) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const a = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
const dotColor = (id) => {
  const c = COLORS[id] || '#9AA39F';
  return themeMode === 'dark' ? mixHex(c, '#ffffff', 0.55) : c;
};
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };

/*
 * 组件是常驻进程，不能把“今天”在加载时算一次就冻住：
 * 跨过零点、或者电脑睡眠唤醒后，today 必须重新计算，否则会一直停在启动那天。
 */
const realToday = () => ymd(new Date());
let today = realToday();
let selected = today;
let cursor = monthStart(new Date());
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
    const dots = c.lists.slice(0, 3).map((id) => `<i style="background:${dotColor(id)}"></i>`).join('');
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
      <span class="ti" data-tip="${escapeHtml(e.title)}" data-sub="${escapeHtml(`${e.start || '无时间'} · ${e.listName || ''}${e.status === 'done' ? ' · 已完成' : ''}`)}">${escapeHtml(e.title)}</span>
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

/* 发现日期翻篇：今天高亮跟着走；如果之前停在“今天”，选中日期也一起跟过去 */
async function checkDateRollover() {
  const now = realToday();
  if (now === today) return false;
  const followToday = (selected === today);
  today = now;
  if (followToday) {
    selected = today;
    cursor = monthStart(parseYmd(today));
  }
  await refresh();
  if (isMini()) renderMini();
  return true;
}
setInterval(() => { checkDateRollover().catch(() => {}); }, 10000);
window.addEventListener('focus', () => { checkDateRollover().catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkDateRollover().catch(() => {});
});

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
  today = realToday();
  selected = today;
  cursor = monthStart(parseYmd(today));
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

window.api.onChanged(() => { refresh(); if (isMini()) renderMini(); });
// 换主题要重画：圆点颜色是按主题算出来的内联样式
window.api.onTheme((m) => { applyTheme(m); refresh(); if (isMini()) renderMini(); });

/* ---------------- 收起成小图标 / 展开 ---------------- */
const MINI = 'mini';
function isMini() { return document.body.classList.contains('collapsed'); }

async function renderMini() {
  const d = parseYmd(today);
  document.getElementById('w-mini-day').textContent = d.getDate();
  document.getElementById('w-mini-wd').textContent = '周' + WD[d.getDay()];
  const dots = document.getElementById('w-mini-dots');
  try {
    const c = await window.api.counts(today, today);
    const lists = ((c && c[today]) || {}).lists || [];
    dots.innerHTML = lists.slice(0, 3).map((id) => `<i style="background:${dotColor(id)}"></i>`).join('');
  } catch (_) {
    dots.innerHTML = '';
  }
}

function paintMode(mode) {
  document.body.classList.toggle('collapsed', mode === MINI);
  if (mode === MINI) renderMini();
}

async function setMode(mode) {
  paintMode(mode);
  await window.api.setWidgetMode(mode);
  if (mode !== MINI) await refresh();
}

document.getElementById('w-fold').addEventListener('click', () => setMode(MINI));
document.getElementById('w-mini-open').addEventListener('click', () => setMode('expanded'));
window.api.onWidgetMode((m) => { if (m) paintMode(m); });

/* ---------------- 拖动：整张卡片（含小图标）任意位置按住就能拖 ---------------- */
let dragState = null;
let suppressClick = false;
let lastDragAt = 0;

document.addEventListener('mousedown', (e) => {
  suppressClick = false;
  if (e.button !== 0) return;
  if (e.target.closest('button, input, textarea, select, a')) return; // 这些自己处理点击
  dragState = { x: e.screenX, y: e.screenY, moved: false };
  window.api.widgetDrag({ phase: 'start' });
});

window.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.screenX - dragState.x;
  const dy = e.screenY - dragState.y;
  if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 小抖动不算拖动，保证点击有效
  dragState.moved = true;
  window.api.widgetDrag({ phase: 'move', dx, dy });
});

function endDrag() {
  if (!dragState) return;
  if (dragState.moved) {
    suppressClick = true;
    lastDragAt = Date.now();
    window.api.widgetDrag({ phase: 'end' });
  }
  dragState = null;
}
window.addEventListener('mouseup', endDrag);
document.addEventListener('mouseleave', endDrag);

/* 拖动结束后紧跟的那次 click / dblclick 不能当成点选 */
document.addEventListener('click', (e) => {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);
document.addEventListener('dblclick', (e) => {
  if (Date.now() - lastDragAt < 300) { e.stopPropagation(); e.preventDefault(); }
}, true);

/* ---------------- 悬浮提示：条目标题被截断时看全文 ---------------- */
function hideTip() {
  const t = document.getElementById('tip');
  if (t) t.classList.remove('on');
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  const t = document.getElementById('tip');
  if (!el || !t) { hideTip(); return; }
  if (el.scrollWidth <= el.clientWidth + 1) { hideTip(); return; }
  document.getElementById('tip-t').textContent = el.getAttribute('data-tip') || '';
  document.getElementById('tip-s').textContent = el.getAttribute('data-sub') || '';
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  let y = e.clientY + 16;
  if (y + r.height > window.innerHeight - 6) y = e.clientY - r.height - 10;
  t.style.left = `${Math.max(6, Math.min(e.clientX + 8, window.innerWidth - r.width - 6))}px`;
  t.style.top = `${Math.max(6, y)}px`;
});
document.addEventListener('mouseleave', hideTip);
document.addEventListener('wheel', hideTip, true);
document.addEventListener('click', hideTip, true);

/* 启动时按主进程给的模式渲染（避免先闪一下大卡片） */
paintMode(new URLSearchParams(location.search).get('mode') === MINI ? MINI : 'expanded');
refresh();
