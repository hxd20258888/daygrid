'use strict';

/**
 * 日格 · 云端同步服务（盲存储）
 *
 * 服务器只保存密文：每条变更的 fields 在客户端用同步口令加密，
 * 服务器看不到标题、备注这些内容。它只负责排序、去重、转发。
 *
 * 用法：
 *   node server.js --init          初始化空间，打印空间 ID 和设备令牌
 *   node server.js                 启动服务（默认 8787）
 *
 * 环境变量：PORT / DATA_DIR / MOBILE_DIR
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MOBILE_DIR = process.env.MOBILE_DIR || path.join(__dirname, 'mobile');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

let state = { spaces: {} };

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
function space(id) {
  if (!state.spaces[id]) state.spaces[id] = { id, devices: {}, codes: {}, ops: [], snapshot: null, nextSeq: 1, createdAt: Date.now() };
  return state.spaces[id];
}
function hash(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex');
}
function auth(sp, req) {
  const id = req.headers['x-device-id'];
  const token = req.headers['x-device-token'];
  const dev = sp.devices[id];
  if (!dev || dev.revoked) return null;
  if (dev.hash !== hash(token || '')) return null;
  return dev;
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Device-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 8 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/app\/?/, ''));
  let file = path.join(MOBILE_DIR, rel || 'index.html');
  if (!path.resolve(file).startsWith(path.resolve(MOBILE_DIR))) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(file).toLowerCase();
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Device-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/v1/ping') return json(res, 200, { ok: true, app: 'daygrid', version: 2, time: Date.now() });

    if (p === '/v1/pair' && req.method === 'POST') {
      const body = await readBody(req);
      let sp = state.spaces[body.space];
      if (!sp) {
        for (const id of Object.keys(state.spaces)) {
          if (state.spaces[id].codes[String(body.code)]) { sp = state.spaces[id]; break; }
        }
      }
      if (!sp) return json(res, 404, { error: 'no_space' });
      const c = sp.codes[String(body.code)];
      if (!c || c.used || c.expires < Date.now()) return json(res, 401, { error: 'bad_code' });
      const id = 'dev-' + crypto.randomBytes(4).toString('hex');
      const token = crypto.randomBytes(24).toString('hex');
      sp.devices[id] = { id, name: String(body.device || '手机').slice(0, 40), hash: hash(token), createdAt: Date.now(), revoked: false };
      c.used = true;
      save();
      return json(res, 200, { deviceId: id, token, space: sp.id });
    }

    let m = p.match(/^\/v1\/spaces\/([^/]+)\/codes$/);
    if (m && req.method === 'POST') {
      const sp = state.spaces[m[1]];
      if (!sp || !auth(sp, req)) return json(res, 401, { error: 'unauthorized' });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      sp.codes[code] = { expires: Date.now() + 10 * 60 * 1000, used: false };
      save();
      return json(res, 200, { code, expires: Date.now() + 600000 });
    }

    m = p.match(/^\/v1\/spaces\/([^/]+)\/sync$/);
    if (m && req.method === 'POST') {
      const sp = state.spaces[m[1]];
      if (!sp || !auth(sp, req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const me = req.headers['x-device-id'];

      if (Array.isArray(body.ops)) {
        for (const op of body.ops.slice(0, 500)) {
          if (!op || !op.op_id || !op.data) continue;
          if (sp.ops.some((x) => x.op_id === op.op_id)) continue;
          sp.ops.push({
            seq: sp.nextSeq++,
            op_id: op.op_id,
            device_id: me,
            ts: Number(op.ts) || Date.now(),
            iv: op.iv,
            data: op.data,
          });
        }
      }
      if (body.snapshot && body.snapshot.data) {
        const v = Number(body.snapshot.version) || 0;
        if (!sp.snapshot || v > sp.snapshot.version) {
          sp.snapshot = { version: v, iv: body.snapshot.iv, data: body.snapshot.data, device_id: me, at: Date.now() };
        }
      }
      save();

      const cursor = Number(body.cursor) || 0;
      const ops = sp.ops.filter((o) => o.seq > cursor && o.device_id !== me);
      const out = { cursor: sp.nextSeq - 1, ops };
      if (body.needSnapshot && sp.snapshot) out.snapshot = sp.snapshot;
      return json(res, 200, out);
    }

    if (p === '/download/daygrid.apk') {
      const cands = [path.join(__dirname, 'daygrid.apk'), path.join(MOBILE_DIR, '..', 'android', '日格.apk')];
      const apk = cands.find((f) => fs.existsSync(f));
      if (!apk) { res.writeHead(404); res.end('apk not uploaded'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': fs.statSync(apk).size,
        'Content-Disposition': 'attachment; filename="daygrid.apk"',
      });
      return fs.createReadStream(apk).pipe(res);
    }

    if (p === '/' || p.startsWith('/app')) return serveStatic(res, p === '/' ? '/app/' : p);

    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    return json(res, 400, { error: 'bad_request', message: e.message });
  }
});

if (process.argv.includes('--init')) {
  load();
  const spaceId = process.env.SPACE || 'personal';
  const sp = space(spaceId);
  const token = crypto.randomBytes(24).toString('hex');
  const id = 'pc-' + crypto.randomBytes(3).toString('hex');
  sp.devices[id] = { id, name: 'Windows 电脑', hash: hash(token), createdAt: Date.now(), revoked: false };
  save();
  console.log('');
  console.log('空间 ID    :', spaceId);
  console.log('设备 ID    :', id);
  console.log('设备令牌   :', token);
  console.log('');
  console.log('把这三项填进日格「设置 → 手机同步」，同步口令自己想一个，两台设备保持一致。');
  console.log('');
  process.exit(0);
}

load();
server.listen(PORT, '0.0.0.0', () => {
  console.log('daygrid sync server on :' + PORT);
  console.log('data:', STATE_FILE);
});
