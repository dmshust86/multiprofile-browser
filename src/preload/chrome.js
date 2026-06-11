'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chrome_api', {
  context: () => ipcRenderer.invoke('chrome:context'),
  requestState: () => ipcRenderer.send('chrome:requestState'),
  newTab: (url) => ipcRenderer.send('chrome:newTab', url),
  closeTab: (id) => ipcRenderer.send('chrome:closeTab', id),
  selectTab: (id) => ipcRenderer.send('chrome:selectTab', id),
  navigate: (input) => ipcRenderer.send('chrome:navigate', input),
  back: () => ipcRenderer.send('chrome:back'),
  forward: () => ipcRenderer.send('chrome:forward'),
  reload: () => ipcRenderer.send('chrome:reload'),
  stop: () => ipcRenderer.send('chrome:stop'),
  home: () => ipcRenderer.send('chrome:home'),
  copyUrl: () => ipcRenderer.send('chrome:copyUrl'),
  requestOverlay: (open) => ipcRenderer.send('chrome:overlay', !!open),
  openInProfile: (profileId, pin) => ipcRenderer.invoke('chrome:openInProfile', { profileId, pin }),
  duplicateToTemp: () => ipcRenderer.invoke('chrome:duplicateToTemp'),
  bookmarkToggle: () => ipcRenderer.invoke('chrome:bookmarkToggle'),
  bookmarks: () => ipcRenderer.invoke('chrome:bookmarks'),
  bookmarkDelete: (id) => ipcRenderer.invoke('chrome:bookmarkDelete', id),
  bookmarksExport: () => ipcRenderer.invoke('chrome:bookmarksExport'),
  bookmarksImport: () => ipcRenderer.invoke('chrome:bookmarksImport'),
  history: () => ipcRenderer.invoke('chrome:history'),
  downloads: () => ipcRenderer.invoke('chrome:downloads'),
  noteForUrl: (url) => ipcRenderer.invoke('chrome:noteForUrl', { url }),
  setNoteForUrl: (url, text) => ipcRenderer.invoke('chrome:setNoteForUrl', { url, text }),
  onTabsUpdate: (cb) => ipcRenderer.on('tabs:update', (e, state) => cb(state)),
  onDownloadUpdate: (cb) => ipcRenderer.on('downloads:update', (e, rec) => cb(rec))
});
