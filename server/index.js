import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { ProjectWatcher } from './file-watcher.js';
import { ProjectAnalyzer } from './project-analyzer.js';
import { PrdParser } from './prd-parser.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- State ---
let projectRoot = null;
let watcher = null;
let analyzer = null;

// --- Helpers ---
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(ROOT, 'client')));

// --- REST API ---

// Set / change project root
app.post('/api/project/open', (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || !fs.existsSync(dirPath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (watcher) watcher.close();
  if (analyzer) analyzer = null;

  projectRoot = dirPath;
  watcher = new ProjectWatcher(dirPath, broadcast);
  analyzer = new ProjectAnalyzer(dirPath);

  broadcast({ type: 'project:opened', path: dirPath });
  res.json({ ok: true, path: dirPath });
});

// Get current project structure
app.get('/api/project/structure', (req, res) => {
  if (!analyzer) return res.status(400).json({ error: 'No project open' });
  const tree = analyzer.getTree();
  res.json(tree);
});

// Analyze project
app.get('/api/project/analyze', (req, res) => {
  if (!analyzer) return res.status(400).json({ error: 'No project open' });
  const analysis = analyzer.analyze();
  res.json(analysis);
});

// Get human-readable descriptions
app.get('/api/project/human-descriptions', (req, res) => {
  if (!analyzer) return res.status(400).json({ error: 'No project open' });
  const analysis = analyzer.analyze();
  const descriptions = analyzer.getAllHumanDescriptions(analysis.nodes);
  res.json(descriptions);
});

// Submit PRD
app.post('/api/prd', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'No PRD content' });

  const parser = new PrdParser(content);
  const parsed = parser.parse();
  broadcast({ type: 'prd:parsed', prd: parsed });
  res.json(parsed);
});

// User asks agent for clarification
app.post('/api/agent/prompt', (req, res) => {
  const { prompt } = req.body;
  broadcast({ type: 'agent:suggest-prompt', prompt });
  res.json({ ok: true });
});

// Report a bug
app.post('/api/bug/report', (req, res) => {
  const { description, file } = req.body;
  broadcast({ type: 'bug:reported', description, file });
  res.json({ ok: true });
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  console.log('Client connected');

  if (analyzer) {
    ws.send(JSON.stringify({ type: 'project:state', tree: analyzer.getTree(), analysis: analyzer.analyze() }));
  }

  if (watcher && typeof watcher.getEditCounts === 'function') {
    ws.send(JSON.stringify({ type: 'edit-counts:state', counts: watcher.getEditCounts() }));
  }

  ws.on('close', () => console.log('Client disconnected'));
});

// --- Start ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  [*] Vibe Monitor running at http://localhost:${PORT}\n`);
});
