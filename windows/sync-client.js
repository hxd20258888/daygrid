'use strict';

/**
 * 电脑端云同步客户端。
 * 电脑不再是服务器：它和手机一样，把加密后的变更推给云端，再拉别人的。
 */

const crypto = require('crypto');

class SyncClient {
  constructor(store) {
    this.store = store;
    this.busy = false;
  }

  config() {
    return {
      url: (this.store.setting('cloudUrl', '') || '').replace(/\/$/, ''),
      space: this.store.setting('cloudSpace', 'personal'),
      deviceId: this.store.setting('cloudDeviceId', ''),
      token: this.store.setting('cloudToken', ''),
      pass: this.store.setting('cloudPass', ''),
    };
  }

  configured() {
    const c = this.config();
    return !!(c.url && c.deviceId && c.token && c.pass);
  }

  save(cfg) {
    const map = { url: 'cloudUrl', space: 'cloudSpace', deviceId: 'cloudDeviceId', token: 'cloudToken', pass: 'cloudPass' };
    for (const [k, key] of Object.entries(map)) {
      if (cfg[k] !== undefined) this.store.setSetting(key, cfg[k]);
    }
    this.store.setSetting('syncCursor', 0);
    this.store.setSetting('syncPushSeq', 0);
    this.store.setSetting('syncHasSnapshot', 0);
  }

  key() {
    const { pass, space } = this.config();
    return crypto.pbkdf2Sync(pass, 'daygrid|' + space, 150000, 32, 'sha256');
  }

  encrypt(key, obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return { iv: iv.toString('base64'), data: Buffer.concat([ct, tag]).toString('base64') };
  }

  decrypt(key, ivB64, dataB64) {
    const iv = Buffer.from(ivB64, 'base64');
    const raw = Buffer.from(dataB64, 'base64');
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(0, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
  }

  snapshotPayload() {
    return {
      entries: this.store.all('SELECT * FROM entries WHERE deleted_at IS NULL'),
      logs: this.store.all('SELECT * FROM daily_logs'),
    };
  }

  applySnapshot(key, snap) {
    const payload = this.decrypt(key, snap.iv, snap.data);
    for (const e of payload.entries || []) {
      const cur = this.store.get('SELECT * FROM entries WHERE id = ?', [e.id]);
      if (!cur || (e.updated_at || 0) > (cur.updated_at || 0)) {
        const cols = Object.keys(e);
        const marks = cols.map(() => '?').join(',');
        this.store.run(`INSERT OR REPLACE INTO entries (${cols.join(',')}) VALUES (${marks})`, cols.map((c) => e[c]));
      }
    }
    for (const l of payload.logs || []) {
      const cur = this.store.get('SELECT * FROM daily_logs WHERE space_id = ? AND date = ?', [l.space_id || this.store.spaceId, l.date]);
      if (!cur || (l.updated_at || 0) > (cur.updated_at || 0)) {
        this.store.run('INSERT OR REPLACE INTO daily_logs (space_id,date,mood,summary,highlight,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
          [l.space_id || this.store.spaceId, l.date, l.mood, l.summary, l.highlight, l.created_at, l.updated_at]);
      }
    }
    this.store.setSetting('syncHasSnapshot', 1);
  }

  async request(path, body) {
    const c = this.config();
    const res = await fetch(c.url + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': c.deviceId,
        'X-Device-Token': c.token,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  async sync() {
    if (!this.configured()) return { ok: false, error: '还没有配置同步' };
    if (this.busy) return { ok: false, error: '正在同步' };
    this.busy = true;
    try {
      const c = this.config();
      const key = this.key();
      const pushSeq = Number(this.store.setting('syncPushSeq', '0')) || 0;
      const rows = this.store.all('SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT 300', [pushSeq]);
      const ops = rows.map((r) => {
        const enc = this.encrypt(key, {
          entity: r.entity,
          entity_id: r.entity_id,
          op: r.op,
          fields: JSON.parse(r.fields || '{}'),
        });
        return { op_id: r.op_id, ts: r.updated_at, iv: enc.iv, data: enc.data };
      });

      const cursor = Number(this.store.setting('syncCursor', '0')) || 0;
      const needSnapshot = this.store.setting('syncHasSnapshot', '0') !== '1';
      const body = { cursor, ops, needSnapshot };

      if (needSnapshot) {
        const hasData = this.store.get('SELECT COUNT(*) AS n FROM entries').n > 0;
        if (hasData) {
          const enc = this.encrypt(key, this.snapshotPayload());
          body.snapshot = { version: Date.now(), iv: enc.iv, data: enc.data };
          this.store.setSetting('syncHasSnapshot', 1);
        }
      }

      const data = await this.request('/v1/spaces/' + encodeURIComponent(c.space) + '/sync', body);

      if (data.snapshot) this.applySnapshot(key, data.snapshot);

      const remote = [];
      for (const op of data.ops || []) {
        try {
          const p = this.decrypt(key, op.iv, op.data);
          remote.push({ ...p, op_id: op.op_id, updated_at: op.ts, space_id: c.space });
        } catch (e) {
          // 口令不对或数据损坏，跳过这一条
        }
      }
      if (remote.length) this.store.applyRemoteOps(remote, 'cloud', false);

      if (rows.length) this.store.setSetting('syncPushSeq', rows[rows.length - 1].seq);
      this.store.setSetting('syncCursor', data.cursor || 0);
      this.store.setSetting('syncAt', Date.now());
      this.store.persistNow();
      return { ok: true, pushed: rows.length, pulled: remote.length };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      this.busy = false;
    }
  }

  async newCode() {
    const c = this.config();
    const data = await this.request('/v1/spaces/' + encodeURIComponent(c.space) + '/codes', {});
    return data.code;
  }

  status() {
    const c = this.config();
    return {
      configured: this.configured(),
      url: c.url,
      space: c.space,
      lastSync: Number(this.store.setting('syncAt', '0')) || 0,
      pendingPush: this.store.get('SELECT COUNT(*) AS n FROM changes WHERE seq > ?', [Number(this.store.setting('syncPushSeq', '0')) || 0]).n,
    };
  }
}

module.exports = { SyncClient };
