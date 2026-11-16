'use strict';

/*
 * 日格 · 端到端测试
 * 用 Playwright 的 Electron 驱动，真实启动应用、操作界面、重启验证持久化。
 * 运行：node test/e2e.js
 */

const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP, 'runtime', 'electron.exe');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'daygrid-e2e-'));
const SHOTS = path.join(__dirname, 'screens');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
}

function env() {
  const e = { ...process.env, DAYGRID_DATA_DIR: DATA, DAYGRID_TEST: '1', DAYGRID_USER_DATA: DATA + '-profile', DAYGRID_SYNC_PORT: '0' };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

async function launch() {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: ['.'],
    cwd: APP,
    env: env(),
    timeout: 60000,
  });
  return app;
}

async function pageByUrl(app, part, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = app.windows().find((w) => w.url().includes(part));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('找不到窗口: ' + part);
}

async function main() {
  console.log('数据目录:', DATA);
  let app = await launch();

  /* ---------- 1. 组件窗口 ---------- */
  const widget = await pageByUrl(app, 'widget.html');
  widget.on('pageerror', (err) => console.log('WIDGET PAGE ERROR:', err.message));
  widget.on('console', (msg) => { if (msg.type() === 'error') console.log('WIDGET CONSOLE:', msg.text()); });
  await widget.waitForSelector('.w-cell', { timeout: 20000 });
  check('组件窗口加载', (await widget.title()) === '日格');
  check('月历渲染 42 格', (await widget.locator('.w-cell').count()) === 42);
  check('今天高亮', (await widget.locator('.w-cell.today').count()) === 1);
  const ratio0 = await widget.locator('#w-ratio').textContent();
  check('组件显示今日进度', /^\d+\/\d+$/.test(ratio0.trim()), ratio0);

  const firstTitle = await widget.locator('.w-item .ti').first().textContent();
  check('组件显示示例条目', !!firstTitle, firstTitle);

  const topMost = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('widget.html'));
    return !!(w && w.isAlwaysOnTop());
  });
  check('组件窗口置顶（压在全屏程序之上）', topMost === true, String(topMost));

  /* 跨天换日：把页面里的 Date 往后拨一天，today / 选中日期都应跟上 */
  const rollover = await widget.evaluate(async () => {
    const Real = Date;
    const SHIFT = 86400000;
    class Fake extends Real {
      constructor(...a) { if (a.length) { super(...a); } else { super(Real.now() + SHIFT); } }
      static now() { return Real.now() + SHIFT; }
    }
    const before = today;
    window.Date = Fake;
    const changed = await checkDateRollover();
    const rolled = { before, changed, after: today, selected, cells: [...document.querySelectorAll('.w-cell.today')].map((x) => x.dataset.date) };
    window.Date = Real;
    await checkDateRollover();
    rolled.restored = today === before;
    return rolled;
  });
  check('跨天后「今天」自动更新', rollover.changed === true && rollover.after !== rollover.before, JSON.stringify(rollover));
  check('跨天后高亮只剩新的一天', rollover.cells.length === 1 && rollover.cells[0] === rollover.after, JSON.stringify(rollover.cells));
  check('跨天后选中日期跟着走，且能回到今天', rollover.selected === rollover.after && rollover.restored, JSON.stringify(rollover));

  await widget.screenshot({ path: path.join(SHOTS, '01-widget.png') });

  /* ---------- 1.5 拖动 + 收起成小图标 / 展开 ---------- */
  const wbounds = () => app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('widget.html'));
    return w ? w.getBounds() : null;
  });
  const bBefore = await wbounds();
  await widget.evaluate(async () => {
    const el = document.querySelectorAll('.w-cell')[10];
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, button: 0, clientX: r.x + 8, clientY: r.y + 8 };
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, screenX: 800, screenY: 500 }));
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { ...base, screenX: 800 - i * 15, screenY: 500 + i * 10 }));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { ...base, screenX: 710, screenY: 560 }));
    await new Promise((res) => setTimeout(res, 250));
  });
  const bAfter = await wbounds();
  check('从日历区域就能拖动窗口', Math.abs((bAfter.x - bBefore.x) + 90) <= 6 && Math.abs((bAfter.y - bBefore.y) - 60) <= 6, `${bAfter.x - bBefore.x}, ${bAfter.y - bBefore.y}`);
  check('拖动不误触日期选中', /今天/.test(await widget.locator('#w-day-label').textContent()));

  await widget.click('#w-fold');
  await widget.waitForTimeout(700);
  const bMini = await wbounds();
  check('收起成小图标（窗口变小）', bMini.width <= 200 && bMini.height <= 75 && bMini.width < bBefore.width / 2, `${bMini.width}x${bMini.height}`);
  check('收起后只剩图标', await widget.evaluate(() => {
    const mini = document.querySelector('.w-mini');
    const card = document.getElementById('widget');
    return getComputedStyle(mini).display !== 'none' && getComputedStyle(card).display === 'none';
  }));
  check('图标上是今天的日期', (await widget.locator('#w-mini-day').textContent()).trim() === String(new Date().getDate()));
  await widget.screenshot({ path: path.join(SHOTS, '01b-widget-mini.png') });

  await widget.click('#w-mini-open');
  await widget.waitForTimeout(700);
  const bBack = await wbounds();
  check('再展开回日历', Math.abs(bBack.width - 392) <= 4 && Math.abs(bBack.height - 568) <= 4, `${bBack.width}x${bBack.height}`);

  await widget.locator('.w-cell').nth(20).click();
  await widget.waitForTimeout(250);
  check('拖动后点选日期仍然有效', !/今天/.test(await widget.locator('#w-day-label').textContent()));
  await widget.click('#w-today');
  await widget.waitForTimeout(250);

  /* ---------- 2. 到期提醒 ---------- */
  const fired = await widget.evaluate(async () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const start = `${p(d.getHours())}:${p(d.getMinutes())}`;
    await window.api.create({ title: '提醒测试', date, start, listId: 'work', remindOffset: 10 });
    return await window.api.checkReminders();
  });
  check('到期提醒被调度', fired >= 1, String(fired));
  await widget.waitForSelector('#reminder-bar:not([hidden])', { timeout: 5000 });
  const rb = await widget.locator('#rb-title').textContent();
  check('组件显示提醒条', rb.includes('提醒测试'), rb);
  await widget.screenshot({ path: path.join(SHOTS, '02-reminder.png') });
  await widget.click('#rb-close');

  /* ---------- 3. 速记 → 新建条目 ---------- */
  const capture = await pageByUrl(app, 'capture.html');
  await widget.click('#w-add');
  await capture.waitForSelector('#cap-input', { state: 'visible', timeout: 8000 });
  await capture.fill('#cap-input', '今天下午4点 和设计对稿 #工作 !高');
  await capture.waitForTimeout(150);
  const chips = await capture.locator('.chip').allTextContents();
  check('速记解析出日期/时间/标签', chips.some((c) => c.includes('16:00')) && chips.some((c) => c.includes('#工作')), chips.join(' | '));

  /* 周几解析回归：周五（11/13）说的「下周三」是 11/18，周一（11/16）说的才是 11/25 */
  const dow = await capture.evaluate(() => ({
    nextWedFromFri: parse('下周三对方案', '2026-11-13').date,
    nextWedFromMon: parse('下周三对方案', '2026-11-16').date,
    wedFromFri: parse('周三 对方案', '2026-11-13').date,
    bigAfter: parse('大后天对方案', '2026-11-16'),
  }));
  check('「下周三」按基准日推算，不多跳一周', dow.nextWedFromFri === '2026-11-18', dow.nextWedFromFri);
  check('周一说「下周三」是 11/25', dow.nextWedFromMon === '2026-11-25', dow.nextWedFromMon);
  check('「周三」本周已过则顺延', dow.wedFromFri === '2026-11-18', dow.wedFromFri);
  check('「大后天」不残留「大」', dow.bigAfter.date === '2026-11-19' && !dow.bigAfter.title.includes('大'), `${dow.bigAfter.date} ${dow.bigAfter.title}`);

  /* 时间解析回归：提到时间就必须记下来，中文数字也要认 */
  const tp = await capture.evaluate(() => ({
    cn: parse('后天下午三点 对方案', '2026-11-16'),
    half: parse('晚上八点半 聚餐', '2026-11-16'),
    range: parse('下午2-4点 评审', '2026-11-16'),
    clock: parse('15:30-17:00 评审', '2026-11-16'),
    none: parse('整理文档', '2026-11-16'),
  }));
  check('「后天下午三点」= 11/18 15:00–16:00', tp.cn.date === '2026-11-18' && tp.cn.start === '15:00' && tp.cn.end === '16:00', `${tp.cn.date} ${tp.cn.start}-${tp.cn.end}`);
  check('「晚上八点半」= 20:30–21:30', tp.half.start === '20:30' && tp.half.end === '21:30', `${tp.half.start}-${tp.half.end}`);
  check('时间段「下午2-4点」= 14:00–16:00', tp.range.start === '14:00' && tp.range.end === '16:00', `${tp.range.start}-${tp.range.end}`);
  check('「15:30-17:00」不吃掉成日期', tp.clock.start === '15:30' && tp.clock.end === '17:00', `${tp.clock.start}-${tp.clock.end}`);
  check('没提时间就不记时间', tp.none.start === null, String(tp.none.start));
  await capture.screenshot({ path: path.join(SHOTS, '02-capture.png') });

  await capture.press('#cap-input', 'Enter');
  await capture.waitForTimeout(600);

  /* ---------- 3. 打开主窗口 ---------- */
  const mainPromise = app.waitForEvent('window');
  await widget.click('#w-menu');
  const mainWin = await mainPromise;
  mainWin.on('pageerror', (err) => console.log('MAIN PAGE ERROR:', err.message));
  mainWin.on('console', (msg) => { if (msg.type() === 'error') console.log('MAIN CONSOLE:', msg.text()); });
  await mainWin.waitForTimeout(1500);
  console.log('主窗口 url:', mainWin.url());
  await mainWin.screenshot({ path: path.join(SHOTS, 'debug-main.png') });
  const bodyLen = (await mainWin.evaluate(() => document.body.innerText)).length;
  console.log('主窗口文本长度:', bodyLen);
  await mainWin.waitForSelector('#view-today .ev, #task-list .task', { timeout: 15000 });
  check('主窗口打开「今天」', (await mainWin.locator('#tb-path').textContent()).includes('今天'));

  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('app.html'));
    const b = w.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      b,
      wa,
      areaRatio: (b.width * b.height) / (wa.width * wa.height),
      dxLeft: b.x - wa.x,
      dxRight: (wa.x + wa.width) - (b.x + b.width),
      dyTop: b.y - wa.y,
      dyBottom: (wa.y + wa.height) - (b.y + b.height),
    };
  });
  check('主窗口约占屏幕面积 1/3', geo.areaRatio > 0.28 && geo.areaRatio < 0.40, `${geo.b.width}x${geo.b.height} @ ${geo.areaRatio.toFixed(3)}`);
  check('主窗口居中', Math.abs(geo.dxLeft - geo.dxRight) <= 8 && Math.abs(geo.dyTop - geo.dyBottom) <= 8, `x ${geo.dxLeft}/${geo.dxRight} y ${geo.dyTop}/${geo.dyBottom}`);

  const titles = await mainWin.locator('#task-list .tt').allTextContents();
  check('新条目进入今日待办', titles.some((t) => t.includes('和设计对稿')), titles.join(' | '));

  const posted = await mainWin.locator('#statline').textContent();
  check('统计行显示完成数', /完成\s*\d+\/\d+/.test(posted.replace(/\s+/g, ' ')), posted.replace(/\s+/g, ' ').slice(0, 60));

  await mainWin.screenshot({ path: path.join(SHOTS, '03-today.png') });

  /* ---------- 4. 勾选完成 ---------- */
  const target = mainWin.locator('#task-list .task', { hasText: '和设计对稿' }).first();
  await target.locator('[data-toggle]').click();
  await mainWin.waitForTimeout(500);
  const doneText = await mainWin.locator('#done-list').textContent();
  check('勾选后进入已完成', doneText.includes('和设计对稿'));

  /* ---------- 4.5 新建默认时间 ---------- */
  await mainWin.click('#btn-new');
  await mainWin.waitForSelector('#editor-overlay.on');
  const st = await mainWin.inputValue('#ed-start');
  const en = await mainWin.inputValue('#ed-end');
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  check('新建默认填充时间', /^\d{2}:\d{2}$/.test(st) && /^\d{2}:\d{2}$/.test(en), `${st} - ${en}`);
  check('默认时长为 1 小时', toMin(en) - toMin(st) === 60, String(toMin(en) - toMin(st)));
  await mainWin.click('#ed-cancel');

  /* ---------- 4.6 主题与组件开关 ---------- */
  await mainWin.click('.side-bottom a[data-view="settings"]');
  await mainWin.waitForSelector('#theme-seg');
  check('组件按钮初始为隐藏', (await mainWin.textContent('#btn-toggle-widget')).trim() === '隐藏组件');
  await mainWin.click('#btn-toggle-widget');
  await mainWin.waitForTimeout(300);
  check('隐藏后按钮变显示', (await mainWin.textContent('#btn-toggle-widget')).trim() === '显示组件');
  check('组件确实隐藏', (await mainWin.evaluate(() => window.api.widgetVisible())) === false);
  await mainWin.click('#btn-toggle-widget');
  await mainWin.waitForTimeout(300);
  check('再次点击恢复隐藏', (await mainWin.textContent('#btn-toggle-widget')).trim() === '隐藏组件');

  await mainWin.waitForSelector('#cloud-url');
  const hasCloud = (await mainWin.locator('#cloud-url').count()) === 1 && (await mainWin.locator('#cloud-pass').count()) === 1;
  check('设置页有云同步配置', hasCloud);

  await mainWin.click('#theme-seg span[data-theme-mode="dark"]');
  await mainWin.waitForTimeout(400);
  check('深色主题生效', (await mainWin.evaluate(() => document.body.dataset.theme)) === 'dark');
  await widget.waitForTimeout(400);
  await widget.screenshot({ path: path.join(SHOTS, '08-dark-widget.png') });
  await mainWin.screenshot({ path: path.join(SHOTS, '06-dark-settings.png') });
  await mainWin.click('.nav a[data-view="today"]');
  await mainWin.waitForTimeout(400);
  await mainWin.screenshot({ path: path.join(SHOTS, '07-dark-today.png') });

  await mainWin.click('.side-bottom a[data-view="settings"]');
  await mainWin.click('#theme-seg span[data-theme-mode="transparent"]');
  await mainWin.waitForTimeout(400);
  check('透明主题生效', (await widget.evaluate(() => document.body.dataset.transparent)) === '1');
  await widget.screenshot({ path: path.join(SHOTS, '09-transparent.png') });

  await mainWin.click('#theme-seg span[data-theme-mode="light"]');
  await mainWin.waitForTimeout(300);

  /* ---------- 5. 日历月视图 ---------- */
  await mainWin.click('.nav a[data-view="month"]');
  await mainWin.waitForSelector('#month-grid .mcell');
  check('月视图 42 格', (await mainWin.locator('#month-grid .mcell').count()) === 42);
  const monthTitle = await mainWin.locator('#month-title').textContent();
  check('月视图标题', /年\s*\d+\s*月/.test(monthTitle), monthTitle.trim());
  await mainWin.screenshot({ path: path.join(SHOTS, '04-month.png') });

  /* ---------- 6. 复盘 ---------- */
  await mainWin.click('.nav a[data-view="review"]');
  await mainWin.waitForSelector('#kpi-rate');
  await mainWin.waitForTimeout(400);
  const rate = await mainWin.locator('#kpi-rate').textContent();
  const doneKpi = await mainWin.locator('#kpi-done').textContent();
  check('复盘渲染完成率', /\d+%/.test(rate), rate.trim());
  check('复盘渲染完成/计划', /\d+\s*\/\s*\d+/.test(doneKpi.replace(/\s+/g, ' ')), doneKpi.trim());
  const heatCells = await mainWin.locator('#heat i').count();
  check('热力图 182 格', heatCells === 182, String(heatCells));
  await mainWin.screenshot({ path: path.join(SHOTS, '05-review.png') });

  /* ---------- 7. 搜索 ---------- */
  await mainWin.keyboard.press('Control+k');
  await mainWin.waitForSelector('#search-overlay.on');
  await mainWin.fill('#search-input', '设计');
  await mainWin.waitForTimeout(300);
  const found = await mainWin.locator('.search-item').count();
  check('搜索命中条目', found >= 1, String(found));
  await mainWin.keyboard.press('Escape');

  /* ---------- 8. 每日一句 ---------- */
  await mainWin.click('.nav a[data-view="today"]');
  await mainWin.waitForSelector('#daily-summary');
  await mainWin.fill('#daily-summary', '今天把原型跑通了，明天开始做真实数据。');
  await mainWin.locator('#daily-summary').blur();
  await mainWin.waitForTimeout(500);

  /* ---------- 9. 关闭并重启，验证持久化 ---------- */
  await app.close();
  await new Promise((r) => setTimeout(r, 800));

  app = await launch();
  const w2 = await pageByUrl(app, 'widget.html');
  await w2.waitForSelector('.w-cell', { timeout: 20000 });
  await w2.waitForTimeout(500);
  const dbFile = path.join(DATA, 'daygrid.db');
  check('数据库文件存在', fs.existsSync(dbFile), `${(fs.statSync(dbFile).size / 1024).toFixed(0)} KB`);
  const backups = fs.readdirSync(path.join(DATA, 'backups'));
  check('自动备份已生成', backups.length >= 1, backups.join(', '));

  const mainPromise2 = app.waitForEvent('window');
  await w2.click('#w-menu');
  const main2 = await mainPromise2;
  await main2.waitForSelector('#task-list, #done-list');
  await main2.waitForTimeout(600);
  const doneAfter = await main2.locator('#done-list').textContent();
  check('重启后完成状态仍在', doneAfter.includes('和设计对稿'));
  const summaryVal = await main2.locator('#daily-summary').inputValue();
  check('重启后每日一句仍在', summaryVal.includes('原型跑通'), summaryVal);

  /* ---------- 10. 导出 ---------- */
  const exported = await main2.evaluate(async () => {
    const all = await window.api.range('2000-01-01', '2099-12-31');
    return all.length;
  });
  check('全量查询包含条目', exported >= 8, String(exported));

  await main2.screenshot({ path: path.join(SHOTS, '06-today-after-restart.png') });
  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join(' / '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E 运行失败：', e);
  process.exit(1);
});
