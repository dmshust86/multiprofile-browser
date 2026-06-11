'use strict';
/**
 * browser-window.js — browser window management.
 *
 * One BrowserWindow per open profile (or temporary session). The window's
 * own webContents renders the "chrome" (tab strip + toolbar, with the
 * profile's color, icon and name always visible). Each tab is a
 * WebContentsView whose webPreferences.partition pins it to the profile's
 * isolated Chromium session. Web content never runs with Node integration
 * and is always sandboxed.
 */
const { BrowserWindow, WebContentsView, shell, clipboard, Menu } = require('electron');
const crypto = require('crypto');
const path = require('path');

const CHROME_HEIGHT = 92; // px reserved at the top for tabstrip + toolbar

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  google: { name: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing: { name: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  brave: { name: 'Brave', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` }
};

class BrowserWindowManager {
  constructor({ profileManager, sessionManager, onStateChanged }) {
    this.profiles = profileManager;
    this.sessions = sessionManager;
    this.onStateChanged = onStateChanged || (() => {});
    this.windows = new Map();        // windowKey -> ProfileBrowserWindow
    this.recentlyClosed = [];        // [{ kind, profileId|tempMeta, tabs:[urls], closedAt }]
  }

  keyFor(ctx) { return ctx.temp ? `temp:${ctx.tempId}` : `profile:${ctx.profileId}`; }

  getWindow(key) { return this.windows.get(key) || null; }

  listActive() {
    return [...this.windows.values()].map((w) => w.describe());
  }

  /** Open (or focus) the window for a saved profile. */
  openProfile(profileId, { urls } = {}) {
    const key = `profile:${profileId}`;
    if (this.windows.has(key)) {
      const w = this.windows.get(key);
      w.win.show(); w.win.focus();
      return w;
    }
    const profile = this.profiles.getRaw(profileId);
    if (!profile) throw new Error('Profile not found');
    this.profiles.touch(profileId);

    let startUrls = urls;
    if (!startUrls || !startUrls.length) {
      if (profile.startupBehavior === 'urls' && profile.startupUrls.length) startUrls = profile.startupUrls;
      else startUrls = [profile.homepage || 'https://duckduckgo.com'];
    }
    const w = new ProfileBrowserWindow({
      manager: this,
      ctx: { temp: false, profileId },
      identity: { name: profile.name, color: profile.color, icon: profile.icon },
      session: this.sessions.forProfile(profileId),
      partition: this.profiles.partitionName(profileId),
      searchEngine: profile.searchEngine,
      homepage: profile.homepage,
      startUrls
    });
    this.windows.set(key, w);
    this.onStateChanged();
    return w;
  }

  /** Open a new disposable temporary-session window. */
  openTemp({ urls, name } = {}) {
    const meta = this.sessions.createTemp(name);
    const key = `temp:${meta.id}`;
    const w = new ProfileBrowserWindow({
      manager: this,
      ctx: { temp: true, tempId: meta.id },
      identity: { name: meta.name, color: '#7A7A7A', icon: '◌' },
      session: require('electron').session.fromPartition(meta.partition),
      partition: meta.partition,
      searchEngine: 'duckduckgo',
      homepage: 'https://duckduckgo.com',
      startUrls: urls && urls.length ? urls : ['https://duckduckgo.com']
    });
    this.windows.set(key, w);
    this.onStateChanged();
    return w;
  }

  openMany(profileIds) {
    for (const id of profileIds) {
      const p = this.profiles.getRaw(id);
      if (p && !p.archived) this.openProfile(id);
    }
  }

  openAll() {
    this.openMany(this.profiles.list().filter((p) => !p.archived).map((p) => p.id));
  }

  reopenLastClosed() {
    const last = this.recentlyClosed.pop();
    if (!last) return null;
    if (last.kind === 'profile' && this.profiles.getRaw(last.profileId)) {
      return this.openProfile(last.profileId, { urls: last.tabs });
    }
    if (last.kind === 'temp') {
      return this.openTemp({ urls: last.tabs, name: last.name });
    }
    return null;
  }

  _windowClosed(w) {
    const key = this.keyFor(w.ctx);
    this.windows.delete(key);
    const tabs = w.lastKnownUrls.filter(Boolean);
    if (w.ctx.temp) {
      this.recentlyClosed.push({ kind: 'temp', name: w.identity.name, tabs, closedAt: Date.now() });
      this.sessions.destroyTemp(w.ctx.tempId); // disposable: wipe storage now
    } else {
      this.recentlyClosed.push({ kind: 'profile', profileId: w.ctx.profileId, tabs, closedAt: Date.now() });
    }
    if (this.recentlyClosed.length > 25) this.recentlyClosed.shift();
    this.onStateChanged();
  }
}

class ProfileBrowserWindow {
  constructor({ manager, ctx, identity, session, partition, searchEngine, homepage, startUrls }) {
    this.manager = manager;
    this.ctx = ctx;
    this.identity = identity;
    this.session = session;
    this.partition = partition;
    this.searchEngine = searchEngine || 'duckduckgo';
    this.homepage = homepage;
    this.tabs = new Map();      // tabId -> { id, view, title, url, favicon, loading }
    this.tabOrder = [];
    this.activeTabId = null;
    this.lastKnownUrls = [];

    this.win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 680,
      minHeight: 420,
      title: identity.name,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 14 },
      backgroundColor: '#1B1D22',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'chrome', 'chrome.html'), {
      query: {
        name: identity.name, color: identity.color, icon: identity.icon,
        temp: ctx.temp ? '1' : '0'
      }
    });

    this.win.on('resize', () => this._layout());
    this.win.on('closed', () => this.manager._windowClosed(this));
    this.win.webContents.once('did-finish-load', () => {
      for (const url of startUrls) this.newTab(url, { activate: true });
      this._pushState();
    });

    // Keep last-known URLs current for crash recovery / reopen-closed.
    this._urlPollTimer = setInterval(() => {
      this.lastKnownUrls = this.tabOrder.map((id) => this.tabs.get(id)?.url).filter(Boolean);
    }, 1500);
    this.win.once('closed', () => clearInterval(this._urlPollTimer));
  }

  describe() {
    return {
      key: this.manager.keyFor(this.ctx),
      temp: this.ctx.temp,
      profileId: this.ctx.profileId || null,
      tempId: this.ctx.tempId || null,
      name: this.identity.name,
      color: this.identity.color,
      icon: this.identity.icon,
      tabCount: this.tabs.size,
      urls: this.tabOrder.map((id) => this.tabs.get(id)?.url).filter(Boolean)
    };
  }

  // ---------- tabs ----------

  newTab(url, { activate = true } = {}) {
    const id = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,   // ← the isolation boundary
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const tab = { id, view, title: 'New tab', url: url || '', favicon: '', loading: false, canBack: false, canFwd: false };
    this.tabs.set(id, tab);
    this.tabOrder.push(id);
    this.win.contentView.addChildView(view);
    this._wireTab(tab);
    view.webContents.loadURL(url || this.homepage);
    if (activate) this.selectTab(id); else this._layout();
    this._pushState();
    return id;
  }

  selectTab(id) {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    for (const [tid, t] of this.tabs) t.view.setVisible(!this.overlayOpen && tid === id);
    this._layout();
    const t = this.tabs.get(id);
    this.win.setTitle(`${t.title || t.url || 'New tab'} — ${this.identity.name}`);
    this._pushState();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    this.tabs.delete(id);
    this.tabOrder = this.tabOrder.filter((t) => t !== id);
    if (this.activeTabId === id) {
      const next = this.tabOrder[this.tabOrder.length - 1];
      if (next) this.selectTab(next);
      else this.win.close(); // last tab closed → close the profile window
    }
    this._pushState();
  }

  active() { return this.tabs.get(this.activeTabId) || null; }

  // Overlay panels (bookmarks / history / downloads / notes) are rendered by the
  // chrome webContents, which sits *under* the WebContentsViews. Hide the active
  // page view while a panel is open so the panel is visible, restore it on close.
  setOverlay(open) {
    this.overlayOpen = !!open;
    const tab = this.active();
    if (!tab) return;
    if (this.overlayOpen) {
      tab.view.setVisible(false);
    } else {
      // restore visibility of the active tab only
      for (const [tid, t] of this.tabs) t.view.setVisible(tid === this.activeTabId);
      this._layout();
    }
  }

  navigate(input) {
    const tab = this.active();
    if (!tab) return;
    tab.view.webContents.loadURL(this._resolveInput(input));
  }

  goBack() { this.active()?.view.webContents.navigationHistory.goBack(); }
  goForward() { this.active()?.view.webContents.navigationHistory.goForward(); }
  reload() { this.active()?.view.webContents.reload(); }
  stop() { this.active()?.view.webContents.stop(); }
  goHome() { this.active()?.view.webContents.loadURL(this.homepage); }

  _resolveInput(input) {
    const text = String(input || '').trim();
    if (!text) return this.homepage;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;            // has scheme
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`; // bare domain
    if (text === 'localhost' || text.startsWith('localhost:')) return `http://${text}`;
    const engine = SEARCH_ENGINES[this.searchEngine] || SEARCH_ENGINES.duckduckgo;
    return engine.url(text);
  }

  _wireTab(tab) {
    const wc = tab.view.webContents;
    const push = () => this._pushState();

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // target=_blank / window.open stays inside the same isolated profile.
      if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
        this.newTab(url, { activate: disposition !== 'background-tab' });
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    wc.on('page-title-updated', (e, title) => { tab.title = title; push(); });
    wc.on('page-favicon-updated', (e, icons) => { tab.favicon = icons[icons.length - 1] || ''; push(); });
    wc.on('did-start-loading', () => { tab.loading = true; push(); });
    wc.on('did-stop-loading', () => { tab.loading = false; push(); });
    wc.on('did-navigate', (e, url) => {
      tab.url = url;
      tab.canBack = wc.navigationHistory.canGoBack();
      tab.canFwd = wc.navigationHistory.canGoForward();
      if (!this.ctx.temp && url && !url.startsWith('about:')) {
        this.manager.profiles.addHistory(this.ctx.profileId, { url, title: tab.title });
      }
      push();
    });
    wc.on('did-navigate-in-page', (e, url, isMain) => {
      if (isMain) { tab.url = url; push(); }
    });
    wc.on('context-menu', (e, params) => this._contextMenu(tab, params));
    wc.on('render-process-gone', () => { tab.title = 'Tab crashed — reload to recover'; push(); });
  }

  _contextMenu(tab, params) {
    const items = [];
    if (params.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.newTab(params.linkURL, { activate: false }) },
        { label: 'Open link in temporary session', click: () => this.manager.openTemp({ urls: [params.linkURL] }) },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
    }
    items.push(
      { label: 'Back', enabled: tab.canBack, click: () => this.goBack() },
      { label: 'Reload', click: () => tab.view.webContents.reload() },
      { type: 'separator' },
      { label: 'Copy page URL', click: () => clipboard.writeText(tab.url) },
      { label: 'Open page in Finder-default browser', click: () => shell.openExternal(tab.url) },
      { type: 'separator' },
      { label: 'Inspect element', click: () => tab.view.webContents.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  _layout() {
    const [w, h] = this.win.getContentSize();
    const t = this.active();
    if (t) t.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: w, height: Math.max(0, h - CHROME_HEIGHT) });
  }

  _pushState() {
    if (this.win.isDestroyed()) return;
    const active = this.active();
    let bookmarked = false;
    if (!this.ctx.temp && active) {
      const items = this.manager.profiles.stores(this.ctx.profileId).bookmarks.get('items', []);
      bookmarked = items.some((b) => b.url === active.url);
    }
    this.win.webContents.send('tabs:update', {
      tabs: this.tabOrder.map((id) => {
        const t = this.tabs.get(id);
        return { id, title: t.title, url: t.url, favicon: t.favicon, loading: t.loading };
      }),
      activeTabId: this.activeTabId,
      address: active ? active.url : '',
      canBack: active ? active.canBack : false,
      canFwd: active ? active.canFwd : false,
      loading: active ? active.loading : false,
      bookmarked
    });
  }
}

module.exports = { BrowserWindowManager, SEARCH_ENGINES, CHROME_HEIGHT };
