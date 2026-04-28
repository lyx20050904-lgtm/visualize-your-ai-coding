# Vibe Guarding — Engineering Log

## Status: v0.1.0 — Core visualization only

> **已实现:** 文件监控 → 依赖分析 → 语义描述 → 力导向图渲染 → 编辑计数热度 → 模块聚合色块

---

## 1. Project Overview

```
Name:        Vibe Guarding
Version:     0.1.0
Stack:       Node.js 22 + Express + WebSocket + chokidar / D3.js v7 + vanilla JS
Path:        /Users/macos/Desktop/vibe guarding/vibe-guarding/
Output:      http://localhost:3001
Size:        7 source files | ~3546 LOC
Runtime:     Node 22.22.2
```

Real-time visualization tool for AI vibe coding processes. Monitors filesystem changes, renders an interactive dependency graph with force-directed layout, tracks per-file edit heat, and provides PRD comparison.

**Design language:** Anthropic-inspired — warm cream canvas (#faf9f5), coral primary accent (#cc785c), dark navy product surface (#181715), Cormorant Garamond serif display headlines paired with Inter sans body.

---

## 2. Architecture & Tech Stack

```
Browser ←→ WebSocket ←→ Express Server ←→ chokidar ←→ Target Project FS
   ↓                        ↓
D3.js v7 force graph    REST API (/api/project, /api/prd, /api/agent)
   ↓
Vanilla JS app.js (state + UI)
```

### Why each dependency

| Package | Version | Purpose | Justification |
|---------|---------|---------|---------------|
| express | ^4.21 | HTTP server | De facto standard, zero-config, vast middleware ecosystem |
| ws | ^8.18 | WebSocket | Lightweight (~50KB), no bloat, native `EventEmitter` compat |
| chokidar | ^4.0.3 | FS watcher | Battle-tested, macOS fsevents support, ignore patterns built-in |
| chalk | ^5.3 | Terminal coloring | Dev UX — color-coded server logs |
| D3.js v7 | CDN | Graph visualization | Only library capable of force-directed layout with animated transitions |

---

## 3. Module Specification

### 3.1 file-watcher.js

```
FILE: server/file-watcher.js
LINES: 100
ROLE:  Filesystem event source
API:   class ProjectWatcher(root, broadcast)
```

**Behavior:**
- Wraps `chokidar.watch()` with recursive directory watching
- **Ignore list**: `node_modules`, `.git`, `.next`, `.cache`, `dist`, `build`, `.turbo`, `.nyc_output`, `coverage`, `.vscode`, `.idea`, `.DS_Store`, `yarn-error.log`, `package-lock.json`
- **Debounce**: 300ms per unique path+event combination
- **Events emitted**: `file:added`, `file:changed`, `file:deleted`, `dir:added`, `dir:deleted`, `agent:editing-start`, `agent:editing-end`
- **Edit counting**: `_trackEdit()` increments per-file counter and broadcasts `edit-counts:update`
- **Editing detection**: chokidar `change` event triggers `agent:editing-start` immediately, debounced `change` triggers `agent:editing-end` after 300ms

### 3.2 project-analyzer.js

```
FILE: server/project-analyzer.js
LINES: 294
ROLE:  Project structure introspection
API:   class ProjectAnalyzer(root)
       .getTree()   → [TreeNode]
       .analyze()   → { nodes, edges, roles }
       .getHumanDescription(path, role) → string
       .getAllHumanDescriptions(nodes) → { path → desc }
```

**Tree building:** Recursive `fs.readdirSync`, synchronous single-pass.

**Role assignment:** Ordered heuristic rules (component, route, service, util, type, middleware, style, test, config, doc, data, script).

**Import extraction (regex-based, no AST):** JS/TS `import...from` and `require()`, Python `import X`. Relative paths resolved against known nodes.

**Semantic mapping (F13):** Triple-layer human-readable description system with ~20 hardcoded entries.

### 3.3 prd-parser.js

```
FILE: server/prd-parser.js
LINES: 105
ROLE:  PRD document → structured feature map
API:   class PrdParser(content)
       .parse() → { title, features, modules, dataModels, raw }
```

Rule-based section detection, zero LLM calls.

### 3.4 visualizer.js

```
FILE: client/visualizer.js
LINES: ~1364
ROLE:  D3.js force-directed graph engine
```

**Force simulation:** Adaptive parameters based on graph size (>100 nodes vs smaller).

**Visual encoding:**
- Shapes: Circle (component), Square (directory), Diamond (service/ghost), Triangle (config), Cross (test)
- Color: Directory-hued palette of 8, or state override (bug #d65c5c, editing #ff7a3d, PRD ghost #a99dd1)
- Size: Directory 18px, File 8px (uniform) or 6-18px (heat-scaled)
- Editing highlight: 24px orange fill, static (no animation)

**Features:** Force simulation, hover tooltip, click-to-select with focus mode, right-click details, pan/zoom, minimap, hull bounding boxes, edge arrows, PRD ghost nodes, bug marking.

### 3.5 app.js

```
FILE: client/app.js
LINES: 445
ROLE:  Application controller
API:   class App()
```

WebSocket lifecycle, message dispatch, change batching (500ms), REST API calls, sidebar tree, detail panel, PRD display, prompt modal, activity log (200-entry ring buffer), auto-reopen last project.

### 3.6 server/index.js

```
FILE: server/index.js
LINES: 119
ROLE:  Express server + WebSocket hub
```

REST endpoints: `/api/project/open`, `/api/project/structure`, `/api/project/analyze`, `/api/project/human-descriptions`, `/api/prd`, `/api/agent/prompt`, `/api/bug/report`.

---

## 4. Build & Run

```bash
# Install
cd /Users/macos/Desktop/vibe\ guarding/vibe-guarding
npm install

# Start
npm start   # → http://localhost:3001

# Dev mode (auto-restart on file change)
npm run dev
```

Current runtime: `http://localhost:3001` — active.
