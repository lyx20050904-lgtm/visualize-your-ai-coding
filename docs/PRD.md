# Vibe Guarding — PRD v2.0.0

> 版本：2.1.0
> 狀態：P0+P1 全部實現，P0 新增 F00（活動數據持久化）為最高優先級基礎設施需求；P2 F16（注意力雷達）+ F17（3D 活動地形圖）已規劃
> 本文檔替代 v1.0.0 所有章節，根據 2026-04-30 產品決策會議重新編寫，更新於 2026-04-30

---

## 1. 背景與問題定義 (Problem Statement)

### 被替代的人工工作流

使用 AI Agent（Cursor / Claude Code / Windsurf 等）進行 Vibe Coding 時，開發者依賴以下人工監督流程：

- 手動切換到文件管理器查看新增了哪些文件
- 在 IDE 的 diff 視圖中逐個文件審閱變更
- 憑記憶追蹤項目結構的演變
- 手動將錯誤文件路徑複製給 Agent

Vibe Guarding 將上述流程替代為：**一個與編碼界面同步運行的實時可視化監控面板，讓用戶在 AI 改代碼的過程中，始終知道它在改哪裡。**

### 核心痛點

| 痛點 | 現狀描述 | 量化影響 |
|------|---------|---------|
| **實時感知缺失** | 開發者無法在 AI 編輯時同步看到哪個文件正在被改動 | 每次需手動切換 IDE 確認，上下文切換損失 30-60 秒 |
| **結構迷失** | 無法直觀感知 Agent 操作的文件在整個架構中的位置與關聯 | 跑偏後重構成本增加 3-10 倍 |
| **調試定位慢** | Bug 發生時需手動搜索文件路徑，再將路徑傳遞給 Agent | 每次額外消耗 200-500 Tokens 用於路徑描述 |
| **認知鴻溝** | 非技術用戶無法理解技術文件結構，工具對小白不可用 | 小白用戶流失率 > 60% |

---

## 2. 目標用戶與使用場景

### 用戶畫像

| 角色 | 描述 | 核心需求 |
|------|------|---------|
| **Vibe Coder（主要）** | 使用 AI 編程工具的開發者，同步打開 Guarding 與編碼界面 | 實時追踪 AI 編輯動態，及時發現跑偏 |
| **純小白 Vibe Coder** | 無編程基礎，用自然語言驅動 AI 編程的用戶（產品經理、設計師） | 用業務語言理解項目結構，看懂 AI 在改什麼 |
| **Tech Lead / Reviewer** | 需審閱 Agent 產出代碼的技術管理者 | 快速定位高頻改動模塊，降低審閱時間 |

### 核心使用場景

**場景一：實時監控（主場景）**
用戶同步打開 Vibe Guarding 與 AI 編碼工具，雙屏或分屏運行。AI 每改動一個文件，對應節點即時產生視覺響應。用戶無需切換界面，持續感知 AI 的操作軌跡。

**場景二：小白視圖**
非技術用戶切換到小白視圖，過濾基建文件後圖譜只呈現業務文件。配合 LLM 語義描述，每個節點顯示大白話說明，用戶無需理解文件名即可讀懂結構。

**場景三：Debug 定位**
發現 Bug 後，在圖譜中找到相關節點，點擊「複製路徑」直接將精確路徑傳給 Agent，省去手動查找與描述。

**場景四：按需查詢（v2.0.0 新增）**
選中節點後，點擊「詢問 Agent」獲取該節點在整個項目中的角色說明、依賴關係、設計意圖。有別於批量後台生成語義描述（F10），此為按需、單節點、互動式查詢。

---

## 3. 功能規格 (Feature Spec)

### P0 — 核心功能（MVP 必須全部就緒）

| ID | 功能 | 描述 | 輸入 | 輸出 |
|----|------|------|------|------|
| F00 | **活動數據持久化** | 將編輯會話計數、讀取會話計數（F16）、活動歷史記錄持久化到 `.vibe-guarding-activity.json`，使數據在頁面刷新、服務重啟、項目切換後保留。<br><br>**這是 F05/F06/F16/F17 的基礎設施前置依賴。** | 所有 `agent:*` 和 `file:*` 事件 | `.vibe-guarding-activity.json` 緩存文件（項目根目錄） |
| F01 | **即時文件監控** | 監聽項目目錄的文件新增/修改/刪除事件，通過 WebSocket 即時推送 | 項目根目錄路徑 | 即時事件流（文件路徑 + 事件類型 + 時間戳） |
| F02 | **項目結構圖譜** | D3.js 力導向圖：節點=文件/目錄，邊=依賴/包含關係。`contains` 邊渲染為虛線，`import` 邊渲染為實線+箭頭 | 項目文件樹 | SVG 交互式圖形 |
| F03 | **節點角色辨識** | 根據擴展名與內容規則推斷文件角色（component / service / route / config / test / style） | 文件路徑 + 內容片段 | 角色標籤 |
| F04 | **依賴關係分析** | 解析 import/require 語句，產出有向依賴邊 | 文件源代碼 | 有向依賴圖邊 |
| F05 | **實時編輯動效** | 編輯中節點填充色變更 + feGaussianBlur 外光暈脈衝。消退使用 CSS transition 平滑過渡，非 setTimeout 跳變 | 文件 change 事件 | 節點外光暈（feGaussianBlur），防抖 2500ms 後平滑消退 |
| F06 | **編輯熱力圖** | 節點外光暈強度與半徑反映累計編輯會話次數；每 30 秒重新計算一次發光強度，減少 DOM 操作 | 編輯會話計數（防抖 2500ms 內連續 change 算一次會話） | 節點外光暈強度分級渲染 |
| F07 | **互動式細節面板** | 點選節點後展示文件路徑、角色、編輯會話次數、所屬模塊 | 節點選取事件 | 右側面板 |
| F08 | **一鍵複製路徑** | 將選取節點的文件路徑複製到剪貼板 | 點擊「複製路徑」按鈕 | 系統剪貼板寫入 |

### P1 — 重要功能（MVP 驗收後推進）

