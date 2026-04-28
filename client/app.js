/**
 * Vibe Monitor — Main Application Controller
 *
 * Manages WebSocket connection, project state, UI panels,
 * and coordinates between server and D3 visualization.
 */
class App {
  constructor() {
    this.ws = null;
    this.visualizer = null;
    this.projectRoot = null;
    this.projectName = '';

    // Cached data
    this.treeData = null;
    this.analysisData = null;
    this.fullAnalysis = null;
    this.currentNode = null;
    this.humanDescriptions = {};

    // Pending file changes (batched for incremental update)
    this.pendingChanges = [];
    this.updateTimer = null;

    this._initUI();
    this._connect();
  }

  // ─── WebSocket ───

  _connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this._setStatus('connected');
    };
    this.ws.onclose = () => {
      this._setStatus('disconnected');
      setTimeout(() => this._connect(), 3000);
    };
    this.ws.onerror = () => this.ws.close();
    this.ws.onmessage = (msg) => this._handleMessage(JSON.parse(msg.data));
  }

  _setStatus(state) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    dot.className = `status-dot ${state}`;
    text.textContent = state === 'connected' ? `connected${this.projectName ? ' — ' + this.projectName : ''}` : 'disconnected';
  }

  // ─── Message Handler ───

  _handleMessage(data) {
    switch (data.type) {
      case 'project:opened':
        this.projectRoot = data.path;
        this.projectName = data.path.split('/').pop() || data.path.split('\\').pop();
        this._setStatus('connected');
        this._log('project', `Opened: ${data.path}`);
        this._loadAnalysis();
        break;

      case 'project:state':
        if (data.tree) this.treeData = data.tree;
        if (data.analysis) {
          this.analysisData = data.analysis;
          this._renderGraph(data.analysis);
          this._loadHumanDescriptions();
        }
        break;

      case 'file:added':
      case 'file:deleted':
      case 'dir:added':
      case 'dir:deleted':
        this._log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'file:changed':
        this._log(data.type, data.path);
        this._queueChange(data);
        break;

      case 'prd:parsed':
        this._displayPrd(data.prd);
        break;

      case 'agent:suggest-prompt':
        this._showPromptModal(data.prompt);
        break;

      case 'bug:reported':
        this._log('bug', `Bug reported: ${data.description} (${data.file})`);
        break;

      case 'agent:editing-start':
        this._queueChange(data);
        break;

      case 'agent:editing-end':
        this._queueChange(data);
        break;

      case 'edit-counts:state':
      case 'edit-counts:update':
        if (this.visualizer) {
          this.visualizer.setEditCounts(data.counts || {});
        }
        break;
    }
  }

  // ─── Change Batching ───

  _queueChange(change) {
    this.pendingChanges.push(change);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this._flushChanges(), 500);
  }

  _flushChanges() {
    if (this.pendingChanges.length === 0) return;
    if (this.visualizer) {
      this.visualizer.incrementalUpdate(this.pendingChanges);
    }
    this.pendingChanges = [];
  }

  // ─── API Calls ───

  async _loadAnalysis() {
    try {
      const res = await fetch('/api/project/analyze');
      const data = await res.json();
      this.analysisData = data;
      this._renderGraph(data);
      this._loadHumanDescriptions();
    } catch (e) {
      console.error('Failed to load analysis:', e);
    }
  }

  async _loadHumanDescriptions() {
    try {
      const res = await fetch('/api/project/human-descriptions');
      this.humanDescriptions = await res.json();
      if (this.visualizer) {
        this.visualizer.setHumanDescriptions(this.humanDescriptions);
      }
      if (this.currentNode && this.humanDescriptions[this.currentNode.path]) {
        this._showNodeDetails(this.currentNode);
      }
    } catch (e) {
      console.error('Failed to load descriptions:', e);
    }
  }

  async _openProject(dirPath) {
    try {
      const res = await fetch('/api/project/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      const data = await res.json();
      if (data.error) {
        this._log('error', `Open failed: ${data.error}`);
      }
    } catch (e) {
      this._log('error', `Open failed: ${e.message}`);
    }
  }

  async _submitPrd(content) {
    try {
      const res = await fetch('/api/prd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return await res.json();
    } catch (e) {
      console.error('PRD submit failed:', e);
    }
  }

  // ─── Graph Rendering ───

  _renderGraph(analysis) {
    if (!analysis || !analysis.nodes || analysis.nodes.length === 0) return;

    this.fullAnalysis = analysis;

    if (!this.visualizer) {
      this.visualizer = new Visualizer('graphSvg', 'tooltip');
      this.visualizer.onNodeClick = (node) => this._showNodeDetails(node);
      this.visualizer.onDeselect = () => this._clearDetails();
    }

    this.visualizer.render(analysis);
    this._buildTree(analysis.nodes);
  }

  // ─── Tree View ───

  _buildTree(nodes) {
    const container = document.getElementById('treeContainer');
    container.innerHTML = '';

    const rootNodes = nodes.filter((n) => !n.path.includes('/'));
    const children = (parentId) => nodes.filter((n) => {
      const parts = n.path.split('/');
      parts.pop();
      return parts.join('/') === parentId;
    });

    const renderNode = (node, depth) => {
      const div = document.createElement('div');
      div.className = `tree-item ${node.type === 'directory' ? 'directory' : ''}`;
      div.style.paddingLeft = `${12 + depth * 14}px`;
      const isDir = node.type === 'directory';
      const iconSvg = isDir
        ? '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
        : '<svg class="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      div.innerHTML = `${iconSvg}<span class="tree-name">${node.name}</span>${node.role !== 'unknown' ? `<span class="role-badge">${node.role}</span>` : ''}`;
      div.title = node.path;
      div.dataset.id = node.id;
      div.addEventListener('click', () => {
        if (this.visualizer) this.visualizer.selectNode(node.id);
      });
      container.appendChild(div);

      const kids = children(node.id);
      for (const kid of kids) renderNode(kid, depth + 1);
    };

    for (const root of rootNodes) renderNode(root, 0);
  }

  // ─── Details Panel ───

  _showNodeDetails(node) {
    this.currentNode = node;
    document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
    const treeItem = document.querySelector(`.tree-item[data-id="${CSS.escape(node.id)}"]`);
    if (treeItem) treeItem.classList.add('active');

    const content = document.getElementById('detailsContent');

    const roleLabel = node.prdGhost ? 'planned' : (node.role || 'unknown');
    const isBug = this.visualizer && this.visualizer.bugReports[node.id];
    const desc = node.description || this.humanDescriptions[node.path] || '';

    content.innerHTML = `
      ${desc ? `<div class="detail-row">
        <div class="label">Description</div>
        <div class="value" style="font-size:12px;color:var(--muted);line-height:1.6">${desc}</div>
      </div>` : ''}
      <div class="detail-row">
        <div class="label">Name</div>
        <div class="value">${node.name}</div>
      </div>
      <div class="detail-row">
        <div class="label">Path</div>
        <div class="value" style="font-size:11px">${node.id}</div>
      </div>
      <div class="detail-row">
        <div class="label">Type</div>
        <div class="value">${node.type} / ${roleLabel}</div>
      </div>
      ${node.prdGhost ? `<div class="detail-row"><div class="label">PRD Planned</div><div class="value" style="color:#a78bfa">${node.description || 'Feature from PRD'}</div></div>` : ''}
      <div class="detail-actions">
        <button class="detail-btn" id="btnCopyPath">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copy Path
        </button>
        <button class="detail-btn ${isBug ? 'danger' : ''}" id="btnToggleBug">
          ${isBug ? 'Clear Bug Flag' : 'Report Bug'}
        </button>
      </div>
    `;

    document.getElementById('btnCopyPath')?.addEventListener('click', () => {
      navigator.clipboard.writeText(node.id).then(() => {
        this._log('clipboard', `Copied: ${node.id}`);
      });
    });

    document.getElementById('btnToggleBug')?.addEventListener('click', () => {
      if (this.visualizer) {
        if (this.visualizer.bugReports[node.id]) {
          this.visualizer.clearBug(node.id);
          this._log('bug', `Cleared bug flag: ${node.id}`);
        } else {
          this.visualizer.markBug(node.id);
          this._log('bug', `Bug reported: ${node.id}`);
        }
        this._showNodeDetails(node);
      }
    });
  }

  _clearDetails() {
    this.currentNode = null;
    document.getElementById('detailsContent').innerHTML = '<p class="muted">Click a node to see details</p>';
    document.querySelectorAll('.tree-item.active').forEach((el) => el.classList.remove('active'));
  }

  // ─── PRD Display ───

  _displayPrd(prd) {
    const panel = document.getElementById('prdPanel');
    const content = document.getElementById('prdContent');

    let html = `<div class="prd-title">${prd.title}</div>`;

    if (prd.features.length > 0) {
      html += '<div class="prd-section-label">Features</div>';
      for (const f of prd.features) {
        html += `<div class="prd-item"><div class="prd-name">${f.name}</div><div class="prd-desc">${f.description}</div></div>`;
      }
    }

    if (prd.modules.length > 0) {
      html += '<div class="prd-section-label">Expected Modules</div>';
      for (const m of prd.modules) {
        html += `<div class="prd-item"><div class="prd-name">${m.name}</div></div>`;
      }
    }

    content.innerHTML = html;

    document.querySelectorAll('.details-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.details-panel').forEach((p) => p.classList.remove('active'));
    document.querySelector('.details-tab[data-target="prdPanel"]')?.classList.add('active');
    panel.classList.add('active');

    if (this.visualizer) {
      const allPlanned = [...prd.features, ...prd.modules.map((m) => ({ ...m, role: 'component' }))];
      this.visualizer.setPrdGhosts(allPlanned);
    }
  }

  // ─── Prompt Modal ───

  _showPromptModal(prompt) {
    const modal = document.getElementById('promptModal');
    const textarea = document.getElementById('promptText');
    modal.classList.remove('hidden');
    textarea.value = prompt;

    document.getElementById('btnCopyPrompt').onclick = () => {
      navigator.clipboard.writeText(prompt).then(() => {
        this._log('clipboard', 'Prompt copied to clipboard');
      });
    };
  }

  // ─── Activity Log ───

  _log(type, message) {
    const container = document.getElementById('logContainer');
    const entry = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-event">${type}</span><span class="log-path">${message}</span>`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;

    while (container.children.length > 200) {
      container.removeChild(container.firstChild);
    }
  }

  // ─── UI Event Binding ───

  _initUI() {
    document.getElementById('btnOpenProject').addEventListener('click', () => {
      const path = prompt('Enter the absolute path to your project:', localStorage.getItem('vibe-monitor-last-path') || '');
      if (path && path.trim()) {
        localStorage.setItem('vibe-monitor-last-path', path.trim());
        this._openProject(path.trim());
      }
    });

    const fallbackPath = localStorage.getItem('vibe-monitor-last-path');
    if (fallbackPath) {
      setTimeout(() => this._openProject(fallbackPath), 500);
    }

    document.getElementById('btnOpenPrd').addEventListener('click', () => {
      document.getElementById('prdFileInput').click();
    });

    document.getElementById('prdFileInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const content = await file.text();
      this._submitPrd(content);
      this._log('prd', `Loaded PRD: ${file.name}`);
    });

    document.getElementById('modalClose').addEventListener('click', () => {
      document.getElementById('promptModal').classList.add('hidden');
    });
    document.getElementById('promptModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('promptModal').classList.add('hidden');
      }
    });

    document.getElementById('btnClearLog').addEventListener('click', () => {
      document.getElementById('logContainer').innerHTML = '';
    });

    document.getElementById('btnToggleLog').addEventListener('click', () => {
      const bar = document.getElementById('logbar');
      const btn = document.getElementById('btnToggleLog');
      bar.classList.toggle('collapsed');
      btn.textContent = bar.classList.contains('collapsed') ? 'Show' : 'Hide';
    });

    document.querySelectorAll('.details-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.details-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.details-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        const target = document.getElementById(tab.dataset.target);
        if (target) target.classList.add('active');
      });
    });

    document.getElementById('treeFilter').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.tree-item').forEach((el) => {
        const match = el.textContent.toLowerCase().includes(q);
        el.style.display = match ? '' : 'none';
      });
    });
  }
}
