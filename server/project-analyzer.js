import fs from 'fs';
import path from 'path';

const IGNORE_PATTERNS = [
  /node_modules/, /\.git/, /\.next/, /\.cache/,
  /dist/, /build/, /\.turbo/, /\.nyc_output/,
  /coverage/, /\.vscode/, /\.idea/, /\.DS_Store/,
  /\.vibe-guarding/,
];

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

const HUMAN_DESCRIPTIONS = {
  exact: {
    'package.json':       '项目身份证：记录名称、版本和依赖',
    'README.md':          '项目说明文档',
    'index.html':         '页面入口：浏览器加载的基础 HTML',
    'app.js':             '应用主逻辑：连接各功能模块的调度核心',
    'styles.css':         '全局样式：定义颜色、字体和布局',
    'Dockerfile':         '容器构建配置',
    '.gitignore':         'Git 忽略规则清单',
    'tsconfig.json':      'TypeScript 编译配置',
    '.env':               '环境变量和密钥配置',
    'package-lock.json':  '依赖版本锁定文件',
  },
  pattern: [
    { match: /\.(tsx|jsx|vue|svelte)$/i, desc: 'UI 组件文件' },
    { match: /\.(test|spec)\.(ts|js|tsx|jsx)$/i, desc: '自动化测试文件' },
    { match: /\.(css|scss|less|styl)$/i, desc: '样式定义文件' },
    { match: /\.(md|mdx|txt|rst)$/i, desc: '文档文件' },
    { match: /\.(json|ya?ml|toml|ini)$/i, desc: '配置文件' },
    { match: /\.(sh|bash|zsh)$/i, desc: '可执行脚本' },
    { match: /\.(py|go|rs|java)$/i, desc: '源代码文件' },
  ],
  dirs: {
    'src': '源代码目录', 'client': '前端源码', 'server': '后端源码',
    'public': '静态资源', 'components': '组件目录', 'pages': '页面目录',
    'services': '服务模块', 'utils': '工具函数', 'config': '配置目录',
    'tests': '测试目录', 'docs': '文档目录', 'hooks': '钩子函数',
    'styles': '样式目录', 'api': '接口目录', 'models': '数据模型',
    'types': '类型定义',
  },
};

const ROLE_DESC = {
  component:  'UI 组件：负责界面展示和用户交互',
  route:      '页面路由：控制用户访问路径',
  service:    '服务模块：处理数据和业务逻辑',
  config:     '配置文件：存储程序运行参数',
  style:      '样式定义：控制视觉表现',
  test:       '测试文件：自动验证代码正确性',
  type:       '类型声明：描述数据结构',
  util:       '工具函数：提供通用辅助功能',
  middleware: '中间件：在请求处理中插入逻辑',
  data:       '数据定义：描述数据库结构',
  doc:        '说明文档：记录项目用法',
  script:     '可执行脚本：命令行指令文件',
};

function getHumanDescription(filePath, role) {
  const name = path.basename(filePath);
  if (HUMAN_DESCRIPTIONS.exact[name]) return HUMAN_DESCRIPTIONS.exact[name];
  for (const { match, desc } of HUMAN_DESCRIPTIONS.pattern) {
    if (match.test(name)) return desc;
  }
  return ROLE_DESC[role] || `代码模块：${name}`;
}

function getHumanDescriptionForDir(dirName) {
  return HUMAN_DESCRIPTIONS.dirs[dirName] || null;
}

function inferRole(filePath, content) {
  for (const rule of ROLE_MAP) {
    if (rule.pattern.test(filePath)) {
      if (rule.contentTest && content && content.length > 0) {
        const head = content.substring(0, 2000);
        if (rule.contentTest.test(head)) return rule.role;
      }
      if (!rule.contentTest) return rule.role;
    }
  }
  return 'unknown';
}

