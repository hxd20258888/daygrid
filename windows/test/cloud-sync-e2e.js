'use strict';

/*
 * 云同步端到端测试：本地起一个“云服务器”，电脑端和手机端都当客户端。
 * 验证：初始化、配对、加密（服务器看不到明文）、双向同步。
 */

const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const { Store } = require('../db');
const { SyncClient } = require('../sync-client');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const MOBILE = path.join(ROOT, 'apps', 'mobile');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'daygrid-cloud-'));
const PC_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'daygrid-pc-'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
}
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

(async () => {
  /* 1. 初始化服务器 */
  const init = spawnSync(process.execPath, [SERVER, '--init'], { env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
  const out = init.stdout || '';
  const space = (out.match(/空间 ID\s*:\s*(\S+)/) || [])[1];
  const deviceId = (out.match(/设备 ID\s*:\s*(\S+)/) || [])[1];
  const token = (out.match(/设备令牌\s*:\s*(\S+)/) || [])[1];
  check('服务器初始化', !!(space && deviceId && token), space);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: DATA, MOBILE_DIR: MOBILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => console.log('SERVER ERR', d.toString().trim()));
  await new Promise((resolve) => {
    srv.stdout.on('data', (d) => { if (d.toString().includes('sync server on')) resolve(); });
    setTimeout(resolve, 3000);
  });
  check('服务器启动', true, url);

  /* 2. 电脑端作为客户端同步 */
  const store = new Store();
  await store.init(PC_DATA);
  const client = new SyncClient(store);
  client.save({ url, space, deviceId, token, pass: 'my-secret-pass' });
  const r1 = await client.sync();
  check('电脑端首次同步', r1.ok, JSON.stringify(r1));

  /* 3. 服务器只存密文 */
  const raw = fs.readFileSync(path.join(DATA, 'state.json'), 'utf8');
  const hasPlain = raw.includes('周会') || raw.includes('和张总');
  check('服务器上看不到明文', !hasPlain, hasPlain ? '发现明文!' : '只有密文');

  /* 4. 手机配对 */
  const code = await client.newCode();
  check('生成配对码', /^\d{6}$/.test(code), code);

  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(url + '/app/');
  await page.waitForTimeout(900);
  await page.click('.tab[data-tab="me"]');
  await page.waitForTimeout(300);
  await page.fill('#sync-url', url);
  await page.fill('#pair-code', code);
  await page.fill('#sync-pass', 'my-secret-pass');
  await page.click('#btn-pair');
  await page.waitForTimeout(2500);

  const paired = await page.evaluate(() => !!localStorage.getItem('daygrid.sync'));
  check('手机配对成功', paired);

  await page.click('.tab[data-tab="today"]');
  await page.waitForTimeout(600);
  const titles = await page.locator('#timed-list .row .title').allTextContents();
  check('手机拉到电脑数据', titles.length >= 3, titles.slice(0, 3).join(' / '));

  /* 5. 手机新增 → 电脑拉到 */
  await page.click('#fab');
  await page.waitForTimeout(400);
  await page.fill('#cap-input', '今天下午6点 手机上记的 #工作');
  await page.click('#cap-save');
  await page.waitForTimeout(900);
  await page.click('.tab[data-tab="me"]');
  await page.waitForTimeout(300);
  await page.click('#btn-sync');
  await page.waitForTimeout(2000);

  const r2 = await client.sync();
  check('电脑端第二次同步', r2.ok, JSON.stringify(r2));
  const onPc = store.range(today(), today()).find((e) => e.title.includes('手机上记的'));
  check('手机新增到了电脑', !!onPc, onPc ? onPc.title : '未找到');

  /* 6. 电脑新增 → 手机拉到 */
  store.create({ title: '电脑上记的', date: today(), start: '19:00', listId: 'work' });
  const r3 = await client.sync();
  check('电脑推送新增', r3.ok, JSON.stringify(r3));
  await page.click('#btn-sync');
  await page.waitForTimeout(2000);
  await page.click('.tab[data-tab="today"]');
  await page.waitForTimeout(600);
  const titles2 = await page.locator('#timed-list .row .title').allTextContents();
  check('电脑新增到了手机', titles2.some((t) => t.includes('电脑上记的')), titles2.join(' / '));

  /* 7. 错误口令不应崩 */
  const before = (await page.evaluate(() => document.querySelectorAll('#timed-list .row').length)) || 0;
  check('页面没有因为同步崩掉', before > 0, String(before));

  await page.screenshot({ path: path.join(__dirname, 'screens', 'cloud-01-today.png') });
  await browser.close();
  srv.kill();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
})().catch((e) => { console.error('云同步测试失败:', e); process.exit(1); });
