# Vibe Guarding — 产品重设计规格文档

> 版本：v1.0 | 日期：2026-04-29  
> 状态：待确认，未动任何工程文件  
> 前提：目标用户锁定为非技术用户（PM / 设计师 / 创业者），使用姿势为「旁观者模式」——打开页面放在旁边，AI Agent 在另一个窗口跑任务。

---

## 一、产品定位升级

### 从「可视化工具」→「AI 工程卫士」

```
旧定位：文件变了 → 图上闪一下 → 用户看看
新定位：文件变了 → LLM 理解变化 → 判断结构是否健康 → 主动告警
```

核心价值不是「让用户看懂结构」，而是「AI 替用户盯着工程，发现问题主动说出来」。  
可视化是呈现手段，LLM 分析 + 健康评分 + PRD 对齐检测是核心。

---

## 二、需要废弃 / 移除的内容

| 项目 | 当前状态 | 处理方式 | 理由 |
|------|---------|---------|------|
| 全景 / 热度 Lens 切换 | `index.html` 顶栏 `#lensBar` | **直接删除** | 非技术用户不知道该切哪个，也没有动机切换 |
| `viewLevel` 逻辑（1/2） | `app.js` L20, L499-511；`visualizer.js` `_nodeColor` / `_nodeDiameter` / `_nodeLabelVisible` / `_edgeOpacity` / `setViewLevel` | **保留底层，移除入口** | 底层颜色/大小逻辑继续用，只是不再由用户手动触发 |
| `humanDescriptions` 硬编码映射表 | `project-analyzer.js` L32-112，`HUMAN_DESCRIPTIONS` 对象 | **大幅精简，保留 20 条兜底** | LLM 每次文件变动后增量分析，硬编码表只做「LLM 未返回前的占位符」 |
| PRD ghost node 的「prd-match」虚线边 | `visualizer.js` `setPrdGhosts` | **保留节点，移除连线** | PRD 偏离检测改由 LLM 文字播报，虚线连线对非技术用户没有语义 |

---

## 三、核心新功能规格

### 3.1 增量 LLM 分析引擎

**触发时机：** 每次 `file:changed` 事件（300ms 防抖之后）

**调用链：**

```
file:changed (path: "src/components/Login.tsx")
  ↓ 300ms 防抖后
server/llm-service.js → analyzeFileChange(context)
  ↓ 构建上下文（预计 500-800 Token input）：
    - 文件路径 + 角色 + 内容前 300 行
    - import 列表（已有解析结果，project-analyzer.js）
    - 全局结构摘要（目录树 + 各目录文件数，压缩后约 200 Token）
    - 当前健康分（上次分数作为基线）
    - PRD features 列表（如已上传，约 100-300 Token）
  ↓ DeepSeek API（stream: false，预计延迟 1-2s）
  ↓ LLM 返回严格 JSON：
    {
      "prd_aligned": true,
      "prd_deviation_desc": "",          // prd_aligned=false 时填写
      "violations": [                    // 空数组表示无问题
        {
          "rule": "跨层调用",
          "severity": "high",            // high / medium / low
          "detail": "第 23 行直接调用 fetch()"
        }
      ],
      "health_delta": 0,                 // 正负整数，对健康分的影响
      "summary": "登录组件新增了表单验证逻辑，结构合理"
    }
  ↓ server broadcast：
    { type: "analysis:result", path, result, newScore }
  ↓ client 更新节点状态 + 顶部 banner + 右侧面板 + 健康分
```

**输出格式约束：** Prompt 中强制要求 JSON Schema，`try/catch` + 正则后备提取，失败则静默跳过（不阻塞 UI）。

---

### 3.2 工程规范检查（模块 A）

LLM 对照以下规则清单检查变动文件，不需要「自己发明」规则，只需对照检查。这样幻觉风险极低，输出可预测。

| 规则ID | 规则名 | 描述 | 严重度 | 扣分 |
|--------|-------|------|-------|------|
| R01 | 跨层调用 | `components/` 里出现直接 `fetch` / `axios` / `http` 调用 | high | -10 |
| R02 | 文件膨胀 | 单文件超过 400 行且 role 为 component 或 service | medium | -5 |
| R03 | 根目录堆叠 | 新文件直接放在项目根目录而非对应模块目录 | high | -10 |
| R04 | 循环依赖 | A import B，B import A（已有 import 解析可检测） | high | -10 |
| R05 | 命名语义不符 | 文件名含 `util/helper` 但内容全是 API 调用；或文件名含 `service` 但内容全是 UI 渲染 | medium | -5 |
| R06 | 测试缺失 | 新增 `service` / `route` 文件但项目中无对应 `*.test.*` 文件（可配置开关，默认关闭） | low | -3 |

