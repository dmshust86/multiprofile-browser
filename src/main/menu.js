'use strict';
/**
 * menu.js — native macOS menu bar with standard shortcuts.
 * Commands route to the focused profile window when one exists.
 */
const { app, Menu, BrowserWindow } = require('electron');

function buildMenu({ windowManager, showDashboard }) {
  const focusedProfileWindow = () => {
    const fw = BrowserWindow.getFocusedWindow();
    if (!fw) return null;
    for (const w of windowManager.windows.values()) if (w.win === fw) return w;
    return null;
  };
  const cmd = (fn) => () => { const w = focusedProfileWindow(); if (w) fn(w); };

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Profile Dashboard', accelerator: 'Cmd+Shift+D', click: showDashboard },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'Cmd+T', click: cmd((w) => w.newTab(w.homepage)) },
        { label: 'New Temporary Session', accelerator: 'Cmd+Shift+N', click: () => windowManager.openTemp() },
        { label: 'Reopen Closed Profile Window', accelerator: 'Cmd+Shift+T', click: () => windowManager.reopenLastClosed() },
        { type: 'separator' },
        { label: 'Open All Profiles', click: () => windowManager.openAll() },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: cmd((w) => w.activeTabId && w.closeTab(w.activeTabId)) },
        { label: 'Close Window', accelerator: 'Cmd+Shift+W', role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' },
        { role: 'delete' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload Page', accelerator: 'Cmd+R', click: cmd((w) => w.reload()) },
        { label: 'Stop Loading', accelerator: 'Cmd+.', click: cmd((w) => w.stop()) },
        { type: 'separator' },
        { label: 'Home', accelerator: 'Cmd+Shift+H', click: cmd((w) => w.goHome()) },
        { label: 'Back', accelerator: 'Cmd+Left', click: cmd((w) => w.goBack()) },
        { label: 'Forward', accelerator: 'Cmd+Right', click: cmd((w) => w.goForward()) },
        { type: 'separator' },
        {
          label: 'Toggle Page DevTools', accelerator: 'Cmd+Alt+I',
          click: cmd((w) => w.active() && w.active().view.webContents.toggleDevTools())
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
