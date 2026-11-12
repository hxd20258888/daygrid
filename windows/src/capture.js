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

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const LIST = { 工作: 'work', 生活: 'life', 学习: 'study' };

const input = document.getElementById('cap-input');
const chipsEl = document.getElementById('cap-chips');
const destEl = document.getElementById('cap-dest');

let baseDate = ymd(new Date());

function parse(text, base) {
  const out = { title: text, date: base, start: null, end: null, tags: [], listId: 'work', priority: 0, estimate: null, allDay: false, matched: [] };
  let rest = text;

  const take = (re, fn) => {
    const m = rest.match(re);
    if (!m) return false;
    fn(m);
    rest = rest.replace(m[0], ' ');
    return true;
  };

  // 日期
  const rel = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3 };
  let dateSet = false;
  for (const [k, n] of Object.entries(rel)) {
    if (rest.includes(k)) { out.date = addDays(base, n); rest = rest.replace(k, ' '); dateSet = true; break; }
  }
  if (!dateSet) {
    take(/(下)?周([一二三四五六日天])/, (m) => {
      const target = '一二三四五六日'.indexOf(m[2] === '天' ? '日' : m[2]) + 1;
      const d = parseYmd(base);
      const cur = (d.getDay() + 6) % 7 + 1;
      let diff = target - cur;
      if (diff <= 0) diff += 7;
      if (m[1]) diff += 7;
      out.date = addDays(base, diff);
    }) || take(/(\d{1,2})月(\d{1,2})[日号]/, (m) => {
      const d = parseYmd(base);
      out.date = `${d.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`;
    }) || take(/(\d{1,2})[-/](\d{1,2})/, (m) => {
      const d = parseYmd(base);
      out.date = `${d.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`;
    });
  }

  // 时间
  take(/(上午|下午|晚上|中午)?\s*(\d{1,2})[:：点](\d{0,2})分?\s*[-–—到至]\s*(\d{1,2})[:：点](\d{0,2})/, (m) => {
    const conv = (h, mm, ap) => {
      let hh = +h;
      if ((ap === '下午' || ap === '晚上') && hh < 12) hh += 12;
      if (ap === '中午' && hh < 11) hh += 12;
      return `${pad(hh)}:${pad(mm ? +mm : 0)}`;
    };
    out.start = conv(m[2], m[3], m[1]);
    out.end = conv(m[4], m[5], m[1]);
  }) || take(/(上午|下午|晚上|中午)?\s*(\d{1,2})[:：点](\d{0,2})分?半?/, (m) => {
    let hh = +m[2];
    if ((m[1] === '下午' || m[1] === '晚上') && hh < 12) hh += 12;
    if (m[1] === '中午' && hh < 11) hh += 12;
    const mm = /半/.test(m[0]) ? 30 : (m[3] ? +m[3] : 0);
    out.start = `${pad(hh)}:${pad(mm)}`;
    const end = new Date(2000, 0, 1, hh, mm + 60);
    out.end = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  });

  // 标签 / 清单 / 优先级 / 时长
  const tags = [...rest.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
  if (tags.length) { out.tags = tags; rest = rest.replace(/#[^\s#]+/g, ' '); }
  take(/@([^\s@]+)/, (m) => { out.listId = LIST[m[1]] || 'work'; });
  take(/!(高|中|低)/, (m) => { out.priority = m[1] === '高' ? 2 : m[1] === '中' ? 1 : 0; });
  take(/~\s*(\d+)\s*(m|min|分钟|h|小时)?/, (m) => {
    const n = +m[1];
    out.estimate = /h|小时/.test(m[2] || '') ? n * 60 : n;
  });
  if (rest.includes('全天')) { out.allDay = true; rest = rest.replace('全天', ' '); }

  out.title = rest.replace(/\s+/g, ' ').trim() || text.trim();
  return out;
}

function chipHtml(p) {
  const d = parseYmd(p.date);
  const dateLabel = p.date === ymd(new Date()) ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`;
  const ic = {
    date: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1F6F78" stroke-width="1.9"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    time: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1F6F78" stroke-width="1.9"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    tag: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#1F6F78" stroke-width="1.9"><path d="M4 12V5h7l9 9-7 7z"/><circle cx="8" cy="9" r="1.2"/></svg>',
  };
  let html = `<span class="chip">${ic.date} <b>${dateLabel}</b></span>`;
  if (p.start) html += `<span class="chip">${ic.time} <b>${p.start}</b>${p.end ? ' – ' + p.end : ''}</span>`;
  if (p.tags.length) html += `<span class="chip tag">${ic.tag} ${p.tags.map((t) => '#' + t).join(' ')}</span>`;
  if (p.priority === 2) html += `<span class="chip">！高优先级</span>`;
  if (p.estimate) html += `<span class="chip">~${p.estimate} 分钟</span>`;
  return html + '<span class="chip ghost">+ 提醒：提前 10 分钟</span>';
}

function update() {
  const raw = input.value.trim();
  if (!raw) {
    chipsEl.innerHTML = '<span class="chip ghost">输入后自动识别日期、时间与标签</span>';
    destEl.textContent = '今天';
    return;
  }
  const p = parse(raw, baseDate);
  chipsEl.innerHTML = chipHtml(p);
  const d = parseYmd(p.date);
  destEl.textContent = p.date === ymd(new Date()) ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
}

async function save(openDetail) {
  const raw = input.value.trim();
  if (!raw) { window.api.closeCapture(); return; }
  const p = parse(raw, baseDate);
  await window.api.create({
    title: p.title,
    date: p.date,
    start: p.start,
    end: p.end,
    allDay: p.allDay,
    listId: p.listId,
    tags: p.tags,
    priority: p.priority,
    estimate: p.estimate,
  });
  input.value = '';
  update();
  window.api.closeCapture();
  if (openDetail) window.api.openMain();
}

input.addEventListener('input', update);
input.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); window.api.closeCapture(); }
  if (e.key === 'Enter') { e.preventDefault(); save(e.ctrlKey || e.metaKey); }
});

window.api.onFocus((payload) => {
  baseDate = (payload && payload.date) || ymd(new Date());
  input.value = '';
  update();
  input.focus();
  window.setTimeout(() => input.focus(), 30);
});

update();