**规则清单写入 LLM prompt，不写入任何配置文件。** 后续增减规则只需改 prompt 模板。

---

### 3.3 PRD 对齐检查（模块 B）

**运行条件：** 用户已上传 PRD。没有 PRD → 模块 B 静默，不运行。

**判断逻辑：**

```
每次文件变动时，LLM 检查：
  「这个文件的改动，是否对应 PRD 里的某个 feature 或 module？」
    ├─ 对应 → prd_aligned: true，节点标记「✓」，不打扰用户
    └─ 不对应 → prd_aligned: false，prd_deviation_desc 填写具体描述
               → 触发顶部橙色 banner + 右侧面板提示
```

**偏离提示文案格式：**
```
⚠️ AI 正在开发 PRD 未提及的功能
[prd_deviation_desc 的内容，例如：「正在集成第三方支付 SDK，PRD 中未提及」]
[忽略]  [已知扩展，不再提示]
```

**「已知扩展」按钮逻辑：**  
点击后将 `prd_deviation_desc` 的语义 key（由 LLM 生成的 1-3 个词的标签）写入内存中的 `knownExtensions: Set<string>`。后续同类变动（LLM 判断语义匹配）不再触发 banner。  
**不持久化到磁盘**（用户关闭页面后重置）。原因：已知扩展列表应该反映到 PRD 里，不应该由工具记忆来替代 PRD 更新。

---

### 3.4 健康分系统

**初始分：100**（每次打开新项目重置）

| 事件 | 分数变化 |
|------|---------|
| high 违规 | -10 / 个 |
| medium 违规 | -5 / 个 |
| low 违规 | -3 / 个 |
| PRD 偏离（未标记为已知扩展） | -8 / 次 |
| PRD feature 被首次覆盖（LLM 确认对应实现存在） | +5 |
| 新增测试文件 | +3 |
| 健康变动（LLM 判断此次改动结构合理） | 0（不加分，只减分） |

**分数区间：**

| 分数 | 状态 | 顶栏颜色 | 含义 |
|------|------|---------|------|
| 90-100 | 健康 | `#5db872`（绿） | 正常 |
| 70-89 | 轻度风险 | `#e8a55a`（琥珀） | 有小问题，建议关注 |
| 50-69 | 需要关注 | `#ff7a3d`（橙） | 多处违规，建议让 Agent 修复 |
| < 50 | 高风险 | `#d65c5c`（红） | 建议暂停，让 Agent 先重构 |

**分数显示位置：** 顶栏状态区（`#statusDot` 右侧），格式：`[92] ● 健康`，颜色跟随区间。

---

## 四、视图重设计规格

### 4.1 核心原则：废弃 Lens，改为单视图自适应两种状态

**状态 1：空闲（`editingIds` 为空，且无 `file:changed` 事件超过 5s）**

- 显示全量节点图，目录着色，hull 可见
- 所有节点 opacity = 1
- 顶栏状态区显示：健康分 + 状态文字
- 右侧面板：「点击节点查看详情」默认文案

**状态 2：活跃（`editingIds` 非空 或 `file:changed` 事件刚发生）**

- 自动触发，无需用户操作
- 全图降噪：非编辑节点 opacity → 0.15，所有边 opacity → 0.04
- 编辑节点：极度放大 + 强光晕（详见 4.2）
- 顶部 banner 出现（详见 4.3）
- LLM 分析结果返回后：banner 更新为分析摘要

---

### 4.2 「正在编辑」节点视觉规格（三层叠加）

#### 层次 1：节点本体

| 属性 | 当前值 | 新值 | 位置 |
|------|-------|------|------|
| 节点直径（editing 状态） | 22px | **52px** | `visualizer.js` `_nodeDiameter()`，`editingIds.has(d.id)` 分支 |
| glow-editing stdDeviation | 8 | **20** | `visualizer.js` `_setupMarkers()` `#glow-editing` filter |
| glow-editing flood-color | `#ff7a3d` | 保持 `#ff7a3d` | 不变 |
| glow-editing filter 区域 x/y | `-80% / -80%` | **`-150% / -150%`** | 同上，width/height 改为 `400%` |
| editing-pulse scale 峰值 | 1.7（0.4s cycle） | **1.4**（减小，避免 52px 基础上抖动过猛） | `styles.css` `@keyframes editing-pulse` |

**效果：** 编辑中节点在全图中视觉重量从约 0.01% 提升至约 0.5-0.8%，进入「不可忽视」区间。

