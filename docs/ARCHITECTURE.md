# 架構總覽（ARCHITECTURE）

> 一頁以內的全貌。細節請跟著連結走：模組 → [MODULES.md](MODULES.md)、動作 → [API.md](API.md)、分頁 → [DATA.md](DATA.md)、設定 → [CONFIG.md](CONFIG.md)、維運 → [RUNBOOK.md](RUNBOOK.md)。共通規則 → [AGENTS.md](../AGENTS.md)。

## 元件

| 元件 | 是什麼 | 在哪 |
|---|---|---|
| PWA | 單檔前端（HTML／CSS／JS），1.0 與 2.0 兩套介面共存 | `index.html`、`sw.js`、`manifest.json`，發布在 GitHub Pages |
| 後端 | Google Apps Script Web App，PWA 與 LINE 共用同一個網址 | `apps-script/*.gs` |
| 資料 | 一個 Google 試算表（多張分頁）＋ Google Drive（收藏圖片、郵件附件） | 見 DATA.md |
| LINE | 官方帳號：輸入管道與推播管道 | Webhook 指向後端網址 |
| 排程 | 唯一的時間觸發器 `runScheduler`，每 5 分鐘依序派工 | `scheduler.gs` |
| 外部服務 | AI（Gemini／OpenAI／Claude）、IG 擷取、股票行情、氣象、Gmail、Drive API | 一律經 `callApi_` |

## 資料流

```text
LINE 訊息 ──► doPost ──► routeLineMessage_ ──► writeGate_ ─► 寫 Sheet ──► 回覆＋logs
PWA 操作 ──► 待送佇列 ──► cloudPost ──► doPost ──► routePwaSync_ ──► authDevice_ ─► 守門 ─► 寫 Sheet＋logs
PWA 開機／輪詢 ◄── boot／readMany ◄── 讀 Sheet（依權限過濾）
排程 runScheduler ──► 各工作（收藏抓取→Drive、郵件、股票、提醒推播、用量與效能落地）
```

LINE 寫入的資料，PWA 下次輪詢就會讀到；PWA 寫入的資料，LINE「查/」與排程直接讀 Sheet。

## 同步與衝突規則

- **雲端是唯一真相**：Sheet／Drive 是權威來源；`localStorage` 只放非權威快取、設定與待送佇列，**不得無聲覆蓋雲端**。
- **寫入**：一筆一筆 `upsert`（整張覆寫的 `replaceAll` 已退場）；寫入以後端確認為準，「找列 → 新增／修改」整段包 script lock，避免同一筆併發寫兩列。
- **刪除**：軟刪除（`del`），封存時才實際刪除並寄信備份。
- **衝突**：圖書館筆記帶 `revision`，鎖內比對，不一致回 `conflict` 與雲端新版，前端保留使用者輸入並提示；白板列只有建立者能改。
- **離線**：顯示連線錯誤，不假裝畫面上是最新資料；待送佇列有上限，滿了就不收新修改並明講。

## 權限三層

1. **身份**：PWA 用 LINE 配對換來的裝置 token（後端只存雜湊、閒置過期要續期、可撤銷）；LINE 用訊息裡的 userId。後端一律自己換出身份，不信任請求裡自稱的 `line_id`。
2. **白名單**：`line_users` 的啟用中成員才放行（`writeGate_`，查不到就拒絕）；管理者旗標另外決定管理動作。
3. **功能矩陣＋模組開關**：`feat_*`（個人）與 `_module_registry` 的 `enabled`（全域）都在後端強制執行（`canUse_` 先問模組開關）。各模組再加自己的規則，例如收藏只限擁有者、白板只改自己的。

## 部署管線

PR（base 為 `main`）→ `pr-check`（測試、密鑰掃描、外部呼叫出口、發布白名單；不部署）→ 合併 `main` → `deploy.yml`：Pages 只發布白名單裡的 7 個檔；Apps Script `clasp push` 後更新**既有**正式部署（網址不變），版本說明 `main@<前七碼>`。每次合併都部署，純文件變更也一樣。

## LINE 入口的安全邊界

- Apps Script 的 `doPost` **讀不到 HTTP 標頭**，所以**無法驗證 LINE 的 `x-line-signature` 簽章**。
- `doPost` 只要看到 body 裡有 `events` 陣列，就當成 LINE 事件處理。
- 因此 LINE 入口唯一的防線是 `writeGate_` 白名單：只有啟用中成員的 userId 發出的事件會被處理。**任何成員的 LINE userId 都不能出現在公開位置**（repo、文件、PR、issue）。
- 偽造的事件看不到回覆：回覆是送到 LINE 平台的 reply token，不會回到發出請求的人。
- LINE 事件目前沒有以 `webhookEventId` 去重；同一事件到達兩次會寫兩列（Phase 2 候選）。

## 效能原則

冷開機只讀必要摘要（2.0 先核心層、Widget 再分批）；完整模組按需載入；搜尋、AI、資料擷取不放進冷開機；一個 Widget 失敗不拖垮其他。每個雲端動作都帶 `trigger`，後端依此記一列效能紀錄。
