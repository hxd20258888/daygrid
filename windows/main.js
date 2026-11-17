'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, nativeImage, dialog, shell, Notification, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./db');
const { SyncClient } = require('./sync-client');

const isTest = !!process.env.DAYGRID_TEST;
const dataDir = process.env.DAYGRID_DATA_DIR || path.join(app.getPath('appData'), 'DayGrid', 'data');

app.setPath('userData', process.env.DAYGRID_USER_DATA || path.join(app.getPath('appData'), 'DayGrid'));
app.setAppUserModelId('com.daygrid.desktop');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let store;
let widgetWin = null;
let captureWin = null;
let mainWin = null;
let tray = null;
let quitting = false;
let syncClient = null;
let dragOrigin = null;

async function startSync() {
  syncClient = new SyncClient(store);
  setInterval(() => {
    if (syncClient && syncClient.configured()) syncClient.sync().catch(() => {});
  }, 60000);
  setTimeout(() => {
    if (syncClient && syncClient.configured()) syncClient.sync().catch(() => {});
  }, 4000);
}

/*
 * 组件要一直待在最顶层。
 * 只有 alwaysOnTop: true 还不够：默认的 'normal' 置顶层会被全屏 / 最大化的程序盖住，
 * Windows 上 'screen-saver' 是最高的置顶层，能压在普通全屏窗口之上。
 * 另外别的程序（尤其全屏程序）会重新抢 z 序，所以需要时不时再推一次。
 */
function pinWidgetTop() {
  if (!widgetWin || widgetWin.isDestroyed()) return;
  // 速记浮层打开时让浮层在上面，别把输入框挡住
  if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) return;
  widgetWin.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform !== 'win32') {
    try { widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  }
}

const WIDGET_SIZE = { width: 392, height: 568 };
const MINI_SIZE = { width: 180, height: 60 };

function widgetMode() {
  return store && store.setting('widgetMode') === 'mini' ? 'mini' : 'expanded';
}

/* 别把组件拖出屏幕：整体夹进当前显示器的工作区 */
function clampBounds(b) {
  const { workArea } = screen.getDisplayMatching(b);
  return {
    ...b,
    x: Math.min(Math.max(b.x, workArea.x), workArea.x + workArea.width - b.width),
    y: Math.min(Math.max(b.y, workArea.y), workArea.y + workArea.height - b.height),
  };
}

function saveWidgetPos(b) {
  const prefix = widgetMode() === 'mini' ? 'mini' : 'widget';
  store.setSetting(prefix + 'X', b.x);
  store.setSetting(prefix + 'Y', b.y);
}

/* 展开 ↔ 收起：以右上角为锚点换尺寸，位置跟手、不跑偏 */
function applyWidgetMode(mode) {
  if (!widgetWin || widgetWin.isDestroyed()) return false;
  const next = mode === 'mini' ? 'mini' : 'expanded';
  const size = next === 'mini' ? MINI_SIZE : WIDGET_SIZE;
  store.setSetting('widgetMode', next);
  const b = widgetWin.getBounds();
  const bounds = clampBounds({ ...size, x: b.x + b.width - size.width, y: b.y });
  widgetWin.setBounds(bounds);
  saveWidgetPos(bounds);
  const sendMode = () => {
    if (widgetWin && !widgetWin.isDestroyed()) widgetWin.webContents.send('widget:mode', next);
  };
  if (widgetWin.webContents.isLoading()) widgetWin.webContents.once('did-finish-load', sendMode);
  else sendMode();
  pinWidgetTop();
  return true;
}

function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  const mode = widgetMode();
  const size = mode === 'mini' ? MINI_SIZE : WIDGET_SIZE;
  const sx = store.setting((mode === 'mini' ? 'mini' : 'widget') + 'X');
  const sy = store.setting((mode === 'mini' ? 'mini' : 'widget') + 'Y');
  let x = workArea.x + workArea.width - size.width - 24;
  let y = workArea.y + 64;
  if (sx && sy) { x = Number(sx); y = Number(sy); }
  const bounds = clampBounds({ ...size, x, y });

  widgetWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  widgetWin.loadFile(path.join(__dirname, 'src', 'widget.html'), { query: { mode } });
  widgetWin.once('ready-to-show', () => { pinWidgetTop(); widgetWin.show(); broadcastWidgetVisibility(true); });
  widgetWin.on('show', () => pinWidgetTop());
  widgetWin.on('closed', () => { widgetWin = null; });
  widgetWin.on('moved', () => {
    if (!widgetWin) return;
    if (dragOrigin) return; // 拖动过程中不落盘，松手时统一保存
    saveWidgetPos(widgetWin.getBounds());
  });
  return widgetWin;
}

function createCapture() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 720;
  const h = 300;
  captureWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height * 0.2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'src', 'capture.html'));
  // 和组件同属最高置顶层，谁后显示谁在上面：速记浮层不能被组件压住
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.on('blur', () => { if (!isTest && captureWin && captureWin.isVisible()) captureWin.hide(); });
  captureWin.on('hide', () => { pinWidgetTop(); });
  captureWin.on('closed', () => { captureWin = null; });
  return captureWin;
}

