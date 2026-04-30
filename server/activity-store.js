import fs from 'fs';
import path from 'path';

const FILE_NAME = '.vibe-guarding-activity.json';
const SAVE_DEBOUNCE_MS = 1000;
const HISTORY_MAX = 5000;
const HISTORY_TRIM_THRESHOLD = 5500;

export class ActivityStore {
  constructor(projectRoot, broadcast) {
    this.projectRoot = projectRoot;
    this.broadcast = broadcast;
    this.editCounts = {};
    this.readingCounts = {};
    this.history = [];
    this.globalSessionId = 0;
    this._saveTimer = null;
    this._load();
  }

  // ─── Public API ───

  recordEdit(path) {
    this.editCounts[path] = (this.editCounts[path] || 0) + 1;
    this._scheduleSave();
    this.broadcast({ type: 'edit-counts:update', counts: { ...this.editCounts } });
  }

  recordRead(path) {
    this.readingCounts[path] = (this.readingCounts[path] || 0) + 1;
    this._scheduleSave();
    this.broadcast({ type: 'reading-counts:update', counts: { ...this.readingCounts } });
  }

  appendHistory(entry) {
    this.history.push(entry);
    if (this.history.length > HISTORY_TRIM_THRESHOLD) {
      this.history = this.history.slice(-HISTORY_MAX);
    }
    this._scheduleSave();
  }

  getEditCounts() {
    return { ...this.editCounts };
  }

  getReadingCounts() {
    return { ...this.readingCounts };
  }

  getHistory(n) {
    return n ? this.history.slice(-n) : [...this.history];
  }

  getAll() {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      globalSessionId: this.globalSessionId,
      editCounts: { ...this.editCounts },
      readingCounts: { ...this.readingCounts },
      history: [...this.history],
    };
  }

  clear() {
    this.editCounts = {};
    this.readingCounts = {};
    this.history = [];
    this.globalSessionId = 0;
    this._removeFile();
    this.broadcast({
      type: 'activity:state',
      data: this.getAll(),
    });
  }

  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._flush();
  }

  // ─── Internal: Load ───

  _load() {
    const filePath = this._getFilePath();
    if (!fs.existsSync(filePath)) return;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.version !== 1) {
        this._backup(filePath);
        return;
      }

      this.editCounts = data.editCounts || {};
      this.readingCounts = data.readingCounts || {};
      this.history = data.history || [];
      this.globalSessionId = data.globalSessionId || 0;

      if (this.history.length > HISTORY_MAX) {
        this.history = this.history.slice(-HISTORY_MAX);
      }
    } catch (e) {
      this._backup(filePath);
      console.error(`\x1b[33m  [store] Corrupted activity file, backed up: ${FILE_NAME}.bak\x1b[0m`);
    }
  }

  // ─── Internal: Save ───

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), SAVE_DEBOUNCE_MS);
  }

  _flush() {
    this._saveTimer = null;
    const filePath = this._getFilePath();
    const tmpPath = filePath + '.tmp';

    try {
      const data = JSON.stringify(this.getAll(), null, 2);
      fs.writeFileSync(tmpPath, data, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error(`\x1b[31m  [store] Write failed: ${e.message}\x1b[0m`);
    }
  }

  // ─── Internal: Helpers ───

  _getFilePath() {
    return path.join(this.projectRoot, FILE_NAME);
  }

  _backup(filePath) {
    const bakPath = filePath + '.bak';
    try {
      fs.renameSync(filePath, bakPath);
    } catch (_) {}
  }

  _removeFile() {
    try {
      fs.unlinkSync(this._getFilePath());
    } catch (_) {}
    try {
      fs.unlinkSync(this._getFilePath() + '.bak');
    } catch (_) {}
  }
}