| ID | 功能 | 描述 | 輸入 | 輸出 |
|----|------|------|------|------|
| F09 | **雙視圖切換** | 開發者視圖（全量）與小白視圖（過濾基建文件）切換；過濾邏輯為規則引擎，不調用 LLM | 視圖切換事件 | 圖譜節點過濾，alpha 0.05 微調佈局，不重建 simulation |
| F10 | **LLM 語義描述** | 異步為每個節點生成大白話描述；用戶提供 API Key，存於項目根目錄 `.vibe-guarding.json`；結果緩存於 `.vibe-guarding-cache.json` | 項目文件樹 + 用戶 API Key | 節點 tooltip 大白話描述 |
| F11 | **側邊欄樹狀視圖** | 傳統目錄樹，支持關鍵詞過濾 | 項目文件樹 | 左側可過濾樹狀面板 |
| F12 | **活動即時日誌** | 底部面板顯示文件變更時間流水，含事件類型與文件路徑 | 文件事件流 | 可滾動日誌列表（環形緩衝 300 條） |
| F13 | **節點詢問 Agent** | 選中節點後，通過「詢問 Agent」按鈕向 LLM 發起按需查詢，返回該節點在整個項目中的角色說明與設計意圖 | 節點選取 + 用戶點擊 | LLM 返回的節點分析（摘要/模式/關聯節點） |

### P2 — 未來功能（當前版本不實現）

| ID | 功能 | 描述 | 預計版本 |
|----|------|------|---------|
| F14 | **編輯節點視覺強化** | 在 F05 基礎上疊加 combo 效果（呼吸外圈 stroke + 光暈脈衝），進一步提升編輯節點的視覺顯著性 | v1.2.0+ |
| F15 | **結構健康度評分** | 遍歷工程結構，對照架構最佳實踐，給出可量化的健康度評分 + 優化建議 | v1.2.0+ |
| F16 | **注意力雷達（Agent 讀取監控）** | 透過 lsof 輪詢監控 AI Agent 進程對項目文件的讀取行為，當 Agent 打開文件準備讀取時，在圖譜上渲染冷色系「閱讀中」狀態，實現從滯後指标（寫）到實時指标（讀）的監控前置 | AI Agent 進程名/ PID + 輪詢間隔 | `agent:reading-start/end` 事件流 + 冷色系閱讀狀態節點渲染 + 注意力雷達面板 |
| F17 | **3D 活動地形圖 (Activity Terrain Map)** | 基於 Three.js 的 3D 曲面地形視圖，可與 D3 力導圖切換。以目錄為族群聚類形成獨立山體，Agent 活動熱力（編輯 + 讀取）驅動海拔高度，等高線疊加顯示活動強度分布，滑鼠 hover 高亮局部等高線 | 項目分析數據 + Agent 活動事件 | WebGL 3D 地形渲染（曲面網格 + 等高線疊層 + 節點族群分布 + 活動驅動海拔動畫） |

### 明確不在 v2.0.0 範圍的功能

以下功能在當前版本範圍外，不實現、不討論：

- PRD 上傳與自動目錄生成（F15 的 3a 部分）— 定位為獨立工具，不與監控面板耦合
- 歷史時間軸回放
- IDE 插件整合
- Agent 提示詞生成

---

## 4. 核心基礎設施規格

### F00 活動數據持久化 — 規格

**動機：** 當前所有活動計數（編輯會話、熱力圖、熱力讀取）僅存於運行時內存。刷新頁面、重啟服務、切換項目後數據全部清零。F16 注意力雷達和 F17 3D 地形圖都依賴累積數據作為輸入，持久化是它們的前提條件。

**存儲方案：** 項目根目錄下的 `.vibe-guarding-activity.json` 文件。

**文件格式：**
```json
{
  "version": 1,
  "projectRoot": "/Users/xxx/my-project",
  "lastUpdated": "2026-04-30T10:00:00.000Z",
  "editCounts": {
    "src/app.ts": 15,
    "src/components/Button.tsx": 3
  },
  "readingCounts": {
    "src/app.ts": 22
  },
  "activityHistory": [
    { "type": "file:changed", "path": "src/app.ts", "ts": "2026-04-30T10:00:00.000Z", "role": "service" },
    { "type": "agent:editing-start", "path": "src/utils/helper.ts", "ts": "2026-04-30T09:59:00.000Z", "role": "util" }
  ],
  "globalSessionId": 42
}
```

**核心約束：**

| 規則 | 說明 |
|------|------|
| **寫入策略** | 每次有效狀態變更後觸發寫入，1 秒去抖合併，避免高頻 I/O |
| **原子寫入** | 先寫 `.vibe-guarding-activity.json.tmp`，再 rename 覆蓋，防止寫入中斷導致文件損壞 |
| **加載策略** | 項目打開時同步讀取；文件不存在或格式錯誤 → 靜默初始化為空數據 |
| **寫入頻率上限** | 最高每秒寫入 1 次（高於此頻率的變更合併到最近一次寫入） |
| **最大歷史條數** | 環形緩衝 5000 條，超過時丟棄最早記錄 |
| **文件大小警戒** | 正常場景 < 500KB，超過 2MB 時自動截斷歷史（保留最近 1000 條） |
| **併發安全** | 所有讀寫經過 activity-store.js 模塊，無外部直接文件操作 |
| **.gitignore** | `.vibe-guarding-activity.json` 和 `.tmp` 文件應加入 `.gitignore`，屬本地開發數據 |
| **清除機制** | 用戶可通過 UI 按鈕「清除活動數據」手動重置，也可直接刪除文件 |

**與 LLM 緩存的關係：**
- `.vibe-guarding-activity.json`（活動數據）與 `.vibe-guarding-cache.json`（LLM 描述緩存）是兩個獨立文件
- 活動數據不包含 LLM 相關內容，LLM 緩存不包含計數數據
- 刪除活動數據不影響 LLM 描述，反之亦然

**事件到持久化的映射：**

```
agent:editing-end（編輯會話結束）
  → activity-store.recordEdit(path)
  → editCounts[path] += 1
  → 觸發去抖寫入（1s）
  → broadcast edit-counts:update

agent:reading-end（讀取會話結束，F16）
  → activity-store.recordRead(path)
  → readingCounts[path] += 1
  → 觸發去抖寫入
  → broadcast reading-counts:update

file:added / file:changed / file:deleted（文件變更）
  → activity-store.appendHistory({ type, path, ts })
  → 觸發去抖寫入

agent:editing-start / agent:reading-start（開始事件）
  → 不計數，不寫入（僅內存狀態，用於實時動效）
```

**新建 server/activity-store.js 模塊：**

