# Vibe Guarding — PRD v2.0.0

> 版本：2.0.1
> 狀態：P0+P1 全部實現，v1.2.0 已合併
> 本文檔替代 v1.0.0 所有章節，根據 2026-04-29 產品決策會議重新編寫，更新於 2026-04-29

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

### 明確不在 v2.0.0 範圍的功能

以下功能在當前版本範圍外，不實現、不討論：

- PRD 上傳與自動目錄生成（F15 的 3a 部分）— 定位為獨立工具，不與監控面板耦合
- 歷史時間軸回放
- IDE 插件整合
- 業務模塊聚合色塊
- Agent 提示詞生成

---

## 4. 核心視覺機制詳細規格

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
- 計數存於內存，項目關閉後清零（不持久化，每次監控從零開始）
- 計數只增不減

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

### F09 雙視圖切換過濾規則

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
│  ├─ D3.js Force Graph
│  │  ├─ Layer 1: 實時動效（外光暈，文件寫入時觸發，500ms 消退）
│  │  └─ Layer 2: 熱力圖（外光暈強度隨編輯會話次數累積，30s 刷新）
│  ├─ Sidebar Tree View（左側，支持過濾）
│  ├─ Details Panel（右側，節點信息 + 複製路徑 + 詢問 Agent）
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
│  ├─ chokidar Watcher（文件系統監聽）
│  ├─ llm-service.js（異步語義生成 + 節點問詢，不接觸 broadcast()）
│  └─ project-knowledge.js（Layer 2 未來新增 — 項目知識庫管理）
│        ↕ fs events
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

server/llm-service.js → 只負責讀配置、調用 LLM API、讀寫緩存、暴露 /api/llm/* 端點
                         禁止調用 broadcast()，禁止修改文件監控行為
                         新增 askNode() 方法返回 Promise，由路由層 await

server/project-knowledge.js（Layer 2）→ 只負責項目文件掃描、摘要生成、知識庫查詢
                         禁止調用 broadcast()，禁止修改文件監控行為
                         依賴 llm-service.js 進行 LLM 調用

client/visualizer.js  → 只負責圖譜渲染、節點增量更新、雙視圖過濾、熱力圖渲染
                         禁止直接調用任何 API，禁止感知 WebSocket 連接狀態

client/app.js         → 只負責 WebSocket 消息路由、poll LLM 描述、更新 tooltip、
                         管理細節面板、發起 F13 查詢
                         禁止直接渲染 D3 節點
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
| **LLM 批量生成失敗（F10）** | 無配置 / Key 無效 / 網絡中斷 | 靜默降級到硬編碼描述，activity log 寫入 `[llm] warning`，不拋出用戶可見錯誤 |
| **LLM 按需查詢失敗（F13 Layer 1）** | API Key 無效 / 網絡中斷 / 文件讀取失敗 | 按鈕顯示錯誤提示「查詢失敗，請稍後重試」，不阻塞其他功能 |
| **LLM 知識庫掃描失敗（F13 Layer 2）** | 批量摘要生成超時或部分失敗 | 使用已成功的部分摘要，失敗文件標記為「未掃描」，下次項目打開時重新嘗試 |
| **無項目打開** | 用戶首次加載頁面 | 顯示空狀態引導：圖示 + Open Project 按鈕 + 單行說明 |
| **瀏覽器不兼容** | 不支持 ES Module 或 D3.js v7 | 顯示兼容性提示，要求使用 Chrome / Firefox / Edge 最新版 |
| **編輯動畫頻繁觸發** | 高頻 change 事件導致視覺疲勞 | 500ms 防抖窗口合併，消退 transition 完成前不重新觸發動畫 |

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
| 批量文件變更（10+ 文件） | 圖譜 3 秒內完成更新，無卡頓 |

---

## 9. 冷啟動數據策略 (Cold Start Data Strategy)

### 初期數據來源

| 數據類型 | 來源 | 獲取方式 |
|---------|------|---------|
| 項目文件結構 | 用戶指定目錄 | 啟動時遞歸掃描文件系統 |
| 依賴關係 | 項目源代碼 | 全量掃描 import/require |
| 文件角色 | 文件路徑 + 擴展名 | 規則引擎推斷 |
| 編輯會話計數 | 運行時內存 | 從 0 開始累積，項目關閉後清零 |
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
- **CDN 依賴**：D3.js 從 CDN 加載，首次加載需要網絡訪問

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
| visualizer.js | < 800 LOC | 強制拆分渲染引擎 / 交互層 / 數據層 |
| app.js | < 600 LOC | 強制拆分消息處理 / 狀態管理 / UI 控制 |
| llm-service.js | < 400 LOC | 超限說明為何必要 |
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
- [ ] F05 消退是否已通過 CSS transition 驗收？否則不開始 F14

### 版本規劃

```
v1.0.0 — 當前版本
  P0: 全部就緒（F05/F06 已閉環）
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
```
