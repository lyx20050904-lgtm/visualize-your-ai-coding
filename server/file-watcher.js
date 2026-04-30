import chokidar from 'chokidar';
import path from 'path';
import chalk from 'chalk';

const IGNORE_PATTERNS = [
  /node_modules/, /\.git/, /\.next/, /\.cache/,
  /dist/, /build/, /\.turbo/, /\.nyc_output/,
  /coverage/, /\.vscode/, /\.idea/,
  /\.DS_Store/, /yarn-error\.log/, /package-lock\.json/,
  /\.vibe-guarding-cache\.json/,
  /\.vibe-guarding-activity\.json/,
  /\.vibe-guarding-knowledge\.json/
];

// Session debounce window: 2500ms — long enough for human visual perception
// AI agents typically write a file once per edit, so the 500ms window was too short
// and the editing glow would disappear before the user could notice it.
const SESSION_DEBOUNCE_MS = 2500;

export class ProjectWatcher {
  constructor(root, broadcast, activityStore) {
    this.root = root;
    this.broadcast = broadcast;
    this.activityStore = activityStore || null;

    // Debounce timers for file events (structural: add/delete)
    this.debounceTimers = new Map();

    // Per-file editing session tracking
    // editingFiles: Set of relative paths currently in an editing session
    this.editingFiles = new Set();
    // sessionTimers: Map of relative path → timeout handle (500ms session window)
    this.sessionTimers = new Map();
    // editSessionCounts: relative path → number of completed edit sessions
    this.editSessionCounts = {};

    this._initialScanDone = false;
    this.watcher = null;
    this.start();
  }

  start() {
    console.log(chalk.cyan(`\n  [*] Watching: ${this.root}\n`));

    this.watcher = chokidar.watch(this.root, {
      ignored: (p) => IGNORE_PATTERNS.some((re) => re.test(p)),
      persistent: true,
      ignoreInitial: false,
      depth: 12,
      // awaitWriteFinish stabilizes rapid multi-write saves
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    });

    this.watcher
      .on('add',      (p) => { if (this._initialScanDone) this._debounce('add', p, 'file:added'); })
      .on('change',   (p) => { this._handleChange(p); })
      .on('unlink',   (p) => { this._debounce('unlink', p, 'file:deleted'); })
      .on('addDir',   (p) => { if (this._initialScanDone) this._debounce('addDir', p, 'dir:added'); })
      .on('unlinkDir',(p) => { this._debounce('unlinkDir', p, 'dir:deleted'); })
      .on('ready',    ()  => {
        this._initialScanDone = true;
        console.log(chalk.gray('  Initial scan complete. Edit session tracking active.'));
      })
      .on('error',    (e) => console.error(chalk.red('Watcher error:'), e));
  }

  // ─── Structural event debounce (add/delete) ───
  _debounce(eventType, filePath, eventName) {
    const key = `${eventType}:${filePath}`;
    if (this.debounceTimers.has(key)) clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      const relative = path.relative(this.root, filePath);
      const ext = path.extname(filePath);
      console.log(chalk.gray(`  ${eventName}: ${relative}`));
      this.broadcast({ type: eventName, path: relative, fullPath: filePath, ext });
    }, 300));
  }

  // ─── Edit session logic ───
  // Rule: consecutive change events within SESSION_DEBOUNCE_MS → same session
  // When the session timer fires without a new change → session ends, count++
  _handleChange(filePath) {
    if (!this._initialScanDone) return;
    const relative = path.relative(this.root, filePath);

    // Start or extend session
    if (!this.editingFiles.has(relative)) {
      // New session begins
      this.editingFiles.add(relative);
      this.broadcast({ type: 'agent:editing-start', path: relative });
      console.log(chalk.yellow(`  ✎ editing-start: ${relative}`));
    }

    // Broadcast change event for structural updates
    this.broadcast({ type: 'file:changed', path: relative });

    // Reset session timer
    if (this.sessionTimers.has(relative)) {
      clearTimeout(this.sessionTimers.get(relative));
    }
    this.sessionTimers.set(relative, setTimeout(() => {
      this._endSession(relative);
    }, SESSION_DEBOUNCE_MS));
  }

  _endSession(relative) {
    this.sessionTimers.delete(relative);
    if (!this.editingFiles.has(relative)) return;

    this.editingFiles.delete(relative);

    // Increment local memory count
    this.editSessionCounts[relative] = (this.editSessionCounts[relative] || 0) + 1;

    // Delegate persistence to activity store (handles broadcast + file write)
    if (this.activityStore) {
      this.activityStore.recordEdit(relative);
    } else {
      // Fallback: direct broadcast if no activity store available
      this.broadcast({
        type: 'edit-counts:update',
        counts: { ...this.editSessionCounts }
      });
    }

    this.broadcast({ type: 'agent:editing-end', path: relative });

    console.log(chalk.gray(
      `  ✓ editing-end: ${relative} (session #${this.editSessionCounts[relative]})`
    ));
  }

  getEditSessionCounts() {
    return { ...this.editSessionCounts };
  }

  close() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
    this.sessionTimers.forEach((t) => clearTimeout(t));
    this.sessionTimers.clear();
    console.log(chalk.yellow('  Watcher stopped.'));
  }
}