```
class ActivityStore {
  constructor(projectRoot, broadcast)
    → 讀取 .vibe-guarding-activity.json 初始化
    → 如果文件不存在 → editCounts={}, readingCounts={}, history=[]

  recordEdit(path)       → editCounts[path] += 1; scheduleSave()
  recordRead(path)       → readingCounts[path] += 1; scheduleSave()
  appendHistory(entry)   → 追加到 history 环形缓冲; scheduleSave()
  getEditCounts()        → 返回 editCounts 拷貝
  getReadingCounts()     → 返回 readingCounts 拷貝
  getHistory(limit)      → 返回最近 N 條歷史
  getAll()               → 返回完整狀態對象（用於 broadcast）
  clear()                → 重置所有數據; 刪除文件; broadcast
  scheduleSave()         → 1s 去抖後調用 flush()
  flush()                → 原子寫入 JSON 文件
  destroy()              → 立即 flush + 清理定時器
}
```

**與 file-watcher.js 的協作：**

```
當前（內存僅）:
  file-watcher._endSession()
    → editSessionCounts[path]++
    → broadcast edit-counts:update

改造後:
  file-watcher._endSession()
    → editSessionCounts[path]++
    → activityStore.recordEdit(path)  ← 新增
    → broadcast edit-counts:update

  agent-monitor._endReading() [F16]
    → activityStore.recordRead(path)  ← 新增
    → broadcast reading-counts:update
```

**WebSocket 恢復協議：**

```
客戶端連接時（包括重連後）:
  1. 服務端發送 project:state（含完整分析數據）
  2. 服務端同時發送 activity:state（含 editCounts + readingCounts + globalSessionId）
  3. 客戶端 visualizer 恢復所有計數和熱力圖

這確保：
  - 新打開的瀏覽器標籤頁能看到完整歷史數據
  - WebSocket 重連後不丟失計數
  - 刷新頁面後視覺狀態完全恢復
```

### 核心視覺機制詳細規格

### F05 實時編輯動效（修訂版）

**觸發邏輯：**
```
chokidar change 事件到達
  ↓
file-watcher._handleChange():
  ├─ 首次 change → 發送 agent:editing-start（節點進入編輯狀態）
  └─ 每次 change → 重置 session 計時器（2500ms）
      ↓
visualizer 收到 agent:editing-start:
  ├─ 節點填充色設為 #FF6B35（立即生效）
  └─ 節點 filter 設為 url(#glow-editing)（feGaussianBlur stdDeviation=7）
      ↓
2500ms 內無新 change 事件
  ↓
agent:editing-end 發送
  ↓
visualizer 收到 agent:editing-end:
  ├─ 填充色 CSS transition 500ms ease-out → 原色
  └─ filter CSS transition 500ms ease-out → 無（或對應熱力圖 filter）
```

**設計約束：**
- 編輯中光暈通過 SVG `<filter>` + `feGaussianBlur` 實現，不修改節點半徑
- 消退使用 CSS transition，不使用 setTimeout 跳變
- 消退持續時間：500ms ease-out
- 發光色：橙色 `#FF6B35`，與熱力圖外光暈色系一致但亮度更高
- 節點大小固定，物理模擬不受影響，佈局不發生漂移

### F06 編輯熱力圖（修訂版）

**計數規則：**
- 編輯會話定義：防抖窗口 2500ms 內的連續 change 事件合併計為 1 次會話
- 計數由 `activity-store.js` 管理：內存快取 + 文件持久化（`.vibe-guarding-activity.json`）
- 計數只增不減，頁面刷新、服務重啟、項目切換後自動還原

**發光強度分級：**

| 會話次數 | 外光暈 stdDeviation | 發光 opacity | 語義 |
|---------|-------------------|-------------|------|
| 0 | 0 | 0 | 未編輯，無發光 |
| 1–3 | 3 | 0.3 | 輕度編輯 |
| 4–8 | 6 | 0.5 | 中度編輯 |
| 9–15 | 10 | 0.7 | 高頻編輯 |
| > 15 | 14 | 0.85 | 極高頻，發光上限 |

**設計約束：**
- 發光不改變節點半徑，不影響力導向碰撞半徑
- 熱力圖與實時動效共用同一 SVG filter，通過疊加 opacity 區分
- **熱力圖刷新頻率：每 30 秒重新計算一次發光強度**，不做每次事件觸發（減少 DOM 操作）

### F09 視圖切換過濾規則

**現有視圖切換（D3 內部）：**
- 開發者視圖（全量）與小白視圖（過濾基建文件）共用 D3 圖譜引擎
- 過濾邏輯為規則引擎，不調用 LLM

**F17 新增視圖切換（圖譜 vs 地形）：**
- 在頂部工具欄新增下拉選擇器：`[ 力導圖 | 3D 地形圖 ]`
- 切換時互斥顯示，不共存
- 切換邏輯見 F17 視覺規格章節

### F17 新增視圖切換交互

地形視圖下，小白視圖過濾規則保持生效（僅業務文件出現在曲面上）

**小白視圖過濾的基建文件 pattern（規則引擎，不調用 LLM）：**

```
路徑 pattern:
  node_modules/**
  .git/**
  dist/**
  build/**
  .cache/**
  coverage/**
  .turbo/**

文件名 pattern:
  *.config.js / *.config.ts / *.config.mjs
  .eslintrc* / .prettierrc* / .babelrc*
  package-lock.json / yarn.lock / pnpm-lock.yaml / *.lock
  *.test.js / *.test.ts / *.spec.js / *.spec.ts
  __tests__/**
  .env* / *.env
  Dockerfile

深度規則:
  路徑深度 > 4 層的文件默認隱藏（可配置）
```

### F05 消退 CSS Transition 規格

```css
.vg-node .node-body {
  transition: fill 500ms ease-out, filter 500ms ease-out;
}
.vg-node .heat-ring {
  transition: fill 500ms ease-out, filter 500ms ease-out, opacity 500ms ease-out;
}
```

### F16 注意力雷達 — 讀取狀態視覺規格

**觸發邏輯：**
```
AgentProcessMonitor 輪詢 (800ms 間隔)
  ↓
lsof -p <PID> -F n 輸出變化偵測
  ↓
對比上次快照 → 發現新增打開文件（在 projectRoot 範圍內且不在忽略清單）
  ↓
文件連續 2 次輪詢皆在打開清單 → 發出 agent:reading-start
  ↓
文件從打開清單消失 → 發出 agent:reading-end
```

**WebSocket 事件格式：**
```json
{ "type": "agent:reading-start", "path": "src/services/auth.ts" }
{ "type": "agent:reading-end",   "path": "src/services/auth.ts" }
```

**視覺規格：**

