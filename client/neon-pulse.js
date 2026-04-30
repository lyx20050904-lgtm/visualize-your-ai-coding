/**
 * NeonPulse — SVG-native heat effect layer
 *
 * Renders inside .graph-root as a <g class="neon-layer">, BELOW the nodes.
 * Because it lives in the same D3 coordinate space, it inherits pan/zoom
 * automatically — zero coordinate math, zero drift on resize or zoom.
 *
 * Architecture:
 *   - <g class="neon-auras">  — one radial-gradient <radialGradient> + <circle>
 *                               per hot node; updated every RAF frame.
 *   - <g class="neon-rings">  — expanding ring <circle> elements; each ring
 *                               stores its state in a JS object and is removed
 *                               from DOM when life expires.
 *
 * No canvas. No coordinate transforms. No drift.
 */

class NeonPulse {
  constructor(containerId, svgId) {
    this._svgEl = document.getElementById(svgId);

    // Find (or wait for) .graph-root — inserted by Visualizer after us
    this._root = null;
    this._pendingNodes = [];
    this._ensureRoot();

    // Node state: Map<id, { x, y, r, color, heat, editing }>
    this.nodes = new Map();

    // Active rings: [{ id, gx, gy, r, maxR, color, life, speed, width, el, elInner }]
    this.rings = [];
    this._ringId = 0;

    // Spawn timing
    this._lastSpawn = new Map();

    // Animation
    this._raf = null;
    this._t   = 0;

    this._loop();
  }

  // ─── Public API ───────────────────────────────────────────

  update(nodes) {
    this._ensureRoot();
    const seen = new Set();
    for (const n of nodes) {
      seen.add(n.id);
      this.nodes.set(n.id, { ...n });
    }
    for (const id of this.nodes.keys()) {
      if (!seen.has(id)) this.nodes.delete(id);
    }
  }

  setEditing(id, editing) {
    const n = this.nodes.get(id);
    if (n) {
      n.editing = editing;
      if (editing) this._spawnBurst(n, 5);
    }
  }

  setHeat(counts, pathToId) {
    for (const [path, count] of Object.entries(counts)) {
      const id = pathToId[path];
      if (!id) continue;
      const n = this.nodes.get(id);
      if (n) n.heat = count;
    }
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._auraG?.remove();
    this._ringG?.remove();
    this._defs?.remove();
  }

  // ─── Internal ─────────────────────────────────────────────

  _ensureRoot() {
    if (this._root) return;
    const root = this._svgEl?.querySelector('.graph-root');
    if (!root) return;
    this._root = root;

    // SVG defs for radial gradients (one per node, keyed by id)
    this._defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    this._svgEl.insertBefore(this._defs, this._svgEl.firstChild);

    // neon-auras goes FIRST in graph-root (behind links and nodes)
    this._auraG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this._auraG.setAttribute('class', 'neon-auras');
    this._auraG.setAttribute('pointer-events', 'none');
    root.insertBefore(this._auraG, root.firstChild);

    // neon-rings also behind nodes
    this._ringG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this._ringG.setAttribute('class', 'neon-rings');
    this._ringG.setAttribute('pointer-events', 'none');
    root.insertBefore(this._ringG, this._auraG.nextSibling);
  }

  _hex3to6(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    return hex;
  }

  _hexAlpha(hex, alpha) {
    hex = this._hex3to6(hex);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }

  _nodeColor(n) { return n.color || '#00D4FF'; }

  // ── Aura management ──

  _getOrCreateAura(n) {
    const gradId = `neon-grad-${n.id}`;
    let gradEl = this._defs.querySelector(`#${CSS.escape(gradId)}`);
    let circEl = this._auraG.querySelector(`[data-nid="${CSS.escape(n.id)}"]`);

    if (!gradEl) {
      gradEl = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
      gradEl.setAttribute('id', gradId);
      gradEl.setAttribute('gradientUnits', 'userSpaceOnUse');
      // 3 stops: center opaque → mid semi → edge transparent
      for (const [offset, opacity] of [['0%', 0.9], ['40%', 0.5], ['100%', 0]]) {
        const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-opacity', opacity);
        gradEl.appendChild(stop);
      }
      this._defs.appendChild(gradEl);
    }

    if (!circEl) {
      circEl = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circEl.setAttribute('data-nid', n.id);
      circEl.setAttribute('fill', `url(#${gradId})`);
      this._auraG.appendChild(circEl);
    }

    return { gradEl, circEl, gradId };
  }

  _updateAura(n, t) {
    if (!this._auraG) return;
    const heat      = n.heat || 0;
    const intensity = Math.min(heat / 20, 1);
    const col       = this._nodeColor(n);

    const { gradEl, circEl, gradId } = this._getOrCreateAura(n);

    // editing: radius 8x node, violent pulse; idle: heat-proportional
    const auraR = n.r * (n.editing ? 8 : (1 + intensity * 5));
    const pulse = n.editing
      ? 1 + Math.sin(t * 10) * 0.25
      : 1 + Math.sin(t * 1.5 + n.x * 0.05) * 0.06 * intensity;
    const R     = auraR * pulse;
    const alpha = n.editing ? 0.85 : 0.12 + intensity * 0.28;

    // Update gradient position to follow node
    gradEl.setAttribute('cx', n.x);
    gradEl.setAttribute('cy', n.y);
    gradEl.setAttribute('r',  R);

    const stops = gradEl.querySelectorAll('stop');
    const colors = [
      this._hexAlpha(col, alpha * 0.9),
      this._hexAlpha(col, alpha * 0.5),
      this._hexAlpha(col, 0),
    ];
    stops.forEach((s, i) => s.setAttribute('stop-color', colors[i]));

    circEl.setAttribute('cx', n.x);
    circEl.setAttribute('cy', n.y);
    circEl.setAttribute('r',  R);
    circEl.setAttribute('opacity', 1);
  }

