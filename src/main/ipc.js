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

/** Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

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
    // Close this profile's tabs inside any workspace windows too.
    for (const w of windows.windowsWithProfile(id)) {
      for (const [tabId, t] of [...w.tabs]) if (t.pid === id) w.closeTab(tabId);
    }
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

  ipcMain.handle('profiles:openWorkspace', (e, { ids } = {}) => {
    const r = windows.openWorkspace({ profileIds: ids && ids.length ? ids : null });
    if (!r.window && !r.locked.length) return { ok: false, error: 'No profiles available for a workspace window.' };
    return { ok: Boolean(r.window), locked: r.locked };
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

  // ---------------- Proxy / per-profile egress IPs ----------------

  ipcMain.handle('proxy:get', () => sessions.proxyConfig());
  ipcMain.handle('proxy:set', (e, patch) => {
    const cfg = sessions.setProxyConfig(patch || {});
    broadcastDashboard();
    return cfg;
  });
  ipcMain.handle('proxy:test', async () => {
    try { return await sessions.testProxy(); }
    catch (err) { return { ok: false, error: err.message || 'Test failed.' }; }
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

  ipcMain.on('chrome:newTab', withWin((w, url) => {
    // In a workspace, "+" (no URL) cycles to the next profile, but opening a
    // specific URL (bookmark/history) stays in the ACTIVE tab's profile.
    if (url && w.mode === 'workspace') return w.newTab(url, { profileId: w.activePid() });
    w.newTab(url || null);
  }));
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
  ipcMain.on('chrome:tabMenu', withWin((w, id) => w.showTabMenu(id)));
  ipcMain.on('chrome:newTabMenu', withWin((w) => w.showNewTabMenu()));

  ipcMain.handle('chrome:context', withWin((w) => ({
    temp: w.ctx.temp,
    mode: w.mode,
    profileId: w.activePid(),
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
    const pid = w.activePid();
    if (!pid) return { ok: false, error: 'Temporary sessions do not keep bookmarks.' };
    const t = w.active();
    if (!t || !t.url) return { ok: false };
    const store = profiles.stores(pid).bookmarks;
    const items = store.get('items', []);
    const i = items.findIndex((b) => b.url === t.url);
    if (i >= 0) items.splice(i, 1);
    else items.unshift({ id: require('crypto').randomUUID(), url: t.url, title: t.title || t.url, folderId: 'root', addedAt: Date.now() });
    store.set('items', items);
    w._pushState();
    return { ok: true, bookmarked: i < 0 };
  }));

  ipcMain.handle('chrome:bookmarks', withWin((w) => {
    const pid = w.activePid();
    if (!pid) return { folders: [], items: [] };
    const store = profiles.stores(pid).bookmarks;
    return { folders: store.get('folders', []), items: store.get('items', []) };
  }));

  ipcMain.handle('chrome:bookmarkDelete', withWin((w, id) => {
    const pid = w.activePid();
    if (!pid) return { ok: false };
    const store = profiles.stores(pid).bookmarks;
    store.set('items', store.get('items', []).filter((b) => b.id !== id));
    w._pushState();
    return { ok: true };
  }));

  ipcMain.handle('chrome:bookmarksExport', withWin(async (w) => {
    const pid = w.activePid();
    if (!pid) return { ok: false };
    const r = await dialog.showSaveDialog(w.win, { defaultPath: 'bookmarks.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return { ok: false };
    const store = profiles.stores(pid).bookmarks;
    fs.writeFileSync(r.filePath, JSON.stringify({ folders: store.get('folders'), items: store.get('items') }, null, 2));
    return { ok: true };
  }));

  ipcMain.handle('chrome:bookmarksImport', withWin(async (w) => {
    const pid = w.activePid();
    if (!pid) return { ok: false };
    const r = await dialog.showOpenDialog(w.win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const store = profiles.stores(pid).bookmarks;
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
    const pid = w.activePid();
    if (!pid) return { entries: [] };
    return { entries: profiles.stores(pid).history.get('entries', []).slice(0, 200) };
  }));

  ipcMain.handle('chrome:downloads', withWin((w) => {
    const pid = w.activePid();
    if (!pid) return { items: [] };
    return { items: profiles.stores(pid).downloads.get('items', []).slice(0, 100) };
  }));

  ipcMain.handle('chrome:noteForUrl', withWin((w, { url }) => {
    const pid = w.activePid();
    if (!pid) return { text: '' };
    const notes = profiles.readNotes(pid);
    return { text: (notes.urls && notes.urls[url]) || '' };
  }));

  ipcMain.handle('chrome:setNoteForUrl', withWin((w, { url, text }) => {
    const pid = w.activePid();
    if (!pid) return { ok: false };
    const notes = profiles.readNotes(pid);
    notes.urls = notes.urls || {};
    if (text) notes.urls[url] = text; else delete notes.urls[url];
    profiles.writeNotes(pid, notes);
    return { ok: true };
  }));

  // ---------------- Password vault (per profile, encrypted at rest) ----------------

  const credDomainOf = (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  };

  /** List for the active tab's profile; passwords are NOT included here. */
  ipcMain.handle('chrome:credList', withWin((w) => {
    const pid = w.activePid();
    const t = w.active();
    const pageDomain = t ? credDomainOf(t.url) : '';
    if (!pid) return { items: [], pageDomain, vaultAvailable: false };
    const items = profiles.readCredentials(pid).map(({ password, ...rest }) => ({
      ...rest,
      match: Boolean(pageDomain && (pageDomain === rest.domain || pageDomain.endsWith(`.${rest.domain}`)))
    }));
    items.sort((a, b) => (b.match - a.match) || (b.updatedAt - a.updatedAt));
    return { items, pageDomain, vaultAvailable: true };
  }));

  /** Full record (for the edit form) — explicit user action only. */
  ipcMain.handle('chrome:credGet', withWin((w, id) => {
    const pid = w.activePid();
    if (!pid) return null;
    return profiles.readCredentials(pid).find((c) => c.id === id) || null;
  }));

  ipcMain.handle('chrome:credSave', withWin((w, payload) => {
    const pid = w.activePid();
    if (!pid) return { ok: false, error: 'Temporary sessions do not keep saved logins.' };
    const { id, domain, label, username, password } = payload || {};
    if (!domain || !password) return { ok: false, error: 'Domain and password are required.' };
    const list = profiles.readCredentials(pid);
    const clean = {
      domain: String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0],
      label: String(label || '').trim(),
      username: String(username || ''),
      password: String(password),
      updatedAt: Date.now()
    };
    const i = id ? list.findIndex((c) => c.id === id) : -1;
    if (i >= 0) list[i] = { ...list[i], ...clean };
    else list.unshift({ id: require('crypto').randomUUID(), ...clean });
    profiles.writeCredentials(pid, list);
    return { ok: true };
  }));

  ipcMain.handle('chrome:credDelete', withWin((w, id) => {
    const pid = w.activePid();
    if (!pid) return { ok: false };
    profiles.writeCredentials(pid, profiles.readCredentials(pid).filter((c) => c.id !== id));
    return { ok: true };
  }));

  /**
   * Fill the login form on the active tab with a stored credential.
   * Runs only on an explicit click in the Passwords panel; the values go
   * straight into the page's own form fields (the same thing typing does).
   * Two-step logins (email page → password page): fill, continue, fill again.
   */
  ipcMain.handle('chrome:credFill', withWin(async (w, id) => {
    const pid = w.activePid();
    const t = w.active();
    if (!pid || !t) return { ok: false };
    const cred = profiles.readCredentials(pid).find((c) => c.id === id);
    if (!cred) return { ok: false };
    const script = `(() => {
      const setVal = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const vis = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
      const pw = [...document.querySelectorAll('input[type=password]')].filter(vis)[0] || null;
      const texts = [...document.querySelectorAll('input[type=email],input[type=text],input[type=tel],input:not([type])')].filter(vis);
      let user = null;
      if (pw) {
        for (const c of texts) if (pw.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING) user = c;
        if (!user) user = texts[0] || null;
      } else {
        user = texts.find((c) => /user|email|login|phone|account/i.test(c.name + ' ' + c.id + ' ' + (c.getAttribute('autocomplete') || ''))) || texts[0] || null;
      }
      let filled = 0;
      const U = ${JSON.stringify(cred.username || '')};
      const P = ${JSON.stringify(cred.password)};
      if (user && U) { setVal(user, U); filled++; }
      if (pw) { setVal(pw, P); pw.focus(); filled++; }
      else if (user && U) user.focus();
      return filled;
    })()`;
    try {
      const filled = await t.view.webContents.executeJavaScript(script, true);
      return { ok: true, filled };
    } catch {
      return { ok: false, error: 'Could not fill on this page.' };
    }
  }));

  /**
   * Import logins from a CSV export (LastPass, Chrome, Bitwarden and most
   * managers export this shape). Reads the file once, merges into the
   * ACTIVE tab's profile vault, never logs values. Duplicate
   * domain+username pairs are skipped.
   */
  ipcMain.handle('chrome:credImportCsv', withWin(async (w) => {
    const pid = w.activePid();
    if (!pid) return { ok: false, error: 'Temporary sessions do not keep saved logins.' };
    const r = await dialog.showOpenDialog(w.win, {
      title: 'Import logins from CSV (e.g. LastPass export)',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile']
    });
    if (r.canceled) return { ok: false };
    let rows;
    try { rows = parseCsv(fs.readFileSync(r.filePaths[0], 'utf8')); }
    catch { return { ok: false, error: 'Could not read that file as CSV.' }; }
    if (!rows.length) return { ok: false, error: 'That CSV appears to be empty.' };

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
    // LastPass: url,username,password,totp,extra,name,grouping,fav
    // Chrome:   name,url,username,password,note
    // Bitwarden: ...,name,...,login_uri,login_username,login_password
    const cUrl = col('url', 'login_uri', 'website');
    const cUser = col('username', 'login_username', 'user');
    const cPass = col('password', 'login_password', 'pass');
    const cName = col('name', 'title', 'label');
    if (cUrl < 0 || cPass < 0) return { ok: false, error: 'Could not find URL and password columns in that CSV.' };

    const list = profiles.readCredentials(pid);
    let added = 0, skipped = 0;
    for (const row of rows.slice(1)) {
      const rawUrl = (row[cUrl] || '').trim();
      const password = row[cPass] || '';
      if (!rawUrl || !password) { skipped++; continue; }
      let domain;
      try { domain = new URL(/^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname.replace(/^www\./, ''); }
      catch { skipped++; continue; }
      if (!domain || domain === 'sn') { skipped++; continue; } // LastPass secure notes use http://sn
      const username = cUser >= 0 ? (row[cUser] || '') : '';
      if (list.some((c) => c.domain === domain && c.username === username)) { skipped++; continue; }
      list.push({
        id: require('crypto').randomUUID(),
        domain,
        label: cName >= 0 ? (row[cName] || '').trim() : '',
        username,
        password,
        updatedAt: Date.now()
      });
      added++;
    }
    profiles.writeCredentials(pid, list);
    return { ok: true, added, skipped };
  }));

  // Download progress fan-out to the owning window's chrome.
  sessions.onDownload((record) => {
    const targets = new Set();
    const key = record.tempId ? `temp:${record.tempId}` : `profile:${record.profileId}`;
    const direct = windows.getWindow(key);
    if (direct) targets.add(direct);
    if (record.profileId) for (const w of windows.windowsWithProfile(record.profileId)) targets.add(w);
    for (const w of targets) {
      if (!w.win.isDestroyed()) w.win.webContents.send('downloads:update', record);
    }
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