| 屬性 | 值 | 備註 |
|------|-----|------|
| 節點填充色 | `#00E5FF`（冷青色） | 與編輯狀態橙紅 `#FF6B35` 形成色溫對立 |
| 外光暈 | `feGaussianBlur stdDeviation=6` | 略弱於編輯光暈（stdDeviation=7） |
| 動畫週期 | 慢呼吸脈衝 2000ms | 區別於編輯快脈衝 700ms |
| 節點縮放 | scale 1.15 | 輕微放大表示「正在被關注」 |
| 外圈動畫 | 旋轉虛線環 | 模擬雷達掃描效果 |
| tooltip | 顯示 `● reading` + 已讀時長（累計） | 橙色 `editing` 之上疊加青色 `reading` |
| 消退轉場 | CSS transition 800ms ease-out | 比編輯消退（500ms）更慢，體現「閱讀殘留」 |

**讀取計數規則：**
- 會話定義：文件連續出現在 lsof 結果期間記為一次讀取會話
- 讀取期間若該文件也發生 change 事件 → 同時顯示 reading + editing 狀態（青色底 + 橙色光暈疊加）
- 讀取會話計數獨立於編輯會話計數，互不影響

**CSS class 設計：**
```css
/* reading 狀態節點 — 藍色呼吸發光 */
.vg-node.reading .node-body {
  fill: #00E5FF;
  filter: url(#glow-reading);
  animation: breathe-reading 2s ease-in-out infinite;
}

.vg-node.reading .breathing-ring {
  stroke: #00E5FF;
  stroke-dasharray: 4,4;
  animation: rotate-ring 3s linear infinite;
}

@keyframes breathe-reading {
  0%, 100% { r: var(--node-r); }
  50%      { r: calc(var(--node-r) * 1.15); }
}

@keyframes rotate-ring {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
```

### F16 注意力雷達面板規格

在原有細節面板基礎上，增加雷達面板（可選展開）：

```
━━━━━━━━━━━━━━━━━━━━━━━━━
 注意力雷達                 [x]
━━━━━━━━━━━━━━━━━━━━━━━━━
 ● 正在閱讀: src/services/auth.ts    (3s)
 ● 正在閱讀: src/config/db.ts        (1s)
 ─────────────────────────
 最近閱讀 (最近 5 個):
 ○ src/utils/jwt.ts                   (已關閉)
 ○ src/models/user.ts                 (已關閉)
 ─────────────────────────
 Agent 路徑: src/services/ → src/config/ → src/utils/
━━━━━━━━━━━━━━━━━━━━━━━━━
```

### F17 3D 活動地形圖 (Activity Terrain Map) — 視覺規格

**定位：** D3 力導圖之外的可切換第二視圖，基於 Three.js WebGL 渲染，提供等高線地形視角理解 Agent 活動分布。

```
視圖切換控件:
[ D3 圖 ⚬|⚬ 3D 地形圖 ]
       ↑ 視圖互斥切換，不共存
```

**地形生成管線：**

```
[輸入] 項目分析數據 (nodes + edges)
  ↓
1. 族群聚類：按目錄深度 1–2 層分組（src/components/ → "components" 族）
   ├─ 每個族群計算中心點 (x, y)
   └─ 族群間最小間距控制，避免山體重疊
  ↓
2. 高度場生成 (Z 軸 = Agent 活動熱力)
   ├─ 基底海拔: 該族群內所有文件的編輯會話次數 + 讀取會話次數總和
   ├─ 曲面平滑: 高斯核函數 + 雙線性插值，輸出 128×128 格點高度圖
   ├─ 族群間凹陷: 不同族群之間強制拉低海拔，形成"山谷"
   └─ 時間衰減: 舊活動海拔緩慢下沉，新活動持續推高
  ↓
3. 網格構建 (Three.js BufferGeometry)
   ├─ 頂點數: ~16,384 (128×128)
   ├─ 法線計算: 自動生成，用於光照
   └─ UV 映射: 用於等高線紋理位置
  ↓
4. 等高線提取
   ├─ 按海拔層切片（8–12 層，間距自適應）
   ├─ 每層輸出閉合 LineLoop
   └─ 海拔層顏色映射：低層(暗紫) → 中層(青綠) → 高層(橙紅)
  ↓
5. 節點定位
   ├─ 文件中點映射到曲面對應 (x, y) 位置
   ├─ 海拔 = 曲面海拔 + 恒定偏移（浮於曲面上方）
   └─ 節點以球體/晶體呈現，大小=文件複雜度，顏色=角色
  ↓
6. Agent 事件映射
   ├─ agent:editing-start → 對應節點"噴發"粒子 + 局部地塊隆起動畫
   ├─ agent:reading-start → 節點藍色脈衝光環
   └─ agent:editing-end/reading-end → 消退
```

**視覺風格規格：**

| 屬性 | 值 | 備註 |
|------|-----|------|
| 曲面材質 | `MeshPhysicalMaterial` + 漸層頂點色 | 低海拔→暗灰藍，高海拔→暖橙紅 |
| 曲面透明度 | 0.85 | 可透見背面等高線層 |
| 等高線顏色 | 低: `#3B1F6E` → 中: `#00E5FF` → 高: `#FF6B35` | 8–12 層漸變 |
| 等高線寬度 | 1.5px，hover 區域 → 3px | 使用 TubeGeometry 或 Line2 |
| 等高線發光 | 高海拔層疊加 bloom 效果 | |
| 非 hover 等高線 | opacity 0.2 | 全局 dim 確保對比 |
| hover 區域等高線 | opacity 1.0 + 加亮 | Raycaster 判定 UV 範圍 |
| 節點球體 | `SphereGeometry(r)`，r = log2(file_lines) | 文件越大節點越大 |
| 節點顏色 | 同 D3 角色色譜 | 保持與 D3 視圖一致 |
| 編輯狀態節點 | 橙色發光 + 跳動動畫 | |
| 讀取狀態節點 | 青色呼吸環 | |
| 背景 | 深紫→深藍漸層 + 粒子星場 | |
| 光照 | HemisphereLight + DirectionalLight | 自然光照+陰影 |

**等高線高亮機制（關鍵交互）：**

```
每幀執行:
  ├─ Raycaster.setFromCamera(mouse, camera)
  ├─ 檢測與 terrainMesh 的交叉點
  ├─ 取得交叉點的 UV 坐標
  ├─ 以 UV 為中心，計算半徑 r=0.15 內的等高線 segment
  ├─ 該 segment → opacity 1.0 + 顏色提亮 (multiply 1.5x)
  └─ 其餘等高線 → opacity 0.15–0.25
```

**視圖切換邏輯：**