#### 层次 2：全图降噪

触发条件：`editingIds.size > 0`（`agent:editing-start` 事件后立即触发）  
恢复条件：`editingIds` 清空后延迟 2s 恢复（避免频繁闪烁）

**实现方式：** 复用现有 `_hoverFocus` 的降噪逻辑，改为由 `editingIds` 非空状态全局触发。  
具体：在 `_updateNodeVisuals()` 中，当检测到 `editingIds.size > 0` 时，对所有非编辑节点执行：

```
非编辑节点：path.opacity → 0.15，text.opacity → 0.15
所有 link：opacity → 0.04
编辑节点：不受影响（opacity = 1）
```

#### 层次 3：顶部播报 Banner

详见 4.3。

---

### 4.3 顶部 Banner 规格

**DOM 位置：** `#canvas` 内，绝对定位，顶部居中。复用现有 `.focus-exit-btn` 的定位样式（`top: 12px; left: 50%; transform: translateX(-50%)`），但独立新增 `#activityBanner` 元素。

**四种状态的视觉规格：**

#### Banner 状态 A：AI 正在编辑（`agent:editing-start` 触发）

```
背景色：rgba(255, 122, 61, 0.15)          // 橙色半透明
边框：1px solid rgba(255, 122, 61, 0.4)
高度：40px
内边距：0 20px
圆角：var(--radius-pill)  // 9999px
backdrop-filter: blur(8px)

内容：
  ⚡ [icon 12px, color: #ff7a3d]
  「AI 正在修改：[human_description]（[filename]）」
  字体：Inter 13px font-weight: 500, color: #ff7a3d

示例文字：「⚡ AI 正在修改：监控警卫（file-watcher.js）」
```

`human_description` 优先取 LLM 缓存描述，其次取 F13 硬编码描述，最后取文件名。

#### Banner 状态 B：LLM 分析中（发出请求到结果返回之间，约 1-2s）

```
同状态 A 样式，但文字改为：
「⚡ AI 正在修改：[filename] · 分析中...」
右侧显示 12px 旋转加载圆环（复用现有 spinner CSS）
```

#### Banner 状态 C：分析完成，无问题（`violations` 为空且 `prd_aligned: true`）

```
背景色：rgba(93, 184, 114, 0.12)          // 绿色半透明
边框：1px solid rgba(93, 184, 114, 0.35)
内容：
  ✓ [icon, color: #5db872]
  「[summary 的前 40 个字]」
  字体：Inter 13px font-weight: 400, color: #5db872

3s 后自动消失（opacity → 0，transition 0.5s）
```

#### Banner 状态 D：分析完成，有问题（有 violation 或 PRD 偏离）

**子状态 D1：工程规范违规**

```
背景色：rgba(216, 92, 92, 0.12)           // 红色半透明（high）
         rgba(232, 165, 90, 0.12)          // 琥珀（medium/low）
边框颜色跟随严重度
内容：
  ⚠ [icon]
  「[filename] 存在结构问题：[violations[0].rule]」
  如有多条：「及其他 N 个问题」

点击 Banner → 右侧面板展开完整 violation 列表（不自动消失）
右上角 ✕ 关闭按钮（16px，dismisses banner）
```

**子状态 D2：PRD 偏离**

```
背景色：rgba(232, 165, 90, 0.15)          // 琥珀
边框：1px solid rgba(232, 165, 90, 0.4)
内容（两行）：
  第一行：「⚠️ AI 正在开发 PRD 未提及的功能」
  第二行：[prd_deviation_desc，最多 60 字，超出截断加「...」]
右侧两个按钮（行内）：
  [忽略]           // dismiss banner，本次不记录
  [已知扩展]       // 写入 knownExtensions，后续不再提示
  按钮高度：24px，padding: 0 10px，圆角：4px
  颜色：border 1px solid rgba(232,165,90,0.5)，背景透明，hover 背景 rgba(232,165,90,0.1)

不自动消失，必须用户操作
```

---

### 4.4 健康分显示规格（顶栏）

**位置：** `#topbar` 右侧，`#statusDot` 与 `#statusText` 之间插入。

```html
<!-- 新增 DOM 结构（在 .status-group 内） -->
<div id="healthScore" class="health-score">
  <span id="healthNum">—</span>
  <span id="healthLabel">—</span>
</div>
```

**CSS 规格：**

