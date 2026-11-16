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

/* 中文数字 → 阿拉伯数字：三点、八点半、十点、二十三分、十一点 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  if (!t) return NaN;
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  if (t === '十') return 10;
  if (!/^[零一二两三四五六七八九十]+$/.test(t)) return NaN;
  if (t.length === 1) return CN_DIGIT[t];
  if (t[0] === '十') return 10 + (CN_DIGIT[t[1]] || 0);
  if (t[1] === '十') return (CN_DIGIT[t[0]] || 0) * 10 + (t[2] ? (CN_DIGIT[t[2]] || 0) : 0);
  return NaN;
}

/* 分钟：「半」「一刻」「三刻」「20」「二十分」 */
function minuteOf(spec) {
  if (!spec) return 0;
  const t = String(spec).replace(/\s*分$/, '').trim();
  if (t === '半') return 30;
  if (t === '一刻') return 15;
  if (t === '三刻') return 45;
  const n = cnNum(t);
  return Number.isFinite(n) && n >= 0 && n < 60 ? n : 0;
}

/* 中文数字或阿拉伯数字的小时 + 时段词 → 24 小时制；不合法的返回 null */
function hourOf(hh, period) {
  let h = cnNum(hh);
  if (!Number.isFinite(h)) return null;
  const p = period || '';
  if (/下午|傍晚|晚上|晚间|夜里|深夜|晚/.test(p)) {
    if (h < 12) h += 12;
  } else if (p === '中午') {
    if (h < 11) h += 12;
  } else if (p === '凌晨') {
    if (h === 12) h = 0;
  } else if (/早上|早|上午|清晨|早晨/.test(p)) {
    // 原样：早上 8 点 = 08:00
  } else if (h >= 1 && h <= 6) {
    // 只说「三点」按下午算（15:00），凌晨三点请说「凌晨三点」
    h += 12;
  }
  return h % 24;
}

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
  // 注意顺序：长的先匹配，否则「大后天」会被「后天」抢先吃掉，标题里剩个「大」
  const rel = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0 };
  let dateSet = false;
  for (const [k, n] of Object.entries(rel)) {
    if (rest.includes(k)) { out.date = addDays(base, n); rest = rest.replace(k, ' '); dateSet = true; break; }
  }
  if (!dateSet) {
    take(/(下个?|这个?|本)?周([一二三四五六日天])/, (m) => {
      // 周一 = 1 … 周日 = 7，和 cur 同一套编号
      const target = '一二三四五六日'.indexOf(m[2] === '天' ? '日' : m[2]) + 1;
      const d = parseYmd(base);
      const cur = (d.getDay() + 6) % 7 + 1;
      let diff = target - cur;
      if (/下/.test(m[1] || '')) {
        // 「下周三」= 本周的周三再往后 7 天；diff 为负时不能先补 7 再 +7，否则会多跳一周
        diff += 7;
      } else if (diff < 0) {
        // 「周三」但本周三已经过了 → 顺延到下一个周三；正好是今天则算今天
        diff += 7;
      }
      out.date = addDays(base, diff);
    }) || take(/(\d{1,2})月(\d{1,2})[日号]/, (m) => {
      const d = parseYmd(base);
      out.date = `${d.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`;
    }) || take(/(?<![\d:：])(\d{1,2})[-/](\d{1,2})(?![\d点时:：])/, (m) => {
      const d = parseYmd(base);
      out.date = `${d.getFullYear()}-${pad(+m[1])}-${pad(+m[2])}`;
    });
  }

  // 时间
  // 只要句子里提到了时间就必须记下来：支持 15:30 / 15点 / 下午三点 / 三点半 / 三点一刻 /
  // 上午九点二十 / 3点到5点 / 下午2-4点；中文数字和阿拉伯数字等价
  const NUM = '(?:[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})';
  const PERIOD = '(?:凌晨|清晨|早晨|早上|早|上午|中午|下午|傍晚|晚间|晚上|夜里|深夜|晚)';
  const MINUTE = '(?:半|一刻|三刻|' + NUM + '\\s*分|' + NUM + ')';
  const core = (p, h, m) => '(?<' + p + '>' + PERIOD + ')?\\s*(?<' + h + '>' + NUM + ')\\s*[:：时点](?<' + m + '>' + MINUTE + ')?';
  const RE_RANGE = new RegExp(
    core('p1', 'h1', 'm1') + '\\s*(?:[-–—~～]|到|至)\\s*(?<p2>' + PERIOD + ')?\\s*(?<h2>' + NUM + ')\\s*(?:[:：时点](?<m2>' + MINUTE + ')?)?',
  );
  // 前一段省略「点」的写法：下午2-4点 / 3-5点（第二段必须有「点」，否则「3-5天」会被误判成时间）
  const RE_RANGE2 = new RegExp(
    '(?<p1>' + PERIOD + ')?\\s*(?<h1>' + NUM + ')\\s*(?:[-–—~～]|到|至)\\s*(?<p2>' + PERIOD + ')?\\s*(?<h2>' + NUM + ')\\s*[:：时点](?<m2>' + MINUTE + ')?',
  );
  const RE_TIME = new RegExp(core('p', 'h', 'm'));

  const setStartEnd = (h1, m1, h2, m2) => {
    out.start = `${pad(h1)}:${pad(m1)}`;
    if (h2 == null) {
      const end = new Date(2000, 0, 1, h1, m1 + 60);
      out.end = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
    } else {
      out.end = `${pad(h2)}:${pad(m2)}`;
    }
  };
  const span = rest.match(RE_RANGE) || rest.match(RE_RANGE2);
  if (span) {
    const h1 = hourOf(span.groups.h1, span.groups.p1);
    const h2 = hourOf(span.groups.h2, span.groups.p2 || span.groups.p1);
    if (h1 != null && h2 != null) {
      setStartEnd(h1, minuteOf(span.groups.m1), h2, minuteOf(span.groups.m2));
      rest = rest.replace(span[0], ' ');
    }
  }
  if (!out.start) {
    const one = rest.match(RE_TIME);
    if (one) {
      const h = hourOf(one.groups.h, one.groups.p);
      if (h != null) {
        setStartEnd(h, minuteOf(one.groups.m), null, 0);
        rest = rest.replace(one[0], ' ');
      }
    }
  }

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