/*
 * 主窗口尺寸：约占屏幕工作区面积的 1/3，比例 3:2，居中。
 * 太大挡事；760×500 是布局还能看的下限（左边栏固定 196px）。
 */
function mainWindowBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const aspect = 1.5;
  const area = (workArea.width * workArea.height) / 3;
  let w = Math.round(Math.sqrt(area * aspect));
  let h = Math.round(w / aspect);
  w = Math.max(760, Math.min(w, 1600));
  h = Math.max(500, Math.min(h, 1000));
  return {
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
  };
}

function createMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({
    ...mainWindowBounds(),
    minWidth: 760,
    minHeight: 500,
    frame: false,
    backgroundColor: '#FBFAF7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'src', 'app.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  return mainWin;
}

function broadcastWidgetVisibility(v) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('widget:visibility', v);
  }
}

function toggleWidget() {
  if (!widgetWin) {
    createWidget();
    widgetWin.once('ready-to-show', () => { pinWidgetTop(); widgetWin.show(); broadcastWidgetVisibility(true); });
    return true;
  }
  const next = !widgetWin.isVisible();
  if (next) { widgetWin.show(); widgetWin.focus(); pinWidgetTop(); } else widgetWin.hide();
  broadcastWidgetVisibility(next);
  return next;
}

function showCapture(date) {
  if (!captureWin) createCapture();
  captureWin.setAlwaysOnTop(true, 'screen-saver');
  captureWin.show();
  captureWin.focus();
  captureWin.webContents.send('capture:focus', { date: date || null });
}

function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('data:changed');
  }
}

function checkReminders() {
  if (!store) return [];
  const now = new Date();
  const due = store.dueReminders(now);
  for (const e of due) {
    const date = ymd(now);
    store.markFired(e.id, date);
    const [h, m] = e.start.split(':').map(Number);
    const mins = h * 60 + m - (now.getHours() * 60 + now.getMinutes());
    const body = `${e.listName} · ${mins > 0 ? `还有 ${mins} 分钟` : '现在开始'}`;
    try {
      if (!isTest && Notification.isSupported()) {
        new Notification({ title: `${e.start} ${e.title}`, body, silent: false }).show();
      }
    } catch (_) {}
    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.webContents.send('reminder', { ...e, mins });
    }
  }
  return due;
}