```css
.health-score {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  transition: background 0.4s, color 0.4s;
}

/* 四个状态 class，由 JS 动态切换 */
.health-score.healthy   { background: rgba(93,184,114,0.12);  color: #5db872; }
.health-score.warning   { background: rgba(232,165,90,0.12);  color: #e8a55a; }
.health-score.danger    { background: rgba(255,122,61,0.12);  color: #ff7a3d; }
.health-score.critical  { background: rgba(216,92,92,0.12);   color: #d65c5c; }
```

**文字格式：** `[92] 健康` / `[74] 轻度风险` / `[58] 需要关注` / `[43] 高风险`

健康分动态更新时，数字做 200ms count-up 动画（从旧值到新值逐帧递增），颜色同步过渡。

---

### 4.5 右侧面板重设计

当前右侧面板（`#details`）在无节点选中时显示「Click a node to see details」。

**新增：Analysis 子区域**

在 `#detailsContent` 顶部固定显示最新一次分析结果（不依赖节点选中）：

```
┌─────────────────────────────────┐
│  LAST ANALYSIS          [刷新]  │  // 10px uppercase label
│  src/components/Login.tsx       │  // 11px mono，muted color
│                                 │
│  ✓ 结构合规                      │  // 绿色，无 violation 时
│  「登录组件新增了表单验证逻辑」   │  // 12px，muted，LLM summary
├─────────────────────────────────┤
│  ⚠ R01 跨层调用   [high]        │  // 有 violation 时
│  第 23 行直接调用 fetch()        │  // detail 文字
│  ⚠ R02 文件膨胀   [medium]      │
│  当前 423 行，超出建议上限 400 行 │
├─────────────────────────────────┤
│  点击节点查看文件详情            │  // 下方原有内容
└─────────────────────────────────┘
```

Violation 条目：  
- `high`：左侧 3px 红色竖线，背景 `rgba(216,92,92,0.06)`  
- `medium`：左侧 3px 琥珀色竖线，背景 `rgba(232,165,90,0.06)`  
- `low`：左侧 3px 灰色竖线，背景 透明

---

## 五、需要修改的文件清单（精确到函数级）

### server/llm-service.js

| 修改项 | 描述 |
|-------|------|
| 新增 `analyzeFileChange(context)` 方法 | 增量分析单文件，返回结构化 JSON |
| 新增 `_buildAnalysisPrompt(context)` | 包含规则清单 R01-R06 + PRD features + 全局结构摘要 |
| 修改 `generate()` | 改为「仅在无缓存时调用，有缓存则跳过」逻辑不变，但触发时机改为由 server/index.js 控制 |

### server/index.js

| 修改项 | 描述 |
|-------|------|
| 新增 `file:changed` 事件监听 handler | 收到 `file:changed` 后调用 `llmGenerator.analyzeFileChange()`，broadcast `analysis:result` |
| 维护 `healthScore` 全局变量（初始 100） | 每次分析结果更新分数，broadcast `health:update` |
| 新增 `GET /api/health` endpoint | 返回当前健康分 + violation 历史（最近 20 条） |
| WS 新连接时 send 当前健康分快照 | 同现有 `edit-counts:state` 的逻辑 |

### client/app.js

| 修改项 | 描述 |
|-------|------|
| 删除 lens 切换事件绑定（L499-511） | 移除 `querySelectorAll('.lens-seg')` 事件绑定块 |
| 新增 `_handleAnalysisResult(data)` | 处理 `analysis:result` WS 消息，更新 banner + 面板 |
| 新增 `_updateHealthScore(score)` | 更新顶栏健康分 DOM + class |
| 新增 `_showActivityBanner(state, data)` | 控制 `#activityBanner` 的四种状态切换 |
| 新增 `_handleKnownExtension(desc)` | 写入 `knownExtensions` Set，dismiss banner |
| 修改 `_handleMessage()` | 新增 `analysis:result` / `health:update` case |

### client/visualizer.js

| 修改项 | 描述 |
|-------|------|
| `_nodeDiameter()` L214 | `editingIds.has(d.id)` 分支：`return 22` → `return 52` |
| `_setupMarkers()` `#glow-editing` | `stdDeviation: 8 → 20`；filter 区域 `x/y: -80% → -150%`，`width/height: 260% → 400%` |
| 新增 `_setGlobalDimming(active)` | 复用 `_hoverFocus` 逻辑，由 `editingIds` 非空触发全图降噪 |
| `incrementalUpdate()` `agent:editing-start` 分支 | 调用 `_setGlobalDimming(true)` |
| `incrementalUpdate()` `agent:editing-end` 分支 | `editingIds` 清空后，2s delay 调用 `_setGlobalDimming(false)` |

### client/index.html