```
頂部工具欄:
  [ 視圖: 圖譜 ▼ ]
         ├─ 力導圖 (D3)
         └─ 地形圖 (3D)

切換流程:
  用戶點擊「地形圖 (3D)」
    ↓
  currentView 切換為 'terrain'
    ↓
  隱藏 D3 SVG 容器 (display:none)
    ↓
  顯示 Three.js Canvas 容器
    ↓
  調用地形生成管線（如果尚未生成）
    ↓
  Three.js renderer 進入 animation loop
    ↓
  WebSocket 事件路由到 terrain-view.js 而非 visualizer.js

  切回 D3 圖時反向操作，保留 Three.js 場景避免重新生成
```

**入場動畫：**
- 載入後相機從俯視 90° 開始，以 1.5s 緩動到 45° 斜視角
- 地形從"海平面"開始，逐步隆起至最終海拔（1.5s easeOutCubic）
- 等高線延遲 0.5s 後淡入
- 節點在最後階段以 explosion 模式飛入定位

**Three.js 架構依賴（CDN 加載）：**

| 依賴 | 用途 | 大小 (gzip) |
|------|------|-------------|
| three.min.js | 核心 WebGL 引擎 | ~65KB |
| OrbitControls | 視角旋轉/縮放/平移 | ~5KB |
| EffectComposer (optional) | Bloom 後處理 | ~8KB |

---

## 5. AI 介入策略 (AI Integration Strategy)

### 核心原則

**主鏈路零 LLM，交互式查詢層可引入 LLM。**

實時文件監控、圖譜渲染、熱力圖計算、雙視圖過濾，全部為確定性規則引擎，不調用 LLM，確保主鏈路 100% 可預測、零延遲依賴。

### LLM 調用位置

| 功能 | 目的 | 觸發時機 | 方式 | 是否阻塞主鏈路 |
|------|------|---------|------|--------------|
| F10 語義描述生成 (batch) | 為每個業務文件生成大白話描述 | 項目載入完成後異步觸發，不阻塞 UI | 讀取 `.vibe-guarding.json` 中的 API Key，向 LLM API 發送批量請求 | 否 |
| F13 節點詢問 Agent (single) | 按需查詢單個節點的角色說明與設計意圖 | 用戶點擊「詢問 Agent」按鈕 | 節點上下文組裝（完整文件內容 + 依賴關係 + 目錄上下文）→ LLM 調用 → 結果渲染至細節面板 | 否（loading spinner） |

### F13 節點詢問 Agent — Prompt 策略

```
系統角色：
  你是一位專業的軟體架構師，擅長從整體項目結構的角度解釋單個文件的職責與設計意圖。

上下文組裝（Layer 1 — 即時讀取）：
  {
    "target": { "path": "src/services/auth.ts", "role": "service", "name": "auth.ts" },
    "fullContent": "import { User } from '../models/user';\nimport { sign } from 'jsonwebtoken';\n...",  // 完整文件內容，不截斷
    "imports": ["../models/user", "../utils/jwt", "bcrypt"],
    "importedBy": ["src/api/routes/login.ts", "src/api/middleware/auth.ts"],
    "siblingFiles": ["src/services/user.ts", "src/services/email.ts"],
    "directory": "src/services/"
  }

上下文組裝（Layer 2 — 知識庫模式，未來實現）：
  {
    "target": { "path": "src/services/auth.ts", "role": "service", "name": "auth.ts" },
    "summary": "認證服務，處理 JWT 權杖生命週期",  // 來自預生成摘要
    "imports": ["../models/user", "../utils/jwt", "bcrypt"],
    "importedBy": ["src/api/routes/login.ts"],
    "projectContext": "電商平台的用戶身份層，依賴 User model 和 JWT 工具",
    "knowledgeBase": "project-knowledge 預掃描結果（佔比最大參考來源）"
  }

輸出格式（JSON Schema）：
  {
    "summary": "less than 100 chars",
    "responsibility": "less than 200 chars",
    "designPattern": "less than 50 chars or null",
    "relatedModules": ["path1", "path2"]
  }

約束：
  - 不輸出技術黑話（若必須使用則附帶簡短解釋）
  - 如果無法判斷，返回 null 而非猜測
  - Layer 1 讀取完整文件內容，不截斷
  - Layer 2 優先生讀取知識庫摘要，按需補全文件內容
```

### F10 批量語義描述的 Prompt 模板

```
# Role
你是一個極具耐心的編程導師，擅長用最通俗易懂的隱喻向完全沒有編程基礎的人解釋軟體工程。

# Task
我將提供一個軟體項目的文件列表（含文件路徑和角色類型）。
請為每個文件生成一段大白話描述，幫助非技術用戶理解它的作用。

# Rules
1. 禁用一切技術黑話（路由、DOM、依賴注入、異步請求等）。
2. 使用生活化隱喻（大腦、圖紙、倉庫、快遞員、皮膚等）。
3. 每條描述不超過 20 個字。
4. 嚴格按 JSON Schema 輸出，不輸出任何額外文字。

# Output Format (Strict JSON)
{
  "mappings": [
    {
      "path": "client/index.html",
      "human_name": "網頁骨架",
      "metaphor_desc": "用戶看到的頁面基礎框架"
    }
  ]
}
```

### API 接口定義

#### POST /api/agent/ask-node（F13 新增）

```
Request:
  {
    "path": "src/services/auth.ts",
    "role": "service",
    "imports": ["../models/user", "../utils/jwt"],
    "importedBy": ["src/api/routes/login.ts"],
    "fullContent": "import { User } from '../models/user';\nexport async function verifyToken...\n..."  // 完整文件內容
  }

Response:
  {
    "summary": "用戶認證服務，處理登入與權杖驗證",
    "responsibility": "負責 JWT token 的生成、驗證和刷新，以及用戶密碼的比對",
    "designPattern": "Singleton + Factory",
    "relatedModules": ["src/models/user.ts", "src/api/routes/login.ts"]
  }

Error Response:
  { "error": "LLM request failed", "detail": "Timeout after 30s" }
```

---

## 6. 模塊邊界定義

### 系統架構圖

