'use strict';
/**
 * sessions.js — session management system.
 *
 * Persistent profiles  → session.fromPartition('persist:profile-<id>')
 *   Backed by a real on-disk Chromium user data directory at
 *   <userData>/Partitions/profile-<id>. Cookies, cache, localStorage,
 *   sessionStorage, IndexedDB, service workers, permissions, HSTS state and
 *   login state all live inside that directory and nowhere else.
 *
 * Temporary sessions   → session.fromPartition('temp-<uuid>')  (no `persist:`)
 *   Fully isolated, held in memory only, discarded by Chromium when the
 *   last window using them closes. We additionally clearStorageData() on
 *   close as a belt-and-braces measure. A temp session can be promoted to
 *   a saved profile, in which case its tabs are reopened inside a new
 *   persistent partition (storage cannot be migrated between partitions —
 *   the user simply signs in once in the new profile).
 *
 * Everything here uses standard Chromium networking and storage. No
 * fingerprint manipulation, no proxy rotation, no anti-detection behavior.
 */
const { app, session, dialog, crashReporter } = require('electron');
const crypto = require('crypto');
const path = require('path');

const PERMISSION_LABELS = {
  notifications: 'show notifications',
  media: 'use your camera or microphone',
  geolocation: 'see your location',
  clipboard_read: 'read your clipboard',
  'clipboard-read': 'read your clipboard',
  fullscreen: 'enter full screen',
  pointerLock: 'lock the mouse pointer',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices'
};

// Permissions that are safe to grant silently for normal consumer web apps.
const AUTO_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'background-sync', 'sensors', 'accelerometer', 'gyroscope', 'magnetometer']);

class SessionManager {
  constructor(profileManager) {
    this.profiles = profileManager;
    this.configured = new Set();      // partition names already wired up
    this.tempSessions = new Map();    // tempId -> { id, partition, name, note, createdAt }
    this.downloadListeners = new Set(); // callbacks receiving download events
    // Standard Chrome UA for the bundled Chromium build: identical to what
    // Chrome of the same version sends. Many account-based sites serve
    // degraded or broken pages to unknown UA tokens, so we present the
    // plain Chrome token set (this is the Electron-documented compatibility
    // approach, not an evasion mechanism — the engine genuinely IS this
    // Chromium version).
    const chromeVersion = process.versions.chrome;
    this.userAgent =
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  /** Resolve and configure the session for a saved profile. */
  forProfile(profileId) {
    const partition = this.profiles.partitionName(profileId);
    const ses = session.fromPartition(partition);
    this._configure(ses, { profileId, partition, temp: false });
    return ses;
  }

  /** Create a new disposable session. */
  createTemp(name) {
    const tempId = crypto.randomUUID();
    const partition = `temp-${tempId}`; // no `persist:` prefix → in-memory
    const meta = { id: tempId, partition, name: name || 'Temporary session', note: '', createdAt: Date.now() };
    this.tempSessions.set(tempId, meta);
    const ses = session.fromPartition(partition);
    this._configure(ses, { tempId, partition, temp: true });
    return meta;
  }

  getTemp(tempId) { return this.tempSessions.get(tempId) || null; }
  listTemp() { return [...this.tempSessions.values()]; }

  async destroyTemp(tempId) {
    const meta = this.tempSessions.get(tempId);
    if (!meta) return;
    try {
      const ses = session.fromPartition(meta.partition);
      await ses.clearStorageData();
      await ses.clearCache();
    } catch { /* session may already be gone */ }
    this.tempSessions.delete(tempId);
  }

  /** Wipe and remove a saved profile's entire partition. */
  async destroyProfileSession(profileId) {
    const ses = this.forProfile(profileId);
    await ses.clearStorageData();   // cookies, storage, IndexedDB, SW, …
    await ses.clearCache();
    await ses.clearAuthCache();
    await ses.clearHostResolverCache();
  }

  onDownload(cb) { this.downloadListeners.add(cb); }

  // ---------- internal ----------

  _configure(ses, ctx) {
    if (this.configured.has(ctx.partition)) return;
    this.configured.add(ctx.partition);

    ses.setUserAgent(this.userAgent);

    // Downloads: per-profile default folder + progress events.
    ses.on('will-download', (event, item, webContents) => {
      this._handleDownload(item, ctx, webContents);
    });

    // Site permissions: remembered per profile, prompted once per origin.
    ses.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
      try {
        if (AUTO_ALLOW.has(permission)) return callback(true);
        if (ctx.temp) {
          // Temporary sessions: prompt every time, never persist.
          return callback(await this._promptPermission(webContents, permission, details));
        }
        const store = this.profiles.stores(ctx.profileId).permissions;
        const origin = this._origin(details.requestingUrl || webContents.getURL());
        const key = `${origin}::${permission}`;
        const decisions = store.get('decisions', {});
        if (key in decisions) return callback(decisions[key]);
        const allowed = await this._promptPermission(webContents, permission, details);
        decisions[key] = allowed;
        store.set('decisions', decisions);
        callback(allowed);
      } catch {
        callback(false);
      }
    });

    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (AUTO_ALLOW.has(permission)) return true;
      if (ctx.temp) return false;
      const store = this.profiles.stores(ctx.profileId).permissions;
      const decisions = store.get('decisions', {});
      return decisions[`${this._origin(requestingOrigin)}::${permission}`] === true;
    });

    // Spellcheck on by default, like a normal desktop browser.
    try { ses.setSpellCheckerEnabled(true); } catch { /* optional */ }
  }

  async _promptPermission(webContents, permission, details) {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(webContents) ||
      (webContents.hostWebContents && BrowserWindow.fromWebContents(webContents.hostWebContents));
    const origin = this._origin(details.requestingUrl || webContents.getURL());
    const label = PERMISSION_LABELS[permission] || `use "${permission}"`;
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${origin} wants to ${label}.`,
      detail: 'This decision applies to this profile only.'
    });
    return response === 0;
  }

  _handleDownload(item, ctx, webContents) {
    const id = crypto.randomUUID();
    let dir;
    if (!ctx.temp) {
      const profile = this.profiles.getRaw(ctx.profileId);
      dir = profile && profile.downloadDir
        ? profile.downloadDir
        : path.join(app.getPath('downloads'), profile ? profile.name : 'Profile');
    } else {
      dir = path.join(app.getPath('downloads'), 'Temporary Session');
    }
    try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    const savePath = path.join(dir, item.getFilename());
    item.setSavePath(savePath);

    const record = {
      id,
      profileId: ctx.profileId || null,
      tempId: ctx.tempId || null,
      filename: item.getFilename(),
      savePath,
      url: item.getURL(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      startedAt: Date.now()
    };
    const emit = () => { for (const cb of this.downloadListeners) cb({ ...record }); };
    emit();

    item.on('updated', (e, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      emit();
    });
    item.once('done', (e, state) => {
      record.receivedBytes = item.getReceivedBytes();
      record.state = state; // 'completed' | 'cancelled' | 'interrupted'
      record.finishedAt = Date.now();
      emit();
      if (!ctx.temp && ctx.profileId) {
        const store = this.profiles.stores(ctx.profileId).downloads;
        const items = store.get('items', []);
        items.unshift(record);
        if (items.length > 500) items.length = 500;
        store.set('items', items);
      }
    });
  }

  _origin(url) {
    try { return new URL(url).origin; } catch { return url || 'unknown'; }
  }
}

module.exports = { SessionManager };
