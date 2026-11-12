'use strict';

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, screen, nativeImage, dialog, shell, Notification } = require('electron');
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

async function startSync() {
  syncClient = new SyncClient(store);
  setInterval(() => {
    if (syncClient && syncClient.configured()) syncClient.sync().catch(() => {});
  }, 60000);
  setTimeout(() => {
    if (syncClient && syncClient.configured()) syncClient.sync().catch(() => {});
  }, 4000);
}

function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 392;
  const h = 568;
  let x = workArea.x + workArea.width - w - 24;
  let y = workArea.y + 64;
  const sx = store.setting('widgetX');
  const sy = store.setting('widgetY');
  if (sx && sy) { x = Number(sx); y = Number(sy); }

  widgetWin = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  widgetWin.loadFile(path.join(__dirname, 'src', 'widget.html'));
  widgetWin.once('ready-to-show', () => { widgetWin.show(); broadcastWidgetVisibility(true); });
  widgetWin.on('closed', () => { widgetWin = null; });
  widgetWin.on('moved', () => {
    if (!widgetWin) return;
    const [wx, wy] = widgetWin.getPosition();
    store.setSetting('widgetX', wx);
    store.setSetting('widgetY', wy);
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
  captureWin.on('blur', () => { if (!isTest && captureWin && captureWin.isVisible()) captureWin.hide(); });
  captureWin.on('closed', () => { captureWin = null; });
  return captureWin;
}

function createMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
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
    widgetWin.once('ready-to-show', () => { widgetWin.show(); broadcastWidgetVisibility(true); });
    return true;
  }
  const next = !widgetWin.isVisible();
  if (next) { widgetWin.show(); widgetWin.focus(); } else widgetWin.hide();
  broadcastWidgetVisibility(next);
  return next;
}

function showCapture(date) {
  if (!captureWin) createCapture();
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
  ipcMain.handle('win:capture', (_e, date) => { showCapture(date); return true; });
  ipcMain.handle('win:closeCapture', () => { if (captureWin) captureWin.hide(); return true; });
  ipcMain.handle('win:minimize', () => { if (mainWin) mainWin.minimize(); });
  ipcMain.handle('win:maximize', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
  ipcMain.handle('win:close', () => { if (mainWin) mainWin.hide(); });
  ipcMain.handle('win:hideWidget', () => { if (widgetWin) { widgetWin.hide(); broadcastWidgetVisibility(false); } });
  ipcMain.handle('win:toggleWidget', () => toggleWidget());
  ipcMain.handle('win:widgetVisible', () => (widgetWin ? widgetWin.isVisible() : false));
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