```
開發者工作站
├─ Browser (http://localhost:3001)
│  ├─ [視圖選擇]
│  │  ├─ D3.js Force Graph (預設)
│  │  │  ├─ Layer 1: 實時動效（外光暈，文件寫入時觸發，500ms 消退）
│  │  │  └─ Layer 2: 熱力圖（外光暈強度隨編輯會話次數累積，30s 刷新）
│  │  └─ Three.js Terrain Map (F17)
│  │     ├─ 3D 曲面網格 + 等高線疊層
│  │     ├─ 節點族群分布 + 活動海拔
│  │     └─ 等高線 hover 高亮交互
│  ├─ Sidebar Tree View（左側，支持過濾）
│  ├─ Details Panel（右側，節點信息 + 複製路徑 + 詢問 Agent）
│  ├─ Attention Radar Panel（F16）
│  └─ Activity Log（底部，300 條環形緩衝）
│        ↕ WebSocket (ws://localhost:3001)
│        ↕ Poll GET /api/llm/descriptions（每 3 秒，最多 20 次）
├─ Vibe Guarding Server (Node.js)
│  ├─ Express (REST API)
│  │  ├─ POST /api/project/open
│  │  ├─ GET  /api/project/analyze
│  │  ├─ GET  /api/project/human-descriptions
│  │  ├─ GET  /api/llm/descriptions
│  │  ├─ GET  /api/llm/logs
│  │  └─ POST /api/agent/ask-node (F13)
│  ├─ WebSocket Server（實時推送文件事件）
│  ├─ chokidar Watcher（文件系統監聽 — change/add/unlink）
│  ├─ activity-store.js（F00 — 活動數據持久化讀寫引擎）
│  ├─ agent-monitor.js（F16 — lsof 輪詢引擎 — 讀取偵測）
│  ├─ llm-service.js（異步語義生成 + 節點問詢，不接觸 broadcast()）
│  └─ project-knowledge.js（Layer 2 — 項目知識庫管理）
│        ↕ fs events / lsof output / .vibe-guarding-activity.json
└─ 受監控項目目錄
   ├─ .vibe-guarding.json（用戶配置，含 API Key，可選）
   ├─ .vibe-guarding-cache.json（LLM 描述緩存，自動生成）
   └─ src/ ...
```

### 模塊邊界約束（硬性）

```
server/index.js       → 只負責 WebSocket 生命週期 + 路由註冊 + broadcast()
                         禁止感知 LLM 存在，禁止在 broadcast() 內 await 任何異步操作
                         禁止直接調用 llmService.askNode()（應通過 Express 路由委託）
                         項目打開時初始化 activity-store.js，關閉時調用 destroy()

server/activity-store.js（F00 新增）→ 只負責活動數據的持久化讀寫
                         內存快取 + 文件持久化（`.vibe-guarding-activity.json`）
                         寫入採用 1s 去抖 + 原子寫入（tmp + rename）
                         禁止感知 D3/圖譜/LLM 的存在
                         禁止在無 projectRoot 時運行
                         暴露 clear() 方法供 UI 調用

server/llm-service.js → 只負責讀配置、調用 LLM API、讀寫緩存、暴露 /api/llm/* 端點
                         禁止調用 broadcast()，禁止修改文件監控行為
                         新增 askNode() 方法返回 Promise，由路由層 await

server/project-knowledge.js（Layer 2）→ 只負責項目文件掃描、摘要生成、知識庫查詢
                         禁止調用 broadcast()，禁止修改文件監控行為
                         依賴 llm-service.js 進行 LLM 調用

server/agent-monitor.js（F16 新增）→ 只負責 lsof 輪詢、PID 發現、增量 diff、發射 reading-start/end 事件
                         禁止感知 D3/圖譜渲染，禁止修改文件監控行為
                         輪詢週期默認 800ms，用戶可配置
                         禁止在無 projectRoot 時運行

client/visualizer.js  → 只負責 D3 圖譜渲染、節點增量更新、雙視圖過濾、熱力圖渲染
                         禁止直接調用任何 API，禁止感知 WebSocket 連接狀態

client/terrain-view.js（F17 新增）→ 只負責 Three.js 地形渲染、等高線計算、族群聚類、
                         滑鼠交互、WebGL 動畫循環
                         禁止感知 WebSocket 狀態，通過 app.js 接收標準事件
                         視圖切換時不銷毀場景，僅 toggle DOM 顯示
                         依賴 CDN 加載 three.min.js + OrbitControls

client/app.js         → 只負責 WebSocket 消息路由、poll LLM 描述、更新 tooltip、
                         管理細節面板、發起 F13 查詢、管理視圖切換狀態
                         將標準事件同時分發給 visualizer.js 與 terrain-view.js（當前激活的視圖）
                         禁止直接渲染 D3 節點或 Three.js 場景
```

---

## 7. 降級與兜底策略 (Fallback Strategy)

