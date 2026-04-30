/**
 * LLM Service — Async semantic description generator
 *
 * LOC: ~526 (exceeds 400-line guardrail)
 * Reason: F10 batch generation + F13 single-node streaming + 3 provider variants
 *   (OpenAI batch, Anthropic batch, OpenAI stream, Anthropic fallback, single-call).
 *   Each provider path is structurally distinct — extracting would add abstraction overhead.
 *
 * Isolation contract:
 *   - NEVER calls broadcast()
 *   - NEVER modifies file-watcher state
 *   - NEVER touches D3 / client state
 *   - Only reads config, calls LLM API, reads/writes cache file
 *   - Exposes: generateDescriptions(), getCachedDescriptions(), isReady()
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const CONFIG_FILE = '.vibe-guarding.json';
const CACHE_FILE = '.vibe-guarding-cache.json';
const BATCH_SIZE = 50;
const TIMEOUT_MS = 30000;

// Base64 infrastructure file patterns to skip sending to LLM
const INFRA_SKIP = [
  /node_modules/, /\.git/, /dist/, /build/, /\.cache/,
  /package-lock\.json/, /yarn\.lock/, /pnpm-lock\.yaml/,
  /\.eslintrc/, /\.prettierrc/, /\.babelrc/,
  /\.(test|spec)\.(js|ts|jsx|tsx)$/i,
  /\.env/,
];

export class LlmService {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.config = null;
    this.cache = {};
    this._ready = false;
    this._generating = false;
    this._log = [];

    this._loadConfig();
    this._loadCache();
  }

  // ─── Config ───

  _loadConfig() {
    const configPath = path.join(this.projectRoot, CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      this._addLog('info', 'No .vibe-guarding.json found. LLM descriptions disabled.');
      return;
    }
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.llm && parsed.llm.apiKey && parsed.llm.provider) {
        this.config = parsed.llm;
        this._addLog('info', `LLM config loaded. Provider: ${this.config.provider}`);
      } else {
        this._addLog('warn', '.vibe-guarding.json missing llm.provider or llm.apiKey.');
      }
    } catch (e) {
      this._addLog('error', `Failed to parse .vibe-guarding.json: ${e.message}`);
    }
  }

  // ─── Cache ───

  _loadCache() {
    const cachePath = path.join(this.projectRoot, CACHE_FILE);
    if (fs.existsSync(cachePath)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        this._ready = Object.keys(this.cache).length > 0;
        this._addLog('info', `Cache loaded: ${Object.keys(this.cache).length} descriptions.`);
      } catch (e) {
        this.cache = {};
      }
    }
  }

  _saveCache() {
    const cachePath = path.join(this.projectRoot, CACHE_FILE);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (e) {
      this._addLog('error', `Cache write failed: ${e.message}`);
    }
  }

  // ─── Public API ───

  isReady() { return this._ready; }
  isGenerating() { return this._generating; }
  isEnabled() { return !!this.config; }

  getCachedDescriptions() {
    return { ...this.cache };
  }

  getLogs() {
    return [...this._log];
  }

  /**
   * F13 — Single-node inquiry. Reads full file content, calls LLM for architectural analysis.
   * @param {Object} ctx - { path, role, imports, importedBy, fullContent }
   * @returns {Object} { summary, responsibility, designPattern, relatedModules }
   */
  async askNode(ctx) {
    if (!this.config) {
      throw new Error('LLM not configured. Add .vibe-guarding.json with apiKey.');
    }
    const prompt = this._buildAskPrompt(ctx);
    return this._callLlmSingle(prompt);
  }

  /**
   * F13 — Streaming single-node inquiry. Sends SSE events to `res`.
   * Events: {type:"chunk",text:"..."} | {type:"done",result:{...}} | {type:"error",text:"..."}
   */
  async streamAskNode(ctx, res) {
    if (!this.config) {
      res.write(`data: ${JSON.stringify({ type: 'error', text: 'LLM not configured' })}\n\n`);
      res.end();
      return;
    }
    const prompt = this._buildAskPrompt(ctx);
    const kbSummary = ctx.kbSummary || null;

    if (this.config.provider === 'openai') {
      await this._callOpenAIStream(prompt, res);
    } else if (this.config.provider === 'anthropic') {
      await this._callAnthropicStream(prompt, res);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', text: `Unknown provider: ${this.config.provider}` })}\n\n`);
      res.end();
    }
  }

  /**
   * Trigger async generation. Non-blocking — caller should not await.
   * @param {Array} nodes - analysis nodes from ProjectAnalyzer
   */
  async generateDescriptions(nodes) {
    if (!this.config) return;
    if (this._generating) return;

    // Filter to business files only
    const targets = nodes.filter((n) => {
      if (n.type === 'directory') return false;
      if (INFRA_SKIP.some((re) => re.test(n.path))) return false;
      if (this.cache[n.path]) return false; // already cached
      return true;
    });

    if (targets.length === 0) {
      this._ready = true;
      this._addLog('info', 'All descriptions already cached. Skipping LLM call.');
      return;
    }

    this._generating = true;
    this._addLog('info', `Generating descriptions for ${targets.length} files...`);

    // Process in batches
    const batches = [];
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      batches.push(targets.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      try {
        const result = await this._callLlm(batch);
        if (result) {
          for (const item of result) {
            if (item.path && item.human_name) {
              this.cache[item.path] = {
                human_name: item.human_name,
                metaphor_desc: item.metaphor_desc || '',
              };
            }
          }
          this._saveCache();
        }
      } catch (e) {
        this._addLog('error', `Batch failed: ${e.message}`);
      }
    }

    this._generating = false;
    this._ready = true;
    this._addLog('info', `Done. ${Object.keys(this.cache).length} total descriptions cached.`);
  }

  // ─── LLM Call ───

  async _callLlmSingle(prompt) {
    if (this.config.provider === 'openai') {
      return this._callOpenAISingle(prompt);
    } else if (this.config.provider === 'anthropic') {
      return this._callAnthropicSingle(prompt);
    } else {
      this._addLog('error', `Unknown provider: ${this.config.provider}`);
      return null;
    }
  }

  async _callLlm(batch) {
    const prompt = this._buildPrompt(batch);

    if (this.config.provider === 'openai') {
      return this._callOpenAI(prompt);
    } else if (this.config.provider === 'anthropic') {
      return this._callAnthropic(prompt);
    } else {
      this._addLog('error', `Unknown provider: ${this.config.provider}`);
      return null;
    }
  }

  _buildPrompt(nodes) {
    const fileList = nodes.map((n) =>
      `- path: "${n.path}", role: "${n.role}", name: "${n.name}"`
    ).join('\n');

    return `You are a patient coding mentor. Explain software files to non-technical users using simple metaphors.

Given this file list:
${fileList}

For each file, generate a short plain-language description (no technical jargon, max 20 Chinese characters or 12 English words).

Return ONLY valid JSON matching this exact schema, no extra text:
{
  "mappings": [
    {"path": "client/app.js", "human_name": "应用大脑", "metaphor_desc": "协调各功能模块的核心调度者"}
  ]
}`;
  }

  // ─── F13 Ask-Node Prompt ───

  _buildAskPrompt({ path, role, imports, importedBy, fullContent, kbSummary }) {
    const truncated = fullContent && fullContent.length > 6000
      ? fullContent.slice(0, 6000) + '\n... [truncated]'
      : fullContent || '';

    // Structural summary for large files
    let structureSummary = '';
    if (fullContent) {
      const lines = fullContent.split('\n').length;
      const fnCount = (fullContent.match(/^\s*(export\s+)?(async\s+)?function\s+|^\s*(export\s+)?class\s+|^\s*(export\s+)?const\s+\w+\s*=[^;]*=>|^\s*interface\s+|^\s*type\s+\w+\s*=/gm) || []).length;
      if (lines > 150 || fullContent.length > 6000) {
        structureSummary = `\nFile structure: ${lines} lines, ~${fnCount} functions/classes/exports.`;
      }
    }

    return `You are a professional software architect. Analyze the following file and explain its role in the project. CRITICAL: You MUST answer in Simplified Chinese. All text fields must be in Chinese, NOT English.

File: ${path}
Role: ${role}
Imports: ${(imports || []).join(', ') || 'none'}
Imported by: ${(importedBy || []).join(', ') || 'none'}
${kbSummary ? `Knowledge base: ${kbSummary.lines} lines, exports: [${(kbSummary.exports || []).join(', ')}]` : ''}
${structureSummary}
File content:
\`\`\`
${truncated}
\`\`\`

STRICTLY output ONLY a valid JSON object. No markdown, no headings, no code fences, no extra text. Output raw JSON directly. ALL text values MUST be in Simplified Chinese:
{
  "summary": "用简体中文一句话概括文件功能，不超过100字",
  "responsibility": "用简体中文描述核心职责，不超过200字",
  "designPattern": "填写设计模式名称如 单例模式/控制器/工具类 或 null，不超过50字",
  "relatedModules": ["相对路径/到/相关/文件1", "相对路径/到/相关/文件2"]
`;
  }

  _getOpenAIEndpoint() {
    if (this.config.apiBase) {
      const url = new URL(this.config.apiBase.replace(/\/+$/, '') + '/chat/completions');
      return { hostname: url.hostname, path: url.pathname };
    }
    return { hostname: 'api.openai.com', path: '/v1/chat/completions' };
  }

  _callOpenAI(prompt) {
    return new Promise((resolve, reject) => {
      const model = this.config.model || 'gpt-4o-mini';
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const ep = this._getOpenAIEndpoint();
      const options = {
        hostname: ep.hostname,
        path: ep.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      this._request(options, body, resolve, reject);
    });
  }

  _callAnthropic(prompt) {
    return new Promise((resolve, reject) => {
      const model = this.config.model || 'claude-haiku-4-5-20251001';
      const body = JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      this._request(options, body, resolve, reject, 'anthropic', false);
    });
  }

  // ─── Streaming variants for F13 ───

  _callOpenAIStream(prompt, res) {
    return new Promise((resolve) => {
      const model = this.config.model || 'gpt-4o-mini';
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a JSON-only API. Return ONLY valid JSON matching the requested schema. Never include markdown, headings, explanations, or any text outside the JSON object.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        stream: true,
      });

      const ep = this._getOpenAIEndpoint();
      const options = {
        hostname: ep.hostname,
        path: ep.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (llmRes) => {
        let buf = '';
        let fullContent = '';

        llmRes.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                fullContent += content;
                res.write(`data: ${JSON.stringify({ type: 'chunk', text: content })}\n\n`);
              }
            } catch (_) { /* skip partial lines */ }
          }
        });

        llmRes.on('end', () => {
          // Parse accumulated content as JSON and send structured result
          try {
            const cleaned = fullContent.replace(/```json\n?|\n?```/g, '').trim();
            const result = JSON.parse(cleaned);
            const allowed = ['summary', 'responsibility', 'designPattern', 'relatedModules'];
            const filtered = {};
            for (const key of allowed) {
              if (result[key] !== undefined) filtered[key] = result[key];
            }
            res.write(`data: ${JSON.stringify({ type: 'done', result: filtered })}\n\n`);
            res.end();
          } catch (e) {
            // Stream produced invalid JSON — retry with non-streaming (has response_format guard)
            this._addLog('warn', `Stream JSON parse failed, retrying via non-streaming: ${e.message}`);
            this._callOpenAISingle(prompt)
              .then((result) => {
                res.write(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
                res.end();
              })
              .catch((e2) => {
                res.write(`data: ${JSON.stringify({ type: 'error', text: `JSON parse failed after retry: ${e2.message}` })}\n\n`);
                res.end();
              });
          }
          resolve();
        });
      });

      req.on('error', (e) => {
        res.write(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`);
        res.end();
        resolve();
      });

      req.write(body);
      req.end();
    });
  }

  _callAnthropicStream(prompt, res) {
    // Fallback: non-streaming for Anthropic via the single-call variant
    this._callAnthropicSingle(prompt)
      .then((result) => {
        res.write(`data: ${JSON.stringify({ type: 'done', result })}\n\n`);
        res.end();
      })
      .catch((e) => {
        res.write(`data: ${JSON.stringify({ type: 'error', text: e.message })}\n\n`);
        res.end();
      });
  }

  // F13 single-call variants — return full JSON object, not mappings array
  _callOpenAISingle(prompt) {
    return new Promise((resolve, reject) => {
      const model = this.config.model || 'gpt-4o-mini';
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });
      const ep = this._getOpenAIEndpoint();
      const options = {
        hostname: ep.hostname,
        path: ep.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      this._request(options, body, resolve, reject, 'openai', true);
    });
  }

  _callAnthropicSingle(prompt) {
    return new Promise((resolve, reject) => {
      const model = this.config.model || 'claude-haiku-4-5-20251001';
      const body = JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      this._request(options, body, resolve, reject, 'anthropic', true);
    });
  }

  _request(options, body, resolve, reject, provider = 'openai', raw = false) {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('LLM request timeout (30s)'));
    }, TIMEOUT_MS);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          let content = '';
          if (provider === 'anthropic') {
            content = json.content?.[0]?.text || '';
          } else {
            content = json.choices?.[0]?.message?.content || '';
          }

          if (!content) {
            reject(new Error('Empty LLM response'));
            return;
          }

          // Parse JSON — handle markdown code fences
          const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          if (raw) {
            resolve(parsed);
          } else {
            resolve(parsed.mappings || []);
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    req.write(body);
    req.end();
  }

  // ─── Internal log ───

  _addLog(level, msg) {
    const entry = { level, msg, ts: new Date().toISOString() };
    this._log.push(entry);
    if (this._log.length > 100) this._log.shift();
    const prefix = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[90m';
    console.log(`${prefix}  [llm] ${msg}\x1b[0m`);
  }
}