function buildTray() {
  const iconPath = path.join(__dirname, 'build', 'tray.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('日格 · 今天');
  const menu = Menu.buildFromTemplate([
    { label: '打开日格', click: () => createMain() },
    { label: '速记  Ctrl+Alt+Space', click: () => showCapture() },
    { label: '显示 / 隐藏桌面组件', click: () => toggleWidget() },
    {
      label: '组件：展开 / 收起成小图标',
      click: () => {
        if (!widgetWin) { createWidget(); return; }
        if (!widgetWin.isVisible()) { widgetWin.show(); broadcastWidgetVisibility(true); }
        applyWidgetMode(widgetMode() === 'mini' ? 'expanded' : 'mini');
      },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: store.setting('launchAtLogin', '0') === '1',
      click: (item) => {
        store.setSetting('launchAtLogin', item.checked ? '1' : '0');
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
      },
    },
    { label: '数据目录', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => createMain());
}

function registerIpc() {
  ipcMain.handle('entries:range', (_e, { from, to }) => store.range(from, to));
  ipcMain.handle('entries:counts', (_e, { from, to }) => store.countsByDate(from, to));
  ipcMain.handle('entry:create', (_e, input) => { const r = store.create(input); broadcast(); return r; });
  ipcMain.handle('entry:update', (_e, { id, patch }) => { const r = store.update(id, patch); broadcast(); return r; });
  ipcMain.handle('entry:toggle', (_e, id) => { const r = store.toggle(id); broadcast(); return r; });
  ipcMain.handle('entry:get', (_e, id) => store.byId(id));
  ipcMain.handle('entry:removeConfirm', async (_e, { id, title }) => {
    // 测试里不弹原生对话框，直接删
    if (!isTest) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['删除', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '删除条目',
        message: '删除这个条目？',
        detail: (title || '').slice(0, 120),
      });
      if (response !== 0) return false;
    }
    store.remove(id);
    broadcast();
    return true;
  });
  ipcMain.handle('entry:remove', (_e, id) => { store.remove(id); broadcast(); return true; });
  ipcMain.handle('log:get', (_e, date) => store.getLog(date));
  ipcMain.handle('log:range', (_e, { from, to }) => store.logsRange(from, to));
  ipcMain.handle('log:set', (_e, { date, ...rest }) => { const r = store.setLog(date, rest); broadcast(); return r; });
  ipcMain.handle('stats:week', (_e, date) => store.weekStats(date));
  ipcMain.handle('stats:heat', (_e, days) => store.heat(days));
  ipcMain.handle('setting:get', (_e, key) => store.setting(key));
  ipcMain.handle('setting:set', (_e, { key, value }) => { store.setSetting(key, value); return true; });
  ipcMain.handle('data:info', () => store.info());
  ipcMain.handle('data:export', async () => {
    const json = JSON.stringify(store.exportAll(), null, 2);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出日格数据',
      defaultPath: path.join(app.getPath('documents'), `daygrid-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, json, 'utf8');
    return filePath;
  });
  ipcMain.handle('data:backup', () => { store.persistNow(); store.backupIfNeeded(); return store.info(); });
  ipcMain.handle('data:clear', () => { store.clearAll(); broadcast(); return true; });
  ipcMain.handle('data:openDir', () => shell.openPath(dataDir));

  ipcMain.handle('win:openMain', () => { createMain(); return true; });
  // 从桌面组件里「修改」某条：打开主窗口并弹出它的编辑框
  ipcMain.handle('win:openEditor', (_e, id) => {
    const win = createMain();
    const send = () => { if (win && !win.isDestroyed()) win.webContents.send('entry:edit', id); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
    win.show();
    win.focus();
    return true;
  });
  ipcMain.handle('win:capture', (_e, date) => { showCapture(date); return true; });
  ipcMain.handle('win:closeCapture', () => { if (captureWin) captureWin.hide(); return true; });
  ipcMain.handle('win:minimize', () => { if (mainWin) mainWin.minimize(); });
  ipcMain.handle('win:maximize', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
  ipcMain.handle('win:close', () => { if (mainWin) mainWin.hide(); });
  ipcMain.handle('win:hideWidget', () => { if (widgetWin) { widgetWin.hide(); broadcastWidgetVisibility(false); } });
  ipcMain.handle('win:toggleWidget', () => toggleWidget());
  ipcMain.handle('win:widgetVisible', () => (widgetWin ? widgetWin.isVisible() : false));
  ipcMain.handle('win:widgetMode', () => widgetMode());
  ipcMain.handle('win:setWidgetMode', (_e, mode) => applyWidgetMode(mode));
  // 拖动：渲染进程只报位移，主进程用起点算绝对位置，避免累计误差
  ipcMain.on('widget:drag', (_e, msg) => {
    if (!widgetWin || widgetWin.isDestroyed() || !msg) return;
    if (msg.phase === 'start') {
      const [x, y] = widgetWin.getPosition();
      dragOrigin = { x, y };
      return;
    }
    if (msg.phase === 'move' && dragOrigin) {
      widgetWin.setPosition(Math.round(dragOrigin.x + (msg.dx || 0)), Math.round(dragOrigin.y + (msg.dy || 0)));
      return;
    }
    if (msg.phase === 'end') {
      const b = widgetWin.getBounds();
      dragOrigin = null;
      saveWidgetPos(b);
    }
  });
  ipcMain.handle('theme:set', (_e, mode) => {
    store.setSetting('theme', mode);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('theme:changed', mode);
    }
    return true;
  });
  ipcMain.handle('reminders:check', () => checkReminders().length);
  ipcMain.handle('sync:status', () => (syncClient ? syncClient.status() : { configured: false }));
  ipcMain.handle('sync:config', (_e, cfg) => {
    if (!syncClient) syncClient = new SyncClient(store);
    syncClient.save(cfg);
    return syncClient.status();
  });
  ipcMain.handle('sync:run', async () => {
    if (!syncClient) syncClient = new SyncClient(store);
    const r = await syncClient.sync();
    broadcast();
    return { ...r, status: syncClient.status() };
  });
  ipcMain.handle('sync:code', async () => {
    if (!syncClient) syncClient = new SyncClient(store);
    try { return { ok: true, code: await syncClient.newCode() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

const gotLock = app.requestSingleInstanceLock();

app.whenReady().then(async () => {
  if (!gotLock) { app.quit(); return; }
  store = new Store();
  await store.init(dataDir);
  registerIpc();
  createWidget();
  createCapture();
  buildTray();
  // 组件常驻置顶：定期复位置顶层，并记住屏幕/睡眠状态的变化
  setInterval(pinWidgetTop, 10000);
  powerMonitor.on('resume', () => { pinWidgetTop(); });
  screen.on('display-metrics-changed', () => { pinWidgetTop(); });
  screen.on('display-added', () => { pinWidgetTop(); });
  screen.on('display-removed', () => { pinWidgetTop(); });
  globalShortcut.register('CommandOrControl+Alt+Space', () => showCapture());
  globalShortcut.register('CommandOrControl+Alt+D', () => toggleWidget());
  await startSync();
  if (store.setting('launchAtLogin', '0') === '1') app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  setTimeout(checkReminders, 2500);
  setInterval(checkReminders, 30000);
});

app.on('second-instance', () => { createMain(); });

app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });

app.on('before-quit', () => {
  quitting = true;
  try { store.persistNow(); } catch (_) {}
});

app.on('will-quit', () => globalShortcut.unregisterAll());
