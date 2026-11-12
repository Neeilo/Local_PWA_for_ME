# 維運手冊（RUNBOOK）

> 部署、確認版本、回退、資料還原與常見故障的步驟。**每一步都標「未驗證」，除非註明已演練**——Phase 1 只寫文件，沒有在正式環境演練任何一步。
> 平常的部署後檢查清單見 [apps-script/OPERATIONS_2_0.md](../apps-script/OPERATIONS_2_0.md)；設定鍵見 [CONFIG.md](CONFIG.md)。

## 部署

| 事件 | 會發生什麼 |
|---|---|
| 開 PR（base 是 `main`） | `.github/workflows/pr-check.yml`：`npm test`、`npm run scan`、`check-api-exit`、發布白名單。**不部署**。 |
| PR 的 base 不是 `main`（疊起來的 PR） | `pr-check` **不會觸發**（它只對 `pull_request: branches: [main]`）。 |
| push 到非 `main` 分支 | 什麼都不跑。 |
| push／合併到 `main` | `.github/workflows/deploy.yml` 兩個獨立 job：**Pages**（`npm test` → 注入 `CLOUD_URL` → 只收白名單 7 個檔 → 發布）與 **Apps Script**（密鑰掃描 → `npm test` → 產生 `build-info.gs` → `clasp push --force` → `clasp deploy -i <既有部署 ID> -d "main@<前七碼>"`）。**沒有路徑過濾，純文件變更也會部署**，並新增一個 Apps Script 版本。 |
| 手動觸發 | `deploy.yml` 有 `workflow_dispatch`，可在 Actions 頁手動執行（等同一次部署）。 |

- 兩個 job 各自成功才算部署完成；任何一個失敗都不能說「已部署」。
- `apps-script/` 是正式來源。**不要在本機 `clasp push`**，也不要在 Apps Script 編輯器直接維護程式；緊急修改後必須 `npm run pull` 收回 repo（見下方「後端緊急止血」）。
- **不要更換正式部署 ID**：新的 exec 網址會讓 LINE Webhook 與 PWA 指向不同後端。

## 部署後：LINE「初始化」

管理者在 LINE **一對一**傳「初始化」（或在編輯器執行 `installAll`，結果一樣）。依序補欄、建表、模組登記、記帳分類、股票、郵件、收藏、成本記帳、重裝排程總管觸發器、重產 `_guide`；每一步可重複執行，已做過的不會重做。回覆只列這次有變動或有 ⚠️ 的步驟。（未驗證：本手冊撰寫時未執行）

唯一例外：第一次授權寄信（`authorizeArchiveMail`）、Gmail 與 Drive（`authorizeGmailController`）要在編輯器由部署者本人按一次。

## 確認線上版本

- **LINE**：傳一個不存在的指令（例如「版本？」），回覆最後一行是 `目前版本：#<執行編號> · main@<前七碼>（<建置時間>）`；寫「未知」代表線上程式不是 CI 部署的（有人在編輯器改過）。（未驗證）
- **GitHub**：Actions → `Deploy to GitHub Pages` 的最新一次 → `apps-script` job 的「Deploy a new version」步驟會印出 `main@<前七碼>`。
- **Apps Script**：編輯器 → 部署 → 管理部署作業 → 正式部署的版本說明是 `main@<前七碼>`。

## 程式回退

### 一般回退（前後端都適用）
1. 對出問題的那次合併開 **revert PR**。（未驗證）
2. 等 `pr-check` 綠燈後合併；CI 會重新部署前後端。（未驗證）
3. 前端有回退時，見下方「PWA 相容性復原」：`sw.js` 的 `CACHE` 版號要**往前加**，不要退回舊號。

### 後端緊急止血（只有後端）
1. Apps Script 編輯器 → 部署 → 管理部署作業 → 編輯**正式部署** → 版本改選上一版（版本說明是 `main@<前七碼>`）→ 部署。exec 網址不變。（未驗證）
2. **之後仍必須補 revert PR**；否則下一次合併到 `main` 會把出問題的程式再部署上去。
3. 如果是在編輯器直接改程式止血：改完必須在本機 `npm run pull` 收回 repo、檢查 diff、提交 PR（`npm run pull` 後面會自動跑密鑰掃描）。

### 前端
沒有等效的快速路徑，只能走 revert PR。

## 資料還原

