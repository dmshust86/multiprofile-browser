'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // profiles
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  profileMeta: () => ipcRenderer.invoke('profiles:meta'),
  createProfile: (payload) => ipcRenderer.invoke('profiles:create', payload),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', { id, patch }),
  deleteProfile: (id, pin) => ipcRenderer.invoke('profiles:delete', { id, pin }),
  setPin: (id, currentPin, newPin) => ipcRenderer.invoke('profiles:setPin', { id, currentPin, newPin }),
  launchProfile: (id, pin, urls) => ipcRenderer.invoke('profiles:launch', { id, pin, urls }),
  launchMany: (ids) => ipcRenderer.invoke('profiles:launchMany', { ids }),
  openAll: () => ipcRenderer.invoke('profiles:openAll'),
  openWorkspace: (ids) => ipcRenderer.invoke('profiles:openWorkspace', { ids }),
  reopenClosed: () => ipcRenderer.invoke('profiles:reopenClosed'),
  chooseDownloadDir: () => ipcRenderer.invoke('profiles:chooseDownloadDir'),
  // sessions
  listActive: () => ipcRenderer.invoke('sessions:listActive'),
  listTemp: () => ipcRenderer.invoke('sessions:listTemp'),
  newTemp: (opts) => ipcRenderer.invoke('sessions:newTemp', opts || {}),
  closeWindow: (key) => ipcRenderer.invoke('sessions:closeWindow', { key }),
  renameTemp: (tempId, name) => ipcRenderer.invoke('sessions:renameTemp', { tempId, name }),
  // settings, rules, timers
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSmart: (url) => ipcRenderer.invoke('url:openSmart', { url }),
  fireTimer: (label) => ipcRenderer.send('timers:fire', { label }),
  // notes
  getNotes: (profileId) => ipcRenderer.invoke('notes:get', { profileId }),
  setNotes: (profileId, notes) => ipcRenderer.invoke('notes:set', { profileId, notes }),
  // events
  onStateChanged: (cb) => ipcRenderer.on('state:changed', cb)
});
