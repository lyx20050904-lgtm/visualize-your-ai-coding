# Vibe Guarding

**Visualize your code.**

Your AI codes. You watch. You stay in control.

Vibe Guarding is a real-time visualization panel that runs alongside your AI coding tools (Cursor, Claude Code, Windsurf, etc.). While your AI agent edits files, Vibe Guarding instantly shows you **what's changing, where it's changing, and how often** — so you never have to guess what the AI is doing.

---

## Why Vibe Guarding?

When you're vibe coding with an AI agent, there's always that nagging question:

> *"What is it doing right now? Which file did it just touch? Is it going in the right direction?"*

You switch to the file manager. You scan the diff. You lose your flow.

Vibe Guarding sits in a second window or browser tab — always visible, always instant. No context switching. No hunting for file paths. Just a live, animated map of your project as the AI shapes it.

---

## Features

- **Live file monitoring** — every file change, addition, and deletion appears instantly on screen
- **Interactive dependency graph** — D3.js force-directed layout shows your project structure with zoom, pan, and drag
- **Edit heatmap** — frequently edited files glow brighter, so you spot hot zones at a glance
- **Real-time glow effects** — actively edited nodes pulse, fading smoothly when the AI moves on
- **Smart file roles** — automatically classifies files as components, routes, services, configs, and more
- **Dual view** — Developer view (full project) or Simple view (business files only, no infra noise)
- **AI descriptions** — plain-language explanations for every file, powered by LLM (optional)
- **Ask Agent** — click any node and ask for its role and design context within the project
- **Sidebar tree** — classic directory tree with keyword filter
- **Activity log** — time-ordered event feed with 300-entry ring buffer

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A browser (Chrome, Firefox, or Edge)

### 1. Install

```bash
git clone https://github.com/lyx20050904-lgtm/visualize-your-ai-coding.git
cd visualize-your-ai-coding
npm install
```

### 2. Start

```bash
npm start
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### 3. Open a project

Paste the absolute path to the project you want to monitor into the top bar and click **Open**.

```
/Users/you/your-ai-project
```

That's it. Start coding with your AI agent — the graph updates live.

### Optional: Connect LLM

If you want AI-powered plain-language descriptions for your files:

1. Create `.vibe-guarding.json` in the project root you're monitoring:
   ```json
   {
     "llm": {
       "provider": "openai",
       "apiKey": "sk-...",
       "model": "gpt-4o-mini"
     }
   }
   ```
   Supported providers: `openai` (gpt-4o-mini), `anthropic` (claude-haiku-4-5-20251001)

2. Restart Vibe Guarding and reopen the project. Descriptions generate automatically in the background.

---

## Usage Tips

| Goal | Action |
|------|--------|
| Monitor AI edits | Open Vibe Guarding in a second monitor or split view |
| Find a specific file | Use the sidebar tree filter |
| Inspect a node | Click it → see details in the right panel |
| Copy file path | Click a node → **Copy Path** button |
| Ask about a file | Click a node → **Ask Agent** button (requires LLM config) |
| Filter infrastructure | Toggle **Simple view** in the top bar |
| Clear activity log | Click **Clear** at the bottom |
| Reset layout | Click and drag nodes to reposition |

---

## Architecture

```
Browser (D3.js graph) ← WebSocket → Node.js server → chokidar → your project
     ↓                                              ↓
  Details panel + Tree view                 REST API (project analysis + LLM)
```

- **Zero data upload**: file monitoring, graph rendering, and heatmap calculation all happen locally
- **LLM is opt-in**: no API calls unless you configure an API key
- **Single dependency**: D3.js loaded from CDN; everything else is vanilla JS

---

## Project Status

Active development. All P0 (core) and P1 features are implemented. See [PRD.md](docs/PRD.md) for full feature spec and roadmap.

---

## License

MIT