| 風險項 | 描述 | 降級方案 |
|--------|------|---------|
| **D3 邊渲染斷裂** | 增量更新後 source/target 引用失效，邊退化為 M0,0L0,0 | 每次增量更新將 edge source/target 統一轉回 id 字符串，交給 forceLink 重新解析（FIX-01） |
| **WebSocket 斷線** | 長連接中斷 | 指數退避自動重連（1s/2s/4s，max 30s），斷線期間緩存事件於隊列，重連後批量發送 |
| **文件監控失敗** | chokidar 權限不足或 inotify 限制 | 降級為輪詢模式（每 2 秒掃描），activity log 提示用戶調整目錄權限 |
| **D3 性能瓶頸** | 節點 > 2000 時渲染卡頓 | 提示用戶切換小白視圖縮減節點數量；不自動過濾（保留用戶控制權） |
| **超大項目** | node_modules 未正確排除導致掃描爆炸 | 默認排除清單（node_modules / .git / dist / build），深度上限 12 層 |
| **依賴解析失敗** | 動態 import / 路徑 alias 等非標準語法 | 跳過無法解析的 import，activity log 標註 `[unresolved]`，不阻塞渲染 |
| **lsof 權限不足（F16）** | macOS SIP/TCC 阻止查詢目標進程 | 降級只監控文件變更（退化到當前模式），activity log 提示用戶授權終端 Full Disk Access |
| **Agent 進程未運行（F16）** | 指定進程不存在或尚未啟動 | 靜默等待，每 5 秒重試一次 PID 發現，不拋出錯誤，不阻塞其他功能 |
| **lsof 輪詢超載（F16）** | 極大項目導致 lsof 輸出 > 1000 行，輪詢延遲超標 | 動態降低輪詢頻率（800ms → 2000ms），或跳過本次輪詢 |
| **Agent PID 漂移（F16）** | Agent 重啟 / 子進程產生 / 容器化運行導致 PID 變化 | 定期 pgrep 重試 PID 發現，支持模糊進程名匹配（claude/cursor/windsurf），最多同時追蹤 3 個子進程 |
| **LLM 批量生成失敗（F10）** | 無配置 / Key 無效 / 網絡中斷 | 靜默降級到硬編碼描述，activity log 寫入 `[llm] warning`，不拋出用戶可見錯誤 |
| **LLM 按需查詢失敗（F13 Layer 1）** | API Key 無效 / 網絡中斷 / 文件讀取失敗 | 按鈕顯示錯誤提示「查詢失敗，請稍後重試」，不阻塞其他功能 |
| **LLM 知識庫掃描失敗（F13 Layer 2）** | 批量摘要生成超時或部分失敗 | 使用已成功的部分摘要，失敗文件標記為「未掃描」，下次項目打開時重新嘗試 |
| **無項目打開** | 用戶首次加載頁面 | 顯示空狀態引導：圖示 + Open Project 按鈕 + 單行說明 |
| **瀏覽器不兼容** | 不支持 ES Module 或 D3.js v7 | 顯示兼容性提示，要求使用 Chrome / Firefox / Edge 最新版 |
| **編輯動畫頻繁觸發** | 高頻 change 事件導致視覺疲勞 | 500ms 防抖窗口合併，消退 transition 完成前不重新觸發動畫 |
| **Three.js CDN 加載失敗（F17）** | 網絡中斷或 CDN 不可達 | 3D 地形視圖按鈕禁用，顯示提示「CDN 加載失敗，請檢查網絡」，D3 視圖正常使用 |
| **Three.js 性能不足（F17）** | 低端 GPU / 集成顯卡導致幀率 < 20 FPS | 自動檢測幀率，連續 5 秒 < 20 FPS 時彈出提示「建議切換回 D3 視圖」，不強制切換 |
| **活動數據文件損壞** | `.vibe-guarding-activity.json` 格式錯誤或版本不匹配 | 靜默初始化為空數據（editCounts={}, readingCounts={}, history=[]），原文件備份為 `.vibe-guarding-activity.json.bak` |
| **活動數據寫入失敗** | 磁碟空間不足 / 權限不足 / 文件鎖定 | 降級為純內存模式，activity log 寫入 `[store] write error`，不阻塞其他功能 |
| **活動數據清除操作** | 用戶點擊「清除活動數據」| 原子操作：清空內存 → 刪除文件 → broadcast activity:state（空）→ 不可逆，操作前二次確認 |
| **地形數據不足（F17）** | 文件數 < 10，無法形成有效地形 | 直接顯示「項目過小，不適合地形視圖」提示，保持 D3 視圖 |
| **等高線計算超時（F17）** | 極大項目（> 5000 文件）導致地形成本 > 2s | 降級為不渲染等高線，僅顯示曲面 + 節點，activity log 提示 |

---

## 8. 評測指標與驗收標準 (Evals & Acceptance Criteria)

### 定量指標

| 指標 | 目標值 | 測量方式 |
|------|-------|---------|
| 文件事件到動效觸發延遲（P95） | < 200ms | 瀏覽器 Performance API 計時 |
| 圖形渲染幀率 | > 30 FPS（500 節點以內） | Chrome DevTools FPS meter |
| WebSocket 斷線重連 | 3 秒內自動重連 | 手動斷網測試 |
| 依賴解析準確率（JS/TS） | > 85% | 與 `madge` 工具輸出對比 |
| 節點角色辨識準確率 | > 80% | 人工抽樣 50 個文件驗證 |
| LLM 描述生成成功率 | > 90%（有效 Key + 網絡正常條件下） | 測試項目跑通全流程 |
| F13 節點查詢響應時間（P95） | < 8s | 10 次連續查詢計時 |
| F16 讀取偵測延遲（lsof 輪詢） | P95 < 2.5s | 計時 Agent 訪問文件 → 前端 WebSocket 收到 agent:reading-start |
| F16 讀取誤報率 | < 15% | 抽樣 50 次打開事件人工驗證 |
| F16 PID 綁定成功率 | > 90%（進程存活條件下） | 啟動後 10 秒內成功關聯目標進程 |
| F17 地形初始化時間 | < 3s（500 節點以內） | 計時視圖切換點擊 → 地形完整呈現 |
| F17 3D 渲染幀率 | > 30 FPS（中等 GPU, 500 節點） | Chrome DevTools FPS meter |
| F17 等高線 hover 響應延遲 | < 50ms | 滑鼠移動→等高線高亮變化的幀間隔 |
| F00 寫入去抖延遲（P95） | < 1.5s（從事件發生到文件 flush） | 端到端計時：activity-store.recordEdit() → 文件寫入完成 |
| F00 數據恢復正確率 | 100%（文件未損壞條件下） | 重啟後讀取 editCounts 與重啟前比對 |
| F00 大項目恢復時間 | < 500ms（5000 條歷史以內） | 計時 project open → activity:state broadcast 完成 |

### 定性驗收

| 場景 | 驗收標準 |
|------|---------|
| 首次打開項目 | 5 秒內呈現完整圖譜，節點佈局穩定 |
| 文件被 AI 寫入 | 對應節點 200ms 內觸發外光暈動效，消退 smooth 無跳變 |
| 連續編輯同一文件 | 熱力圖發光強度隨會話次數累積增強，30s 刷新一次 |
| 文件新增 | 新節點 1 秒內出現，依賴邊正確連接，無 M0,0L0,0 |
| 文件刪除 | 節點與關聯邊 1 秒內消失，無殘留 |
| 切換小白視圖 | 基建節點 300ms 內隱藏，業務節點保留，切換不重建圖譜 |
| LLM 描述加載完成 | tooltip 顯示大白話描述，無 LLM 描述時顯示硬編碼角色名 |
| F13 節點查詢 | 點擊「詢問 Agent」後 8 秒內顯示分析結果，失敗時顯示錯誤提示 |
| 無 `.vibe-guarding.json` | 工具正常啟動，無任何報錯，tooltip 使用硬編碼描述 |
| 頁面刷新後數據恢復 | 刷新瀏覽器 → 所有編輯計數、讀取計數、熱力圖恢復至刷新前狀態 |
| 服務重啟後數據恢復 | 關閉服務 → 重啟 → 恢復項目 → 所有計數恢復（與刷新測試一致） |
| 切換項目再切回 | 打開項目 A → 編輯若干文件 → 切換到項目 B → 切回 A → A 的編輯計數仍在 |
| 批量文件變更（10+ 文件） | 圖譜 3 秒內完成更新，無卡頓 |
| 切換到 3D 地形視圖（F17） | 3 秒內呈現完整地形，曲面平滑無鋸齒，等高線清晰可辨 |
| 3D 地形 hover 等高線（F17） | 滑鼠移動到某區域，該區域等高線即時提亮，其餘變暗，無明顯延遲 |
| 3D 地形 Agent 活動映射（F17） | Agent 編輯文件後，對應山體/節點海拔在 5 秒內可見變化 |
| 3D 地形旋轉操作（F17） | OrbitControls 流暢，無卡頓、無翻轉異常 |

