import { execSync } from 'child_process';

const DEFAULT_PROCESS_NAME = 'Claude';
const DEFAULT_POLL_INTERVAL = 800;
const CONFIRM_CYCLES = 2;

const IGNORE_PATTERNS = [
  /node_modules/, /\.git/, /\.next/, /\.cache/,
  /dist/, /build/, /\.turbo/, /\.nyc_output/,
  /coverage/, /\.vscode/, /\.idea/,
  /\.DS_Store/, /yarn-error\.log/, /package-lock\.json/,
  /\.vibe-guarding/
];

export class AgentMonitor {
  constructor(projectRoot, broadcast, activityStore) {
    this.projectRoot = projectRoot;
    this.broadcast = broadcast;
    this.activityStore = activityStore || null;

    this.processName = DEFAULT_PROCESS_NAME;
    this.pollInterval = DEFAULT_POLL_INTERVAL;
    this.pid = null;
    this._timer = null;
    this._running = false;
    this._pidRetryTimer = null;

    // Candidate tracking for double-check confirmation
    this._candidateFiles = new Map();
    // Active reading sessions: path → startTimestamp
    this._readingFiles = new Map();
  }

  // ─── Config ───

  configure(config) {
    if (config?.processName) this.processName = config.processName;
    if (config?.pollInterval) this.pollInterval = config.pollInterval;
  }

  // ─── PID Discovery ───

  _discoverPid() {
    try {
      const result = execSync(`pgrep -fi "${this.processName}" 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' });
      const pids = result.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
      if (pids.length > 0) {
        this.pid = pids[0];
        return true;
      }
    } catch (_) { /* pgrep not available or no match */ }
    this.pid = null;
    return false;
  }

  _schedulePidRetry() {
    if (this._pidRetryTimer) clearTimeout(this._pidRetryTimer);
    this._pidRetryTimer = setTimeout(() => {
      if (!this._running) return;
      if (this._discoverPid()) {
        console.log(`\x1b[36m  [agent-monitor] PID discovered: ${this.pid}\x1b[0m`);
      } else {
        this._schedulePidRetry();
      }
    }, 5000);
  }

  // ─── lsof Polling ───

  _getOpenFiles() {
    if (!this.pid) return new Set();
    try {
      const result = execSync(`lsof -p ${this.pid} -F n 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' });
      const files = new Set();
      for (const line of result.split('\n')) {
        if (!line.startsWith('n')) continue;
        const filePath = line.slice(1);
        if (filePath.startsWith(this.projectRoot)) {
          const relative = filePath.slice(this.projectRoot.length + 1);
          if (!this._shouldIgnore(relative)) {
            files.add(relative);
          }
        }
      }
      return files;
    } catch (_) {
      return new Set();
    }
  }

  _shouldIgnore(relative) {
    return IGNORE_PATTERNS.some(re => re.test(relative));
  }

  // ─── Tick ───

  tick() {
    // Re-discover PID if lost (agent restart / PID drift)
    if (!this.pid) return;

    const currentFiles = this._getOpenFiles();

    // Detect newly opened files (double-check confirmation)
    for (const f of currentFiles) {
      if (this._readingFiles.has(f)) continue;

      const count = (this._candidateFiles.get(f) || 0) + 1;
      this._candidateFiles.set(f, count);

      if (count >= CONFIRM_CYCLES) {
        this._candidateFiles.delete(f);
        this._readingFiles.set(f, Date.now());
        this.broadcast({ type: 'agent:reading-start', path: f });
        console.log(`\x1b[36m  ○ reading-start: ${f}\x1b[0m`);
      }
    }

    // Detect closed files
    for (const [f, startTs] of this._readingFiles) {
      if (!currentFiles.has(f)) {
        const duration = Date.now() - startTs;
        this._readingFiles.delete(f);
        this.broadcast({ type: 'agent:reading-end', path: f, duration });
        console.log(`\x1b[36m  ○ reading-end: ${f} (${duration}ms)\x1b[0m`);
        if (this.activityStore) {
          this.activityStore.recordRead(f);
        }
      }
    }

    // Clean up stale candidates
    for (const f of this._candidateFiles.keys()) {
      if (!currentFiles.has(f)) {
        this._candidateFiles.delete(f);
      }
    }
  }

  // ─── Lifecycle ───

  start() {
    if (this._running) return;
    this._running = true;

    if (!this.pid && !this._discoverPid()) {
      console.log(`\x1b[33m  [agent-monitor] No PID found for "${this.processName}", retrying every 5s\x1b[0m`);
      this._schedulePidRetry();
    } else if (this.pid) {
      console.log(`\x1b[36m  [agent-monitor] Watching PID ${this.pid} (${this.processName})\x1b[0m`);
    }

    this._tickLoop();
  }

  _tickLoop() {
    if (!this._running) return;
    this.tick();
    this._timer = setTimeout(() => this._tickLoop(), this.pollInterval);
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._pidRetryTimer) { clearTimeout(this._pidRetryTimer); this._pidRetryTimer = null; }
  }

  getStatus() {
    return {
      running: this._running,
      pid: this.pid,
      processName: this.processName,
      pollInterval: this.pollInterval,
      readingFiles: Array.from(this._readingFiles.entries()).map(([path, start]) => ({
        path,
        duration: Date.now() - start,
      })),
    };
  }

  destroy() {
    this.stop();
    // Emit reading-end for all active readings
    for (const [path, start] of this._readingFiles) {
      this.broadcast({ type: 'agent:reading-end', path, duration: Date.now() - start });
      if (this.activityStore) {
        this.activityStore.recordRead(path);
      }
    }
    this._readingFiles.clear();
    this._candidateFiles.clear();
  }
}