function extractImports(content, filePath) {
  const imports = [];
  const ext = path.extname(filePath);
  if (/\.(ts|js|tsx|jsx)$/i.test(ext)) {
    const re = /(?:import\s+(?:(?:\{[^}]*\}|[^;{]+)\s+from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/g;
    let m;
    while ((m = re.exec(content)) !== null) imports.push(m[1] || m[2]);
  } else if (/\.(py)$/i.test(ext)) {
    const re = /(?:import\s+(\S+)|from\s+(\S+)\s+import)/g;
    let m;
    while ((m = re.exec(content)) !== null) imports.push(m[1] || m[2]);
  }
  return imports;
}

function walkDir(dir, root, tree, contentCache) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (IGNORE_PATTERNS.some((re) => re.test(fullPath))) continue;

      const relative = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        const children = [];
        tree.push({ id: relative, path: relative, name: entry.name, type: 'directory', role: 'folder', children });
        walkDir(fullPath, root, children, contentCache);
      } else if (entry.isFile()) {
        let content = '';
        try {
          if (fs.statSync(fullPath).size < 50000) content = fs.readFileSync(fullPath, 'utf-8');
        } catch { /* binary or inaccessible */ }
        contentCache[relative] = content;
        tree.push({
          id: relative, path: relative, name: entry.name,
          type: 'file', role: inferRole(fullPath, content),
          size: fs.statSync(fullPath).size,
        });
      }
    }
  } catch (e) {
    console.error('walkDir error:', dir, e.message);
  }
}

export class ProjectAnalyzer {
  constructor(root) {
    this.root = root;
    this.contentCache = {};
  }

  getTree() {
    const tree = [];
    this.contentCache = {};
    walkDir(this.root, this.root, tree, this.contentCache);
    return tree;
  }

  getHumanDescription(filePath, role) { return getHumanDescription(filePath, role); }
  getHumanDescriptionForDir(dirName) { return getHumanDescriptionForDir(dirName); }

  getAllHumanDescriptions(nodes) {
    const map = {};
    for (const node of nodes) {
      if (node.type === 'directory') {
        const d = getHumanDescriptionForDir(node.name);
        if (d) map[node.path] = d;
      } else {
        map[node.path] = getHumanDescription(node.path, node.role);
      }
    }
    return map;
  }

  analyze() {
    const tree = this.getTree();
    const nodes = [];
    const edges = [];
    const flatMap = {};

    function flatten(items, parentId) {
      for (const item of items) {
        const node = { id: item.id, name: item.name, path: item.path, type: item.type, role: item.role, size: item.size || 0 };
        nodes.push(node);
        flatMap[item.id] = node;
        if (parentId) edges.push({ source: parentId, target: item.id, type: 'contains' });
        if (item.children) flatten(item.children, item.id);
      }
    }
    flatten(tree, null);

    // Extract import dependencies
    for (const node of nodes) {
      if (node.type === 'file' && this.contentCache[node.path]) {
        const imports = extractImports(this.contentCache[node.path], node.path);
        for (const imp of imports) {
          let resolved = imp;
          if (imp.startsWith('.')) {
            const dir = path.dirname(node.path);
            resolved = path.normalize(path.join(dir, imp));
          }
          const match = nodes.find((n) =>
            n.path === resolved ||
            n.path === resolved + '.ts' || n.path === resolved + '.js' ||
            n.path === resolved + '.tsx' || n.path === resolved + '.jsx' ||
            n.path === resolved + '/index.ts' || n.path === resolved + '/index.js' ||
            n.path === resolved + '/index.tsx' || n.path === resolved + '/index.jsx' ||
            n.path.endsWith('/' + imp.split('/').pop())
          );
          if (match) {
            edges.push({ source: node.id, target: match.id, type: 'import' });
          }
        }
      }
    }

    const roles = {};
    for (const n of nodes) roles[n.role] = (roles[n.role] || 0) + 1;

    return { nodes, edges, roles, root: this.root };
  }
}

