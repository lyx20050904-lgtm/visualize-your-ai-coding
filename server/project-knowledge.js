/**
 * ProjectKnowledge — F13 Layer 2 knowledge base
 *
 * Scans project files on open, generates summary cache for fast lookups.
 * F13 queries read from this cache first, avoiding full file reads.
 *
 * Isolation contract:
 *   - NEVER calls broadcast()
 *   - NEVER modifies file-watcher state
 *   - ONLY reads project files + writes .vibe-guarding-knowledge.json
 */
import fs from 'fs';
import path from 'path';

const KNOWLEDGE_FILE = '.vibe-guarding-knowledge.json';

// Skip binary/too-large files
const MAX_SCAN_SIZE = 100000;
const SCAN_EXTENSIONS = /\.(js|ts|jsx|tsx|vue|svelte|py|go|rs|java|css|scss|html|json|md|yaml|yml|sh)$/i;

export class ProjectKnowledge {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.store = {};
    this._ready = false;
    this._load();
  }

  isReady() { return this._ready; }

  getSummary(filePath) {
    return this.store[filePath] || null;
  }

  getAllSummaries() {
    return { ...this.store };
  }

  /**
   * Background scan: build a structural summary for each business file.
   * Designed to be fast (no LLM calls) — just code metrics + key exports.
   */
  scan(nodes) {
    const updates = {};
    for (const node of nodes) {
      if (node.type === 'directory') continue;
      if (this.store[node.path]) continue; // already cached
      if (!SCAN_EXTENSIONS.test(node.path)) continue;

      const fullPath = path.join(this.projectRoot, node.path);
      let content = '';
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).size <= MAX_SCAN_SIZE) {
          content = fs.readFileSync(fullPath, 'utf-8');
        }
      } catch { /* skip unreadable */ }
      if (!content) continue;

      updates[node.path] = this._summarize(content, node.path);
    }

    if (Object.keys(updates).length > 0) {
      Object.assign(this.store, updates);
      this._save();
    }
    this._ready = true;
  }

  _summarize(content, filePath) {
    const lines = content.split('\n');
    const exports = [];
    const classNames = [];
    const fnNames = [];

    // Extract key identifiers (not exhaustive, just structural hints)
    for (const line of lines) {
      const trimmed = line.trim();
      const exp = trimmed.match(/^export\s+(default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/);
      if (exp) exports.push(exp[2]);
      const cls = trimmed.match(/^\s*(export\s+)?(abstract\s+)?class\s+(\w+)/);
      if (cls) classNames.push(cls[cls.length - 1]);
      const fn = trimmed.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)/);
      if (fn) fnNames.push(fn[fn.length - 1]);
    }

    const ext = path.extname(filePath);
    return {
      exports,
      classes: classNames.slice(0, 10),
      functions: fnNames.slice(0, 15),
      lines,
      size: content.length,
      ext,
      role: _inferRoleFromExt(ext),
    };
  }

  _load() {
    const p = path.join(this.projectRoot, KNOWLEDGE_FILE);
    if (fs.existsSync(p)) {
      try {
        this.store = JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch { this.store = {}; }
    }
  }

  _save() {
    try {
      fs.writeFileSync(
        path.join(this.projectRoot, KNOWLEDGE_FILE),
        JSON.stringify(this.store, null, 2),
        'utf-8'
      );
    } catch { /* best-effort */ }
  }
}

function _inferRoleFromExt(ext) {
  const map = {
    '.tsx': 'component', '.jsx': 'component', '.vue': 'component', '.svelte': 'component',
    '.css': 'style', '.scss': 'style',
    '.json': 'config', '.yaml': 'config', '.yml': 'config',
    '.md': 'doc',
    '.html': 'template',
    '.py': 'service', '.go': 'service', '.rs': 'service', '.java': 'service',
    '.sh': 'script',
  };
  return map[ext] || 'module';
}

