'use strict';
/**
 * recovery.js — crash recovery.
 *
 * A runtime journal (<userData>/runtime-state.json) records which profiles
 * are open and their tab URLs, refreshed every few seconds. On a clean quit
 * the journal is marked clean. If the app launches and finds a dirty
 * journal with open profiles, it offers to restore the previous session.
 */
const { app, dialog } = require('electron');
const path = require('path');
const { readJSON, writeJSON } = require('./store');

class CrashRecovery {
  constructor(windowManager) {
    this.windows = windowManager;
    this.file = path.join(app.getPath('userData'), 'runtime-state.json');
    this.previous = readJSON(this.file, null);
    this._timer = null;
  }

  start() {
    this._write(false);
    this._timer = setInterval(() => this._write(false), 4000);
  }

  markClean() {
    clearInterval(this._timer);
    this._write(true);
  }

  _write(clean) {
    const open = this.windows.listActive()
      .filter((w) => !w.temp)
      .map((w) => ({ profileId: w.profileId, tabs: w.urls }));
    writeJSON(this.file, { cleanShutdown: clean, open, at: Date.now() });
  }

  /** Call after app ready. Returns true if a restore was offered+performed. */
  async maybeOfferRestore() {
    const prev = this.previous;
    if (!prev || prev.cleanShutdown || !prev.open || !prev.open.length) return false;
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restore session', 'Start fresh'],
      defaultId: 0,
      cancelId: 1,
      message: 'Partitions did not shut down cleanly.',
      detail: `Restore ${prev.open.length} profile window${prev.open.length === 1 ? '' : 's'} and their tabs?`
    });
    if (response !== 0) return false;
    for (const entry of prev.open) {
      try { this.windows.openProfile(entry.profileId, { urls: entry.tabs }); }
      catch { /* profile may have been deleted */ }
    }
    return true;
  }
}

module.exports = { CrashRecovery };
