'use strict';
/**
 * profiles.js — profile management system.
 *
 * Each profile is:
 *   1. A metadata record in <userData>/profiles.json (name, color, icon,
 *      homepage, timestamps, hashed PIN, startup behavior).
 *   2. A persistent Chromium storage partition: `persist:profile-<id>`.
 *      Electron materializes this as a real, fully separate user data
 *      directory at <userData>/Partitions/profile-<id>/ containing its own
 *      Cookies, Cache, Local Storage, IndexedDB, Service Worker registry,
 *      Network Persistent State, and Preferences. Nothing is shared between
 *      partitions — this is the same isolation mechanism Chromium uses for
 *      separate user-data-dir instances.
 *   3. A private app-level data directory <userData>/ProfileData/<id>/ for
 *      things the app tracks itself: bookmarks, history, downloads ledger,
 *      notes (encrypted), and site-permission decisions.
 */
const { app, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { JsonStore, ensureDir, readJSON, writeJSON } = require('./store');

const COLORS = ['#E5484D', '#E8843C', '#D9B13B', '#46A758', '#2F9E9B', '#3E7BD6', '#6E56CF', '#C04A8C', '#7A7A7A'];
const ICONS = ['◆', '●', '■', '▲', '⬟', '✦', '☗', '✚', '☾', '★'];

class ProfileManager {
  constructor() {
    this.userData = app.getPath('userData');
    this.store = new JsonStore(path.join(this.userData, 'profiles.json'), { profiles: [] });
    this.profileDataRoot = ensureDir(path.join(this.userData, 'ProfileData'));
    this._perProfileStores = new Map(); // id -> { bookmarks, history, downloads, notes, permissions }
  }

  // ---------- CRUD ----------

  list() {
    return this.store.get('profiles', []).map((p) => this._public(p));
  }

  getRaw(id) {
    return this.store.get('profiles', []).find((p) => p.id === id) || null;
  }

  create({ name, color, icon, note = '', homepage = 'https://duckduckgo.com', searchEngine = 'duckduckgo' }) {
    const profiles = this.store.get('profiles', []);
    const id = crypto.randomUUID();
    const profile = {
      id,
      name: (name || `Profile ${profiles.length + 1}`).trim(),
      color: color || COLORS[profiles.length % COLORS.length],
      icon: icon || ICONS[profiles.length % ICONS.length],
      note,
      homepage,
      searchEngine,
      startupBehavior: 'homepage', // 'homepage' | 'restore' | 'urls'
      startupUrls: [],
      downloadDir: '', // empty = system Downloads/<profile name>
      pinHash: null,
      pinSalt: null,
      archived: false,
      createdAt: Date.now(),
      lastOpenedAt: null
    };
    profiles.push(profile);
    this.store.set('profiles', profiles);
    ensureDir(this.dataDir(id));
    return this._public(profile);
  }

  update(id, patch) {
    const profiles = this.store.get('profiles', []);
    const p = profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found');
    const allowed = ['name', 'color', 'icon', 'note', 'homepage', 'searchEngine',
      'startupBehavior', 'startupUrls', 'downloadDir', 'archived'];
    for (const k of allowed) if (k in patch) p[k] = patch[k];
    this.store.set('profiles', profiles);
    return this._public(p);
  }

  touch(id) {
    const profiles = this.store.get('profiles', []);
    const p = profiles.find((x) => x.id === id);
    if (p) { p.lastOpenedAt = Date.now(); this.store.set('profiles', profiles); }
  }

  /**
   * Permanently delete a profile: metadata record, the app-level data dir,
   * and the Chromium partition directory (cookies, cache, IndexedDB, …).
   * The caller must ensure the profile's session is closed and its storage
   * cleared first (see SessionManager.destroyProfileSession).
   */
  delete(id) {
    const profiles = this.store.get('profiles', []).filter((p) => p.id !== id);
    this.store.set('profiles', profiles);
    this._perProfileStores.delete(id);
    for (const dir of [this.dataDir(id), this.partitionDir(id)]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // ---------- Identity of the isolated session ----------

  partitionName(id) { return `persist:profile-${id}`; }
  partitionDir(id) { return path.join(this.userData, 'Partitions', `profile-${id}`); }
  dataDir(id) { return path.join(this.profileDataRoot, id); }

  // ---------- PIN lock ----------

  setPin(id, pin) {
    const profiles = this.store.get('profiles', []);
    const p = profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found');
    if (!pin) { p.pinHash = null; p.pinSalt = null; }
    else {
      const salt = crypto.randomBytes(16).toString('hex');
      p.pinSalt = salt;
      p.pinHash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
    }
    this.store.set('profiles', profiles);
  }

  verifyPin(id, pin) {
    const p = this.getRaw(id);
    if (!p || !p.pinHash) return true; // no lock set
    const hash = crypto.scryptSync(String(pin || ''), p.pinSalt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(p.pinHash, 'hex'));
  }

  // ---------- Per-profile app stores ----------

  stores(id) {
    if (!this._perProfileStores.has(id)) {
      const dir = ensureDir(this.dataDir(id));
      this._perProfileStores.set(id, {
        bookmarks: new JsonStore(path.join(dir, 'bookmarks.json'), { folders: [{ id: 'root', name: 'Bookmarks' }], items: [] }),
        history: new JsonStore(path.join(dir, 'history.json'), { entries: [] }),
        downloads: new JsonStore(path.join(dir, 'downloads.json'), { items: [] }),
        permissions: new JsonStore(path.join(dir, 'permissions.json'), { decisions: {} })
      });
    }
    return this._perProfileStores.get(id);
  }

  addHistory(id, entry) {
    const s = this.stores(id).history;
    const entries = s.get('entries', []);
    entries.unshift({ ...entry, at: Date.now() });
    if (entries.length > 5000) entries.length = 5000;
    s.set('entries', entries);
  }

  // ---------- Encrypted notes (sticky notes per profile / per URL) ----------

  _notesFile(id) { return path.join(this.dataDir(id), 'notes.enc.json'); }
  _credsFile(id) { return path.join(this.dataDir(id), 'credentials.enc.json'); }

  /**
   * Per-profile password vault. Stored encrypted at rest via Electron
   * safeStorage (key held in the macOS Keychain), same scheme as notes.
   * Records: { id, domain, label, username, password, updatedAt }.
   * Passwords are never logged and only leave this process when the user
   * explicitly fills a form or opens a record for editing.
   */
  readCredentials(id) {
    const raw = readJSON(this._credsFile(id), null);
    if (!raw) return [];
    if (raw.encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return JSON.parse(safeStorage.decryptString(Buffer.from(raw.payload, 'base64')));
      } catch { return []; }
    }
    return raw.plain || [];
  }

  writeCredentials(id, list) {
    const file = this._credsFile(id);
    if (safeStorage.isEncryptionAvailable()) {
      const payload = safeStorage.encryptString(JSON.stringify(list)).toString('base64');
      writeJSON(file, { encrypted: true, payload });
    } else {
      writeJSON(file, { encrypted: false, plain: list });
    }
  }

  readNotes(id) {
    const file = this._notesFile(id);
    const raw = readJSON(file, null);
    if (!raw) return { profile: '', urls: {} };
    if (raw.encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        return JSON.parse(safeStorage.decryptString(Buffer.from(raw.payload, 'base64')));
      } catch { return { profile: '', urls: {} }; }
    }
    return raw.plain || { profile: '', urls: {} };
  }

  writeNotes(id, notes) {
    const file = this._notesFile(id);
    if (safeStorage.isEncryptionAvailable()) {
      // Encrypted with a key held in the macOS Keychain (Electron safeStorage).
      const payload = safeStorage.encryptString(JSON.stringify(notes)).toString('base64');
      writeJSON(file, { encrypted: true, payload });
    } else {
      writeJSON(file, { encrypted: false, plain: notes });
    }
  }

  // ---------- shape returned to renderers (never includes pinHash/salt) ----------

  _public(p) {
    const { pinHash, pinSalt, ...rest } = p;
    return { ...rest, hasPin: Boolean(pinHash), partition: this.partitionName(p.id) };
  }

  static get COLORS() { return COLORS; }
  static get ICONS() { return ICONS; }
}

module.exports = { ProfileManager, COLORS, ICONS };
