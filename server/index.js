import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { ProjectWatcher } from './file-watcher.js';
import { ProjectAnalyzer } from './project-analyzer.js';
import { LlmService } from './llm-service.js';
import { ProjectKnowledge } from './project-knowledge.js';
import { ActivityStore } from './activity-store.js';
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
let knowledgeBase = null;
let activityStore = null;

// ─── Broadcast (sync only — no async operations here) ───
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ─── Middleware ───
app.use(express.json({ limit: '10mb' }));
// Disable caching for client JS/CSS so browser always gets latest
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
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

  // Tear down existing watchers and store
  if (watcher) watcher.close();
  if (activityStore) activityStore.destroy();

  projectRoot = dirPath;
  activityStore = new ActivityStore(dirPath, broadcast);
  analyzer = new ProjectAnalyzer(dirPath);
  watcher = new ProjectWatcher(dirPath, broadcast, activityStore);

  // Initialize LLM service (isolated — never touches broadcast directly)
  llmService = new LlmService(dirPath);

  // Initialize project knowledge base (F13 Layer 2)
  knowledgeBase = new ProjectKnowledge(dirPath);

  broadcast({ type: 'project:opened', path: dirPath });
  broadcast({ type: 'activity:state', data: activityStore.getAll() });
  res.json({ ok: true, path: dirPath });

  // Trigger background processes — fire and forget
  // No await here — these MUST NOT block or couple to broadcast()
  setImmediate(() => {
    if (llmService && llmService.isEnabled()) {
      const analysis = analyzer.analyze();
      llmService.generateDescriptions(analysis.nodes).catch((e) => {
        console.error('[llm] Generation error:', e.message);
      });
    }
    // Scan project knowledge base (fast, local-only — no API calls)
    if (knowledgeBase) {
      const analysis = analyzer.analyze();
      knowledgeBase.scan(analysis.nodes);
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

app.get('/api/knowledge/status', (req, res) => {
  if (!knowledgeBase) return res.json({ ready: false, count: 0 });
  res.json({
    ready: knowledgeBase.isReady(),
    count: Object.keys(knowledgeBase.getAllSummaries()).length,
  });
});

app.get('/api/llm/logs', (req, res) => {
  if (!llmService) return res.json([]);
  res.json(llmService.getLogs());
});

// ─── F00: Activity clear ───

app.post('/api/activity/clear', (req, res) => {
  if (!activityStore) return res.status(400).json({ error: 'No project open' });
  activityStore.clear();
  res.json({ ok: true });
});

// ─── REST: F13 Node Inquiry Agent ───

app.post('/api/agent/ask-node', async (req, res) => {
  if (!llmService || !llmService.isEnabled()) {
    return res.status(400).json({ error: 'LLM not configured. Add .vibe-guarding.json with apiKey.' });
  }
  if (!analyzer) {
    return res.status(400).json({ error: 'No project open' });
  }

  const { path: filePath, role } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'Missing file path' });
  }

  try {
    // Read full file content
    const fullPath = join(projectRoot, filePath);
    let fullContent = '';
    if (fs.existsSync(fullPath)) {
      fullContent = fs.readFileSync(fullPath, 'utf-8');
    }

    // Gather imports/importedBy from analysis
    const analysis = analyzer.analyze();
    const node = analysis.nodes.find((n) => n.path === filePath);
    const imports = node?.imports || [];
    const importedBy = [];
    for (const e of analysis.edges) {
      const src = typeof e.source === 'object' ? e.source.path : e.source;
      const tgt = typeof e.target === 'object' ? e.target.path : e.target;
      if (tgt === filePath) importedBy.push(src);
    }

    const result = await llmService.askNode({
      path: filePath,
      role: role || node?.role || 'unknown',
      imports,
      importedBy,
      fullContent,
    });

    res.json(result);
  } catch (e) {
    console.error('\x1b[31m  [ask-node] Error:\x1b[0m', e.message);
    res.status(500).json({ error: 'LLM request failed', detail: e.message });
  }
});

// ─── F13 Streaming Agent (SSE) ───

app.post('/api/agent/ask-node/stream', (req, res) => {
  if (!llmService || !llmService.isEnabled()) {
    return res.status(400).json({ error: 'LLM not configured' });
  }
  if (!analyzer) {
    return res.status(400).json({ error: 'No project open' });
  }

  const { path: filePath, role } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'Missing file path' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Read full file content
  const fullPath = join(projectRoot, filePath);
  let fullContent = '';
  if (fs.existsSync(fullPath)) {
    fullContent = fs.readFileSync(fullPath, 'utf-8');
  }

  // Gather imports/importedBy from analysis
  const analysis = analyzer.analyze();
  const node = analysis.nodes.find((n) => n.path === filePath);
  const imports = node?.imports || [];
  const importedBy = [];
  for (const e of analysis.edges) {
    const src = typeof e.source === 'object' ? e.source.path : e.source;
    const tgt = typeof e.target === 'object' ? e.target.path : e.target;
    if (tgt === filePath) importedBy.push(src);
  }

  // Check knowledge base for pre-computed summary (F13 Layer 2)
  const kbSummary = knowledgeBase?.getSummary(filePath) || null;

  llmService.streamAskNode({
    path: filePath,
    role: role || node?.role || 'unknown',
    imports,
    importedBy,
    fullContent,
    kbSummary,
  }, res).catch((e) => {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`);
      res.end();
    }
  });
});

// ─── WebSocket ───

wss.on('connection', (ws) => {
  console.log('\x1b[90m  [ws] Client connected\x1b[0m');

  // Send current state to newly connected client
  if (analyzer) {
    const analysis = analyzer.analyze();
    ws.send(JSON.stringify({ type: 'project:state', analysis }));
  }

  if (activityStore) {
    ws.send(JSON.stringify({ type: 'activity:state', data: activityStore.getAll() }));
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

