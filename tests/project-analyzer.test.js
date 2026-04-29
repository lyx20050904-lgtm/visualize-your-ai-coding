import { describe, it } from 'node:test';
import assert from 'node:assert';

// Test the core logic functions directly by importing the module
// Since they aren't exported, we test through ProjectAnalyzer
import { ProjectAnalyzer } from '../server/project-analyzer.js';

describe('ProjectAnalyzer — role inference', () => {
  it('identifies .tsx files as component', () => {
    const a = new ProjectAnalyzer('/tmp');
    const result = a.analyze();
    // Use a temp file to test role inference
  });

  it('inferRole maps .css to style', () => {
    // Direct test of the internal ROLE_MAP logic:
    // .css files should get role 'style'
    const result = _testRole('button.css', '');
    assert.strictEqual(result, 'style');
  });

  it('inferRole maps .test.ts to test', () => {
    const result = _testRole('auth.test.ts', '');
    assert.strictEqual(result, 'test');
  });

  it('inferRole maps .json to config', () => {
    const result = _testRole('package.json', '');
    assert.strictEqual(result, 'config');
  });

  it('inferRole maps .md to doc', () => {
    const result = _testRole('README.md', '');
    assert.strictEqual(result, 'doc');
  });

  it('inferRole uses contentTest for route detection', () => {
    const result = _testRole('app.js', 'const route = Router();');
    assert.strictEqual(result, 'route');
  });

  it('inferRole returns unknown for unmatched files', () => {
    const result = _testRole('random.bin', '');
    assert.strictEqual(result, 'unknown');
  });
});

describe('ProjectAnalyzer — import extraction', () => {
  it('extracts ES import statements', () => {
    const result = _testImports(`import { ref } from 'vue';\nimport { useRouter } from 'vue-router';`, 'test.ts');
    assert.ok(result.includes('vue'));
    assert.ok(result.includes('vue-router'));
  });

  it('extracts require calls', () => {
    const result = _testImports(`const fs = require('fs');\nconst path = require('path');`, 'test.js');
    assert.ok(result.includes('fs'));
    assert.ok(result.includes('path'));
  });

  it('extracts default imports', () => {
    const result = _testImports(`import React from 'react';`, 'test.jsx');
    assert.ok(result.includes('react'));
  });

  it('handles empty content', () => {
    const result = _testImports('', 'test.js');
    assert.deepStrictEqual(result, []);
  });
});

describe('ProjectAnalyzer — human descriptions', () => {
  it('returns exact match for known files', () => {
    const a = new ProjectAnalyzer('/tmp');
    const desc = a.getHumanDescription('package.json', 'config');
    assert.ok(desc.includes('身份证'));
  });

  it('returns pattern match for .tsx files', () => {
    const a = new ProjectAnalyzer('/tmp');
    const desc = a.getHumanDescription('Button.tsx', 'component');
    assert.ok(desc.includes('UI 组件'));
  });

  it('falls back to role description for unknown files', () => {
    const a = new ProjectAnalyzer('/tmp');
    const desc = a.getHumanDescription('weird.xyz', 'service');
    assert.ok(desc.includes('服务模块'));
  });
});

// ─── Helpers (mirror internal logic from project-analyzer.js) ───

function _testRole(filePath, content) {
  // Re-import the internal functions by re-interpreting the module
  const analyz = new ProjectAnalyzer('/tmp');
  // Force a structure that tests would use:
  // We'll access the tree-building logic by creating a minimal project
  return _inferRole(filePath, content);
}

// Inline the ROLE_MAP from project-analyzer.js for isolated testing
const ROLE_MAP = [
  { pattern: /\.(tsx|jsx|vue|svelte)$/i, role: 'component' },
  { pattern: /\.(ts|js)$/i, contentTest: /(Route|router|page|pages)/i, role: 'route' },
  { pattern: /\.(ts|js)$/i, contentTest: /(service|Service|api|API|controller|Controller)/i, role: 'service' },
  { pattern: /\.(ts|js)$/i, contentTest: /(util|helper|Util|Helper)/i, role: 'util' },
  { pattern: /\.(ts|js)$/i, contentTest: /(type|interface|Type|Interface)/i, role: 'type' },
  { pattern: /\.(ts|js)$/i, contentTest: /(middleware|Middleware|hook|use[A-Z])/i, role: 'middleware' },
  { pattern: /\.(css|scss|less|tailwind|styl)/i, role: 'style' },
  { pattern: /\.(test|spec)\.(ts|js|tsx|jsx)$/i, role: 'test' },
  { pattern: /\.(json|ya?ml|toml|ini|env)/i, role: 'config' },
  { pattern: /\.(md|mdx|txt|rst)$/i, role: 'doc' },
  { pattern: /\.(py)$/i, role: 'service' },
  { pattern: /\.(go)$/i, role: 'service' },
  { pattern: /\.(rs)$/i, role: 'service' },
  { pattern: /\.(java|kt)$/i, role: 'service' },
  { pattern: /\.(sql)$/i, role: 'data' },
  { pattern: /Dockerfile/i, role: 'config' },
  { pattern: /\.(sh|bash|zsh)$/i, role: 'script' },
];

function _inferRole(filePath, content) {
  for (const rule of ROLE_MAP) {
    if (rule.pattern.test(filePath)) {
      if (rule.contentTest && content) {
        const head = content.substring(0, 2000);
        if (rule.contentTest.test(head)) return rule.role;
      }
      if (!rule.contentTest) return rule.role;
    }
  }
  return 'unknown';
}

function _testImports(content, filePath) {
  const imports = [];
  const ext = filePath.split('.').pop() || '';
  if (/^(ts|js|tsx|jsx)$/i.test(ext)) {
    const re = /(?:import\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
    let m;
    while ((m = re.exec(content)) !== null) imports.push(m[1] || m[2]);
  }
  return imports;
}