| 修改项 | 描述 |
|-------|------|
| 删除 `#lensBar` 整个 div | L37-40 |
| 新增 `#activityBanner` div（在 `#canvas` 内） | 顶部居中，默认 `display: none` |
| 新增 `#healthScore` div（在 `.status-group` 内） | 初始文字「—」，等待第一次分析 |

### client/styles.css

| 修改项 | 描述 |
|-------|------|
| 删除 `.lens-bar` / `.lens-seg` 相关样式（L168-221） | |
| 修改 `@keyframes editing-pulse` | scale 峰值 1.7 → 1.4 |
| 新增 `#activityBanner` 样式 | 见 4.3 规格 |
| 新增 `.health-score` 及四种状态 class | 见 4.4 规格 |
| 新增 `.violation-item` 样式 | 左侧竖线 + 背景，见 4.5 规格 |

### server/project-analyzer.js

| 修改项 | 描述 |
|-------|------|
| `HUMAN_DESCRIPTIONS` 对象 L32-112 | 精简至 20 条最通用的兜底规则（`package.json`、`README.md`、`index.html` 等），删除长尾匹配 |
| 新增 `getStructureSummary(nodes)` | 返回压缩后的全局结构摘要（目录列表 + 各目录文件数），用于 LLM 上下文注入 |

---

## 六、LLM Prompt 模板（精确版）

```
# 角色
你是一个专注工程质量的代码审查 AI。你的任务是分析单次文件变动，输出结构化评估。

# 项目背景
项目名称：{projectName}
当前健康分：{currentScore}/100
项目结构概览：
{structureSummary}

# 本次变动文件
路径：{filePath}
角色：{role}
引用的模块：{imports}
被引用方：{dependents}
文件内容（前 300 行）：
{fileContent}

# PRD 功能清单（如有）
{prdFeatures}

# 工程规范检查清单
R01 跨层调用：components/ 里出现直接 fetch/axios/http 调用 → high
R02 文件膨胀：单文件超 400 行且 role 为 component 或 service → medium
R03 根目录堆叠：新文件放在项目根目录而非模块目录 → high
R04 循环依赖：A import B，B import A → high
R05 命名语义不符：文件名与实际内容 role 明显不符 → medium
R06 测试缺失：新增 service/route 但无对应 test 文件 → low

# 任务
1. 检查上述规范，列出所有违规项（无违规则 violations 为空数组）
2. 如有 PRD 清单：判断本次变动是否对应 PRD 中的某个 feature/module
3. 计算本次变动对健康分的影响（health_delta）
4. 用一句话描述本次变动的内容（summary，不超过 30 字，使用中文）

# 输出格式（严格 JSON，不含任何其他文字）
{
  "prd_aligned": true,
  "prd_deviation_desc": "",
  "violations": [
    {
      "rule": "R01",
      "rule_name": "跨层调用",
      "severity": "high",
      "detail": "第 23 行直接调用 fetch('/api/users')"
    }
  ],
  "health_delta": -10,
  "summary": "登录组件新增了表单验证逻辑，引入 zod 校验库"
}
```

---

## 七、关键技术约束与降级方案

| 风险 | 降级方案 |
|------|---------|
| LLM 无 API Key | 静默跳过分析，健康分不更新，banner 不出现，UI 保持原始状态 |
| LLM 返回非 JSON | `try/catch` + 正则提取 `\{[\s\S]*\}`，失败则丢弃本次结果，不更新 UI |
| LLM 延迟 > 5s | 30s 超时后 abort，本次分析结果丢弃 |
| 高频文件变动（Agent 快速改多个文件） | 300ms 防抖保证每个文件最多 1 次调用；多文件并发最多 3 个 in-flight 请求（超出队列等待） |
| `agent:editing-start` 与 `agent:editing-end` 间隔仅 300ms | 降噪效果用户可能感知不到；可将全图降噪的触发改为 `file:changed` 后（写入完成），而非 `editing-start` |
| 健康分跌至 0 以下 | 钳制在 0，不出现负数 |

---

## 八、暂不修改的内容

以下功能当前实现正常，本次重设计不涉及：

- WebSocket 连接 / 断线重连逻辑
- chokidar 文件监控逻辑
- 节点 click → focus 模式（zoom + 邻居高亮）
- PRD 上传解析（`prd-parser.js`）
- 流式 Agent Q&A（`/api/agent/ask` + SSE）
- Minimap（右下角缩略图导航）
- Activity Log（底部日志栏）
- 左侧树状文件面板
- Hull 区域色块（保留，颜色逻辑不变）

---

*文档结束。确认后开始逐文件修改。*
