import chokidar from 'chokidar';
import path from 'path';
import chalk from 'chalk';

const IGNORE_PATTERNS = [
  /node_modules/, /\.git/, /\.next/, /\.cache/,
  /dist/, /build/, /\.turbo/, /\.nyc_output/,
  /coverage/, /\.vscode/, /\.idea/,
  /\.DS_Store/, /yarn-error\.log/, /package-lock\.json/
];

export class ProjectWatcher {
  constructor(root, broadcast) {
    this.root = root;
    this.broadcast = broadcast;
    this.debounceTimers = new Map();
    this.editingFiles = new Set();
    this.editCounts = {};
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
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 }
    });

    this.watcher
      .on('add', (p) => {
        this.debounce('add', p, 'file:added');
      })
      .on('change', (p) => {
        // Immediately mark editing before debounce
        this._markEditing(p);
        this.debounce('change', p, 'file:changed');
        this._trackEdit(p);
      })
      .on('unlink', (p) => this.debounce('unlink', p, 'file:deleted'))
      .on('addDir', (p) => this.debounce('addDir', p, 'dir:added'))
      .on('unlinkDir', (p) => this.debounce('unlinkDir', p, 'dir:deleted'))
      .on('ready', () => {
        this._initialScanDone = true;
        console.log(chalk.gray('  Initial scan complete, session tracking active'));
      })
      .on('error', (e) => console.error(chalk.red('Watcher error:'), e));
  }

  debounce(eventType, filePath, eventName) {
    const key = `${eventType}:${filePath}`;
    if (this.debounceTimers.has(key)) clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      const relative = path.relative(this.root, filePath);
      const ext = path.extname(filePath);
      console.log(chalk.gray(`  ${eventName}: ${relative}`));
      this.broadcast({ type: eventName, path: relative, fullPath: filePath, ext });
      if (eventType === 'change') {
        this.editingFiles.delete(relative);
        this.broadcast({ type: 'agent:editing-end', path: relative });
      }
    }, 300));
  }

  /** Mark file as being edited — sends editing-start immediately */
  _markEditing(filePath) {
    const relative = path.relative(this.root, filePath);
    if (!this.editingFiles.has(relative)) {
      this.editingFiles.add(relative);
      this.broadcast({ type: 'agent:editing-start', path: relative });
    }
  }

  _trackEdit(filePath) {
    if (!this._initialScanDone) return;
    const relative = path.relative(this.root, filePath);
    this.editCounts[relative] = (this.editCounts[relative] || 0) + 1;
    this.broadcast({ type: 'edit-counts:update', counts: { ...this.editCounts } });
  }

  getEditCounts() {
    return { ...this.editCounts };
  }

  close() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.debounceTimers.forEach((t) => clearTimeout(t));
    this.debounceTimers.clear();
    console.log(chalk.yellow('  Watcher stopped'));
  }
}
