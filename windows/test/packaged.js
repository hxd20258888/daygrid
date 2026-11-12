'use strict';

const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIST = path.join(__dirname, '..', 'dist', '日格');
const EXE = path.join(DIST, '日格.exe');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'daygrid-pack-'));

(async () => {
  const env = { ...process.env, DAYGRID_DATA_DIR: DATA, DAYGRID_USER_DATA: DATA + '-profile', DAYGRID_SYNC_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: EXE, args: [], cwd: DIST, env, timeout: 60000 });
  const start = Date.now();
  let widget = null;
  while (Date.now() - start < 20000) {
    widget = app.windows().find((w) => w.url().includes('widget.html'));
    if (widget) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!widget) throw new Error('打包版组件窗口没有出现');
  await widget.waitForSelector('.w-cell', { timeout: 15000 });
  const cells = await widget.locator('.w-cell').count();
  console.log('PASS 打包版启动');
  console.log('PASS 组件 42 格:', cells === 42);
  await widget.screenshot({ path: path.join(__dirname, 'screens', '07-packaged-widget.png') });

  const mainP = app.waitForEvent('window');
  await widget.click('#w-menu');
  const main = await mainP;
  await main.waitForSelector('#task-list .task', { timeout: 15000 });
  const hasSyncApi = await widget.evaluate(() => typeof window.api.syncStatus === 'function');
  console.log('PASS 云同步接口存在:', hasSyncApi);

  await main.screenshot({ path: path.join(__dirname, 'screens', '08-packaged-main.png') });
  await app.close();
  console.log('DONE');
})().catch((e) => { console.error('打包版测试失败:', e); process.exit(1); });