---

## 9. 冷啟動數據策略 (Cold Start Data Strategy)

### 初期數據來源

| 數據類型 | 來源 | 獲取方式 |
|---------|------|---------|
| 項目文件結構 | 用戶指定目錄 | 啟動時遞歸掃描文件系統 |
| 依賴關係 | 項目源代碼 | 全量掃描 import/require |
| 文件角色 | 文件路徑 + 擴展名 | 規則引擎推斷 |
| 編輯會話計數 | 運行時內存 + `.vibe-guarding-activity.json` | 從緩存文件恢復，項目關閉持久化 |
| 讀取會話計數（F16） | 運行時內存 + `.vibe-guarding-activity.json` | 同編輯計數，獨立記錄 |
| 活動歷史記錄 | 運行時內存 + `.vibe-guarding-activity.json` | 環形緩衝 5000 條，持久化 |
| LLM 語義描述 | `.vibe-guarding-cache.json` | 優先讀緩存，無緩存則異步生成 |

### 語義描述優先級鏈

```
讀取順序（從高到低）:
  1. .vibe-guarding-cache.json（LLM 生成緩存）
  2. project-analyzer.js 硬編碼規則映射表
  3. 原始角色名（component / service / config 等）
```

---

## 10. 風險與合規聲明 (Risk & Compliance)

### 數據隱私邊界

- **主鏈路完全本地**：文件監控、圖譜渲染、熱力圖計算均在本地進行，無任何數據上傳
- **LLM 調用例外**：F10/F13 會將文件路徑與角色信息發送至用戶指定的 LLM API（OpenAI 或 Anthropic）。用戶對此知情且主動配置，數據隱私責任由用戶與 LLM 服務商共同承擔
- **不發送文件內容**：發送給 LLM 的僅為文件路徑和角色類型，不包含文件源代碼內容（F13 僅發送前 500 字符片段作為上下文）
- **CDN 依賴**：D3.js 從 CDN 加載，首次加載需要網絡訪問；F17 地形視圖另需 three.min.js + OrbitControls（~78KB gzip）

### 開源與知識產權

- Vibe Guarding 本身採用 MIT 授權
- 用戶項目的文件路徑與結構信息歸用戶所有

### 算法透明度

- 角色辨識、依賴分析、熱力圖計算均為確定性規則引擎，無不透明決策路徑
- 所有推斷規則定義於 `project-analyzer.js`，用戶可審閱與修改
- 無算法備案要求（不涉及個人信息處理或自動化決策）

---

## 11. 工程紀律規則

### 代碼量警戒線

| 文件 | 警戒線 | 超限措施 |
|------|--------|---------|
| activity-store.js | < 200 LOC | 持久化模塊需控制邏輯複雜度 |
| visualizer.js | < 800 LOC | 強制拆分渲染引擎 / 交互層 / 數據層 |
| app.js | < 600 LOC | 強制拆分消息處理 / 狀態管理 / UI 控制 |
| llm-service.js | < 400 LOC | 超限說明為何必要 |
| agent-monitor.js | < 250 LOC | 超限需拆分輪詢引擎與數據處理 |
| terrain-view.js | < 800 LOC | 強制拆分地形生成 / 等高線引擎 / 交互控制 |
| styles.css | < 900 LOC | 基建樣式與功能樣式分離文件 |
| 單個功能 PR | < 200 LOC diff | 需說明為何超過 |

### 新功能准入檢查清單

在添加任何新功能前，必須自檢：

- [ ] 這個功能解決的是用戶報告的痛點，不是「可能有用」？
- [ ] 它屬於哪個優先級（P0 / P1 / P2）？P1 功能必須 P0 全部通過驗收後才能啟動
- [ ] 預估新增代碼量是否 > 200 LOC？如是，先做架構設計再動手
- [ ] 它是否依賴外部 API？如是，降級方案必須在編碼前定義
- [ ] 它會修改哪些現有文件？必須列出所有需要改動的模塊
- [ ] 如果沒有這個功能，用戶的核心體驗是否受影響？
- [ ] 如果涉及累積數據（計數/熱力/活動歷史），是否已接入 F00 activity-store.js 做持久化？
- [ ] F05 消退是否已通過 CSS transition 驗收？否則不開始 F14

### 版本規劃

```
[最高優先級] F00 活動數據持久化
  新增 server/activity-store.js（~150 LOC）
  依賴：無（獨立的文件讀寫模塊）
  影響範圍：F05/F06（編輯計數可復原）+ F16（讀取計數可復原）+ F17（地形海拔基於累積數據）
  前置依賴：F00 必須在 F16/F17 實現之前完成

v1.0.0 — 當前版本
  P0: F01-F08 全部就緒
  P1: F09-F12 已實現，F13 待實現

v1.1.0 — 下一個 Sprint
  P1: F13 節點詢問 Agent — Layer 1（即時讀取完整文件內容 + LLM 查詢）
      依賴：復用 .vibe-guarding.json 配置，無額外存儲需求
      預估：~120 LOC（server + client）

v1.2.0 — 未來版本
  P1: F13 節點詢問 Agent — Layer 2（項目知識庫模式）
      新增 server/project-knowledge.js（~200 LOC）
      項目打開時後台異步掃描全文件 → 生成摘要 → 寫入擴展緩存
      Ask 查詢優先生讀取知識庫摘要，按需補全文件內容
  P2: F14 編輯視覺強化（外圈呼吸 stroke 脈衝）

v1.3.0+ — 遠期
  P2: F15 結構健康度評分
  P2: F16 注意力雷達（Agent 讀取監控）
      新增 server/agent-monitor.js（~200 LOC）
      lsof 輪詢引擎 + 前端 reading 狀態渲染 + 注意力雷達面板
      依賴：macOS lsof 命令（系統自帶），需用戶指定 Agent 進程名
  P2: F17 3D 活動地形圖（Agent 活動等高線地圖）
      新增 client/terrain-view.js（~800 LOC）
      Three.js 3D 曲面地形 + 等高線 hover 高亮 + 視圖切換
      依賴：three.min.js 從 CDN 加載（~65KB gzip）
      工作量：~980 LOC 總計（含場景生成 + 等高線 + 交互 + 動畫）
      周期：約 8–10 天
```
