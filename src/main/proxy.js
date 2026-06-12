'use strict';
/**
 * proxy.js — per-profile egress IP assignment ("proxy rotation").
 *
 * Goal: every profile reaches the network from its OWN egress IP, so two
 * profiles never share an origin. Because a profile is one Chromium
 * `session` (partition), the proxy is applied at the session level with
 * `session.setProxy()` — every tab of a given profile therefore shares that
 * profile's IP, and different profiles get different IPs.
 *
 * Stickiness model (refcounted, in SessionManager):
 *   - First tab of a profile opens  → mint a fresh IP, held for the profile.
 *   - While ≥1 tab of that profile is open → the IP stays put (sticky).
 *   - Last tab closes → the assignment is dropped, so the NEXT time the
 *     profile opens it gets a brand-new IP. "Close it and it becomes a new
 *     one." Nothing re-rotates underneath a live session.
 *
 * Two vendor models are supported behind one config — you obtain the IPs
 * from any third-party provider and plug the details in here:
 *
 *   'rotating'  A single gateway endpoint where a session token embedded in
 *               the username pins one sticky IP. We mint a new token per
 *               profile-open; the provider maps token → IP. Use the
 *               {session} placeholder in the username template (also
 *               {country}/{region}). This is the simplest path: no pool to
 *               manage, pay-as-you-go traffic, fresh IP per token.
 *
 *   'static'    A pool of fixed endpoints (host:port:user:pass, one per
 *               line). We lease one per profile with a least-used picker so
 *               two profiles don't share an IP while spare IPs exist.
 *
 * Provider credentials never touch the renderer and are encrypted at rest
 * via Electron safeStorage (key in the macOS Keychain), the same scheme the
 * profile password vault uses. Proxy auth is answered in-process through the
 * `login` event; credentials are never placed in a URL or query string.
 */
const { app, session, net, safeStorage } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { readJSON, writeJSON } = require('./store');

const DEFAULTS = {
  enabled: false,
  mode: 'rotating',      // 'rotating' | 'static'
  scheme: 'http',        // 'http' (HTTP/HTTPS proxy) | 'socks5'
  host: '',
  port: 0,
  // Username template for rotating gateways. {session} is replaced with a
  // fresh per-profile token; {country}/{region} with the targeting below.
  usernameTemplate: '',
  country: 'us',
  region: '',
  testEndpoint: 'https://api.ipify.org/?format=json'
};

