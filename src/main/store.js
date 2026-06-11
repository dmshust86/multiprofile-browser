'use strict';
/**
 * store.js — tiny atomic JSON persistence layer.
 *
 * Every store is a JSON file inside the app's userData directory (or a
 * profile's private data directory). Writes are atomic: write to a temp
 * file, then rename over the target, so a crash mid-write never corrupts
 * profile metadata.
 */
const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** A small persisted key/value document with debounced flush. */
class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults, ...readJSON(file, {}) };
    this._timer = null;
  }
  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
  }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 150);
  }
  flush() {
    clearTimeout(this._timer);
    writeJSON(this.file, this.data);
  }
}

module.exports = { ensureDir, readJSON, writeJSON, JsonStore };
