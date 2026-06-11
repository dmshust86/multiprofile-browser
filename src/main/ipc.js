'use strict';
/**
 * ipc.js — every IPC surface in one place.
 * Renderers are sandboxed; these handlers are the only bridge.
 */
const { ipcMain, BrowserWindow, dialog, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { COLORS, ICONS } = require('./profiles');
const { SEARCH_ENGINES } = require('./browser-window');

function registerIpc({ profiles, sessions, windows, settings, dashboard }) {
  const profileWindowFor = (event) => {
    const bw = BrowserWindow.fromWebContents(event.sender);
    for (const w of windows.windows.values()) if (w.win === bw) return w;
    return null;
  };

  const broadcastDashboard = () => {
    if (dashboard.current() && !dashboard.current().isDestroyed()) {
      dashboard.current().webContents.send('state:changed');
    }
  };
  windows.onStateChanged = broadcastDashboard;

  // ---------------- Profiles ----------------

  ipcMain.handle('profiles:list', () => profiles.list());
  ipcMain.handle('profiles:meta', () => ({ colors: COLORS, icons: ICONS, searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })) }));
  ipcMain.handle('profiles:create', (e, payload) => { const p = profiles.create(payload || {}); broadcastDashboard(); return p; });
  ipcMain.handle('profiles:update', (e, { id, patch }) => { const p = profiles.update(id, patch); broadcastDashboard(); return p; });

  ipcMain.handle('profiles:setPin', (e, { id, currentPin, newPin }) => {
    if (!profiles.verifyPin(id, currentPin)) return { ok: false, error: 'Current PIN is incorrect.' };
    profiles.setPin(id, newPin);
    broadcastDashboard();
    return { ok: true };
  });

  ipcMain.handle('profiles:delete', async (e, { id, pin }) => {
    const p = profiles.getRaw(id);
    if (!p) return { ok: false, error: 'Profile not found.' };
    if (!profiles.verifyPin(id, pin)) return { ok: false, error: 'PIN required to delete this profile.' };
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Delete profile and all its data', 'Cancel'],
      defaultId: 1, cancelId: 1,
      message: `Delete “${p.name}”?`,
      detail: 'All cookies, logins, history, bookmarks, downloads history and notes for this profile will be permanently removed from this Mac.'
    });
    if (response !== 0) return { ok: false };
    const key = `profile:${id}`;
    const open = windows.getWindow(key);
    if (open) open.win.destroy();
    await sessions.destroyProfileSession(id);
    profiles.delete(id);
    broadcastDashboard();
    return { ok: true };
  });

  ipcMain.handle('profiles:launch', (e, { id, pin, urls }) => {
    if (!profiles.verifyPin(id, pin)) return { ok: false, error: 'pin' };
    windows.openProfile(id, { urls });
    return { ok: true };
  });

  ipcMain.handle('profiles:launchMany', (e, { ids }) => {
    const locked = [];
    for (const id of ids) {
      const p = profiles.getRaw(id);
      if (!p) continue;
      if (p.pinHash) { locked.push(id); continue; } // PIN-locked profiles must be launched individually
      windows.openProfile(id);
    }
    return { ok: true, locked };
  });

  ipcMain.handle('profiles:openAll', () => {
    const all = profiles.list().filter((p) => !p.archived);
    const locked = all.filter((p) => p.hasPin).map((p) => p.id);
    windows.openMany(all.filter((p) => !p.hasPin).map((p) => p.id));
    return { ok: true, locked };
  });

  ipcMain.handle('profiles:reopenClosed', () => {
    const w = windows.reopenLastClosed();
    return { ok: Boolean(w) };
  });

  ipcMain.handle('profiles:chooseDownloadDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  // ---------------- Sessions / session manager page ----------------

  ipcMain.handle('sessions:listActive', () => windows.listActive());
  ipcMain.handle('sessions:listTemp', () => sessions.listTemp());
  ipcMain.handle('sessions:newTemp', (e, { urls, name } = {}) => { windows.openTemp({ urls, name }); return { ok: true }; });
  ipcMain.handle('sessions:closeWindow', (e, { key }) => {
    const w = windows.getWindow(key);
    if (w) w.win.close();
    return { ok: true };
  });
  ipcMain.handle('sessions:renameTemp', (e, { tempId, name }) => {
    const meta = sessions.getTemp(tempId);
    if (meta) {
      meta.name = name;
      const w = windows.getWindow(`temp:${tempId}`);
      if (w) { w.identity.name = name; w.win.setTitle(name); }
    }
    broadcastDashboard();
    return { ok: true };
  });

  // ---------------- Settings: domain rules, timers ----------------

  ipcMain.handle('settings:get', () => settings.data);
  ipcMain.handle('settings:set', (e, patch) => {
    for (const [k, v] of Object.entries(patch || {})) settings.set(k, v);
    return settings.data;
  });

  /** Open a URL respecting domain rules (domain → preferred profile). */
  ipcMain.handle('url:openSmart', (e, { url }) => {
    let target = null;
    try {
      const host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
      const rules = settings.get('domainRules', []);
      const rule = rules.find((r) => host === r.domain || host.endsWith(`.${r.domain}`));
      if (rule) target = rule.profileId;
    } catch { /* fall through */ }
    const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
    if (target && profiles.getRaw(target)) {
      const p = profiles.getRaw(target);
      if (p.pinHash) return { ok: false, error: 'pin', profileId: target };
      const w = windows.openProfile(target);
      w.win.webContents.once('did-finish-load', () => w.newTab(full));
      if (w.tabs.size) w.newTab(full);
      return { ok: true, profileId: target };
    }
    return { ok: false, error: 'no-rule' };
  });

  // ---------------- Notes (per profile / per URL), encrypted at rest ----------------

  ipcMain.handle('notes:get', (e, { profileId }) => profiles.readNotes(profileId));
  ipcMain.handle('notes:set', (e, { profileId, notes }) => { profiles.writeNotes(profileId, notes); return { ok: true }; });

  // ---------------- Chrome (per-window toolbar) ----------------

  const withWin = (fn) => (event, ...args) => {
    const w = profileWindowFor(event);
    if (!w) return null;
    return fn(w, ...args);
  };

  ipcMain.on('chrome:newTab', withWin((w, url) => w.newTab(url || w.homepage)));
  ipcMain.on('chrome:closeTab', withWin((w, id) => w.closeTab(id)));
  ipcMain.on('chrome:selectTab', withWin((w, id) => w.selectTab(id)));
  ipcMain.on('chrome:navigate', withWin((w, input) => w.navigate(input)));
  ipcMain.on('chrome:back', withWin((w) => w.goBack()));
  ipcMain.on('chrome:forward', withWin((w) => w.goForward()));
  ipcMain.on('chrome:reload', withWin((w) => w.reload()));
  ipcMain.on('chrome:stop', withWin((w) => w.stop()));
  ipcMain.on('chrome:home', withWin((w) => w.goHome()));
  ipcMain.on('chrome:copyUrl', withWin((w) => { const t = w.active(); if (t) clipboard.writeText(t.url); }));
  ipcMain.on('chrome:requestState', withWin((w) => w._pushState()));
  ipcMain.on('chrome:overlay', withWin((w, open) => w.setOverlay(!!open)));

  ipcMain.handle('chrome:context', withWin((w) => ({
    temp: w.ctx.temp,
    profileId: w.ctx.profileId || null,
    name: w.identity.name, color: w.identity.color, icon: w.identity.icon,
    profiles: profiles.list().filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, color: p.color, icon: p.icon, hasPin: p.hasPin }))
  })));

  ipcMain.handle('chrome:openInProfile', withWin((w, { profileId, pin }) => {
    const t = w.active();
    if (!t) return { ok: false };
    if (!profiles.verifyPin(profileId, pin)) return { ok: false, error: 'pin' };
    const target = windows.openProfile(profileId);
    if (target.tabs.size) target.newTab(t.url);
    else target.win.webContents.once('did-finish-load', () => target.newTab(t.url));
    return { ok: true };
  }));

  ipcMain.handle('chrome:duplicateToTemp', withWin((w) => {
    const t = w.active();
    if (t) windows.openTemp({ urls: [t.url] });
    return { ok: true };
  }));

  ipcMain.handle('chrome:bookmarkToggle', withWin((w) => {
    if (w.ctx.temp) return { ok: false, error: 'Temporary sessions do not keep bookmarks.' };
    const t = w.active();
    if (!t || !t.url) return { ok: false };
    const store = profiles.stores(w.ctx.profileId).bookmarks;
    const items = store.get('items', []);
    const i = items.findIndex((b) => b.url === t.url);
    if (i >= 0) items.splice(i, 1);
    else items.unshift({ id: require('crypto').randomUUID(), url: t.url, title: t.title || t.url, folderId: 'root', addedAt: Date.now() });
    store.set('items', items);
    w._pushState();
    return { ok: true, bookmarked: i < 0 };
  }));

  ipcMain.handle('chrome:bookmarks', withWin((w) => {
    if (w.ctx.temp) return { folders: [], items: [] };
    const store = profiles.stores(w.ctx.profileId).bookmarks;
    return { folders: store.get('folders', []), items: store.get('items', []) };
  }));

  ipcMain.handle('chrome:bookmarkDelete', withWin((w, id) => {
    if (w.ctx.temp) return { ok: false };
    const store = profiles.stores(w.ctx.profileId).bookmarks;
    store.set('items', store.get('items', []).filter((b) => b.id !== id));
    w._pushState();
    return { ok: true };
  }));

  ipcMain.handle('chrome:bookmarksExport', withWin(async (w) => {
    if (w.ctx.temp) return { ok: false };
    const r = await dialog.showSaveDialog(w.win, { defaultPath: 'bookmarks.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return { ok: false };
    const store = profiles.stores(w.ctx.profileId).bookmarks;
    fs.writeFileSync(r.filePath, JSON.stringify({ folders: store.get('folders'), items: store.get('items') }, null, 2));
    return { ok: true };
  }));

  ipcMain.handle('chrome:bookmarksImport', withWin(async (w) => {
    if (w.ctx.temp) return { ok: false };
    const r = await dialog.showOpenDialog(w.win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const store = profiles.stores(w.ctx.profileId).bookmarks;
      const items = store.get('items', []);
      for (const b of data.items || []) {
        if (b.url && !items.some((x) => x.url === b.url)) {
          items.push({ id: require('crypto').randomUUID(), url: b.url, title: b.title || b.url, folderId: 'root', addedAt: Date.now() });
        }
      }
      store.set('items', items);
      return { ok: true, count: (data.items || []).length };
    } catch (err) {
      return { ok: false, error: 'Could not read that file as bookmarks JSON.' };
    }
  }));

  ipcMain.handle('chrome:history', withWin((w) => {
    if (w.ctx.temp) return { entries: [] };
    return { entries: profiles.stores(w.ctx.profileId).history.get('entries', []).slice(0, 200) };
  }));

  ipcMain.handle('chrome:downloads', withWin((w) => {
    if (w.ctx.temp) return { items: [] };
    return { items: profiles.stores(w.ctx.profileId).downloads.get('items', []).slice(0, 100) };
  }));

  ipcMain.handle('chrome:noteForUrl', withWin((w, { url }) => {
    if (w.ctx.temp) return { text: '' };
    const notes = profiles.readNotes(w.ctx.profileId);
    return { text: (notes.urls && notes.urls[url]) || '' };
  }));

  ipcMain.handle('chrome:setNoteForUrl', withWin((w, { url, text }) => {
    if (w.ctx.temp) return { ok: false };
    const notes = profiles.readNotes(w.ctx.profileId);
    notes.urls = notes.urls || {};
    if (text) notes.urls[url] = text; else delete notes.urls[url];
    profiles.writeNotes(w.ctx.profileId, notes);
    return { ok: true };
  }));

  // Download progress fan-out to the owning window's chrome.
  sessions.onDownload((record) => {
    const key = record.tempId ? `temp:${record.tempId}` : `profile:${record.profileId}`;
    const w = windows.getWindow(key);
    if (w && !w.win.isDestroyed()) w.win.webContents.send('downloads:update', record);
    if (record.state === 'completed' && Notification.isSupported()) {
      new Notification({ title: 'Download complete', body: record.filename }).show();
    }
  });

  // ---------------- Timers / notifications ----------------

  ipcMain.on('timers:fire', (e, { label }) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'Countdown finished', body: label || 'Timer done' }).show();
    }
  });
}

module.exports = { registerIpc };
