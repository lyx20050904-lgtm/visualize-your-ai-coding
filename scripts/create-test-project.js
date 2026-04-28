/**
 * 压力测试虚拟工程生成器
 *
 * 生成 175 节点 / 500+ 边的测试工程，覆盖全部 14 种角色、
 * 多种 import 语法、大目录深度、密集依赖耦合。
 *
 * 用法:  node scripts/create-test-project.js
 * 输出:  ./test-project/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'test-project');

const DIRS = {
  'src/api': [],
  'src/components': [],
  'src/pages': [],
  'src/hooks': [],
  'src/store': [],
  'src/services': [],
  'src/utils': [],
  'src/types': [],
  'src/middleware': [],
  'src/config': [],
  'server/routes': [],
  'server/models': [],
  'server/controllers': [],
  'server/database': [],
  'tests/unit': [],
  'tests/integration': [],
  'tests/e2e': [],
  'docs': [],
  'scripts': [],
  'styles': [],
  'assets': [],
};

// ─── 50 个组件 ───
const COMPONENTS = [
  'Button', 'Card', 'Header', 'Footer', 'Sidebar',
  'Modal', 'Input', 'Select', 'Dropdown', 'Table',
  'Tabs', 'Accordion', 'Badge', 'Tooltip', 'Avatar',
  'Spinner', 'ProgressBar', 'Pagination', 'Breadcrumb', 'Menu',
  'Navbar', 'SearchBar', 'DatePicker', 'TimePicker', 'ColorPicker',
  'FileUpload', 'Slider', 'Switch', 'RadioGroup', 'CheckboxGroup',
  'Stepper', 'Rating', 'Timeline', 'TreeView', 'DataGrid',
  'VirtualList', 'Chart', 'PieChart', 'BarChart', 'LineChart',
  'HeatMap', 'Kanban', 'Calendar', 'DragDrop', 'Resizer',
  'SplitPane', 'Icon', 'Toast', 'Snackbar', 'Alert',
];

function makeComponent(name) {
  const imp = [
    `import React from 'react';`,
    `import './${name}.css';`,
  ];
  return `${imp.join('\n')}

export const ${name} = ({ children, ...props }) => {
  return <div className="${name.toLowerCase()}">{children}</div>;
};
`;
}

// ─── 服务层 ───
const SERVICES = ['authService', 'paymentService', 'emailService', 'cacheService', 'loggerService', 'metricsService'];
function makeService(name) {
  const imp = [`import { client } from '../api/client';`];
  return `${imp.join('\n')}

export const ${name} = {
  async get() { return client.get('/${name.replace('Service', '')}'); },
  async post(data) { return client.post('/${name.replace('Service', '')}', data); },
};
`;
}

// ─── API 模块 ───
const API_MODS = ['client', 'auth', 'products', 'orders', 'users', 'payments', 'notifications', 'analytics'];
function makeApi(name) {
  if (name === 'client') {
    return `const BASE_URL = '/api/v1';

export const client = {
  async get(url) { return fetch(BASE_URL + url).then(r => r.json()); },
  async post(url, data) { return fetch(BASE_URL + url, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()); },
  async put(url, data) { return fetch(BASE_URL + url, { method: 'PUT', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()); },
  async delete(url) { return fetch(BASE_URL + url, { method: 'DELETE' }).then(r => r.json()); },
};
`;
  }
  return `import { client } from './client';

export const ${name} = {
  list: (params) => client.get('/${name}', params),
  get: (id) => client.get('/${name}/' + id),
};
`;
}

// ─── Pages ───
const PAGES = ['HomePage', 'LoginPage', 'ProductPage', 'CartPage', 'CheckoutPage', 'OrderHistoryPage', 'ProfilePage', 'SettingsPage', 'DashboardPage', 'AdminPage'];
function makePage(name) {
  // 每个 page 随机引用 3-5 个 component + 2 个 service + 1 个 hook
  const picks = [...COMPONENTS].sort(() => Math.random() - 0.5).slice(0, 4);
  const svcPicks = [...SERVICES].sort(() => Math.random() - 0.5).slice(0, 2);
  const apiPicks = [...API_MODS.filter(a => a !== 'client')].sort(() => Math.random() - 0.5).slice(0, 1);
  const hookPicks = ['useAuth', 'useDebounce'].sort(() => Math.random() - 0.5).slice(0, 1);
  const imp = [
    ...picks.map(c => `import { ${c} } from '../components/${c}';`),
    ...svcPicks.map(s => `import { ${s} } from '../services/${s}';`),
    ...apiPicks.map(a => `import { ${a} } from '../api/${a}';`),
    ...hookPicks.map(h => `import { ${h} } from '../hooks/${h}';`),
  ];
  return `${imp.join('\n')}

export const ${name} = () => {
  return <div>${name}</div>;
};
`;
}

// ─── Hooks ───
const HOOKS = ['useAuth', 'useDebounce', 'useLocalStorage', 'useMediaQuery', 'useIntersectionObserver', 'useKeyboard', 'useClipboard', 'useOnlineStatus', 'useEventListener'];
function makeHook(name) {
  return `import { useState, useEffect } from 'react';

export function ${name}(initialValue) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => { /* ${name} logic */ }, []);
  return [value, setValue];
}
`;
}

// ─── Store slices ───
const STORES = ['index', 'authSlice', 'cartSlice', 'productSlice', 'orderSlice', 'uiSlice', 'userSlice'];
function makeStore(name) {
  if (name === 'index') {
    return `export { authSlice } from './authSlice';
