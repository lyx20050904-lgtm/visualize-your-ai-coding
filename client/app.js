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
    this.readingCounts = {};

    this.currentView = 'dev'; // 'dev' | 'simple'
    this.neonPulse = null;

    // Batched incremental updates
    this.pendingChanges = [];
    this.updateTimer = null;

    // LLM polling
    this.llmPollTimer = null;
    this.llmPollCount = 0;
    this.LLM_POLL_MAX = 20;
    this.LLM_POLL_INTERVAL = 3000;

    // F16: Attention Radar
    this.activeReadings = new Map();  // path → startTime
    this.recentReadings = [];         // { path, duration } ring buffer (max 10)
    this.readingPathTrace = [];       // path history for trace display
    this._radarRaf = null;
    this._radarLastRender = 0;

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
      ? (this.projectName ? 'connected · ' + this.projectName : 'connected')
      : 'disconnected';
  }

  // ─── Message Router ───

  _handleMessage(data) {
    switch (data.type) {
      case 'project:opened':
        this.projectRoot = data.path;
        this.projectName = data.path.split(/[/\\]/).filter(Boolean).pop() || data.path;
        this._setStatus('connected');
        LogManager.log(data.type, data.path);
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
        LogManager.log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'agent:editing-start':
        LogManager.log(data.type, data.path);
        this._queueChange(data);
        // Immediate NeonPulse burst — no batching delay for visual impact
        if (this.neonPulse && this.visualizer) {
          const n = this.visualizer.nodeMap[data.path];
          if (n) this.neonPulse.setEditing(data.path, true);
        }
        break;

      case 'agent:editing-end':
        LogManager.log(data.type, data.path);
        this._queueChange(data);
        if (this.neonPulse && this.visualizer) {
          const n = this.visualizer.nodeMap[data.path];
          if (n) this.neonPulse.setEditing(data.path, false);
        }
        break;

      case 'agent:reading-start':
        LogManager.log(data.type, data.path);
        this._queueChange(data);
        this.activeReadings.set(data.path, Date.now());
        this._startRadarLoop();
        // Highlight tree item
        this._setTreeItemReading(data.path, true);
        break;

      case 'agent:reading-end':
        LogManager.log(data.type, data.path);
        this._queueChange(data);
        this.activeReadings.delete(data.path);
        // Add to recent readings ring buffer (max 10)
        this.recentReadings.unshift({ path: data.path, duration: data.duration || 0 });
        if (this.recentReadings.length > 10) this.recentReadings.pop();
        // Add to path trace
        this.readingPathTrace.push(data.path);
        if (this.readingPathTrace.length > 20) this.readingPathTrace.shift();
        // Remove tree highlight
        this._setTreeItemReading(data.path, false);
        break;

      case 'activity:state':
        this.editCounts = data.data?.editCounts || {};
        this.readingCounts = data.data?.readingCounts || {};
        if (this.visualizer) {
          this.visualizer.setEditCounts(this.editCounts);
          this.visualizer.setReadingCounts(this.readingCounts);
        }
        if (this.neonPulse && this.visualizer) {
          const pathToId = {};
          for (const n of (this.visualizer.nodes || [])) pathToId[n.path] = n.id;
          this.neonPulse.setHeat(this.editCounts, pathToId);
        }
        this._refreshTreeBadges();
        break;

      case 'edit-counts:state':
      case 'edit-counts:update':
        this.editCounts = data.counts || {};
        if (this.visualizer) this.visualizer.setEditCounts(this.editCounts);
        if (this.neonPulse && this.visualizer) {
          // Build path→id map for NeonPulse heat sync
          const pathToId = {};
          for (const n of (this.visualizer.nodes || [])) pathToId[n.path] = n.id;
          this.neonPulse.setHeat(this.editCounts, pathToId);
        }
        this._refreshTreeBadges();
        break;

      case 'reading-counts:update':
        this.readingCounts = data.counts || {};
        if (this.visualizer) this.visualizer.setReadingCounts(this.readingCounts);
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
      if (data.error) LogManager.log('info', 'Error: ' + data.error);
      if (data.ok) {
        this.projectRoot = data.path;
        this.projectName = data.path.split(/[/\\\\]/).filter(Boolean).pop() || data.path;
        this._setStatus('connected');
        LogManager.log('project:opened', data.path);
        this._loadAnalysis();
      }
    } catch (e) {
      LogManager.log('info', 'Open failed: ' + e.message);
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

    if (state === 'loading')     { dot.className = 'llm-dot generating'; text.textContent = 'AI loading...'; }
    if (state === 'generating')  { dot.className = 'llm-dot generating'; text.textContent = 'AI generating...'; }
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

      // NeonPulse: Canvas overlay for Neon Pulse Ring heat effect
      // Must be created after Visualizer so the canvas stacks above the SVG
      if (typeof NeonPulse !== 'undefined') {
        this.neonPulse = new NeonPulse('graphContainer', 'graphSvg');
        this.visualizer.neonPulse = this.neonPulse;
      }
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
        div.className = 'tree-item' + (isDir ? ' dir-item' : '');
        div.dataset.nodeId = node.id;

        const indent = document.createElement('span');
        indent.className = 'indent';
        indent.style.display = 'inline-block';
        indent.style.width = (depth * 12 + 10) + 'px';
        indent.style.flexShrink = '0';

        const iconSvg = isDir
          ? '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
          : '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

        const count = this.editCounts[node.path] || 0;
        const badge = count > 0
          ? '<span class="edit-badge" data-badge="' + node.id + '">' + count + '</span>'
          : '<span class="edit-badge" data-badge="' + node.id + '" style="display:none">' + count + '</span>';

        div.appendChild(indent);
        div.insertAdjacentHTML('beforeend',
          iconSvg + '<span class="tree-name">' + node.name + '</span>' + badge
        );

        div.addEventListener('click', () => {
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
      const treeItem = el.closest('.tree-item');
      if (treeItem) treeItem.classList.toggle('editing-item', count > 0);
    });
  }

  // ─── Details Panel ───

  _showNodeDetails(node) {
    this.currentNode = node;

    document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
    const treeItem = document.querySelector('.tree-item[data-node-id="' + CSS.escape(node.id) + '"]');
    if (treeItem) treeItem.classList.add('selected');

    const content = document.getElementById('detailsContent');

    const humanDesc = this.humanDescriptions[node.path] || this.humanDescriptions[node.name] || '';
    const llmEntry  = this.llmDescriptions[node.path];
    const llmName   = llmEntry?.human_name || '';
    const llmMeta   = llmEntry?.metaphor_desc || '';

    const sessions = this.editCounts[node.path] || 0;
    const maxSessions = Math.max(1, ...Object.values(this.editCounts));
    const heatPct = Math.round((sessions / maxSessions) * 100);

    const role = node.role || 'unknown';
    const isDir = node.type === 'directory';

    var html = '';
    html += '<div class="detail-section">';
    html += '<div class="detail-label">File</div>';
    html += '<div class="detail-value">' + node.name + '</div>';
    html += '<div class="detail-value" style="font-size:10px;color:var(--text-muted);margin-top:2px">' + node.path + '</div>';
    html += '</div>';

    html += '<div class="detail-section">';
    html += '<div class="detail-label">Type</div>';
    html += '<span class="role-chip ' + role + '">' + role + '</span>';
    html += '</div>';

    if (sessions > 0) {
      html += '<div class="detail-section">';
      html += '<div class="detail-label">Edit Sessions</div>';
      html += '<div class="heat-bar-wrap">';
      html += '<div class="heat-bar"><div class="heat-bar-fill" style="width:' + heatPct + '%"></div></div>';
      html += '<span class="heat-count">' + sessions + '</span>';
      html += '</div></div>';
    }

    if (llmName) {
      html += '<div class="detail-section">';
      html += '<div class="detail-label">AI Description</div>';
      html += '<div class="llm-desc-block">';
      html += '<div style="font-weight:600;color:var(--text-primary);font-size:12px">' + llmName + '</div>';
      if (llmMeta) html += '<div class="metaphor">' + llmMeta + '</div>';
      html += '</div></div>';
    } else if (humanDesc) {
      html += '<div class="detail-section">';
      html += '<div class="detail-label">Description</div>';
      html += '<div class="detail-value plain">' + humanDesc + '</div>';
      html += '</div>';
    }

    if (node.size) {
      html += '<div class="detail-section">';
      html += '<div class="detail-label">Size</div>';
      html += '<div class="detail-value">' + this._formatSize(node.size) + '</div>';
      html += '</div>';
    }

    html += '<div class="detail-section" style="margin-top:auto;padding-top:12px;border-top:1px solid var(--border-soft)">';
    html += '<div style="display:flex;gap:6px">';
    html += '<button class="detail-btn" id="detailCopyPath" style="flex:1">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">';
    html += '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>';
    html += '</svg> Copy Path</button>';
    if (!isDir) {
      html += '<button class="detail-btn" id="detailAskAgent" style="flex:1">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">';
      html += '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>';
      html += '</svg> Ask Agent</button>';
    }
    html += '</div></div>';

    html += '<div id="agentResult" style="display:none;margin-top:8px"></div>';

    content.innerHTML = html;

    document.getElementById('detailCopyPath')?.addEventListener('click', () => {
      navigator.clipboard.writeText(node.path);
      LogManager.log('info', 'Copied: ' + node.path);
    });

    document.getElementById('detailAskAgent')?.addEventListener('click', () => {
      this._askNode(node);
    });
  }

  _clearDetails() {
    this.currentNode = null;
    document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
    document.getElementById('detailsContent').innerHTML =
      '<div class="details-empty">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" opacity=".3">' +
      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
      '</svg><p>Click any node to inspect</p></div>';
  }

  _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ─── F16: Attention Radar Panel ───

  _startRadarLoop() {
    if (this._radarRaf) return;
    const tick = () => {
      this._renderRadarPanel();
      if (this.activeReadings.size > 0) {
        this._radarRaf = requestAnimationFrame(tick);
      } else {
        this._radarRaf = null;
      }
    };
    this._radarRaf = requestAnimationFrame(tick);
  }

  _renderRadarPanel() {
    const panel = document.getElementById('radarPanel');
    if (!panel) return;

    panel.classList.toggle('visible', this.activeReadings.size > 0 || this.recentReadings.length > 0);

    const badge = document.getElementById('radarBadge');
    if (badge) badge.textContent = this.activeReadings.size + ' reading';

    // Active readings list
    const activeList = document.getElementById('radarActiveList');
    if (activeList) {
      if (this.activeReadings.size > 0) {
        let html = '';
        const now = Date.now();
        for (const [path, start] of this.activeReadings) {
          const dur = now - start;
          const label = dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's';
          html += '<li class="radar-item active">' +
            '<span><span class="radar-dot"></span><span class="radar-path">' + this._escapeHtml(path) + '</span></span>' +
            '<span class="radar-duration">' + label + '</span></li>';
        }
        activeList.innerHTML = html;
      } else {
        activeList.innerHTML = '';
      }
    }

    // Recent readings list
    const recentList = document.getElementById('radarRecentList');
    if (recentList) {
      if (this.recentReadings.length > 0) {
        let html = '';
        for (let i = 0; i < Math.min(this.recentReadings.length, 5); i++) {
          const r = this.recentReadings[i];
          const dur = r.duration || 0;
          const label = dur < 1000 ? dur + 'ms' : (dur / 1000).toFixed(1) + 's';
          html += '<li class="radar-item">' +
            '<span><span class="radar-dot inactive"></span><span class="radar-path">' + this._escapeHtml(r.path) + '</span></span>' +
            '<span class="radar-duration">' + label + '</span></li>';
        }
        recentList.innerHTML = html;
      } else {
        recentList.innerHTML = '';
      }
    }

    // Path trace
    const traceEl = document.getElementById('radarPathTrace');
    if (traceEl && this.readingPathTrace.length > 1) {
      traceEl.textContent = 'Trace: ' + this.readingPathTrace.slice(-6).join(' → ');
    }
  }

  _setTreeItemReading(path, active) {
    const node = this.analysisData?.nodes?.find((n) => n.path === path);
    if (!node) return;
    const el = document.querySelector('.tree-item[data-node-id="' + CSS.escape(node.id) + '"]');
    if (el) el.classList.toggle('reading-item', active);
  }

  // ─── F13 Node Inquiry Agent (Streaming SSE) ───

  async _askNode(node) {
    const resultEl = document.getElementById('agentResult');
    if (!resultEl) return;

    resultEl.style.display = 'block';
    resultEl.innerHTML =
      '<div class="agent-loading">Analyzing <code>' + this._escapeHtml(node.name) + '</code>...</div>';

    try {
      const res = await fetch('/api/agent/ask-node/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: node.path, role: node.role }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
        resultEl.innerHTML = '<div class="agent-error">' + this._escapeHtml(errData.error) + '</div>';
        return;
      }

      // Switch to streaming view
      resultEl.innerHTML =
        '<div class="detail-section"><div class="detail-label">Agent Analysis</div>' +
        '<div class="agent-stream" id="agentStream"></div></div>';

      const streamEl = document.getElementById('agentStream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';

        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6));

            if (data.type === 'chunk') {
              fullText += data.text;
              streamEl.textContent = fullText;
              streamEl.scrollTop = streamEl.scrollHeight;
            } else if (data.type === 'done') {
              // Render structured result
              streamEl.style.display = 'none';
              const r = data.result;
              var html2 = '<div class="agent-result">';

              html2 += '<div class="agent-field"><span class="agent-label">Summary</span><span class="agent-val">' + this._escapeHtml(r.summary) + '</span></div>';

              if (r.responsibility) {
                html2 += '<div class="agent-field"><span class="agent-label">Responsibility</span><span class="agent-val">' + this._escapeHtml(r.responsibility) + '</span></div>';
              }

              if (r.designPattern) {
                html2 += '<div class="agent-field"><span class="agent-label">Pattern</span><span class="agent-val agent-pattern">' + this._escapeHtml(r.designPattern) + '</span></div>';
              }

              if (r.relatedModules && r.relatedModules.length) {
                html2 += '<div class="agent-field"><span class="agent-label">Related</span><div class="agent-related">';
                for (var i = 0; i < r.relatedModules.length; i++) {
                  html2 += '<code>' + this._escapeHtml(r.relatedModules[i]) + '</code>';
                }
                html2 += '</div></div>';
              }

              html2 += '</div>';
              // Find .detail-section and append result below its label
              var section = resultEl.querySelector('.detail-section');
              section.innerHTML = '<div class="detail-label">Agent Analysis</div>' + html2;
            } else if (data.type === 'error') {
              resultEl.innerHTML = '<div class="agent-error">' + this._escapeHtml(data.text) + '</div>';
            }
          }
        }
      }
    } catch (err) {
      resultEl.innerHTML = '<div class="agent-error">Request failed: ' + this._escapeHtml(err.message) + '</div>';
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── UI Initialization ───

  _initUI() {
    const pathInput = document.getElementById('projectPathInput');
    if (pathInput) {
      pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const p = pathInput.value.trim();
          if (p) this._openProject(p);
        }
      });
    }

    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.view === this.currentView) return;
        this.currentView = btn.dataset.view;
        document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.analysisData) this._renderGraph(this.analysisData);
        LogManager.log('info', 'View: ' + this.currentView);
      });
    });

    document.getElementById('treeFilter')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.tree-item').forEach((el) => {
        el.style.display = q === '' || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    document.getElementById('btnClearLog')?.addEventListener('click', () => {
      document.getElementById('logContainer').innerHTML = '';
    });

    document.getElementById('btnClearActivity')?.addEventListener('click', () => {
      if (!confirm('Clear all edit and read session counts? This cannot be undone.')) return;
      fetch('/api/activity/clear', { method: 'POST' }).catch((e) => {
        LogManager.log('info', 'Clear failed: ' + e.message);
      });
    });

    document.getElementById('btnToggleLog')?.addEventListener('click', () => {
      const bar = document.getElementById('logbar');
      const btn = document.getElementById('btnToggleLog');
      bar.classList.toggle('collapsed');
      btn.textContent = bar.classList.contains('collapsed') ? 'Show' : 'Hide';
    });
  }
}