| 情況 | 做法 |
|---|---|
| 誤刪單筆 | 在 Sheet 上把那一列的 `del` 清空（軟刪除還原）。（未驗證） |
| 少量改錯 | 用 `logs` 找出寫入者與時間（`input` 欄有表名與 id），再對照試算表的版本記錄，手動改回。（未驗證） |
| 整張分頁損壞 | 試算表 → 檔案 → 版本記錄 → 找到損壞前的時間點 → **建立副本，不要按「還原這個版本」**（還原會讓所有分頁一起退回）→ 從副本把該分頁的列複製回正式試算表。（未驗證） |
| 已封存（已實際刪除）的資料 | 從封存時寄給管理者的信件附件貼回。（未驗證） |
| Drive 收藏檔被刪 | 從 Drive 垃圾桶還原（有保留期限）。重抓時舊檔是丟垃圾桶，不是永久刪除。（未驗證） |
| 文字辨識暫存文件殘留 | logs 會寫「暫存文件殘留」；到 Drive 搜 `tmp_ocr_` 手動刪除。 |
| Gmail 誤封存 | 在 Gmail 從「所有郵件」移回收件匣。系統不刪信、不標已讀；要立刻停止封存，在 App 把封存開關關回預演。（未驗證） |
| 指令碼屬性遺失 | 依 [CONFIG.md](CONFIG.md) 的鍵名清單重設；值不在 repo，要從私人紀錄取回。「程式自己維護的」那一類不用手設。（未驗證） |

## PWA 相容性復原

- 前端回退時，`sw.js` 的 `CACHE` 版號要**往前加**（例：`neil-os-v70` → `neil-os-v71`），不要退回舊號，否則已安裝的手機可能不換新版。
- 2.0 有問題時可以切回 1.0（試營運期間保留；設定頁切換，選擇存在本機）。
- 回退前先確認畫面上「待同步」筆數為 0，避免新版前端產生的待送資料送到舊版後端。
- **清除網站資料是最後手段**：會同時清掉待送佇列與裝置 token，需要重新配對。

## 常見故障與健檢工具

| 症狀 | 先看哪裡 |
|---|---|
| LINE 完全不回 | `LINE_CHANNEL_ACCESS_TOKEN`；編輯器跑 `diagnoseLineToken`、`testLinePush` |
| LINE 回「沒有權限寫入」 | `line_users` 的 `is_active`；編輯器跑 `diagnoseLineUsers` |
| PWA 一直要重新配對 | `line_devices` 的 `revoked_at`、`last_used_at`（閒置過期）；App 設定頁的裝置清單 |
| 某功能突然全家都不能用 | `_module_registry` 的 `enabled` 是否被關掉；再看 `line_users` 的 `feat_*` |
| 記帳分類怪怪的 | `_expense_config`；編輯器跑 `diagnoseExpenseConfig` |
| logs 沒在寫 | 編輯器跑 `diagnoseLogSheet` |
| AI 回不了 | 設定 ▸ AI 供應商的最後錯誤；編輯器跑 `diagnoseAi`、`diagnoseGemini` |
| 排程好像沒在跑 | `logs` 裡來源「排程」的每日心跳與「慢」紀錄；指令碼屬性 `sched_state`；觸發器清單裡只該有一個 `runScheduler`（不對就傳「初始化」） |
| 收藏一直沒收齊 | `clips.status` 與 `error`；App 管理員的擷取用量與成功率；`APIFY_TOKEN`；編輯器跑 `probeClipSources` |
| 天氣沒資料 | `WEATHER_API`、地點設定、指令碼屬性 `weather_cache`；編輯器跑 `probeWeather`。沒資料不等於沒下雨 |
| 股票報價怪 | 編輯器跑 `probeStockSources` |
| 郵件沒處理 | 指令碼屬性 `gmail_last_run`、`gmail_log`；編輯器跑 `probeGmail`（只讀） |
| 首頁慢 | `performance` 的 `ui`（`v1`／`v2`）、`stages`；App 管理頁的效能摘要 |
| 日誌有重複列 | 編輯器跑 `dedupeReviewsPreview` 先看，再 `dedupeReviews`（先備份再刪）；「初始化」也會做 |

健檢與探針函式只在 Apps Script 編輯器手動執行；**不要對真實 Gmail 做批次封存或任何測試性操作**。

## 待確認

以下三項沒有查證，不要猜數字：

- Apps Script 專案的**版本數上限**，以及目前累積的版本數是否接近上限（每次合併 `main` 都會新增一個版本）。
- 試算表**版本記錄的實際可回溯範圍**。
- **新版前端產生的待送資料能否被舊版後端接受**（回退後端時的相容性，沒有契約測試）。
