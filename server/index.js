import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { ProjectWatcher } from './file-watcher.js';
import { ProjectAnalyzer } from './project-analyzer.js';
import { LlmService } from './llm-service.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ─── State ───
// Module boundary: index.js owns WebSocket lifecycle + routing + broadcast()
// index.js is FORBIDDEN from: awaiting LLM calls, calling llmService from broadcast()
let projectRoot = null;
let watcher = null;
let analyzer = null;
let llmService = null;

// ─── Broadcast (sync only — no async operations here) ───
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ─── Middleware ───
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(ROOT, 'client')));

// ─── REST: Project ───

app.post('/api/project/open', (req, res) => {
  const { path: dirPath } = req.body;

  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'Path is not a directory' });
  }

  // Tear down existing watchers
  if (watcher) watcher.close();

  projectRoot = dirPath;
  watcher = new ProjectWatcher(dirPath, broadcast);
  analyzer = new ProjectAnalyzer(dirPath);

  // Initialize LLM service (isolated — never touches broadcast directly)
  llmService = new LlmService(dirPath);

  broadcast({ type: 'project:opened', path: dirPath });
  res.json({ ok: true, path: dirPath });

  // Trigger LLM generation asynchronously — fire and forget
  // No await here — this MUST NOT block or couple to broadcast()
  setImmediate(() => {
    if (llmService && llmService.isEnabled()) {
      const analysis = analyzer.analyze();
      llmService.generateDescriptions(analysis.nodes).catch((e) => {
        console.error('[llm] Generation error:', e.message);
      });
    }
  });
});

app.get('/api/project/analyze', (req, res) => {
  if (!analyzer) return res.status(400).json({ error: 'No project open' });
  res.json(analyzer.analyze());
});

app.get('/api/project/human-descriptions', (req, res) => {
  if (!analyzer) return res.status(400).json({ error: 'No project open' });
  const analysis = analyzer.analyze();
  res.json(analyzer.getAllHumanDescriptions(analysis.nodes));
});

// ─── REST: LLM descriptions (client polls this endpoint) ───

app.get('/api/llm/descriptions', (req, res) => {
  if (!llmService) return res.json({ ready: false, descriptions: {} });
  res.json({
    ready: llmService.isReady(),
    generating: llmService.isGenerating(),
    descriptions: llmService.getCachedDescriptions(),
  });
});

app.get('/api/llm/logs', (req, res) => {
  if (!llmService) return res.json([]);
  res.json(llmService.getLogs());
});

// ─── WebSocket ───

wss.on('connection', (ws) => {
  console.log('\x1b[90m  [ws] Client connected\x1b[0m');

  // Send current state to newly connected client
  if (analyzer) {
    const analysis = analyzer.analyze();
    ws.send(JSON.stringify({ type: 'project:state', analysis }));
  }

  if (watcher) {
    ws.send(JSON.stringify({
      type: 'edit-counts:state',
      counts: watcher.getEditSessionCounts()
    }));
  }

  ws.on('close', () => {
    console.log('\x1b[90m  [ws] Client disconnected\x1b[0m');
  });
  ws.on('error', (e) => {
    console.error('\x1b[31m  [ws] Error:\x1b[0m', e.message);
  });
});

// ─── Start ───

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  \x1b[36m[*] Vibe Guarding running at http://localhost:${PORT}\x1b[0m\n`);
});
