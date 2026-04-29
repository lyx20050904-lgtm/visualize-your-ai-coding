/**
 * Vibe Guarding — Application Controller
 *
 * Owns: WebSocket lifecycle, project state, tree rendering,
 *       details panel, LLM description polling, view toggle.
 *
 * Invariants:
 *   - Never calls D3 directly — all graph ops go through this.visualizer
 *   - Tree rebuild only on full project reload, not on every file change
 *   - LLM polling: max 20 polls × 3s = 60s window, then stops
 */
class App {
  constructor() {
    this.ws = null;
    this.visualizer = null;
    this.projectRoot = null;
    this.projectName = '';

    this.analysisData = null;
    this.currentNode = null;
    this.humanDescriptions = {};
    this.llmDescriptions = {};
    this.editCounts = {};

    this.currentView = 'dev'; // 'dev' | 'simple'

    // Batched incremental updates
    this.pendingChanges = [];
    this.updateTimer = null;

    // LLM polling
    this.llmPollTimer = null;
    this.llmPollCount = 0;
    this.LLM_POLL_MAX = 20;
    this.LLM_POLL_INTERVAL = 3000;

    this._initUI();
    this._connect();
  }

  // ─── WebSocket ───

  _connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}`);
    this.ws.onopen    = () => this._setStatus('connected');
    this.ws.onclose   = () => { this._setStatus('disconnected'); setTimeout(() => this._connect(), 3000); };
    this.ws.onerror   = () => this.ws.close();
    this.ws.onmessage = (msg) => {
      try { this._handleMessage(JSON.parse(msg.data)); }
      catch (e) { console.error('[ws] parse error', e); }
    };
  }

  _setStatus(state) {
    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    dot.className = 'status-dot ' + state;
    text.textContent = state === 'connected'
      ? (this.projectName ? `connected · ${this.projectName}` : 'connected')
      : 'disconnected';
  }

  // ─── Message Router ───

  _handleMessage(data) {
    switch (data.type) {
      case 'project:opened':
        this.projectRoot = data.path;
        this.projectName = data.path.split(/[/\\]/).filter(Boolean).pop() || data.path;
        this._setStatus('connected');
        this._log(data.type, data.path);
        this._loadAnalysis();
        break;

      case 'project:state':
        // Only render on initial load. On reconnect the graph is already live —
        // re-rendering would reset D3 node positions and cause nodes to fly apart.
        if (data.analysis && !this.visualizer) {
          this.analysisData = data.analysis;
          this._renderGraph(data.analysis);
          this._loadHumanDescriptions();
        }
        break;

      case 'file:added':
      case 'file:deleted':
      case 'file:changed':
      case 'dir:added':
      case 'dir:deleted':
        this._log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'agent:editing-start':
        this._log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'agent:editing-end':
        this._log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'edit-counts:state':
      case 'edit-counts:update':
        this.editCounts = data.counts || {};
        if (this.visualizer) this.visualizer.setEditCounts(this.editCounts);
        this._refreshTreeBadges();
        break;
    }
  }

  // ─── Change Batching ───

  _queueChange(change) {
    this.pendingChanges.push(change);
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this._flushChanges(), 300);
  }

  _flushChanges() {
    if (!this.pendingChanges.length || !this.visualizer) { this.pendingChanges = []; return; }
    this.visualizer.incrementalUpdate(this.pendingChanges);
    this.pendingChanges = [];
  }

  // ─── API ───

  async _loadAnalysis() {
    try {
      const res = await fetch('/api/project/analyze');
      const data = await res.json();
      this.analysisData = data;
      this._renderGraph(data);
      await this._loadHumanDescriptions();
      this._startLlmPoll();
    } catch (e) {
      console.error('[app] analysis load failed', e);
    }
  }

  async _loadHumanDescriptions() {
    try {
      const res = await fetch('/api/project/human-descriptions');
      this.humanDescriptions = await res.json();
      if (this.visualizer) this.visualizer.setDescriptions({ ...this.humanDescriptions, ...this.llmDescriptions });
      if (this.currentNode) this._showNodeDetails(this.currentNode);
    } catch (e) {
      console.error('[app] human descriptions load failed', e);
    }
  }

  async _openProject(dirPath) {
    dirPath = dirPath.trim();
    if (!dirPath) return;
    try {
      const res = await fetch('/api/project/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      const data = await res.json();
      if (data.error) this._log('info', `Error: ${data.error}`);
    } catch (e) {
      this._log('info', `Open failed: ${e.message}`);
    }
  }

  // ─── LLM Description Polling ───

  _startLlmPoll() {
    clearInterval(this.llmPollTimer);
    this.llmPollCount = 0;
    this._setLlmStatus('loading');

    this.llmPollTimer = setInterval(async () => {
      this.llmPollCount++;
      if (this.llmPollCount > this.LLM_POLL_MAX) {
        clearInterval(this.llmPollTimer);
        this._setLlmStatus('hidden');
        return;
      }
      try {
        const res  = await fetch('/api/llm/descriptions');
        const data = await res.json();
        if (data.descriptions && Object.keys(data.descriptions).length > 0) {
          this.llmDescriptions = {};
          for (const [path, val] of Object.entries(data.descriptions)) {
            this.llmDescriptions[path] = val;
          }
          if (this.visualizer) {
            this.visualizer.setDescriptions({ ...this.humanDescriptions, ...this.llmDescriptions });
          }
          if (this.currentNode) this._showNodeDetails(this.currentNode);
        }
        if (data.ready && !data.generating) {
          clearInterval(this.llmPollTimer);
          this._setLlmStatus('ready');
        } else if (data.generating) {
          this._setLlmStatus('generating');
        }
      } catch (e) { /* silent */ }
    }, this.LLM_POLL_INTERVAL);
  }

  _setLlmStatus(state) {
    const el   = document.getElementById('llmStatus');
    const dot  = document.getElementById('llmDot');
    const text = document.getElementById('llmStatusText');
    if (!el) return;

    if (state === 'hidden') { el.style.display = 'none'; return; }
    el.style.display = 'flex';

    if (state === 'loading')     { dot.className = 'llm-dot generating'; text.textContent = 'AI loading…'; }
    if (state === 'generating')  { dot.className = 'llm-dot generating'; text.textContent = 'AI generating…'; }
    if (state === 'ready')       { dot.className = 'llm-dot ready';      text.textContent = 'AI ready'; }
  }

  // ─── Graph ───

  _renderGraph(analysis) {
    if (!analysis?.nodes?.length) return;
    this.analysisData = analysis;

    if (!this.visualizer) {
      this.visualizer = new Visualizer('graphSvg', 'tooltip');
      this.visualizer.onNodeClick = (node) => this._showNodeDetails(node);
      this.visualizer.onDeselect  = () => this._clearDetails();
    }

    const display = this.currentView === 'simple'
      ? this._filterSimpleView(analysis)
      : analysis;

    this.visualizer.render(display);
    this.visualizer.setEditCounts(this.editCounts);
    this.visualizer.setDescriptions({ ...this.humanDescriptions, ...this.llmDescriptions });

    this._buildTree(analysis.nodes);
  }

  _filterSimpleView(analysis) {
    const INFRA = [
      /node_modules/, /\.git/, /dist/, /build/, /\.cache/, /\.turbo/,
      /package-lock\.json/, /yarn\.lock/, /pnpm-lock\.yaml/,
      /\.eslintrc/, /\.prettierrc/, /\.babelrc/, /tsconfig\.json/,
      /\.(test|spec)\.(js|ts|jsx|tsx)$/i,
      /\.env/, /Dockerfile/, /\.github/, /coverage/,
    ];
    const isInfra = (node) => INFRA.some((re) => re.test(node.path));
    const tooDeep = (node) => node.path.split('/').length > 4;

    const keepIds = new Set(
      analysis.nodes
        .filter((n) => !isInfra(n) && !tooDeep(n))
        .map((n) => n.id)
    );

    return {
      ...analysis,
      nodes: analysis.nodes.filter((n) => keepIds.has(n.id)),
      edges: analysis.edges.filter((e) => {
        const src = typeof e.source === 'object' ? e.source.id : e.source;
        const tgt = typeof e.target === 'object' ? e.target.id : e.target;
        return keepIds.has(src) && keepIds.has(tgt);
      }),
    };
  }

  // ─── File Tree ───

  _buildTree(nodes) {
    const container = document.getElementById('treeContainer');
    container.innerHTML = '';

    const byParent = {};
    for (const n of nodes) {
      const parts = n.path.split('/');
      parts.pop();
      const parentId = parts.join('/') || '';
      if (!byParent[parentId]) byParent[parentId] = [];
      byParent[parentId].push(n);
    }

    const render = (parentId, depth) => {
      const children = byParent[parentId] || [];
      for (const node of children) {
        const div = document.createElement('div');
        const isDir = node.type === 'directory';
        div.className = `tree-item${isDir ? ' dir-item' : ''}`;
        div.dataset.nodeId = node.id;

        const indent = document.createElement('span');
        indent.className = 'indent';
        indent.style.display = 'inline-block';
        indent.style.width = `${depth * 12 + 10}px`;
        indent.style.flexShrink = '0';

        const iconSvg = isDir
          ? `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`
          : `<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

        const count = this.editCounts[node.path] || 0;
        const badge = count > 0
          ? `<span class="edit-badge" data-badge="${node.id}">${count}</span>`
          : `<span class="edit-badge" data-badge="${node.id}" style="display:none">${count}</span>`;

        div.appendChild(indent);
        div.insertAdjacentHTML('beforeend',
          `${iconSvg}<span class="tree-name">${node.name}</span>${badge}`
        );

        div.addEventListener('click', () => {
          // selectNode triggers onNodeClick → _showNodeDetails, so don't call both
          if (this.visualizer) {
            this.visualizer.selectNode(node.id);
          } else {
            this._showNodeDetails(node);
          }
        });

        container.appendChild(div);
        if (isDir) render(node.id, depth + 1);
      }
    };

    render('', 0);
  }

  _refreshTreeBadges() {
    document.querySelectorAll('[data-badge]').forEach((el) => {
      const nodeId = el.dataset.badge;
      const node = this.analysisData?.nodes?.find((n) => n.id === nodeId);
      if (!node) return;
      const count = this.editCounts[node.path] || 0;
      el.textContent = count;
      el.style.display = count > 0 ? '' : 'none';
      // Mark editing in tree
      const treeItem = el.closest('.tree-item');
      if (treeItem) treeItem.classList.toggle('editing-item', count > 0);
    });
  }

  // ─── Details Panel ───

  _showNodeDetails(node) {
    this.currentNode = node;

    // Highlight in tree
    document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
    const treeItem = document.querySelector(`.tree-item[data-node-id="${CSS.escape(node.id)}"]`);
    if (treeItem) treeItem.classList.add('selected');

    const content = document.getElementById('detailsContent');

    // Gather descriptions
    const humanDesc = this.humanDescriptions[node.path] || this.humanDescriptions[node.name] || '';
    const llmEntry  = this.llmDescriptions[node.path];
    const llmName   = llmEntry?.human_name || '';
    const llmMeta   = llmEntry?.metaphor_desc || '';

    // Edit sessions
    const sessions = this.editCounts[node.path] || 0;
    const maxSessions = Math.max(1, ...Object.values(this.editCounts));
    const heatPct = Math.round((sessions / maxSessions) * 100);

    // Role chip
    const role = node.role || 'unknown';

    content.innerHTML = `
      <div class="detail-section">
        <div class="detail-label">File</div>
        <div class="detail-value">${node.name}</div>
        <div class="detail-value" style="font-size:10px;color:var(--text-muted);margin-top:2px">${node.path}</div>
      </div>

      <div class="detail-section">
        <div class="detail-label">Type</div>
        <span class="role-chip ${role}">${role}</span>
      </div>

      ${sessions > 0 ? `
      <div class="detail-section">
        <div class="detail-label">Edit Sessions</div>
        <div class="heat-bar-wrap">
          <div class="heat-bar"><div class="heat-bar-fill" style="width:${heatPct}%"></div></div>
          <span class="heat-count">${sessions}</span>
        </div>
      </div>` : ''}

      ${llmName ? `
      <div class="detail-section">
        <div class="detail-label">AI Description</div>
        <div class="llm-desc-block">
          <div style="font-weight:600;color:var(--text-primary);font-size:12px">${llmName}</div>
          ${llmMeta ? `<div class="metaphor">${llmMeta}</div>` : ''}
        </div>
      </div>` : humanDesc ? `
      <div class="detail-section">
        <div class="detail-label">Description</div>
        <div class="detail-value plain">${humanDesc}</div>
      </div>` : ''}

      ${node.size ? `
      <div class="detail-section">
        <div class="detail-label">Size</div>
        <div class="detail-value">${this._formatSize(node.size)}</div>
      </div>` : ''}

      <div class="detail-section" style="margin-top:auto;padding-top:12px;border-top:1px solid var(--border-soft)">
        <button class="detail-btn" id="detailCopyPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          Copy Path
        </button>
      </div>
    `;

    document.getElementById('detailCopyPath')?.addEventListener('click', () => {
      navigator.clipboard.writeText(node.path);
      this._log('info', `Copied: ${node.path}`);
    });
  }

  _clearDetails() {
    this.currentNode = null;
    document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
    document.getElementById('detailsContent').innerHTML = `
      <div class="details-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" opacity=".3">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>Click any node to inspect</p>
      </div>`;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ─── Activity Log ───

  _log(type, message) {
    const container = document.getElementById('logContainer');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.dataset.type = type;
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    const label = type.replace('agent:', '').replace('edit-counts:', '').replace('project:', '');
    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-evt">${label}</span>
      <span class="log-path">${message}</span>`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
    while (container.children.length > 300) container.removeChild(container.firstChild);
  }

  // ─── UI Initialization ───

  _initUI() {
    // Project path input
    const input = document.getElementById('projectPathInput');
    const btnOpen = document.getElementById('btnOpenProject');

    const doOpen = () => {
      const p = input.value.trim();
      if (p) this._openProject(p);
    };

    btnOpen.addEventListener('click', doOpen);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOpen(); });

    // View toggle
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === this.currentView) return;
        this.currentView = btn.dataset.view;
        document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.analysisData) this._renderGraph(this.analysisData);
        this._log('info', `View: ${this.currentView}`);
      });
    });

    // Tree filter
    document.getElementById('treeFilter')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.tree-item').forEach((el) => {
        el.style.display = q === '' || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Log controls
    document.getElementById('btnClearLog')?.addEventListener('click', () => {
      document.getElementById('logContainer').innerHTML = '';
    });

    document.getElementById('btnToggleLog')?.addEventListener('click', () => {
      const bar = document.getElementById('logbar');
      const btn = document.getElementById('btnToggleLog');
      bar.classList.toggle('collapsed');
      btn.textContent = bar.classList.contains('collapsed') ? 'Show' : 'Hide';
    });
  }
}