class ProxyManager {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'proxy.json');
    this._load();

    // Per-session resolved credentials, keyed by the Session object itself.
    // `session.fromPartition(name)` is a singleton per partition, so the
    // object identity is a stable key. Used by the proxy-auth login handler.
    this._sessionCreds = new Map();   // Session -> { username, password }
    this._activeTestCreds = null;     // fallback creds while a test runs

    // Refcounted per-profile assignments (the stickiness state).
    this._profileState = new Map();   // profileId -> { refs, session, token?, lease? }

    // Static-pool usage counts, parallel to this._pool.
    this._use = [];

    this._installLoginHandler();
  }

  // ---------------- persistence ----------------

  _load() {
    const raw = readJSON(this.file, null) || {};
    this.config = { ...DEFAULTS, ...(raw.config || {}) };
    const secret = this._readSecret(raw.secret);
    this._password = secret.password || '';
    this._pool = Array.isArray(secret.pool) ? secret.pool : [];
    this._use = this._pool.map(() => 0);
  }

  _readSecret(secret) {
    if (!secret) return { password: '', pool: [] };
    if (secret.encrypted && safeStorage.isEncryptionAvailable()) {
      try { return JSON.parse(safeStorage.decryptString(Buffer.from(secret.payload, 'base64'))); }
      catch { return { password: '', pool: [] }; }
    }
    return secret.plain || { password: '', pool: [] };
  }

  _save() {
    const secretBlob = JSON.stringify({ password: this._password, pool: this._pool });
    let secret;
    if (safeStorage.isEncryptionAvailable()) {
      secret = { encrypted: true, payload: safeStorage.encryptString(secretBlob).toString('base64') };
    } else {
      secret = { encrypted: false, plain: { password: this._password, pool: this._pool } };
    }
    writeJSON(this.file, { config: this.config, secret });
  }

  // ---------------- config surface (renderer-facing, no secrets) ----------------

  publicConfig() {
    const c = this.config;
    return {
      enabled: c.enabled, mode: c.mode, scheme: c.scheme,
      host: c.host, port: c.port,
      usernameTemplate: c.usernameTemplate, country: c.country, region: c.region,
      testEndpoint: c.testEndpoint,
      hasPassword: Boolean(this._password),
      poolCount: this._pool.length,
      activeAssignments: this._profileState.size
    };
  }

  /**
   * Update config. `patch.password` (non-empty) replaces the stored password.
   * `patch.pool` (multiline "host:port:user:pass" string) replaces the pool.
   * Secrets are never echoed back. Changes apply to the NEXT open of a
   * profile; sessions already open keep their current IP until reopened.
   */
  setConfig(patch = {}) {
    const c = this.config;
    const keys = ['enabled', 'mode', 'scheme', 'host', 'port', 'usernameTemplate', 'country', 'region', 'testEndpoint'];
    for (const k of keys) if (k in patch) c[k] = patch[k];
    c.port = Number(c.port) || 0;
    c.country = (c.country || '').trim().toLowerCase();

    if (typeof patch.password === 'string' && patch.password.length) this._password = patch.password;
    if (patch.clearPassword) this._password = '';
    if (typeof patch.pool === 'string') {
      this._pool = this._parsePool(patch.pool);
      this._use = this._pool.map(() => 0);
    }
    this._save();
    return this.publicConfig();
  }

  _parsePool(text) {
    const out = [];
    for (const line of String(text).split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      // host:port[:user:pass]  (user/pass optional; passwords may contain ':')
      const parts = s.split(':');
      if (parts.length < 2) continue;
      const host = parts[0];
      const port = Number(parts[1]) || 0;
      const username = parts[2] || '';
      const password = parts.length > 3 ? parts.slice(3).join(':') : '';
      if (host && port) out.push({ host, port, username, password });
    }
    return out;
  }

  // ---------------- availability ----------------

  enabled() {
    if (!this.config.enabled) return false;
    if (this.config.mode === 'static') return this._pool.length > 0;
    return Boolean(this.config.host && this.config.port);
  }

  // ---------------- assignment primitives ----------------

  _rules(host, port, scheme) {
    if (scheme === 'socks5') return `socks5://${host}:${port}`; // socks5 → remote DNS
    return `${host}:${port}`; // applies to all schemes (http/https/ws/wss)
  }

  _username(token) {
    const tmpl = this.config.usernameTemplate || '';
    return tmpl
      .replace(/\{session\}/gi, token)
      .replace(/\{country\}/gi, this.config.country || '')
      .replace(/\{region\}/gi, this.config.region || '');
  }

  _leaseStatic() {
    if (!this._pool.length) return null;
    let best = 0;
    for (let i = 1; i < this._pool.length; i++) {
      if ((this._use[i] || 0) < (this._use[best] || 0)) best = i;
    }
    this._use[best] = (this._use[best] || 0) + 1;
    return best;
  }

  _returnStatic(idx) {
    if (idx != null && this._use[idx] > 0) this._use[idx] -= 1;
  }

  /** Apply a fresh egress identity to `ses`. Returns { token?|lease?, label }. */
  async _assign(ses) {
    if (this.config.mode === 'static') {
      const lease = this._leaseStatic();
      if (lease == null) { await this._direct(ses); return { enabled: false }; }
      const e = this._pool[lease];
      await ses.setProxy({ proxyRules: this._rules(e.host, e.port, this.config.scheme), proxyBypassRules: '<local>' });
      this._sessionCreds.set(ses, { username: e.username, password: e.password });
      return { lease, label: `${e.host}:${e.port}` };
    }
    const token = crypto.randomBytes(6).toString('hex');
    await ses.setProxy({ proxyRules: this._rules(this.config.host, this.config.port, this.config.scheme), proxyBypassRules: '<local>' });
    this._sessionCreds.set(ses, { username: this._username(token), password: this._password });
    return { token, label: `${(this.config.country || 'xx').toUpperCase()} • ${token}` };
  }

  async _direct(ses) {
    try { await ses.setProxy({ mode: 'direct' }); } catch { /* ignore */ }
    this._sessionCreds.delete(ses);
  }

  // ---------------- refcounted profile lifecycle ----------------

  /**
   * A tab bound to `profileId` is opening. If the profile is already live
   * (refs > 0) keep its current IP; otherwise mint a fresh one. Resolves
   * once setProxy has taken effect, so the caller can gate the first
   * navigation on it and guarantee the opening request egresses correctly.
   */
  async acquireProfile(profileId, ses) {
    if (!this.enabled()) return null;
    const st = this._profileState.get(profileId);
    if (st && st.refs > 0) { st.refs += 1; return st.info; }
    const info = await this._assign(ses);
    this._profileState.set(profileId, { refs: 1, session: ses, info, lease: info.lease ?? null });
    return info;
  }

  /** A tab bound to `profileId` is closing. Drop the IP when the last one goes. */
  releaseProfile(profileId) {
    const st = this._profileState.get(profileId);
    if (!st) return;
    st.refs -= 1;
    if (st.refs <= 0) {
      if (st.lease != null) this._returnStatic(st.lease);
      this._profileState.delete(profileId);
      // Session is now idle (no tabs). Leave its proxy as-is; the next
      // acquireProfile() overwrites it with a fresh identity.
    }
  }

  /** Temporary sessions are 1 tab : 1 disposable partition — always fresh. */
  async assignTemp(ses) {
    if (!this.enabled()) return null;
    return this._assign(ses);
  }

  /** Drop credential mapping for a session being destroyed (temp cleanup). */
  forgetSession(ses) {
    this._sessionCreds.delete(ses);
  }

  // ---------------- proxy authentication ----------------

  _installLoginHandler() {
    // Fired when any request hits an auth challenge. We only answer PROXY
    // challenges, and only for sessions we configured. Real-site logins and
    // unknown sessions fall through to default handling untouched.
    app.on('login', (event, webContents, _details, authInfo, callback) => {
      if (!authInfo || !authInfo.isProxy) return;
      let creds = null;
      if (webContents && webContents.session) creds = this._sessionCreds.get(webContents.session) || null;
      if (!creds) creds = this._activeTestCreds || null; // net.request test has no webContents
      if (!creds) return; // not ours → leave default behavior
      event.preventDefault();
      callback(creds.username, creds.password);
    });
  }

  // ---------------- test ----------------

  /**
   * Verify the current config end-to-end: spin a throwaway session, route it
   * through the proxy, and report the egress IP it actually came out on.
   */
  async test() {
    if (!this.enabled()) return { ok: false, error: 'Proxy is not enabled or is missing host/credentials.' };
    const part = `temp-proxytest-${crypto.randomUUID()}`;
    const ses = session.fromPartition(part);
    const info = await this._assign(ses);
    if (info.enabled === false) return { ok: false, error: 'No proxy endpoint available to test (empty pool?).' };
    this._activeTestCreds = this._sessionCreds.get(ses) || null;
    const started = Date.now();
    try {
      const body = await this._fetch(ses, this.config.testEndpoint);
      let ip = body.trim();
      try { const j = JSON.parse(body); ip = j.ip || j.query || j.origin || ip; } catch { /* plain text ip */ }
      return { ok: true, ip, ms: Date.now() - started, via: info.label };
    } catch (err) {
      return { ok: false, error: err.message || 'Request failed (check host, port, scheme, and credentials).' };
    } finally {
      this._activeTestCreds = null;
      this.forgetSession(ses);
      if (info.lease != null) this._returnStatic(info.lease);
      try { await ses.clearStorageData(); } catch { /* best effort */ }
    }
  }

  _fetch(ses, url) {
    return new Promise((resolve, reject) => {
      const req = net.request({ url, session: ses, useSessionCookies: false });
      const timer = setTimeout(() => { req.abort(); reject(new Error('Timed out after 15s')); }, 15000);
      req.on('response', (res) => {
        if (res.statusCode === 407) { clearTimeout(timer); return reject(new Error('Proxy rejected the credentials (407).')); }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { clearTimeout(timer); resolve(data); });
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }
}

module.exports = { ProxyManager };