export { cartSlice } from './cartSlice';
export { productSlice } from './productSlice';
export { orderSlice } from './orderSlice';
export { uiSlice } from './uiSlice';
export { userSlice } from './userSlice';
`;
  }
  const svc = ['authService', 'paymentService', 'emailService', 'cacheService'].sort(() => Math.random() - 0.5).slice(0, 2);
  const imp = svc.map(s => `import { ${s} } from '../services/${s}';`);
  return `${imp.join('\n')}

export const ${name} = {
  state: {},
  reducers: {},
  effects: {},
};
`;
}

// ─── Utils ───
const UTILS = ['format', 'validate', 'math', 'date', 'string', 'array', 'object', 'storage', 'throttle', 'debounce'];
function makeUtil(name) {
  // 每个 util 引用 2-3 个其他 util（密集内部耦合）
  const deps = UTILS.filter(u => u !== name).sort(() => Math.random() - 0.5).slice(0, 2);
  const imp = deps.map(d => `import { ${d} } from './${d}';`);
  return `${imp.join('\n')}

export function ${name}() {
  // ${name} utility
}
`;
}

// ─── Types ───
const TYPES = ['user', 'product', 'order', 'payment', 'api', 'common'];
function makeType(name) {
  return `export interface ${name.charAt(0).toUpperCase() + name.slice(1)} {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}
`;
}

// ─── Middleware ───
const MIDDLEWARE = ['authGuard', 'rateLimiter', 'requestLogger', 'errorHandler', 'cors'];
function makeMiddleware(name) {
  return `export function ${name}(req, res, next) {
  // ${name} middleware
  next();
}
`;
}

// ─── Config ───
const CONFIGS = ['index', 'database', 'api', 'app'];
function makeConfig(name) {
  return `export const ${name}Config = {
  enabled: true,
};
`;
}

// ─── Server files ───
function makeServerIndex() {
  return `import { auth } from './routes/auth';
import { products } from './routes/products';
import { orders } from './routes/orders';
import { users } from './routes/users';

export const server = { auth, products, orders, users };
`;
}

function makeServerRoute(name) {
  return `import { ${name}Controller } from '../controllers/${name}Controller';

export const ${name} = {
  list: (req, res) => ${name}Controller.list(req, res),
  get: (req, res) => ${name}Controller.get(req, res),
};
`;
}

function makeServerModel(name) {
  return `export class ${name} {
  constructor(data) {
    Object.assign(this, data);
  }
}
`;
}

function makeController(name) {
  return `import { ${name.charAt(0).toUpperCase() + name.slice(1)} } from '../models/${name.charAt(0).toUpperCase() + name.slice(1)}';

export const ${name}Controller = {
  list: async (req, res) => { res.json([]); },
  get: async (req, res) => { res.json({}); },
};
`;
}

function makeSql(name) {
  return `-- ${name}
CREATE TABLE IF NOT EXISTS ${name.replace('.sql', '')} (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;
}

// ─── Test files ───
const TESTS = {
  'unit/Button.test.tsx': `import { Button } from '../../src/components/Button';\n\ndescribe('Button', () => {\n  it('renders', () => {});\n});\n`,
  'unit/api.test.ts': `import { client } from '../../src/api/client';\n\ndescribe('API', () => {});\n`,
  'unit/utils.test.ts': `import { format } from '../../src/utils/format';\n\ndescribe('utils', () => {});\n`,
  'unit/store.test.ts': `import { authSlice } from '../../src/store/authSlice';\n\ndescribe('store', () => {});\n`,
  'unit/auth.test.ts': `import { useAuth } from '../../src/hooks/useAuth';\n\ndescribe('auth', () => {});\n`,
  'integration/checkout.test.ts': `import { CheckoutPage } from '../../src/pages/CheckoutPage';\n\ndescribe('checkout', () => {});\n`,
  'integration/api.integration.test.ts': `import { client } from '../../src/api/client';\n\ndescribe('API integration', () => {});\n`,
  'e2e/userFlow.test.ts': `describe('User flow', () => {});\n`,
};

// ─── Docs ───
const DOCS = {
  'api-reference.md': '# API Reference\n\n## Endpoints\n',
  'architecture.md': '# Architecture\n\n## Overview\n',
  'contributing.md': '# Contributing\n\n## Setup\n',
  'deployment.md': '# Deployment\n\n## Prerequisites\n',
};

// ─── Scripts ───
const SCRIPTS = ['build.sh', 'deploy.sh', 'seed.sh', 'migrate.sh'];

