/**
 * Vibe Guarding — D3 Force-Directed Visualizer
 *
 * Design rules:
 *   1. Simulation runs ONCE on first load, then stops. Layout is frozen.
 *   2. Node selection / view switch / heat update — zero simulation involvement.
 *   3. Drag: only heats simulation when pointer actually moves (not on click).
 *      Dragged nodes get fx/fy pinned so they stay where dropped.
 *   4. Edge paths are computed in the tick callback ONLY — never via transition
 *      (transition and tick fight each other and leave M0,0L0,0).
 *   5. FIX-01: edges always normalized to string IDs before forceLink.links().
 *   6. SVG overflow visible so feGaussianBlur glow is never clipped.
 */
class Visualizer {
  constructor(svgId, tooltipId) {
    this.svgEl     = document.getElementById(svgId);
    this.tooltipEl = document.getElementById(tooltipId);
    this.width     = this.svgEl.clientWidth  || 900;
    this.height    = this.svgEl.clientHeight || 600;

    this.pad = 60;
    this.svg = d3.select(this.svgEl)
      .attr('viewBox', `${-this.pad} ${-this.pad} ${this.width + this.pad * 2} ${this.height + this.pad * 2}`)
      .style('overflow', 'visible');
    this.g   = this.svg.append('g').attr('class', 'graph-root');

    this.simulation = null;

    this.nodes   = [];
    this.edges   = [];
    this.nodeMap = {};

    this.selectedId     = null;
    this.editingIds     = new Set();
    this.editCounts     = {};
    this._maxCount      = 1;
    this.descriptions   = {};

    this._nodeSel = null;
    this._linkSel = null;
    this._minimapTick = 0;

    this.onNodeClick = null;
    this.onDeselect  = null;

    // F06: 30s heat refresh cycle — bulk DOM update, not per-event
    this._heatDirty = false;
    this._heatTimer = setInterval(() => this._flushHeat(), 30000);

    this._setupDefs();
    this._setupZoom();
    this._setupMinimap();
    this._resizeObserver();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.selectedId) this._deselect();
    });
  }

  // ─── SVG Defs ───

  _setupDefs() {
    this.svg.select('defs').remove();
    const defs = this.svg.append('defs');

    // Arrowhead
    defs.append('marker')
      .attr('id', 'vg-arrow')
      .attr('viewBox', '0 0 8 8')
      .attr('refX', '7').attr('refY', '4')
      .attr('markerWidth', '5').attr('markerHeight', '5')
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,0 L8,4 L0,8 Z')
      .attr('fill', 'rgba(255,107,53,0.6)');

    // Layer 1 — real-time editing glow (intense)
    const ef = defs.append('filter').attr('id', 'glow-editing')
      .attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
    ef.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '7').attr('result', 'b');
    const em = ef.append('feMerge');
    em.append('feMergeNode').attr('in', 'b');
    em.append('feMergeNode').attr('in', 'b');
    em.append('feMergeNode').attr('in', 'SourceGraphic');

    // Layer 2 — heatmap glow tiers
    [
      ['glow-heat-1', 3],
      ['glow-heat-2', 5],
      ['glow-heat-3', 8],
      ['glow-heat-4', 11],
      ['glow-heat-5', 14],
    ].forEach(([id, std]) => {
      const f = defs.append('filter').attr('id', id)
        .attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
      f.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', std).attr('result', 'b');
      const m = f.append('feMerge');
      m.append('feMergeNode').attr('in', 'b');
      m.append('feMergeNode').attr('in', 'SourceGraphic');
    });

    // Selection glow
    const sf = defs.append('filter').attr('id', 'glow-sel')
      .attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
    sf.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '5').attr('result', 'b');
    const sm = sf.append('feMerge');
    sm.append('feMergeNode').attr('in', 'b');
    sm.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  // ─── Zoom ───

  _setupZoom() {
    this.zoom = d3.zoom().scaleExtent([0.05, 5])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
        this._updateMinimapViewport(event.transform);
      });
    this.svg.call(this.zoom);
    // viewBox handles coordinate padding — no initial zoom offset needed
    this.svg.on('click', (event) => {
      if (event.target === this.svgEl) this._deselect();
    });
  }

  _resizeObserver() {
    new ResizeObserver(() => {
      this.width  = this.svgEl.clientWidth;
      this.height = this.svgEl.clientHeight;
    }).observe(this.svgEl);
  }

  // ─── Node helpers ───

  _nodeR(d) {
    return d.type === 'directory' ? 10 : 6;
  }

  _roleColor(role) {
    return {
      component:  '#60a5fa',
      route:      '#a78bfa',
      service:    '#4ade80',
      config:     '#fb923c',
      style:      '#f472b6',
      test:       '#34d399',
      type:       '#fbbf24',
      util:       '#9ca3af',
      middleware: '#818cf8',
      data:       '#2dd4bf',
      doc:        '#c4b5fd',
      script:     '#fdba74',
    }[role] || '#6b7280';
  }

  _nodeColor(d) {
    if (this.editingIds.has(d.id)) return '#FF6B35';
    if (d.type === 'directory')    return '#fb923c';
    return this._roleColor(d.role);
  }

  _nodeHeatColor(d) {
    const base  = this._nodeColor(d);
    if (this.editingIds.has(d.id)) return base;
    const count = this.editCounts[d.path] || 0;
    if (!count) return base;
    const t = Math.min(count / this._maxCount, 1);
    return d3.interpolateRgb(base, '#fb923c')(t * 0.55);
  }

  _heatFilter(d) {
    if (this.editingIds.has(d.id)) return 'url(#glow-editing)';
    if (d.id === this.selectedId)  return 'url(#glow-sel)';
    const c = this.editCounts[d.path] || 0;
    if (!c)   return null;
    if (c <= 2)  return 'url(#glow-heat-1)';
    if (c <= 5)  return 'url(#glow-heat-2)';
    if (c <= 10) return 'url(#glow-heat-3)';
    if (c <= 20) return 'url(#glow-heat-4)';
    return 'url(#glow-heat-5)';
  }

  // ─── Public API ───

  setDescriptions(desc) { this.descriptions = desc || {}; }

  setEditCounts(counts) {
    this.editCounts = counts || {};
    this._maxCount  = Math.max(1, ...Object.values(this.editCounts));
    this._heatDirty = true;
  }

  // F06: bulk heat refresh every 30s — reduces DOM churn
  _flushHeat() {
    if (!this._heatDirty) return;
    this._heatDirty = false;
    this._refreshNodeColors();
  }

  // ─── Full Render (called once per project open) ───

  render(data) {
    const incomingIds = new Set((data.nodes || []).map((n) => n.id));
    const isFirst     = this.nodes.length === 0;

    // Reuse existing live node objects — do NOT create new objects.
    // New objects break D3's internal x/y references → nodes fly on next render.
    this.nodes = this.nodes.filter((n) => incomingIds.has(n.id));
    this.nodeMap = {};
    for (const n of this.nodes) this.nodeMap[n.id] = n;

    for (const n of (data.nodes || [])) {
      if (!this.nodeMap[n.id]) {
        const obj = { ...n };
        this.nodes.push(obj);
        this.nodeMap[n.id] = obj;
      } else {
        // Merge metadata without touching x/y/vx/vy
        Object.assign(this.nodeMap[n.id], { name: n.name, role: n.role, size: n.size, type: n.type });
      }
    }

    // FIX-01: always store edges as string IDs
    this.edges = (data.edges || []).map((e) => ({
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target,
      type:   e.type || 'import',
    })).filter((e) => this.nodeMap[e.source] && this.nodeMap[e.target]);

    // Pre-distribute nodes around center to prevent violent initial burst
    for (const node of this.nodes) {
      if (node.x == null || node.y == null) {
        node.x = (Math.random() - 0.5) * this.width * 0.3;
        node.y = (Math.random() - 0.5) * this.height * 0.3;
      }
    }

    this._buildSimulation(isFirst);
    this._bindDOM();

    document.getElementById('emptyState')?.classList.add('hidden');
  }

  // ─── Incremental update (file add/delete/edit) ───

  incrementalUpdate(changes) {
    let structural = false;

    for (const { type, path } of changes) {
      const id = path;

      if (type === 'agent:editing-start') {
        this.editingIds.add(id);
        this._refreshNodeColors(id);
        // F14: add breathing ring class
        const g = this._nodeSel ? this._nodeSel.filter((d) => d.id === id) : null;
        if (g) g.classed('editing', true);

      } else if (type === 'agent:editing-end') {
        this.editingIds.delete(id);
        // D3 transition: smooth 500ms ease-out from #FF6B35 to normal color
        // No setTimeout — D3 handles interpolation frame-by-frame
        const sel = this._nodeSel ? this._nodeSel.filter((d) => d.id === id) : null;
        if (sel) {
          // F14: remove breathing ring class after transition completes
          setTimeout(() => { sel.classed('editing', false); }, 500);
          sel.select('.node-body')
            .interrupt()
            .transition().duration(500).ease(d3.easeCubicOut)
            .attr('fill', (d) => this._nodeHeatColor(d));
          sel.select('.heat-ring')
            .interrupt()
            .transition().duration(500).ease(d3.easeCubicOut)
            .attr('fill', (d) => this._nodeHeatColor(d))
            .attr('opacity', (d) => (this.editCounts[d.path] || 0) > 0 ? 0.6 : 0);
          sel.select('.node-label')
            .interrupt()
            .transition().duration(500).ease(d3.easeCubicOut)
            .attr('fill', 'var(--text-muted)')
            .attr('opacity', (d) => d.type === 'directory' ? 1 : 0);
          // Filter changes immediately (URL-based, no meaningful interpolation)
          sel.select('.node-body').attr('filter', (d) => this._heatFilter(d));
          sel.select('.heat-ring').attr('filter', (d) => this._heatFilter(d));
        }

      } else if (type === 'file:changed') {
        this._spawnPingRing(id);

      } else if (type === 'file:added' || type === 'dir:added') {
        if (!this.nodeMap[id]) {
          const node = {
            id, path,
            name: path.split('/').pop(),
            type: type === 'dir:added' ? 'directory' : 'file',
            role: type === 'file' ? _inferRoleFromExt(path) : 'folder',
            size: 0,
          };
          this.nodes.push(node);
          this.nodeMap[id] = node;
          // Add contains edge from parent directory
          const parentPath = path.split('/').slice(0, -1).join('/');
          if (parentPath && this.nodeMap[parentPath]) {
            this.edges.push({ source: parentPath, target: id, type: 'contains' });
          }
          structural = true;
        }

      } else if (type === 'file:deleted' || type === 'dir:deleted') {
        this.nodes    = this.nodes.filter((n) => n.id !== id);
        this.editingIds.delete(id);
        delete this.nodeMap[id];
        structural = true;
      }
    }

    if (structural) {
      // Re-normalize edges, remove stale
      this.edges = this.edges.map((e) => ({
        source: typeof e.source === 'object' ? e.source.id : e.source,
        target: typeof e.target === 'object' ? e.target.id : e.target,
        type: e.type,
      })).filter((e) => this.nodeMap[e.source] && this.nodeMap[e.target]);

      this._buildSimulation(true); // gentle reheat for new nodes
      this._bindDOM();
    }
  }

  // ─── Simulation ───

  _buildSimulation(isFirst) {
    // FIX-01: normalize every time before passing to forceLink
    const simEdges = this.edges.map((e) => ({
      source: typeof e.source === 'object' ? e.source.id : e.source,
      target: typeof e.target === 'object' ? e.target.id : e.target,
      type: e.type,
    }));

    const n        = this.nodes.length;
    const charge   = Math.max(-1200, -Math.round(18000 / Math.sqrt(Math.max(n, 1))));
    const linkDist = n > 60 ? 80 : 130;
    const collide  = n > 60 ? 14 : 28;
    const cx       = this.width / 2;
    const cy       = this.height / 2;

    if (!this.simulation) {
      this.simulation = d3.forceSimulation(this.nodes)
        .force('link',      d3.forceLink(simEdges).id((d) => d.id).distance(linkDist).strength(0.5))
        .force('charge',    d3.forceManyBody().strength(charge).distanceMax(400))
        .force('center',    d3.forceCenter(cx, cy).strength(0.08))
        .force('collision', d3.forceCollide(collide).strength(0.9))
        .force('x',         d3.forceX(cx).strength(0.03))
        .force('y',         d3.forceY(cy).strength(0.03))
        .alpha(0.4)
        .alphaDecay(0.02)
        .velocityDecay(0.35)
        .on('tick', () => this._tick())
        .on('end',  () => {
          this.simulation.stop();
          this._updateMinimapDots();
        });

    } else if (isFirst) {
      // Structural change — reheat gently to place new nodes
      this.simulation.nodes(this.nodes);
      this.simulation.force('link').links(simEdges);
      this.simulation.alpha(0.2).restart();
    }
    // If !isFirst and simulation already exists: do nothing to simulation.
    // _bindDOM will rebind the DOM selection; tick handler already has the live refs.
  }

  // ─── Tick (the ONLY place edge paths are written) ───

  _tick() {
    if (!this._linkSel || !this._nodeSel) return;

    this._linkSel.attr('d', (d) => {
      // Resolve via nodeMap — forceLink resolves simEdges in-place, but DOM
      // data join uses this.edges which retains string source/target
      const sId = typeof d.source === 'object' ? d.source.id : d.source;
      const tId = typeof d.target === 'object' ? d.target.id : d.target;
      const s = this.nodeMap[sId];
      const t = this.nodeMap[tId];
      if (!s || !t || s.x == null || t.x == null) return 'M0,0L0,0';
      const dx = t.x - s.x, dy = t.y - s.y;
      const dist = Math.hypot(dx, dy) || 1;
      const r1 = this._nodeR(s) + 2;
      const r2 = this._nodeR(t) + 3;
      const x1 = s.x + dx * r1 / dist;
      const y1 = s.y + dy * r1 / dist;
      const x2 = t.x - dx * r2 / dist;
      const y2 = t.y - dy * r2 / dist;
      const bend = Math.min(dist * 0.12, 20);
      const cx = (x1 + x2) / 2 - (dy / dist) * bend;
      const cy = (y1 + y2) / 2 + (dx / dist) * bend;
      return `M${x1},${y1}Q${cx},${cy} ${x2},${y2}`;
    });

    this._nodeSel.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);

    if (++this._minimapTick % 8 === 0) this._updateMinimapDots();
  }

  // ─── DOM bind (pure data-join, no simulation touch) ───

  _bindDOM() {
    const self = this;

    // Render import + contains edges — import=dependency, contains=hierarchy
    // Contains edges shown as subtle dashed lines for visual structure
    const renderEdges = this.edges;

    // Links — keyed by source→target string
    const linkSel = this.g.selectAll('.vg-link')
      .data(renderEdges, (d) => {
        const s = typeof d.source === 'object' ? d.source.id : d.source;
        const t = typeof d.target === 'object' ? d.target.id : d.target;
        return `${s}→${t}`;
      });

    linkSel.exit().remove();

    // Enter: no initial 'd' — tick will fill it immediately
    // No opacity transition — avoid fighting with tick
    linkSel.enter().append('path')
      .attr('class', 'vg-link')
      .attr('fill', 'none')
      .attr('stroke', (d) => d.type === 'import' ? 'rgba(255,107,53,0.3)' : 'rgba(255,255,255,0.06)')
      .attr('stroke-width', (d) => d.type === 'import' ? 1 : 0.5)
      .attr('stroke-dasharray', (d) => d.type === 'contains' ? '3,2' : null)
      .attr('marker-end', (d) => d.type === 'import' ? 'url(#vg-arrow)' : null)
      .attr('opacity', 0.7);

    this._linkSel = this.g.selectAll('.vg-link');

    // Nodes
    const nodeSel = this.g.selectAll('.vg-node')
      .data(this.nodes, (d) => d.id);

    nodeSel.exit().remove();

    const nodeEnter = nodeSel.enter().append('g')
      .attr('class', 'vg-node')
      .call(d3.drag()
        .on('start', (event, d) => {
          d.fx = d.x; d.fy = d.y;
          d._dragging = false;
        })
        .on('drag', (event, d) => {
          if (!d._dragging) {
            d._dragging = true;
            if (!event.active) self.simulation.alphaTarget(0.05).restart();
          }
          d.fx = event.x; d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (d._dragging) {
            if (!event.active) self.simulation.alphaTarget(0);
            // Keep fx/fy — node stays pinned where dropped
          } else {
            d.fx = null; d.fy = null;
          }
          d._dragging = false;
        })
      )
      .on('mouseenter', (event, d) => { this._showTooltip(event, d); this._hoverDim(d.id, true); })
      .on('mouseleave', ()          => { this._hideTooltip(); this._hoverDim(null, false); })
      .on('click',      (event, d)  => { event.stopPropagation(); this.selectNode(d.id); });

    // Heat ring (glow layer, behind body)
    nodeEnter.append('circle')
      .attr('class', 'heat-ring')
      .attr('r', (d) => this._nodeR(d))
      .attr('fill', (d) => this._nodeHeatColor(d))
      .attr('stroke', 'none')
      .attr('pointer-events', 'none');

    // F14: Breathing ring (visible only when .editing class is active)
    nodeEnter.append('circle')
      .attr('class', 'breathing-ring')
      .attr('r', (d) => this._nodeR(d) + 3)
      .attr('fill', 'none')
      .attr('stroke', '#FF6B35')
      .attr('stroke-width', 2)
      .attr('opacity', 0)
      .attr('pointer-events', 'none');

    // Node body
    nodeEnter.append('circle')
      .attr('class', 'node-body')
      .attr('r', (d) => this._nodeR(d))
      .attr('fill', (d) => this._nodeHeatColor(d))
      .attr('stroke', 'rgba(255,255,255,0.15)')
      .attr('stroke-width', 1);

    // Label (directories always visible, files hidden)
    nodeEnter.append('text')
      .attr('class', 'node-label')
      .attr('dy', 4)
      .attr('font-family', 'var(--font-mono)')
      .attr('font-size', '10')
      .attr('fill', 'var(--text-muted)')
      .attr('paint-order', 'stroke')
      .attr('stroke', '#0a0908')
      .attr('stroke-width', '3')
      .attr('pointer-events', 'none');

    this._nodeSel = this.g.selectAll('.vg-node');

    // Sync colors and labels on all nodes (enter + update)
    this._nodeSel.select('.node-body')
      .attr('fill', (d) => this._nodeHeatColor(d))
      .attr('filter', (d) => this._heatFilter(d));

    this._nodeSel.select('.heat-ring')
      .attr('fill', (d) => this._nodeHeatColor(d))
      .attr('filter', (d) => {
        const c = this.editCounts[d.path] || 0;
        return this.editingIds.has(d.id) ? 'url(#glow-editing)' : this._heatFilter(d);
      })
      .attr('opacity', (d) => {
        if (this.editingIds.has(d.id)) return 0.8;
        return (this.editCounts[d.path] || 0) > 0 ? 0.6 : 0;
      });

    this._nodeSel.select('.node-label')
      .attr('dx', (d) => this._nodeR(d) + 5)
      .attr('opacity', (d) => d.type === 'directory' ? 0.9 : 0)
      .text((d) => d.name.length > 20 ? d.name.slice(0, 19) + '…' : d.name);

    this._updateHighlight();
  }

  // ─── Selection ───

  selectNode(nodeId) {
    if (!this.nodeMap[nodeId]) return;
    this.selectedId = nodeId;
    this._updateHighlight();
    if (this.onNodeClick) this.onNodeClick(this.nodeMap[nodeId]);
  }

  _deselect() {
    if (!this.selectedId) return;
    const prev = this.selectedId;
    this.selectedId = null;
    this._updateHighlight();
    if (this.onDeselect) this.onDeselect(prev);
  }

  // ─── Highlight (pure attr changes, zero simulation) ───

  _updateHighlight() {
    if (!this._nodeSel) return;
    const sid = this.selectedId;

    const neighbors = new Set();
    if (sid) {
      neighbors.add(sid);
      for (const e of this.edges) {
        const s = typeof e.source === 'object' ? e.source.id : e.source;
        const t = typeof e.target === 'object' ? e.target.id : e.target;
        if (s === sid) neighbors.add(t);
        if (t === sid) neighbors.add(s);
      }
    }

    this._nodeSel.each((d, i, nodes) => {
      const g   = d3.select(nodes[i]);
      const sel = d.id === sid;
      const con = sid ? neighbors.has(d.id) && !sel : false;
      const dim = sid ? !neighbors.has(d.id) : false;

      g.attr('opacity', dim ? 0.12 : 1);

      g.select('.node-body')
        .attr('stroke', sel ? '#FF6B35' : con ? 'rgba(255,107,53,0.5)' : 'rgba(255,255,255,0.15)')
        .attr('stroke-width', sel ? 2.5 : con ? 1.5 : 1)
        .attr('filter', sel ? 'url(#glow-sel)' : this._heatFilter(d));

      g.select('.node-label')
        .attr('fill',    sel ? '#FF6B35' : con ? 'var(--text-primary)' : 'var(--text-muted)')
        .attr('opacity', (sel || con || d.type === 'directory') ? 1 : 0);
    });

    if (!this._linkSel) return;
    this._linkSel
      .attr('stroke', (d) => {
        const s = typeof d.source === 'object' ? d.source.id : d.source;
        const t = typeof d.target === 'object' ? d.target.id : d.target;
        return (s === sid || t === sid) ? 'rgba(255,107,53,0.85)' : 'rgba(255,107,53,0.25)';
      })
      .attr('stroke-width', (d) => {
        const s = typeof d.source === 'object' ? d.source.id : d.source;
        const t = typeof d.target === 'object' ? d.target.id : d.target;
        return (s === sid || t === sid) ? 1.8 : 0.8;
      })
      .attr('opacity', (d) => {
        if (!sid) return 0.6;
        const s = typeof d.source === 'object' ? d.source.id : d.source;
        const t = typeof d.target === 'object' ? d.target.id : d.target;
        return (s === sid || t === sid) ? 1 : 0.08;
      });
  }

  // ─── Color refresh (no DOM rebuild) ───

  _refreshNodeColors(singleId) {
    if (!this._nodeSel) return;
    const sel = singleId
      ? this._nodeSel.filter((d) => d.id === singleId)
      : this._nodeSel;

    sel.select('.node-body')
      .attr('fill',   (d) => this._nodeHeatColor(d))
      .attr('filter', (d) => this._heatFilter(d));

    sel.select('.heat-ring')
      .attr('fill',    (d) => this._nodeHeatColor(d))
      .attr('opacity', (d) => {
        if (this.editingIds.has(d.id)) return 0.8;
        return (this.editCounts[d.path] || 0) > 0 ? 0.6 : 0;
      })
      .attr('filter', (d) => this._heatFilter(d));

    sel.select('.node-label')
      .attr('fill', (d) => this.editingIds.has(d.id) ? '#FF6B35' : 'var(--text-muted)')
      .attr('opacity', (d) => (this.editingIds.has(d.id) || d.type === 'directory') ? 1 : 0);
  }

  // ─── Hover dim ───

  _hoverDim(nodeId, entering) {
    if (this.selectedId || !this._nodeSel) return;

    if (!entering || !nodeId) {
      this._nodeSel.attr('opacity', 1);
      if (this._linkSel) this._linkSel.attr('opacity', 0.6).attr('stroke-width', 0.8);
      return;
    }

    const neighbors = new Set([nodeId]);
    for (const e of this.edges) {
      const s = typeof e.source === 'object' ? e.source.id : e.source;
      const t = typeof e.target === 'object' ? e.target.id : e.target;
      if (s === nodeId) neighbors.add(t);
      if (t === nodeId) neighbors.add(s);
    }

    this._nodeSel.attr('opacity', (d) => neighbors.has(d.id) ? 1 : 0.1);
    if (this._linkSel) {
      this._linkSel
        .attr('opacity', (d) => {
          const s = typeof d.source === 'object' ? d.source.id : d.source;
          const t = typeof d.target === 'object' ? d.target.id : d.target;
          return (s === nodeId || t === nodeId) ? 1 : 0.04;
        })
        .attr('stroke-width', (d) => {
          const s = typeof d.source === 'object' ? d.source.id : d.source;
          const t = typeof d.target === 'object' ? d.target.id : d.target;
          return (s === nodeId || t === nodeId) ? 1.5 : 0.8;
        });
    }
  }

  // ─── Ping ring on file change ───

  _spawnPingRing(nodeId) {
    const node = this.nodeMap[nodeId];
    if (!node || node.x == null) return;
    this.g.append('circle')
      .attr('cx', node.x).attr('cy', node.y)
      .attr('r', this._nodeR(node) + 2)
      .attr('fill', 'none')
      .attr('stroke', '#FF6B35')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.9)
      .attr('pointer-events', 'none')
      .transition().duration(700).ease(d3.easeCubicOut)
      .attr('r', 36).attr('opacity', 0).attr('stroke-width', 0.5)
      .remove();
  }

  // ─── Tooltip ───

  _showTooltip(event, d) {
    const rect    = this.svgEl.parentElement.getBoundingClientRect();
    const mx      = event.clientX - rect.left;
    const my      = event.clientY - rect.top;
    const desc    = this.descriptions[d.path];
    const llmName = desc?.human_name || (typeof desc === 'string' ? desc : '');
    const llmMeta = desc?.metaphor_desc || '';
    const sessions = this.editCounts[d.path] || 0;

    this.tooltipEl.innerHTML = `
      <div class="tt-name">${d.name}</div>
      <div class="tt-path">${d.path}</div>
      <div class="tt-row">
        <span class="tt-role">${d.role || d.type}</span>
        ${sessions > 0 ? `<span class="tt-sessions">⦿ ${sessions} sessions</span>` : ''}
        ${this.editingIds.has(d.id) ? `<span class="tt-sessions" style="color:#FF6B35">● editing</span>` : ''}
      </div>
      ${llmName ? `<div class="tt-desc"><strong>${llmName}</strong>${llmMeta ? '<br>' + llmMeta : ''}</div>` : ''}
    `;
    this.tooltipEl.classList.remove('hidden');

    const tw = 280, th = 100;
    this.tooltipEl.style.left = `${mx + 14 + tw > rect.width  ? mx - tw - 8 : mx + 14}px`;
    this.tooltipEl.style.top  = `${my + 14 + th > rect.height ? my - th - 8 : my + 14}px`;
  }

  _hideTooltip() { this.tooltipEl.classList.add('hidden'); }

  // ─── Minimap ───

  _setupMinimap() {
    this._mmW = 150; this._mmH = 100;

    this._mmEl = d3.select('#graphContainer')
      .append('div')
      .style('position', 'absolute').style('bottom', '10px').style('right', '10px')
      .style('width', this._mmW + 'px').style('height', this._mmH + 'px')
      .style('background', 'rgba(15,14,13,0.85)')
      .style('border', '1px solid rgba(255,255,255,0.07)')
      .style('border-radius', '6px').style('overflow', 'hidden')
      .style('z-index', '10').style('cursor', 'crosshair');

    this._mmSvg  = this._mmEl.append('svg').attr('width', '100%').attr('height', '100%');
    this._mmDots = this._mmSvg.append('g');
    this._mmVP   = this._mmSvg.append('rect')
      .attr('fill', 'rgba(255,107,53,0.07)')
      .attr('stroke', 'rgba(255,107,53,0.4)').attr('stroke-width', 1).attr('rx', 2);

    this._mmSvg.on('click', (event) => {
      const [mx, my] = d3.pointer(event); this._mmNavigate(mx, my);
    });
    this._mmSvg.call(d3.drag().on('drag', (event) => {
      const [mx, my] = d3.pointer(event, this._mmSvg.node()); this._mmNavigate(mx, my);
    }));
  }

  _updateMinimapDots() {
    if (!this._mmSvg || !this.nodes.length) return;
    const xs = this.nodes.map((n) => n.x ?? 0);
    const ys = this.nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const gw = Math.max(maxX - minX, 100), gh = Math.max(maxY - minY, 100);
    const pad = 8;
    const s   = Math.min((this._mmW - pad * 2) / gw, (this._mmH - pad * 2) / gh);
    const ox  = (this._mmW - gw * s) / 2, oy = (this._mmH - gh * s) / 2;
    this._mmBounds = { minX, minY, gw, gh, s, ox, oy };

    const dots = this._mmDots.selectAll('circle').data(this.nodes, (d) => d.id);
    dots.exit().remove();
    dots.enter().append('circle').merge(dots)
      .attr('cx', (d) => ((d.x ?? 0) - minX) * s + ox)
      .attr('cy', (d) => ((d.y ?? 0) - minY) * s + oy)
      .attr('r', 1.8)
      .attr('fill', (d) => {
        if (d.id === this.selectedId || this.editingIds.has(d.id)) return '#FF6B35';
        return this._nodeColor(d);
      });

    this._updateMinimapViewport(d3.zoomTransform(this.svgEl));
  }

  _updateMinimapViewport(transform) {
    if (!this._mmVP || !this._mmBounds) return;
    const { minX, minY, s, ox, oy } = this._mmBounds;
    const tr = transform || d3.zoomTransform(this.svgEl);
    const vl = -tr.x / tr.k, vt = -tr.y / tr.k;
    const vw = this.width / tr.k, vh = this.height / tr.k;
    this._mmVP
      .attr('x', Math.max(0, (vl - minX) * s + ox))
      .attr('y', Math.max(0, (vt - minY) * s + oy))
      .attr('width',  Math.min(this._mmW, vw * s))
      .attr('height', Math.min(this._mmH, vh * s));
  }

  _mmNavigate(mx, my) {
    if (!this._mmBounds) return;
    const { minX, minY, s, ox, oy } = this._mmBounds;
    const gx = minX + (mx - ox) / s, gy = minY + (my - oy) / s;
    this.svg.transition().duration(250)
      .call(this.zoom.transform, d3.zoomIdentity.translate(this.width / 2 - gx, this.height / 2 - gy));
  }

  destroy() {
    if (this.simulation) this.simulation.stop();
    clearInterval(this._heatTimer);
  }
}

// ─── Incremental update helpers ───

function _inferRoleFromExt(filePath) {
  const name = filePath.split('/').pop() || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  // Check test files first (two-part extension like .test.js)
  if (/\.(test|spec)\.(ts|js|tsx|jsx)$/i.test(name)) return 'test';
  const map = {
    'tsx': 'component', 'jsx': 'component', 'vue': 'component', 'svelte': 'component',
    'css': 'style', 'scss': 'style', 'less': 'style',
    'json': 'config', 'yaml': 'config', 'yml': 'config', 'env': 'config', 'ini': 'config',
    'md': 'doc', 'mdx': 'doc', 'txt': 'doc', 'rst': 'doc',
    'html': 'template', 'htm': 'template',
    'py': 'service', 'go': 'service', 'rs': 'service', 'java': 'service',
    'sh': 'script', 'bash': 'script', 'zsh': 'script',
    'sql': 'data',
  };
  return map[ext] || 'unknown';
}
