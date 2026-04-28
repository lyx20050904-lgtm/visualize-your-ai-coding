/**
 * D3.js Force-Directed Graph Visualizer
 *
 * Nodes = files & directories.
 * Edges = imports (solid) or containment (dashed).
 * Shapes indicate role, colors indicate status, size indicates recency.
 */
class Visualizer {
  constructor(svgId, tooltipId) {
    this.svgEl = document.getElementById(svgId);
    this.tooltipEl = document.getElementById(tooltipId);
    this.width = this.svgEl.clientWidth || 900;
    this.height = this.svgEl.clientHeight || 600;

    // D3 primitives
    this.svg = d3.select(this.svgEl);
    this.g = this.svg.append('g');
    this.simulation = null;

    // Data
    this.nodes = [];
    this.edges = [];
    this.nodeMap = {};      // id → node
    this.selectedId = null;
    this.editingIds = new Set(); // currently-being-edited file IDs
    this.editCounts = {};         // path → edit count (for heat gradient)

    // Callbacks
    this.onNodeClick = null;
    this.onNodeHover = null;

    // Status tracking for coloring
    this.modifiedTimes = {};  // id → timestamp
    this.bugReports = {};     // id → true

    // Hull rendering (F15)
    this._hullTimer = null;
    this._renderCount = 0;

    // View lens (1=全景, 2=热度)
    this.viewLevel = 1;
    this._dirColorMap = null;
    this._inDegreeCache = null;

    // Active node pulse timers (3s debounce)
    this.activeNodeTimers = {};

    // Minimap
    this._minimapNodes = null;

    // Focus mode

    this._setupMarkers();
    this._setupZoom();
    this._setupDrag();
    this._resizeObserver();
    this._setupMinimap();
    this._setupLegend();
    this._setupFocusUI();

    // Esc exits focus mode
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._deselectAll();
    });
  }

  // ─── Setup ───

  _setupZoom() {
    this.zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
        this._updateMinimapViewport(event.transform);
      });
    this.svg.call(this.zoom);
  }

  _setupDrag() {
    // Drag on the background (pan)
    this.svg.on('mousedown', (event) => {
      if (event.target === this.svgEl) {
        this._deselectAll();
      }
    });
  }

  _setupMarkers() {
    this.svg.select('defs').remove();
    const defs = this.svg.append('defs');

    // ── Arrowhead ──
    defs.append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', '10').attr('refY', '5')
      .attr('markerWidth', '6').attr('markerHeight', '6')
      .attr('orient', 'auto-start-reverse')
      .append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('fill', 'rgba(255,255,255,0.25)');

    // ── Glow filter — ambient (hover/selected) ──
    const glowAmbient = defs.append('filter')
      .attr('id', 'glow-ambient')
      .attr('x', '-60%').attr('y', '-60%')
      .attr('width', '220%').attr('height', '220%');
    glowAmbient.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', '4')
      .attr('result', 'blur');
    const ambientMerge = glowAmbient.append('feMerge');
    ambientMerge.append('feMergeNode').attr('in', 'blur');
    ambientMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // ── Import edge gradient ──
    const importGrad = defs.append('linearGradient')
      .attr('id', 'import-edge-grad')
      .attr('gradientUnits', 'userSpaceOnUse');
    importGrad.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', 'rgba(255,255,255,0.05)');
    importGrad.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', 'rgba(255,255,255,0.55)');
  }

  _resizeObserver() {
    const ro = new ResizeObserver(() => {
      this.width = this.svgEl.clientWidth;
      this.height = this.svgEl.clientHeight;
      this.svg.attr('width', this.width).attr('height', this.height);
      if (this.simulation) {
        this.simulation.alpha(0.3).restart();
      }
    });
    ro.observe(this.svgEl);
  }

  // ─── Node Style Helpers ───

  _nodeRadius(node) {
    return this._nodeDiameter(node) / 2 + 1;
  }

  _nodeColor(node) {
    // High-priority states override everything
    if (this.bugReports[node.id]) return '#d65c5c';
    if (this.editingIds.has(node.id)) return '#ff7a3d';
    if (node.prdGhost) return '#a99dd1';

    const level = this.viewLevel;

    if (level === 1) { /* 全景 — pure structure by directory */
      if (node.type === 'directory') return '#cc785c';
      return this._directoryHue(node);
    }

    if (level === 2) { /* 热度 — structure + edit heat gradient */
      if (node.type === 'directory') return '#cc785c';
      const base = d3.color(this._directoryHue(node));
      const heat = this._getEditHeat(node.id);
      if (heat > 0 && base) {
        base.l = Math.min(72, base.l + heat * 28);
        base.s = Math.min(55, base.s + heat * 15);
        return base.toString();
      }
      return base ? base.toString() : '#6c6a64';
    }

    return '#6c6a64';
  }

  _nodeShape(path, node) {
    const dia = this._nodeDiameter(node);
    const size = Math.PI * (dia / 2) ** 2;
    path.attr('d', d3.symbol().type(this._nodeShapeType(node)).size(size));
  }

  /** Shape symbol based on role */
  _nodeShapeType(d) {
    if (d.type === 'directory') return d3.symbolSquare;
    if (d.prdGhost) return d3.symbolDiamond;
    if (d.role === 'service') return d3.symbolDiamond;
    if (d.role === 'config') return d3.symbolTriangle;
    if (d.role === 'test') return d3.symbolCross;
    return d3.symbolCircle;
  }

  /** Visual diameter in px — driven by lens + node state */
  _nodeDiameter(d) {
    // Editing/selected always override
    if (this.editingIds.has(d.id)) return 24;
    if (d.id === this.selectedId) return 20;

    const level = this.viewLevel;
    if (level === 1) { /* 全景 — pure structure, uniform files */
      if (d.type === 'directory') return 18;
      return 8;
    }
    if (level === 2) { /* 热度 — sized by edit heat */
      if (d.type === 'directory') return 18;
      return 6 + this._getEditHeat(d.id) * 12; // 6px (cold) → 18px (hot)
    }
    return 6;
  }

  /** Whether the node's text label is visible */
  _nodeLabelVisible(d) {
    if (this.editingIds.has(d.id)) return true;
    if (d.id === this.selectedId) return true;

    const level = this.viewLevel;
    if (level === 1) return d.type === 'directory';    /* 全景: only dir labels */
    if (level === 2) return d.type === 'directory';    /* 热度: only dir labels */
    return false;
  }

  /** Max label length in characters for this node in current lens */
  _nodeMaxLabelLen(d) {
    if (this.editingIds.has(d.id) || d.id === this.selectedId) return 30;
    if (d.type === 'directory') return 28;
    return 14;
  }

  /** Edge opacity based on lens + node state */
  _edgeOpacity(e) {
    if (e.type === 'prd-match') return 0.35;

    const src = typeof e.source === 'string' ? e.source : e.source.id;
    const tgt = typeof e.target === 'string' ? e.target : e.target.id;

    const level = this.viewLevel;
    if (level === 1 || level === 2) { /* 全景/热度: editing edges visible, rest subtle */
      if (this.editingIds.has(src) || this.editingIds.has(tgt)) return 0.4;
      if (src === this.selectedId || tgt === this.selectedId) return 0.4;
      return 0.06;
    }
    return 0.06;
  }

  /** Compute in-degree (import count targeting this node) */
  _nodeInDegree(node) {
    if (this._inDegreeCache) return this._inDegreeCache[node.id] || 0;
    this._inDegreeCache = {};
    for (const e of this.edges) {
      if (e.type !== 'import') continue;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      this._inDegreeCache[tgt] = (this._inDegreeCache[tgt] || 0) + 1;
    }
    return this._inDegreeCache[node.id] || 0;
  }

  /** Assign a deterministic hue from top-level directory name */
  _directoryHue(node) {
    const topDir = node.path.split('/')[0];
    if (!topDir) return '#6c6a64';
    if (!this._dirColorMap) {
      const palette = ['#cc785c','#e8a55a','#5db872','#7fb8d4','#d4a67a','#89bd89','#b8bcc0','#4fc3c7'];
      const dirs = [...new Set(this.nodes.map(n => n.path.split('/')[0]).filter(Boolean))].sort();
      this._dirColorMap = {};
      dirs.forEach((d, i) => { this._dirColorMap[d] = palette[i % palette.length]; });
    }
    return this._dirColorMap[topDir] || '#6c6a64';
  }

  // ─── Render ───

  render(data) {
    // Build node map
    this.nodes = data.nodes.map((n) => ({
      ...n,
      x: undefined, y: undefined, // force layout will position
    }));
    this.edges = data.edges.map((e) => ({
      source: typeof e.source === 'string' ? e.source : e.source.id,
      target: typeof e.target === 'string' ? e.target : e.target.id,
      type: e.type || 'import',
    }));

    // Rebuild node map
    this.nodeMap = {};
    for (const n of this.nodes) this.nodeMap[n.id] = n;

    this._updateGraph();
    this._hideEmptyState();
    this._scheduleHulls();
    setTimeout(() => this._updateMinimapDots(), 600);
  }

  /** Switch view lens (1=全景, 2=热度) and update all visuals without re-running force */
  setViewLevel(level) {
    this.viewLevel = level;
    this._dirColorMap = null;   // invalidate caches
    this._inDegreeCache = null;

    if (this.nodes.length === 0) return;

    // Recompute edges with correct source/target references
    const validEdges = this.edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      return this.nodeMap[src] && this.nodeMap[tgt];
    });

    const self = this;

    // Update node shapes
    this.g.selectAll('.node path')
      .transition().duration(350).ease(d3.easeCubicOut)
      .attr('fill', (d) => this._nodeColor(d))
      .each(function(d) { d3.select(this).call(self._nodeShape.bind(self), d); });

    // Update node label visibility
    this.g.selectAll('.node text')
      .transition().duration(250)
      .style('opacity', (d) => this._nodeLabelVisible(d) ? 1 : 0)
      .style('pointer-events', (d) => this._nodeLabelVisible(d) ? 'auto' : 'none')
      .text((d) => {
        const maxLen = self._nodeMaxLabelLen(d);
        return d.name.length > maxLen ? d.name.substring(0, maxLen - 1) + '…' : d.name;
      });

    // Update node editing/recent classes
    this.g.selectAll('.node')
      .classed('editing', (d) => this.editingIds.has(d.id))
      .classed('recently-modified', (d) =>
        this.modifiedTimes[d.id] && (Date.now() - this.modifiedTimes[d.id]) < 10000
      );

    // Update edge opacity
    this.g.selectAll('.link')
      .transition().duration(350)
      .attr('opacity', (d) => this._edgeOpacity(d));

    // Re-render directory hulls immediately (positions are already stable)
    this._renderHulls();

    // Update minimap
    this._updateMinimapDots();
  }

  /** Set edit counts from server broadcast and re-render heat */
  setEditCounts(counts) {
    this.editCounts = counts || {};
    this._maxEditCount = Math.max(1, ...Object.values(this.editCounts));
    if (this.nodes.length > 0) this.setViewLevel(this.viewLevel);
  }

  /** Normalized heat value 0–1 for a node based on edit count */
  _getEditHeat(nodeId) {
    return this.editCounts[nodeId] ? Math.min(this.editCounts[nodeId] / this._maxEditCount, 1) : 0;
  }

  /**
   * Incremental update — add/update/remove nodes without full re-render.
   */
  incrementalUpdate(changes) {
    let needsRebind = false;

    for (const change of changes) {
      const { type, path } = change;
      const id = path;

      if (type === 'file:added' || type === 'dir:added') {
        // In focus mode: add to data but skip re-render (exit refreshes)
        if (this.selectedId) {
          if (!this.nodeMap[id]) {
            const node = {
              id, path,
              name: path.split('/').pop(),
              type: type === 'dir:added' ? 'directory' : 'file',
              role: change.role || 'unknown',
              size: change.size || 0,
            };
            this.nodes.push(node);
            this.nodeMap[id] = node;
            this.modifiedTimes[id] = Date.now();
          }
          continue;
        }
        if (!this.nodeMap[id]) {
          const node = {
            id,
            path,
            name: path.split('/').pop(),
            type: type === 'dir:added' ? 'directory' : 'file',
            role: change.role || 'unknown',
            size: change.size || 0,
          };
          this.nodes.push(node);
          this.nodeMap[id] = node;
          this.modifiedTimes[id] = Date.now();
          needsRebind = true;
        }
      } else if (type === 'file:changed') {
        this.modifiedTimes[id] = Date.now();
        this.editingIds.delete(id);
        if (this.nodeMap[id]) {
          this._updateNodeVisuals(id);
          this._setActiveNode(id);
          this._spawnPingRing(id);
        }
      } else if (type === 'file:deleted' || type === 'dir:deleted') {
        // In focus mode: remove from data; deselect if focused node was deleted
        if (this.selectedId) {
          if (this.selectedId === id) {
            this._deselectAll();
          } else {
            this.nodes = this.nodes.filter((n) => n.id !== id);
            delete this.nodeMap[id];
          }
          continue;
        }
        this.nodes = this.nodes.filter((n) => n.id !== id);
        delete this.nodeMap[id];
        needsRebind = true;
      } else if (type === 'agent:editing-start') {
        this.editingIds.add(id);
        if (this.nodeMap[id]) this._updateNodeVisuals(id);
      } else if (type === 'agent:editing-end') {
        this.editingIds.delete(id);
        if (this.nodeMap[id]) this._updateNodeVisuals(id);
      }
    }

    if (needsRebind) {
      this._updateGraph();
      this._hideEmptyState();
      this._scheduleHulls();
    }
  }

  /**
   * Merge human-readable descriptions into existing node data without re-render.
   * Used by F13 semantic mapping layer.
   */
  setHumanDescriptions(descriptions) {
    for (const node of this.nodes) {
      if (descriptions[node.path]) {
        node.description = descriptions[node.path];
      }
    }
  }

  /**
   * Add PRD ghost nodes (planned features not yet in code).
   */
  setPrdGhosts(prdFeatures) {
    // Remove existing ghosts
    this.nodes = this.nodes.filter((n) => !n.prdGhost);
    for (const id of Object.keys(this.nodeMap)) {
      if (this.nodeMap[id].prdGhost) delete this.nodeMap[id];
    }

    for (const feat of prdFeatures) {
      const id = `prd:${feat.name}`;
      if (!this.nodeMap[id]) {
        const node = {
          id,
          path: feat.name,
          name: feat.name,
          type: 'file',
          role: feat.role || 'component',
          prdGhost: true,
          description: feat.description,
        };
        this.nodes.push(node);
        this.nodeMap[id] = node;
      }
    }

    // Note: PRD ghost edges (prd-match) intentionally omitted per redesign spec.
    // PRD alignment is now handled by LLM text analysis, not visual edges.
    this._updateGraph();
  }

  clearPrdGhosts() {
    this.nodes = this.nodes.filter((n) => !n.prdGhost);
    this.edges = this.edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      return !src.startsWith('prd:') && !tgt.startsWith('prd:');
    });
    for (const id of Object.keys(this.nodeMap)) {
      if (this.nodeMap[id].prdGhost) delete this.nodeMap[id];
    }
    this._updateGraph();
  }

  markBug(nodeId) {
    this.bugReports[nodeId] = true;
    this._updateNodeFill(nodeId);
  }

  clearBug(nodeId) {
    delete this.bugReports[nodeId];
    this._updateNodeFill(nodeId);
  }

  /** Update node color, shape, and CSS class — no simulation re-heat */
  _updateNodeVisuals(nodeId) {
    const self = this;
    this.g.selectAll('.node').filter((d) => d.id === nodeId).each(function(d) {
      const el = d3.select(this);
      const path = el.select('path');

      // Update color
      path.transition().duration(200)
        .attr('fill', self._nodeColor(d));

      // Update shape (size may change with heat / editing state)
      path.each(function() { d3.select(this).call(self._nodeShape.bind(self), d); });

      // Update glow filter
      path.attr('filter', () => {
        if (d.id === self.selectedId) return 'url(#glow-ambient)';
        return null;
      });

      // Update editing CSS class (triggers pulse animation)
      el.classed('editing', self.editingIds.has(d.id));
    });
  }

  _updateNodeFill(nodeId) {
    const self = this;
    this.g.selectAll('.node').filter((d) => d.id === nodeId).select('path')
      .transition().duration(200)
      .attr('fill', (d) => this._nodeColor(d))
      .attr('filter', (d) => {
        if (d.id === this.selectedId) return 'url(#glow-ambient)';
        return null;
      });
  }

  selectNode(nodeId) {
    if (this.selectedId === nodeId) return;
    if (!this.nodeMap[nodeId]) return;

    this.selectedId = nodeId;

    // Visibility-only focus: keep all nodes in place, fade non-neighbors
    this._setFocusVisibility(nodeId);

    // Stop simulation — freeze positions during focus
    if (this.simulation) this.simulation.stop();

    // Smooth zoom to center
    this._zoomToNode(nodeId);

    // Show focus exit button
    this._showFocusUI();

    // Update highlights (selected glow, connected stroke)
    this._updateGraphHighlight();

    // Notify callback
    if (this.onNodeClick && this.nodeMap[nodeId]) {
      this.onNodeClick(this.nodeMap[nodeId]);
    }
  }

  // ─── Module Aggregation Hulls (F15) ───

  _hullGroupNames = {
    'client': '用户界面',
    'server': '后端服务',
    'src': '核心源码',
    'docs': '项目文档',
    'public': '静态资源',
    'components': '组件库',
    'pages': '功能页面',
    'services': '数据服务',
    'utils': '工具集',
    'api': '接口层',
    'models': '数据模型',
    'styles': '样式库',
    'config': '配置项',
    'tests': '测试套件',
    'hooks': '钩子函数',
  };

  _scheduleHulls() {
    const currentRender = ++this._renderCount;
    clearTimeout(this._hullTimer);
    // Wait 2.5s for simulation to stabilize, then compute hulls
    this._hullTimer = setTimeout(() => {
      if (currentRender !== this._renderCount) return; // stale
      this._renderHulls();
    }, 2500);
  }

  _computeHulls() {
    // Compute bounding box per top-level directory with padding
    const groups = {};
    for (const node of this.nodes) {
      if (node.prdGhost || node.x === undefined) continue;
      const topDir = node.path.split('/')[0];
      if (!groups[topDir]) groups[topDir] = [];
      groups[topDir].push(node);
    }

    const PAD = 24;
    const hulls = [];
    for (const [name, nodes] of Object.entries(groups)) {
      if (nodes.length < 2) continue;
      const xs = nodes.map(n => n.x);
      const ys = nodes.map(n => n.y);
      hulls.push({
        name,
        label: this._hullGroupNames[name] || name,
        cx: (Math.min(...xs) + Math.max(...xs)) / 2,
        cy: (Math.min(...ys) + Math.max(...ys)) / 2,
        x0: Math.min(...xs) - PAD,
        y0: Math.min(...ys) - PAD,
        x1: Math.max(...xs) + PAD,
        y1: Math.max(...ys) + PAD,
      });
    }

    // Sort by size (largest first) — smaller ones draw on top
    hulls.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));

    // Simple overlap resolution: push overlapping boxes apart
    for (let iter = 0; iter < 8; iter++) {
      let moved = false;
      for (let i = 0; i < hulls.length; i++) {
        for (let j = i + 1; j < hulls.length; j++) {
          const a = hulls[i], b = hulls[j];
          const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (overlapX > 0 && overlapY > 0) {
            const dx = a.cx - b.cx;
            const dy = a.cy - b.cy;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            // Push smaller one away
            const pushX = overlapX * 0.3 * Math.abs(dx) / dist;
            const pushY = overlapY * 0.3 * Math.abs(dy) / dist;
            if (hulls.indexOf(a) < hulls.indexOf(b)) { // larger pushes smaller
              b.x0 -= pushX; b.x1 -= pushX; b.cx -= pushX;
              b.y0 -= pushY; b.y1 -= pushY; b.cy -= pushY;
            }
            moved = true;
          }
        }
      }
      if (!moved) break;
    }

    return hulls;
  }

  _renderHulls() {
    this.g.selectAll('.hull-group').remove();

    // Always show hulls
    const hulls = this._computeHulls();
    if (hulls.length === 0) return;

    const palette = ['#cc785c','#e8a55a','#5db872','#7fb8d4','#d4a67a','#89bd89','#b8bcc0','#4fc3c7'];
    const dirNames = [...new Set(hulls.map(h => h.name))].sort();
    const dirColor = {};
    dirNames.forEach((d, i) => { dirColor[d] = palette[i % palette.length]; });

    const group = this.g.insert('g', ':first-child').attr('class', 'hull-group');

    for (const h of hulls) {
      const color = dirColor[h.name] || '#cc785c';
      const c = d3.color(color);
      const w = h.x1 - h.x0;
      const r = 8; // corner radius

      // Rounded rectangle
      const path = [
        `M${h.x0 + r},${h.y0}`,
        `L${h.x1 - r},${h.y0}`,
        `Q${h.x1},${h.y0} ${h.x1},${h.y0 + r}`,
        `L${h.x1},${h.y1 - r}`,
        `Q${h.x1},${h.y1} ${h.x1 - r},${h.y1}`,
        `L${h.x0 + r},${h.y1}`,
        `Q${h.x0},${h.y1} ${h.x0},${h.y1 - r}`,
        `L${h.x0},${h.y0 + r}`,
        `Q${h.x0},${h.y0} ${h.x0 + r},${h.y0}`,
        'Z',
      ].join(' ');

      group.append('path')
        .attr('d', path)
        .attr('fill', c.copy({opacity: 0.06}))
        .attr('stroke', c.copy({opacity: 0.2}))
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,3')
        .attr('stroke-linejoin', 'round');

      // Label
      group.append('text')
        .attr('x', h.cx)
        .attr('y', h.y0 - 6)
        .attr('text-anchor', 'middle')
        .attr('fill', c.copy({opacity: 0.4}))
        .attr('font-family', 'var(--font-sans)')
        .attr('font-size', '10px')
        .attr('font-weight', '600')
        .attr('letter-spacing', '0.8px')
        .text(h.label);
    }
  }

  // ─── Legend ───

  _setupLegend() {
    this._legendEl = d3.select('#canvas')
      .append('div')
      .attr('class', 'graph-legend')
      .style('position', 'absolute')
      .style('bottom', '8px')
      .style('left', '8px')
      .style('display', 'flex')
      .style('flex-direction', 'column')
      .style('gap', '4px')
      .style('padding', '8px 12px')
      .style('border-radius', '6px')
      .style('background', 'rgba(24,23,21,0.8)')
      .style('backdrop-filter', 'blur(4px)')
      .style('border', '1px solid rgba(255,255,255,0.08)')
      .style('font-size', '11px')
      .style('color', 'var(--muted)')
      .style('pointer-events', 'none')
      .style('z-index', '9')
      .html(`
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="28" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/><polygon points="22,5 18,2 18,8" fill="rgba(255,255,255,0.3)"/></svg>
          <span>Import dependency</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="28" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="rgba(167,139,250,0.4)" stroke-width="1.5" stroke-dasharray="4,3"/></svg>
          <span>PRD planned match</span>
        </div>
      `);
  }

  // ─── Minimap ───

  _setupMinimap() {
    this._minimapW = 160;
    this._minimapH = 110;

    this._minimapEl = d3.select('#canvas')
      .append('div')
      .attr('class', 'minimap')
      .style('position', 'absolute')
      .style('bottom', '8px')
      .style('right', '8px')
      .style('width', this._minimapW + 'px')
      .style('height', this._minimapH + 'px')
      .style('border-radius', '6px')
      .style('overflow', 'hidden')
      .style('background', 'rgba(24,23,21,0.8)')
      .style('backdrop-filter', 'blur(4px)')
      .style('border', '1px solid rgba(255,255,255,0.08)')
      .style('box-shadow', '0 4px 20px rgba(0,0,0,0.4)')
      .style('cursor', 'crosshair')
      .style('z-index', '10')
      .style('pointer-events', 'all');

    this._minimapSvg = this._minimapEl.append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .style('display', 'block');

    this._minimapDots = this._minimapSvg.append('g');
    this._minimapViewport = this._minimapSvg.append('rect')
      .attr('fill', 'rgba(204,120,92,0.08)')
      .attr('stroke', 'rgba(204,120,92,0.5)')
      .attr('stroke-width', 1)
      .attr('rx', 2)
      .attr('ry', 2);

    // Click / drag to navigate
    const drag = d3.drag()
      .on('drag', (event) => {
        const [x, y] = d3.pointer(event, this._minimapSvg.node());
        this._minimapPan(x, y);
      })
      .on('end', (event) => {
        const [x, y] = d3.pointer(event, this._minimapSvg.node());
        this._minimapPan(x, y);
      });
    this._minimapSvg.call(drag);
    this._minimapSvg.on('click', (event) => {
      const [x, y] = d3.pointer(event);
      this._minimapPan(x, y);
    });
  }

  _minimapPan(x, y) {
    if (!this._minimapBounds) return;
    const { minX, minY, gw, gh } = this._minimapBounds;
    const pad = 8;
    const s = Math.min((this._minimapW - pad * 2) / gw, (this._minimapH - pad * 2) / gh);
    const ox = (this._minimapW - gw * s) / 2;
    const oy = (this._minimapH - gh * s) / 2;

    // Convert minimap coords → graph coords
    const gx = minX + (x - ox) / s;
    const gy = minY + (y - oy) / s;

    // Center main view on that point
    const t = d3.zoomIdentity
      .translate(this.width / 2 - gx * 1, this.height / 2 - gy * 1);
    this.svg.transition().duration(300)
      .call(this.zoom.transform, t);
  }

  _updateMinimapDots() {
    if (!this._minimapSvg || this.nodes.length === 0) return;
    if (this.nodes.every((n) => n.x === undefined)) return;

    const xs = this.nodes.map((n) => n.x || 0);
    const ys = this.nodes.map((n) => n.y || 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const gw = Math.max(maxX - minX, 100);
    const gh = Math.max(maxY - minY, 100);

    this._minimapBounds = { minX, minY, gw, gh };

    const pad = 8;
    const s = Math.min((this._minimapW - pad * 2) / gw, (this._minimapH - pad * 2) / gh);
    const ox = (this._minimapW - gw * s) / 2;
    const oy = (this._minimapH - gh * s) / 2;

    // Data-join dots
    const dots = this._minimapDots.selectAll('circle')
      .data(this.nodes, (d) => d.id);

    dots.exit().remove();

    dots.enter().append('circle')
      .merge(dots)
      .attr('cx', (d) => (d.x - minX) * s + ox)
      .attr('cy', (d) => (d.y - minY) * s + oy)
      .attr('r', 1.8)
      .attr('fill', (d) => {
        if (this.selectedId === d.id) return '#cc785c';
        if (this.bugReports[d.id]) return '#f87171';
        if (d.prdGhost) return '#a78bfa';
        if (this.editingIds.has(d.id)) return '#ff7a3d';
        return this._nodeColor(d);
      });

    // Viewport sync
    const tr = d3.zoomTransform(this.svgEl);
    this._updateMinimapViewport(tr, s, ox, oy, minX, minY, gw, gh);
  }

  _updateMinimapViewport(transform, s, ox, oy, minX, minY, gw, gh) {
    if (!this._minimapSvg) return;
    if (!this._minimapBounds) {
      // First call — compute pending
      if (!s) return this._updateMinimapDots();
      return;
    }

    const b = this._minimapBounds;
    s = s || Math.min((this._minimapW - 16) / b.gw, (this._minimapH - 16) / b.gh);
    ox = ox || (this._minimapW - b.gw * s) / 2;
    oy = oy || (this._minimapH - b.gh * s) / 2;
    minX = minX ?? b.minX;
    minY = minY ?? b.minY;

    const tr = transform || d3.zoomTransform(this.svgEl);
    const vl = -tr.x / tr.k;
    const vt = -tr.y / tr.k;
    const vw = this.width / tr.k;
    const vh = this.height / tr.k;

    this._minimapViewport
      .attr('x', Math.max(0, (vl - minX) * s + ox))
      .attr('y', Math.max(0, (vt - minY) * s + oy))
      .attr('width', Math.min(this._minimapW, vw * s))
      .attr('height', Math.min(this._minimapH, vh * s));
  }

  // ─── Internal Graph Update ───

  _updateGraph() {
    const self = this;

    // Filter edges to only include those between known nodes
    const validEdges = this.edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      return this.nodeMap[src] && this.nodeMap[tgt];
    });

    // Separate layout edges from visual edges:
    // 'contains' edges are layout-only (keep files near parent dirs), never rendered
    const renderEdges = validEdges.filter((e) => e.type !== 'contains');

    // Invalidate caches for level-aware sizing/coloring
    this._inDegreeCache = null;
    this._dirColorMap = null;

    // Adaptive force parameters based on graph size
    const n = this.nodes.length;
    const chargeStrength = n > 100 ? -Math.round(24000 / n) : -800;
    const linkDist = n > 100 ? 80 : 150;
    const collideRadius = n > 100 ? 12 : 30;
    const alphaDecay = Math.min(0.05, 0.01 + n / 8000);

    // Simulation
    if (!this.simulation) {
      this.simulation = d3.forceSimulation(this.nodes)
        .force('link', d3.forceLink(validEdges).id((d) => d.id).distance(linkDist))
        .force('charge', d3.forceManyBody().strength(chargeStrength))
        .force('center', d3.forceCenter(this.width / 2, this.height / 2))
        .force('collision', d3.forceCollide(collideRadius))
        .alphaDecay(alphaDecay)
        .velocityDecay(0.3);
    } else {
      this.simulation.nodes(this.nodes);
      this.simulation.force('link').links(validEdges);
      // Gentle re-heat — low alpha avoids violent rearrangement
      this.simulation.alpha(0.1).restart();
    }

    // ─── Edges (only import & prd-match — contains is layout-only) ───
    const link = this.g.selectAll('.link')
      .data(renderEdges, (d) => `${d.source.id||d.source}:${d.target.id||d.target}`);

    link.exit()
      .transition().duration(250)
      .attr('opacity', 0)
      .remove();

    const linkEnter = link.enter().append('path')
      .attr('class', 'link')
      .attr('d', 'M0,0L0,0')
      .attr('stroke', (d) => {
        if (d.type === 'prd-match') return 'rgba(167,139,250,0.4)';
        return 'url(#import-edge-grad)';
      })
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d) => d.type === 'prd-match' ? '5,5' : null)
      .attr('marker-end', (d) => d.type === 'import' ? 'url(#arrowhead)' : null)
      .attr('fill', 'none')
      .attr('opacity', (d) => this._edgeOpacity(d))
      .style('pointer-events', 'auto');

    // Merge existing edges to update opacity (for subsequent _updateGraph calls)
    link.merge(linkEnter)
      .transition().duration(300)
      .attr('opacity', (d) => this._edgeOpacity(d));

    // ─── Nodes ───
    const node = this.g.selectAll('.node')
      .data(this.nodes, (d) => d.id);

    node.exit()
      .transition().duration(300)
      .attr('opacity', 0)
      .attr('transform', (d) => `translate(${d.x},${d.y}) scale(0)`)
      .remove();

    const nodeEnter = node.enter().append('g')
      .attr('class', 'node node-enter');

    // Selection halo ring (hidden by default)
    nodeEnter.append('circle')
      .attr('class', 'halo')
      .attr('r', 16)
      .attr('fill', 'none')
      .attr('stroke', '#cc785c')
      .attr('stroke-width', 2.5)
      .attr('opacity', 0);

    // Shape
    nodeEnter.append('path')
      .attr('fill', (d) => this._nodeColor(d))
      .attr('stroke', '#181715')
      .each(function (d) { d3.select(this).call(self._nodeShape.bind(self), d); });

    // Label
    nodeEnter.append('text')
      .attr('dx', 14)
      .attr('dy', 4)
      .style('opacity', (d) => this._nodeLabelVisible(d) ? 1 : 0)
      .style('pointer-events', (d) => this._nodeLabelVisible(d) ? 'auto' : 'none')
      .text((d) => {
        const maxLen = this._nodeMaxLabelLen(d);
        return d.name.length > maxLen ? d.name.substring(0, maxLen - 1) + '…' : d.name;
      });

    // Merge & update all nodes
    const nodeMerge = node.merge(nodeEnter);

    nodeMerge.select('path')
      .transition().duration(300)
      .attr('fill', (d) => this._nodeColor(d))
      .each(function (d) { d3.select(this).call(self._nodeShape.bind(self), d); });

    nodeMerge.select('text')
      .style('opacity', (d) => this._nodeLabelVisible(d) ? 1 : 0)
      .style('pointer-events', (d) => this._nodeLabelVisible(d) ? 'auto' : 'none')
      .text((d) => {
        const maxLen = this._nodeMaxLabelLen(d);
        return d.name.length > maxLen ? d.name.substring(0, maxLen - 1) + '…' : d.name;
      });

    // Editing class
    nodeMerge.classed('editing', (d) => this.editingIds.has(d.id));
    // Continuous pulse for recently modified (within 10s)
    nodeMerge.classed('recently-modified', (d) =>
      this.modifiedTimes[d.id] && (Date.now() - this.modifiedTimes[d.id]) < 10000
    );

    nodeMerge.select('path')
      .attr('filter', (d) => {
        if (d.id === this.selectedId) return 'url(#glow-ambient)';
        return null;
      });

    // Interactions
    nodeMerge.on('mouseenter', (event, d) => {
      this._showTooltip(event, d);
      this._hoverFocus(d.id);
    });
    nodeMerge.on('mouseleave', () => {
      this._hideTooltip();
      this._hoverUnfocus();
    });
    nodeMerge.on('click', (event, d) => {
      event.stopPropagation();
      this.selectNode(d.id);
    });
    nodeMerge.on('contextmenu', (event, d) => {
      event.preventDefault();
      if (this.onNodeClick) this.onNodeClick(d);
    });

    // Simulation tick
    const tickMinimap = () => {
      linkEnter.merge(this.g.selectAll('.link'))
        .attr('d', (d) => {
          const dx = d.target.x - d.source.x;
          const dy = d.target.y - d.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const r1 = self._nodeRadius(d.source) + 2;
          const r2 = self._nodeRadius(d.target) + 2;
          const x1 = d.source.x + dx * r1 / dist;
          const y1 = d.source.y + dy * r1 / dist;
          const x2 = d.target.x - dx * r2 / dist;
          const y2 = d.target.y - dy * r2 / dist;
          const offset = Math.min(dist * 0.12, 20);
          const cx = (x1 + x2) / 2 + (dy / dist) * offset;
          const cy = (y1 + y2) / 2 - (dx / dist) * offset;
          return `M${x1},${y1}Q${cx},${cy} ${x2},${y2}`;
        });

      nodeMerge.attr('transform', (d) => `translate(${d.x},${d.y})`);

      if (++this._gradTick % 4 === 0) {
        const sampleEdge = validEdges.find(e => e.type === 'import' && e.source.x !== undefined);
        if (sampleEdge) {
          this.svg.select('#import-edge-grad')
            .attr('x1', sampleEdge.source.x).attr('y1', sampleEdge.source.y)
            .attr('x2', sampleEdge.target.x).attr('y2', sampleEdge.target.y);
        }
      }

      if (++this._minimapTick % 8 === 0) this._updateMinimapDots();
    };

    this.simulation.on('tick', tickMinimap);
    this._minimapTick = 0;
    this._gradTick = 0;

    this._updateGraphHighlight();
  }

  _updateGraphHighlight() {
    if (!this.g) return;

    const sid = this.selectedId;

    // Update nodes
    this.g.selectAll('.node').each((d, i, nodes) => {
      const el = d3.select(nodes[i]);
      const isSelected = d.id === sid;
      const isConnected = sid && this.edges.some((e) => {
        const src = typeof e.source === 'string' ? e.source : (e.source.id || e.source);
        const tgt = typeof e.target === 'string' ? e.target : (e.target.id || e.target);
        return (src === sid && tgt === d.id) || (tgt === sid && src === d.id);
      });

      // CSS classes for glow effects
      el.classed('node-selected', isSelected);
      el.classed('node-connected', isConnected && !isSelected);

      // Halo ring — animated expand + fade
      const halo = el.select('.halo');
      halo.transition().duration(400)
        .attr('r', isSelected ? 22 : 16)
        .attr('opacity', isSelected ? 0.7 : 0)
        .attr('stroke-width', isSelected ? 3 : 2.5);

      // Node path styling
      el.select('path')
        .attr('stroke', isSelected ? '#cc785c' : isConnected ? 'rgba(204,120,92,0.4)' : '#252320')
        .attr('stroke-width', isSelected ? 3 : isConnected ? 2.5 : 1.5);

      // Label
      el.select('text')
        .attr('fill', isSelected ? '#cc785c' : isConnected ? '#faf9f5' : '#a09d96')
        .attr('font-weight', isSelected ? '600' : isConnected ? '500' : '400');
    });

    // Highlight connected edges
    this.g.selectAll('.link')
      .transition().duration(300)
      .attr('stroke', (d) => {
        const src = typeof d.source === 'string' ? d.source : d.source.id;
        const tgt = typeof d.target === 'string' ? d.target : d.target.id;
        if (src === sid || tgt === sid) return 'rgba(204,120,92,0.7)';
        return d.type === 'prd-match' ? 'rgba(167, 139, 250, 0.35)' : 'rgba(255,255,255,0.2)';
      })
      .attr('stroke-width', (d) => {
        const src = typeof d.source === 'string' ? d.source : d.source.id;
        const tgt = typeof d.target === 'string' ? d.target : d.target.id;
        return src === sid || tgt === sid ? 2.5 : 1.5;
      })
      .attr('opacity', (d) => {
        const src = typeof d.source === 'string' ? d.source : d.source.id;
        const tgt = typeof d.target === 'string' ? d.target : d.target.id;
        if (src === sid || tgt === sid) return 0.8;
        return this._edgeOpacity(d);
      });
  }

  // ─── Interactions ───

  /** Hover focus: dim everything except connected nodes/links */
  _hoverFocus(nodeId) {
    if (this.selectedId) return; // no hover dimming during focus mode
    if (this._hoverId === nodeId) return; // already focused
    this._hoverId = nodeId;

    // Collect directly connected node IDs
    const connected = new Set([nodeId]);
    for (const e of this.edges) {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      if (src === nodeId || tgt === nodeId) {
        connected.add(src);
        connected.add(tgt);
      }
    }

    // Dim unconnected nodes
    this.g.selectAll('.node').each(function (d) {
      const el = d3.select(this);
      const keep = connected.has(d.id);
      el.select('path').attr('opacity', keep ? 1 : 0.1);
      el.select('text').attr('opacity', keep ? 1 : 0.1);
    });

    // Dim unconnected links
    this.g.selectAll('.link').each(function (d) {
      const src = typeof d.source === 'string' ? d.source : d.source.id;
      const tgt = typeof d.target === 'string' ? d.target : d.target.id;
      const keep = src === nodeId || tgt === nodeId;
      d3.select(this).attr('opacity', keep ? 1 : 0.1);
    });
  }

  /** Restore default opacity after hover */
  _hoverUnfocus() {
    if (this.selectedId) return; // focus mode manages its own visibility
    this._hoverId = null;
    this.g.selectAll('.node').each(function () {
      d3.select(this).select('path').attr('opacity', 1);
      d3.select(this).select('text').attr('opacity', 1);
    });
    this.g.selectAll('.link')
      .attr('opacity', (d) => this._edgeOpacity(d));
  }

  /** Activate breathing pulse on a node with 3s debounce */
  _setActiveNode(id) {
    // Clear existing timer for this node
    if (this.activeNodeTimers[id]) {
      clearTimeout(this.activeNodeTimers[id]);
    }
    // Add pulse class
    this.g.selectAll('.node').filter((d) => d.id === id)
      .classed('active-node', true);
    // Auto-remove after 3s of inactivity
    this.activeNodeTimers[id] = setTimeout(() => {
      this.g.selectAll('.node').filter((d) => d.id === id)
        .classed('active-node', false);
      delete this.activeNodeTimers[id];
    }, 3000);
  }

  _spawnPingRing(nodeId) {
    const node = this.nodeMap[nodeId];
    if (!node || node.x === undefined) return;
    const ring = this.g.append('circle')
      .attr('class', 'ping-ring')
      .attr('cx', node.x)
      .attr('cy', node.y)
      .attr('r', 10)
      .attr('fill', 'none')
      .attr('stroke', '#ff7a3d')
      .attr('stroke-width', 2)
      .attr('opacity', 0.9)
      .attr('pointer-events', 'none');
    ring.transition()
      .duration(700)
      .ease(d3.easeCubicOut)
      .attr('r', 40)
      .attr('opacity', 0)
      .attr('stroke-width', 0.5)
      .remove();
  }

  _showTooltip(event, d) {
    const rect = this.svgEl.getBoundingClientRect();
    const roleLabel = d.prdGhost ? 'planned' : (d.role || 'unknown');
    const status = this.bugReports[d.id] ? 'Bug' :
      this.editingIds.has(d.id) ? 'Editing' :
      this.modifiedTimes[d.id] ? 'Modified' : '';
    this.tooltipEl.innerHTML = `
      <div class="tt-path">${d.id}</div>
      <span class="tt-role">${roleLabel}</span>
      ${status ? `<span class="tt-role tt-status" style="color:var(--amber)">${status}</span>` : ''}
      ${d.description ? `<div class="tt-desc">${d.description}</div>` : ''}
    `;
    this.tooltipEl.classList.remove('hidden');
    this.tooltipEl.style.left = '12px';
    this.tooltipEl.style.top = '12px';
  }

  _hideTooltip() {
    this.tooltipEl.classList.add('hidden');
  }

  _deselectAll() {
    if (!this.selectedId) return;

    const prevId = this.selectedId;
    this.selectedId = null;
    this._hideFocusUI();

    // Restore all nodes/links to full visibility
    this._removeFocusVisibility();

    // Full re-render to catch any files added/changed/deleted during focus
    this._updateGraph();

    // Reset zoom to full view
    this._resetZoom();

    if (this.onDeselect) this.onDeselect(prevId);
  }

  // ─── Focus Mode (visibility + auto-zoom) ───

  /** Show only the selected node and its direct neighbors, fade everything else */
  _setFocusVisibility(nodeId) {
    // Collect 1-hop neighbors
    const connectedIds = new Set([nodeId]);
    for (const e of this.edges) {
      const src = typeof e.source === 'string' ? e.source : e.source.id;
      const tgt = typeof e.target === 'string' ? e.target : e.target.id;
      if (src === nodeId || tgt === nodeId) {
        connectedIds.add(src);
        connectedIds.add(tgt);
      }
    }

    // Fade non-connected nodes to 0, keep connected at full opacity
    this.g.selectAll('.node').each(function (d) {
      const el = d3.select(this);
      const visible = connectedIds.has(d.id);
      el.select('path').transition().duration(300)
        .attr('opacity', visible ? 1 : 0);
      el.select('text').transition().duration(300)
        .attr('opacity', visible ? 1 : 0);
      el.style('pointer-events', visible ? 'auto' : 'none');
    });

    // Only keep links between visible nodes
    this.g.selectAll('.link').transition().duration(300)
      .attr('opacity', (d) => {
        const src = typeof d.source === 'string' ? d.source : d.source.id;
        const tgt = typeof d.target === 'string' ? d.target : d.target.id;
        if (connectedIds.has(src) && connectedIds.has(tgt)) {
          return this._edgeOpacity(d);
        }
        return 0;
      });
  }

  /** Restore all nodes and links to full visibility after focus exit */
  _removeFocusVisibility() {
    this.g.selectAll('.node').each(function () {
      const el = d3.select(this);
      el.select('path').attr('opacity', 1);
      el.select('text').attr('opacity', 1);
      el.style('pointer-events', 'auto');
    });
    this.g.selectAll('.link')
      .attr('opacity', (d) => this._edgeOpacity(d));
  }

  _zoomToNode(nodeId) {
    const node = this.nodeMap[nodeId];
    if (!node || node.x === undefined) return;

    const scale = 1.5;
    const t = d3.zoomIdentity
      .translate(this.width / 2 - node.x * scale, this.height / 2 - node.y * scale)
      .scale(scale);

    this.svg.transition().duration(600)
      .call(this.zoom.transform, t);
  }

  _resetZoom() {
    this.svg.transition().duration(400)
      .call(this.zoom.transform, d3.zoomIdentity);
  }

  _setupFocusUI() {
    this._focusBtn = d3.select('#canvas')
      .append('div')
      .attr('class', 'focus-exit-btn')
      .style('display', 'none');
    this._focusBtn.on('click', () => this._deselectAll());
  }

  _showFocusUI() {
    if (this._focusBtn) this._focusBtn.style('display', 'flex');
  }

  _hideFocusUI() {
    if (this._focusBtn) this._focusBtn.style('display', 'none');
  }

  _hideEmptyState() {
    const el = document.getElementById('emptyState');
    if (el) el.classList.add('hidden');
  }

  destroy() {
    if (this.simulation) this.simulation.stop();
    if (this._minimapEl) this._minimapEl.remove();
  }
}
