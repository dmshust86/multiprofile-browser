'use strict';
/**
 * browser-window.js — browser window management.
 *
 * Two kinds of windows:
 *
 *  • Single-profile window (or temporary-session window): every tab belongs
 *    to the same isolated session — classic Chrome-profile behavior.
 *
 *  • Workspace window: ONE window where EACH TAB is its own profile.
 *    Every tab is a WebContentsView pinned to a different profile's
 *    persistent partition, so tab 1 can be logged into an account as
 *    "Personal" while tab 2 is logged into the same site as "Work",
 *    side by side. Pressing "+" cycles to the next profile. Tabs are
 *    color-coded with their profile's color and the identity strip/badge
 *    always reflects the ACTIVE tab's profile.
 *
 * In both cases the isolation boundary is identical: each tab's
 * webPreferences.partition pins it to exactly one Chromium session.
 * Web content never runs with Node integration and is always sandboxed.
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

const WORKSPACE_IDENTITY = { name: 'Workspace', color: '#8E8E93', icon: '▦' };

class BrowserWindowManager {
  constructor({ profileManager, sessionManager, onStateChanged }) {
    this.profiles = profileManager;
    this.sessions = sessionManager;
    this.onStateChanged = onStateChanged || (() => {});
    this.windows = new Map();        // windowKey -> ProfileBrowserWindow
    this.recentlyClosed = [];        // [{ kind, ... , tabs, closedAt }]
  }

  keyFor(ctx) {
    if (ctx.workspace) return `workspace:${ctx.workspaceId}`;
    return ctx.temp ? `temp:${ctx.tempId}` : `profile:${ctx.profileId}`;
  }

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
    this.sessions.forProfile(profileId); // ensure session configured
    const w = new ProfileBrowserWindow({
      manager: this,
      mode: 'single',
      ctx: { temp: false, profileId },
      identity: { name: profile.name, color: profile.color, icon: profile.icon },
      partition: this.profiles.partitionName(profileId),
      searchEngine: profile.searchEngine,
      homepage: profile.homepage,
      startTabs: startUrls.map((u) => ({ profileId, url: u }))
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
      mode: 'single',
      ctx: { temp: true, tempId: meta.id },
      identity: { name: meta.name, color: '#7A7A7A', icon: '◌' },
      partition: meta.partition,
      searchEngine: 'duckduckgo',
      homepage: 'https://duckduckgo.com',
      startTabs: (urls && urls.length ? urls : ['https://duckduckgo.com']).map((u) => ({ profileId: null, url: u }))
    });
    this.windows.set(key, w);
    this.onStateChanged();
    return w;
  }

  /**
   * Open a workspace window: one tab per profile, each tab isolated in its
   * own profile partition. `tabs` may be provided to restore a specific
   * layout; otherwise one tab is opened per (non-archived, non-PIN) profile.
   * Returns { window, locked } where locked lists PIN-protected profiles
   * that were skipped (PIN entry happens at the dashboard, not mid-tab).
   */
  openWorkspace({ tabs, profileIds } = {}) {
    let plan = tabs;
    const locked = [];
    if (!plan || !plan.length) {
      let candidates = this.profiles.list().filter((p) => !p.archived);
      if (profileIds && profileIds.length) candidates = candidates.filter((p) => profileIds.includes(p.id));
      plan = [];
      for (const p of candidates) {
        if (p.hasPin) { locked.push(p.id); continue; }
        const raw = this.profiles.getRaw(p.id);
        const url = (raw.startupBehavior === 'urls' && raw.startupUrls.length)
          ? raw.startupUrls[0]
          : (raw.homepage || 'https://duckduckgo.com');
        plan.push({ profileId: p.id, url });
      }
    } else {
      // restoring: drop tabs whose profile vanished or is PIN-locked
      plan = plan.filter((t) => {
        const p = this.profiles.getRaw(t.profileId);
        if (!p || p.archived) return false;
        if (p.pinHash) { locked.push(t.profileId); return false; }
        return true;
      });
    }
    if (!plan.length) return { window: null, locked };

    const workspaceId = crypto.randomUUID();
    const key = `workspace:${workspaceId}`;
    for (const t of plan) this.profiles.touch(t.profileId);
    const w = new ProfileBrowserWindow({
      manager: this,
      mode: 'workspace',
      ctx: { temp: false, workspace: true, workspaceId },
      identity: { ...WORKSPACE_IDENTITY },
      partition: null,
      searchEngine: 'duckduckgo',
      homepage: 'https://duckduckgo.com',
      startTabs: plan
    });
    this.windows.set(key, w);
    this.onStateChanged();
    return { window: w, locked };
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
      return this.openProfile(last.profileId, { urls: last.tabs.map((t) => t.url || t) });
    }
    if (last.kind === 'temp') {
      return this.openTemp({ urls: last.tabs.map((t) => t.url || t), name: last.name });
    }
    if (last.kind === 'workspace') {
      return this.openWorkspace({ tabs: last.tabs }).window;
    }
    return null;
  }

  /** True if any open window has a tab bound to this profile. */
  windowsWithProfile(profileId) {
    return [...this.windows.values()].filter((w) => w.hasProfileTab(profileId));
  }

  _windowClosed(w) {
    const key = this.keyFor(w.ctx);
    this.windows.delete(key);
    const tabs = w.lastKnownTabs.filter((t) => t.url);
    if (w.ctx.workspace) {
      this.recentlyClosed.push({ kind: 'workspace', tabs, closedAt: Date.now() });
    } else if (w.ctx.temp) {
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
  constructor({ manager, mode, ctx, identity, partition, searchEngine, homepage, startTabs }) {
    this.manager = manager;
    this.mode = mode || 'single';
    this.ctx = ctx;
    this.identity = identity;          // window-level identity (workspace: neutral)
    this.partition = partition;        // single mode only
    this.searchEngine = searchEngine || 'duckduckgo';
    this.homepage = homepage;
    this.tabs = new Map();      // tabId -> { id, view, pid, identity, homepage, searchEngine, title, url, ... }
    this.tabOrder = [];
    this.activeTabId = null;
    this.lastKnownTabs = [];
    this._cycleIndex = 0;       // workspace: next profile to use for "+"

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
        temp: ctx.temp ? '1' : '0',
        mode: this.mode
      }
    });

    this.win.on('resize', () => this._layout());
    this.win.on('closed', () => this.manager._windowClosed(this));
    this.win.webContents.once('did-finish-load', () => {
      for (const t of startTabs) this.newTab(t.url, { activate: true, profileId: t.profileId });
      // workspace "+" continues the rotation after the seeded tabs
      if (this.mode === 'workspace') this._cycleIndex = startTabs.length;
      this._pushState();
    });

    // Keep last-known tabs current for crash recovery / reopen-closed.
    this._urlPollTimer = setInterval(() => {
      this.lastKnownTabs = this.tabOrder
        .map((id) => { const t = this.tabs.get(id); return t ? { profileId: t.pid, url: t.url } : null; })
        .filter((t) => t && t.url);
    }, 1500);
    this.win.once('closed', () => clearInterval(this._urlPollTimer));
  }

  describe() {
    return {
      key: this.manager.keyFor(this.ctx),
      temp: this.ctx.temp,
      workspace: !!this.ctx.workspace,
      profileId: this.ctx.profileId || null,
      tempId: this.ctx.tempId || null,
      name: this.identity.name,
      color: this.identity.color,
      icon: this.identity.icon,
      tabCount: this.tabs.size,
      urls: this.tabOrder.map((id) => this.tabs.get(id)?.url).filter(Boolean),
      tabsDetail: this.tabOrder
        .map((id) => { const t = this.tabs.get(id); return t ? { profileId: t.pid, url: t.url } : null; })
        .filter((t) => t && t.url)
    };
  }

  // ---------- per-tab profile context ----------

  /** Resolve identity/partition/etc. for a tab bound to `profileId`
      (null → this window's own single-mode context). */
  _tabContext(profileId) {
    if (profileId == null) {
      return {
        pid: this.ctx.temp ? null : (this.ctx.profileId || null),
        identity: this.identity,
        partition: this.partition,
        homepage: this.homepage,
        searchEngine: this.searchEngine
      };
    }
    const p = this.manager.profiles.getRaw(profileId);
    if (!p) return this._tabContext(null);
    this.manager.sessions.forProfile(profileId); // ensure session is configured
    return {
      pid: profileId,
      identity: { name: p.name, color: p.color, icon: p.icon },
      partition: this.manager.profiles.partitionName(profileId),
      homepage: p.homepage || 'https://duckduckgo.com',
      searchEngine: p.searchEngine || 'duckduckgo'
    };
  }

  /** Workspace: which profile should the next "+" tab use? Round-robin
      over non-archived, non-PIN profiles. */
  _nextCycleProfile() {
    const pool = this.manager.profiles.list().filter((p) => !p.archived && !p.hasPin);
    if (!pool.length) return null;
    const p = pool[this._cycleIndex % pool.length];
    this._cycleIndex += 1;
    return p.id;
  }

  /** Profile owning the ACTIVE tab (null for temporary sessions). */
  activePid() {
    const t = this.active();
    return t ? t.pid : null;
  }

  hasProfileTab(profileId) {
    for (const t of this.tabs.values()) if (t.pid === profileId) return true;
    return false;
  }

  // ---------- tabs ----------

  newTab(url, { activate = true, profileId } = {}) {
    let bindTo = profileId;
    if (this.mode === 'workspace' && bindTo === undefined) bindTo = this._nextCycleProfile();
    const tc = this._tabContext(bindTo === undefined ? null : bindTo);

    const id = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        partition: tc.partition,   // ← the isolation boundary, per tab
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const tab = {
      id, view,
      pid: tc.pid,
      identity: tc.identity,
      homepage: tc.homepage,
      searchEngine: tc.searchEngine,
      title: 'New tab', url: url || '', favicon: '', loading: false, canBack: false, canFwd: false
    };
    this.tabs.set(id, tab);
    this.tabOrder.push(id);
    this.win.contentView.addChildView(view);
    this._wireTab(tab);
    view.webContents.loadURL(url || tc.homepage);
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
    this.win.setTitle(`${t.title || t.url || 'New tab'} — ${t.identity.name}`);
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
      else this.win.close(); // last tab closed → close the window
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
    tab.view.webContents.loadURL(this._resolveInput(input, tab));
  }

  goBack() { this.active()?.view.webContents.navigationHistory.goBack(); }
  goForward() { this.active()?.view.webContents.navigationHistory.goForward(); }
  reload() { this.active()?.view.webContents.reload(); }
  stop() { this.active()?.view.webContents.stop(); }
  goHome() {
    const tab = this.active();
    if (tab) tab.view.webContents.loadURL(tab.homepage || this.homepage);
  }

  _resolveInput(input, tab) {
    const text = String(input || '').trim();
    const home = (tab && tab.homepage) || this.homepage;
    if (!text) return home;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;            // has scheme
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`; // bare domain
    if (text === 'localhost' || text.startsWith('localhost:')) return `http://${text}`;
    const engineId = (tab && tab.searchEngine) || this.searchEngine;
    const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.duckduckgo;
    return engine.url(text);
  }

  _wireTab(tab) {
    const wc = tab.view.webContents;
    const push = () => this._pushState();

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // target=_blank / window.open stays inside the SAME profile as the tab
      // that opened it — popups never leak across identities.
      if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
        this.newTab(url, { activate: disposition !== 'background-tab', profileId: tab.pid });
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    wc.on('page-title-updated', (e, title) => {
      tab.title = title;
      if (tab.id === this.activeTabId) this.win.setTitle(`${title} — ${tab.identity.name}`);
      push();
    });
    wc.on('page-favicon-updated', (e, icons) => { tab.favicon = icons[icons.length - 1] || ''; push(); });
    wc.on('did-start-loading', () => { tab.loading = true; push(); });
    wc.on('did-stop-loading', () => { tab.loading = false; push(); });
    wc.on('did-navigate', (e, url) => {
      tab.url = url;
      tab.canBack = wc.navigationHistory.canGoBack();
      tab.canFwd = wc.navigationHistory.canGoForward();
      if (tab.pid && url && !url.startsWith('about:')) {
        this.manager.profiles.addHistory(tab.pid, { url, title: tab.title });
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
        { label: `Open link in new tab (${tab.identity.name})`, click: () => this.newTab(params.linkURL, { activate: false, profileId: tab.pid }) },
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
    const pid = active ? active.pid : null;
    let bookmarked = false;
    if (pid && active && active.url) {
      const items = this.manager.profiles.stores(pid).bookmarks.get('items', []);
      bookmarked = items.some((b) => b.url === active.url);
    }
    this.win.webContents.send('tabs:update', {
      mode: this.mode,
      tabs: this.tabOrder.map((id) => {
        const t = this.tabs.get(id);
        return {
          id, title: t.title, url: t.url, favicon: t.favicon, loading: t.loading,
          color: t.identity.color, profileName: t.identity.name, profileIcon: t.identity.icon
        };
      }),
      activeTabId: this.activeTabId,
      activeIdentity: active
        ? { name: active.identity.name, color: active.identity.color, icon: active.identity.icon, temp: !active.pid && this.ctx.temp }
        : { name: this.identity.name, color: this.identity.color, icon: this.identity.icon, temp: !!this.ctx.temp },
      address: active ? active.url : '',
      canBack: active ? active.canBack : false,
      canFwd: active ? active.canFwd : false,
      loading: active ? active.loading : false,
      bookmarked
    });
  }
}

module.exports = { BrowserWindowManager, SEARCH_ENGINES, CHROME_HEIGHT };
