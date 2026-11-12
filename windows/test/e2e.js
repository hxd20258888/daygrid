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

  await widget.screenshot({ path: path.join(SHOTS, '01-widget.png') });

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