// ─── Styles ───
const STYLES = ['global.css', 'reset.css', 'variables.css', 'typography.css', 'animations.css'];

// ─── Root files ───
const ROOT_FILES = {
  'package.json': JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    description: 'Pressure test project for Vibe Guarding',
    scripts: { build: 'tsc', start: 'node dist/index.js' },
    dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
    devDependencies: { typescript: '^5.0.0' },
  }, null, 2) + '\n',
  'README.md': `# Test Project

Pressure test fixture for Vibe Guarding.
`,
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', jsx: 'react-jsx', strict: true }, include: ['src'] }, null, 2) + '\n',
  '.gitignore': 'node_modules/\ndist/\n.env\n',
};

// ─── Entry point ───
function create() {
  // Clean
  fs.rmSync(ROOT, { recursive: true, force: true });

  // Create directories
  for (const d of Object.keys(DIRS)) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }

  // Root files
  for (const [name, content] of Object.entries(ROOT_FILES)) {
    fs.writeFileSync(path.join(ROOT, name), content);
  }

  // Components (50)
  for (const c of COMPONENTS) {
    fs.writeFileSync(path.join(ROOT, 'src/components', `${c}.tsx`), makeComponent(c));
  }

  // API (8)
  for (const a of API_MODS) {
    fs.writeFileSync(path.join(ROOT, 'src/api', `${a}.ts`), makeApi(a));
  }

  // Services (6)
  for (const s of SERVICES) {
    fs.writeFileSync(path.join(ROOT, 'src/services', `${s}.ts`), makeService(s));
  }

  // Pages (10)
  for (const p of PAGES) {
    fs.writeFileSync(path.join(ROOT, 'src/pages', `${p}.tsx`), makePage(p));
  }

  // Hooks (9)
  for (const h of HOOKS) {
    fs.writeFileSync(path.join(ROOT, 'src/hooks', `${h}.ts`), makeHook(h));
  }

  // Store (7)
  for (const s of STORES) {
    fs.writeFileSync(path.join(ROOT, 'src/store', `${s}.ts`), makeStore(s));
  }

  // Utils (10)
  for (const u of UTILS) {
    fs.writeFileSync(path.join(ROOT, 'src/utils', `${u}.ts`), makeUtil(u));
  }

  // Types (6)
  for (const t of TYPES) {
    fs.writeFileSync(path.join(ROOT, 'src/types', `${t}.ts`), makeType(t));
  }

  // Middleware (5)
  for (const m of MIDDLEWARE) {
    fs.writeFileSync(path.join(ROOT, 'src/middleware', `${m}.ts`), makeMiddleware(m));
  }

  // Config (4)
  for (const c of CONFIGS) {
    fs.writeFileSync(path.join(ROOT, 'src/config', `${c}.ts`), makeConfig(c));
  }

  // Server
  fs.writeFileSync(path.join(ROOT, 'server/index.ts'), makeServerIndex());
  const ROUTE_NAMES = ['auth', 'products', 'orders', 'users'];
  for (const r of ROUTE_NAMES) {
    fs.writeFileSync(path.join(ROOT, 'server/routes', `${r}.ts`), makeServerRoute(r));
  }
  for (const m of ['User', 'Product', 'Order', 'Payment']) {
    fs.writeFileSync(path.join(ROOT, 'server/models', `${m}.ts`), makeServerModel(m));
  }
  for (const c of ROUTE_NAMES) {
    fs.writeFileSync(path.join(ROOT, 'server/controllers', `${c}Controller.ts`), makeController(c));
  }
  for (const sql of ['schema', 'seed', 'migration']) {
    fs.writeFileSync(path.join(ROOT, 'server/database', `${sql}.sql`), makeSql(sql));
  }

  // Tests
  for (const [file, content] of Object.entries(TESTS)) {
    fs.writeFileSync(path.join(ROOT, 'tests', file), content);
  }

  // Docs
  for (const [file, content] of Object.entries(DOCS)) {
    fs.writeFileSync(path.join(ROOT, 'docs', file), content);
  }

  // Scripts
  for (const s of SCRIPTS) {
    fs.writeFileSync(path.join(ROOT, 'scripts', s), `#!/bin/bash\necho "Running ${s}"\n`);
  }

  // Styles
  for (const s of STYLES) {
    fs.writeFileSync(path.join(ROOT, 'styles', s), `/* ${s} */\n`);
  }

  // Assets
  fs.writeFileSync(path.join(ROOT, 'assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>\n');
  fs.writeFileSync(path.join(ROOT, 'assets/icon.png'), '');
  fs.writeFileSync(path.join(ROOT, 'assets/favicon.ico'), '');

  // Summary
  let totalFiles = 0;
  function count(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) totalFiles++;
      if (e.isDirectory() && !e.name.startsWith('.')) count(path.join(dir, e.name));
    }
  }
  count(ROOT);

  console.log(`
  [*] Test project created: ${ROOT}
  [*] Total files: ${totalFiles}
  [*] Directories: ${Object.keys(DIRS).length + 1}
  [*] Ready for Vibe Guarding pressure tests.
  `);
}

create();