  _hideAura(id) {
    const circEl = this._auraG?.querySelector(`[data-nid="${CSS.escape(id)}"]`);
    if (circEl) circEl.setAttribute('opacity', 0);
  }

  // ── Ring management ──

  _makeRingEl(ring) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('fill', 'none');
    el.setAttribute('cx', ring.gx);
    el.setAttribute('cy', ring.gy);
    el.setAttribute('r', ring.r);
    el.setAttribute('pointer-events', 'none');
    this._ringG.appendChild(el);

    const elInner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    elInner.setAttribute('fill', 'none');
    elInner.setAttribute('cx', ring.gx);
    elInner.setAttribute('cy', ring.gy);
    elInner.setAttribute('r', ring.r * 0.94);
    elInner.setAttribute('pointer-events', 'none');
    this._ringG.appendChild(elInner);

    return { el, elInner };
  }

  _spawnBurst(n, count) {
    if (!this._ringG) return;
    const col = this._nodeColor(n);
    for (let i = 0; i < count; i++) {
      const ring = {
        gx: n.x, gy: n.y,
        r:    n.r + i * 2,
        maxR: n.r + 12 + (n.heat || 0) * 4 + i * 8,
        color: col,
        life:  1 - i * 0.08,
        speed: 0.008 + Math.random() * 0.006,
        width: 1.8 - i * 0.2,
      };
      const { el, elInner } = this._makeRingEl(ring);
      ring.el = el;
      ring.elInner = elInner;
      this.rings.push(ring);
    }
  }

  _spawnAmbientRing(n) {
    if (!this._ringG) return;
    const col       = this._nodeColor(n);
    const intensity = Math.min((n.heat || 0) / 20, 1);
    const ring = {
      gx: n.x, gy: n.y,
      r:    n.r + 1,
      maxR: n.r + 6 + intensity * 40,
      color: col,
      life:  0.85,
      speed: 0.006 + intensity * 0.006,
      width: 1.2 + intensity * 0.8,
    };
    const { el, elInner } = this._makeRingEl(ring);
    ring.el = el;
    ring.elInner = elInner;
    this.rings.push(ring);
  }

  // ── Main loop ──

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    this._t += 0.016;
    this._ensureRoot();
    if (!this._root) return;

    const t   = this._t;
    const now = t;

    // ── Auras ──
    for (const [id, n] of this.nodes) {
      if (n.heat || n.editing) {
        this._updateAura(n, t);
      } else {
        this._hideAura(id);
      }
    }

    // ── Ambient ring spawning ──
    for (const [id, n] of this.nodes) {
      if (!n.heat && !n.editing) continue;
      const heat     = n.heat || 0;
      // editing: burst every 0.5s; hot idle: heat-proportional; cold: rare
      const interval = n.editing ? 0.5 : Math.max(0.4, 4 - heat * 0.18);
      const last     = this._lastSpawn.get(id) || 0;
      if (now - last >= interval) {
        this._lastSpawn.set(id, now);
        if (n.editing) {
          // Re-burst: 3 rings every 0.5s while editing continues
          this._spawnBurst(n, 3);
        } else {
          this._spawnAmbientRing(n);
        }
      }
    }

    // ── Update + draw rings ──
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];

      ring.r    += (ring.maxR - ring.r) * ring.speed * 1.8;
      ring.life -= ring.speed * 0.55;

      if (ring.life <= 0 || ring.r >= ring.maxR * 0.98) {
        ring.el.remove();
        ring.elInner.remove();
        this.rings.splice(i, 1);
        continue;
      }

      const progress = (ring.r - ring.maxR * 0.05) / (ring.maxR * 0.95);
      const alpha    = ring.life * 0.8 * (1 - Math.pow(Math.max(0, progress), 1.5));

      ring.el.setAttribute('cx', ring.gx);
      ring.el.setAttribute('cy', ring.gy);
      ring.el.setAttribute('r',  ring.r);
      ring.el.setAttribute('stroke', this._hexAlpha(ring.color, alpha));
      ring.el.setAttribute('stroke-width', ring.width * ring.life);

      if (ring.life > 0.4) {
        ring.elInner.setAttribute('cx', ring.gx);
        ring.elInner.setAttribute('cy', ring.gy);
        ring.elInner.setAttribute('r',  ring.r * 0.94);
        ring.elInner.setAttribute('stroke', this._hexAlpha(ring.color, alpha * 0.35));
        ring.elInner.setAttribute('stroke-width', ring.width * ring.life * 1.5);
        ring.elInner.setAttribute('opacity', 1);
      } else {
        ring.elInner.setAttribute('opacity', 0);
      }
    }

    // Cap rings
    if (this.rings.length > 400) {
      const dead = this.rings.splice(0, this.rings.length - 400);
      dead.forEach(r => { r.el.remove(); r.elInner.remove(); });
    }
  }
}

