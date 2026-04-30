# Changelog

## v1.2.0 (2026-04-29)

### Features
- **F13 — Node Inquiry Agent (Layer 1)**: Select any node in the graph and click "Ask Agent" to get an LLM-powered analysis of its role, responsibilities, design pattern, and related modules. Streaming SSE output renders progressively in the details panel.
- **F13 — Node Inquiry Agent (Layer 2)**: Project knowledge base pre-scans project files on open, extracting structural summaries (exports, classes, functions). Ask queries prioritize reading the knowledge base summary and fall back to full file content as needed.
- **F14 — Editing Breathing Ring Pulse**: Editing nodes now display a pulsing outer stroke ring animation (`breathe-pulse`) layered on top of the glow effect for enhanced visual salience.

### Bug Fixes
- **Incremental edge creation**: New files added after initial project load now correctly create `contains` edges to their parent directory node.
- **Role inference for new files**: Files added incrementally now have their role correctly inferred from extension.

### Engineering
- **Code quality**: Extracted `LogManager` class from `app.js` to `app-log.js`. Fixed all code size guardrail violations.
- **Testing**: Added `tests/project-analyzer.test.js` with 14 test cases covering role inference, import extraction, and human description generation.
- **Security**: Updated `.gitignore` to prevent accidental commits of `.vibe-guarding.json` (API keys) and cache files.
- **Debounce tuning**: Editing session debounce extended from 500ms to 2500ms for better visual persistence during active AI editing.

### Architecture
- `server/project-knowledge.js` — new module for local-only structural metrics (no LLM calls)
- `client/app-log.js` — new module with ring-buffered log manager
- `server/llm-service.js` — streaming SSE support via `streamAskNode()` with dual OpenAI/Anthropic streaming paths
