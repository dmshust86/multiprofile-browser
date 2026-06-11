'use strict';
/**
 * main.js — application entry point.
 *
 * Boot order: single-instance lock → managers → dashboard window →
 * crash-recovery offer → IPC + menu. All renderer processes are sandboxed
 * with contextIsolation; web content never gets Node access.
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { JsonStore } = require('./store');
const { ProfileManager } = require('./profiles');
const { SessionManager } = require('./sessions');
const { BrowserWindowManager } = require('./browser-window');
const { CrashRecovery } = require('./recovery');
const { registerIpc } = require('./ipc');
const { buildMenu } = require('./menu');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let dashboardWindow = null;
  let profiles, sessions, windows, recovery, settings;

  const dashboard = {
    current: () => dashboardWindow,
    show() {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.show(); dashboardWindow.focus();
        return;
      }
      dashboardWindow = new BrowserWindow({
        width: 1060,
        height: 760,
        minWidth: 820,
        minHeight: 560,
        title: 'Partitions',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 14 },
        backgroundColor: '#141519',
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'dashboard.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      dashboardWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard', 'index.html'));
      dashboardWindow.on('closed', () => { dashboardWindow = null; });
    }
  };

  app.on('second-instance', () => dashboard.show());

  app.whenReady().then(async () => {
    profiles = new ProfileManager();
    sessions = new SessionManager(profiles);
    settings = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), {
      domainRules: [],   // [{ domain: 'example.com', profileId }]
      timers: []         // [{ id, label, endsAt, timeZone }]
    });
    windows = new BrowserWindowManager({ profileManager: profiles, sessionManager: sessions });
    recovery = new CrashRecovery(windows);

    registerIpc({ profiles, sessions, windows, settings, dashboard });
    buildMenu({ windowManager: windows, showDashboard: () => dashboard.show() });

    // First run: seed a starter profile so the dashboard isn't empty.
    if (profiles.list().length === 0) {
      profiles.create({ name: 'Personal' });
    }

    dashboard.show();
    await recovery.maybeOfferRestore();
    recovery.start();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) dashboard.show();
  });

  app.on('before-quit', () => {
    if (recovery) recovery.markClean();
    if (settings) settings.flush();
  });

  // macOS convention: keep the app alive when all windows close.
  app.on('window-all-closed', () => {
    // no-op on macOS; quit elsewhere
    if (process.platform !== 'darwin') app.quit();
  });
}
