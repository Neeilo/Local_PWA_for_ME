# 測試說明

> 跑法：`npm test`（= `node --test tests/*.test.mjs`）。只用 Node 內建模組，不需要網路。
> 原則（[AGENTS.md](../AGENTS.md) 第 9 條）：測試要驗證**為什麼**，測的是 `apps-script/*.gs` 與 `index.html` **本人**，不測抄出來的副本；禁止硬編回傳、修改期待值或測副本只求綠燈。每個測試檔開頭的註解寫了它盯的事與理由。

## 三個假環境

| 檔案 | 假什麼 | 假到什麼程度 | 沒有模擬的 |
|---|---|---|---|
| `fake-apps-script.mjs` | Apps Script 執行環境。`loadCodeGs({ sheets, properties, tokens, extraFiles, overrides, … })` 把 `Code.gs`（加上指定的其他 `.gs`）整份載進 Node 的 `vm` | `FakeSheet` 是二維陣列，`getRange`／`setValues`／`appendRow`／`deleteRow` 的列號語意與真的一致（1 起算、含表頭、刪列會位移）；`FakeCache` 有 TTL；指令碼屬性可讀可寫（`propsWritable`）；`LockService` 的鎖會被占用（`tryLock` 可回 false）；`ScriptApp` 記下建立的觸發器；`MailApp` 記下寄出的信；時區固定台北；`tokens` 會在 `line_devices` 建好對應的裝置 | Sheet 的格式、公式、型別轉換（例如 `0050` 被轉成數字）；真正的並行（同一時間兩個執行）；6 分鐘執行上限與各種配額；OAuth 授權範圍；`UrlFetchApp` 預設直接丟例外（要測外部呼叫就用 `overrides` 換掉）；`GmailApp` 預設丟例外；`DriveApp` 只有資料夾 |
| `fake-browser.mjs` | 瀏覽器。`loadFrontend({ storage, fetchImpl })` 把 `index.html` 的 `<script>` 整段載進 `vm`（切掉結尾的 `init()`） | `localStorage` 真的會存、讀得回來；`fetch` 由測試提供；DOM 只假到「呼叫不會爆」 | 畫面渲染、版面、CSS、事件冒泡、Service Worker、真正的離線狀態；畫面長相要靠真的開來看 |
| `fake-drive.mjs` | 圖片辨識用的雲端硬碟與 Drive API。`fakeDrive(files, folders)`、`fakeDriveApi(texts, { deleteFails })` | 檔案有名字、類型、內容；Drive API 只認 copy（轉文件）／export（讀文字）／delete 三種請求，並記下還沒刪的暫存文件；其他請求一律丟例外 | 真正的 OCR 品質、配額、檔案權限 |

`fixtures/gmail/` 是郵件解析器的樣本（說明見該資料夾的 README）。`ADR-009-phase0-test-report.md` 是 ADR-009 第 0 階段的歷史測試報告，不是測試。

## 只在 PR 檢查跑、不在 `npm test` 裡的檢查

`.github/workflows/pr-check.yml`（只對 base 為 `main` 的 PR 觸發）另外跑：

- `npm run scan`（`scripts/scan-inline-secrets.mjs`）：原始碼裡不能有寫死的密鑰。
- `node scripts/check-api-exit.mjs apps-script`：外部呼叫一律走 `callApi_`，不可直接用 `UrlFetchApp`。**本機跑 `npm test` 不會發現這類問題**，送 PR 前請自己跑。
- `node scripts/site-files.mjs <目錄>`：發布白名單收得齊。

`deploy.yml` 在部署前也會再跑一次 `npm test` 與密鑰掃描。

## 防漂移檢查 `docs-drift.test.mjs`

讓文件跟著程式走：程式改了、文件沒改，`npm test` 就紅燈，失敗訊息會說「少了什麼、該補在哪個文件」。只做靜態解析，不執行程式。

| # | 檢查 | 來源 → 文件 |
|---|---|---|
| 1 | 每個 PWA 動作都有文件 | `Code.gs` 的 `routePwaSync_` 裡每個 `body.action === '名稱'` → `docs/API.md` |
| 2 | 每張分頁都有文件 | `sheet-guide.gs` 的 `guideRegistry_()` → `docs/DATA.md` |
| 3 | 每個設定鍵都有文件 | `.gs` 裡 `getProperty('鍵')` 的字面字串、以 `var 常數 = '鍵'` 宣告再 `get/set/deleteProperty(常數)` 讀寫的鍵、`ai.gs` 的 `keyProp`／`modelProp`；`index.html` 的 `*_KEY` 常數值 → `docs/CONFIG.md` |
| 4 | 每個測試檔都有說明 | `tests/*.test.mjs` → 本檔 |
| 5 | 程式引用的 ADR 都有索引 | `index.html` 與 `.gs` 裡的 `ADR-\d{3}` → `docs/adr/README.md` |
| 6 | 每支 `.gs` 都有模組歸屬 | `apps-script/*.gs`（`build-info.gs` 除外，它不在 repo）→ `docs/MODULES.md` |
| 7 | 公開資訊基本防線 | `AGENTS.md` 與 `docs/` 下所有檔案不得出現 LINE ID 形狀的字串、`example.com`／`example.org` 以外的 email、Apps Script 或試算表的網址 ID |

**沒有涵蓋的（第 3 項）**：鍵名是執行時才組出來的（例如 `apid_` 加日期、`perfq_` 加流水號、`aiProp_(…)` 依供應商組鍵），靜態解析抓不到完整鍵名，所以只檢查前綴與已知常數；CacheService 的鍵不在檢查範圍。第 7 項刻意**不放任何私人名單或關鍵字清單**，只用形狀判斷。

## 測試檔對照

| 測試檔 | 模組 | 測什麼 |
|---|---|---|
| `admin-settings.test.mjs` | 管理與設定 | 首頁「系統設定」卡（管理者） |
| `adr-009-archive.test.mjs` | 管理與設定 | 兩段式封存（軟刪除 → 封存） |
| `adr-009-board-due.test.mjs` | 白板、任務 | 共用白板與到期門檻 |
| `adr-009-duecheck.test.mjs` | 提醒 | 到期檢查與通知 |
| `adr-009-endpoints.test.mjs` | PWA 同步 | 後端端點接線（upsert、讀取） |
| `adr-009-frontend.test.mjs` | PWA 同步 | 前端寫入路徑（單筆 upsert、不再 replaceAll） |
| `adr-009-readpath.test.mjs` | PWA 同步 | 讀取路徑（雲端是真相、離線顯示錯誤） |
| `adr-009-recur-complete.test.mjs` | 任務 | 週期任務完成後接手下一期 |
| `adr-009-recur-frontend.test.mjs` | 任務 | 前端的週期欄位與打勾流程 |
| `adr-009-recurrence.test.mjs` | 任務、提醒 | 週期日期算法 |
| `adr-009.test.mjs` | PWA 同步、身份 | ADR-009 第 0 階段的三個基礎函式 |
| `adr-010-auth.test.mjs` | 身份與配對 | LINE 配對 × 裝置 token（後端） |
| `adr-010-frontend.test.mjs` | 身份與配對 | 配對、續期、驗證失敗的去向（前端） |
| `adr-012-boot-frontend.test.mjs` | PWA 同步 | 一趟開機、功能權限上雲、等待畫面（前端） |
| `adr-012-boot.test.mjs` | PWA 同步、身份 | 一趟開機（boot／readMany）、canUse_（後端） |
| `adr-012-perf-frontend.test.mjs` | 效能紀錄 | 效能紀錄（前端） |
| `adr-012-perf.test.mjs` | 效能紀錄 | 效能紀錄（後端） |
| `adr-013-expense-config.test.mjs` | 記帳 | 記帳分類設定、細項、對象 |
| `adr-013-installments.test.mjs` | 分期 | 分期計畫 |
| `adr-013-line-groups.test.mjs` | LINE 入口 | LINE 群組入口、Quick Reply 記帳 |
| `adr-014-due-reminders.test.mjs` | 提醒、LINE 入口 | 到期提醒排程、推播依來源、LINE 任務兩段式日期 |
| `adr-014-frontend.test.mjs` | 任務 | PWA 編輯到期日、origin_chat 原樣保留 |
| `adr-014-perf-push.test.mjs` | 效能紀錄、管理與設定 | 每個雲端動作都帶 trigger（掃 index.html，也檢查 CLAUDE.md 那句話）、管理者手動推播 |
| `adr-014-zones.test.mjs` | 管理與設定（1.0 版面） | 兩區版面、首頁重組、設定頁 |
| `adr-015-donut.test.mjs` | 記帳 | 支出雙環圖 |
| `adr-015-frontend.test.mjs` | 股票 | 股票頁（前端） |
| `adr-015-probe.test.mjs` | 股票 | 股票資料源探針 |
| `adr-015-stock.test.mjs` | 股票 | 報價層、資料表與權限、LINE 三指令（後端） |
| `adr-016-controller.test.mjs` | 郵件 | Gmail 控制員管線 |
| `adr-016-frontend.test.mjs` | 郵件 | App 上的郵件頁（前端） |
| `adr-016-probe.test.mjs` | 郵件 | 規則探針與 gmail_rules 建表 |
| `adr-017-ai.test.mjs` | AI 供應商 | Gemini／OpenAI／Claude 切換 |
| `adr-018-boot-stages.test.mjs` | PWA 同步、效能紀錄 | 開機分段計時 |
| `adr-018-commands.test.mjs` | LINE 入口 | 指令登記表、? 字典、打錯指令只回一行；路由前綴與登記表對齊 |
| `adr-018-home.test.mjs` | 管理與設定（1.0 首頁） | 首頁三層 |
| `adr-018-plan-adjust.test.mjs` | 分期 | 分期調整 |
| `adr-018-query.test.mjs` | LINE 入口、AI 供應商 | 「查/」納入雜記與提醒 |
| `adr-018-reminders-frontend.test.mjs` | 提醒 | 待辦與提醒分家（前端） |
| `adr-018-reminders.test.mjs` | 提醒、LINE 入口 | 待辦與提醒分家（後端與 LINE） |
| `adr-018-speed-backend.test.mjs` | PWA 同步、效能紀錄 | 開機加速（後端） |
| `adr-018-speed-frontend.test.mjs` | PWA 同步、效能紀錄 | 開機加速（前端） |
| `adr-019-due-cards.test.mjs` | 提醒 | 到期 Flex 卡片 |
| `adr-019-perf-frontend.test.mjs` | 效能紀錄 | request_id（前端） |
| `adr-019-perf.test.mjs` | 效能紀錄 | 效能紀錄單一寫入者、request_id（後端） |
| `adr-019-pr-check.test.mjs` | CI | PR 檢查 workflow 的內容 |
| `adr-019-scheduler.test.mjs` | 排程總管 | 排程總管：到期判斷、順序、預算、單一觸發器、登記表快照 |
| `adr-019-write-guard-frontend.test.mjs` | PWA 同步、白板 | 待送佇列滿了停收、白板只改自己的（前端） |
| `adr-019-write-guard.test.mjs` | PWA 同步、白板 | upsert 上鎖、白板只改自己的（後端） |
| `adr-020-clips-frontend.test.mjs` | 圖書館 | 收藏頁（前端） |
| `adr-020-clips.test.mjs` | 圖書館、LINE 入口 | 收藏搜集器（後端與 LINE） |
| `adr-021-core-boot.test.mjs` | 總覽 Widget、PWA 同步 | 2.0 開機只讀核心層、Widget 摘要、taskDone、clipRead（後端） |
| `adr-021-core-frontend.test.mjs` | 總覽 Widget、PWA 同步 | 2.0 分層載入、總覽 Widget、首頁勾完成（前端） |
| `adr-021-library-e-frontend.test.mjs` | 圖書館 | 筆記、AI 整理、只存連結、加網址（前端） |
| `adr-021-library-e.test.mjs` | 圖書館 | 筆記 revision、AI 整理、非 IG 連結、閱讀狀態（後端） |
| `adr-021-modules-frontend.test.mjs` | 模組總開關 | 總開關（前端 1.0） |
| `adr-021-modules.test.mjs` | 模組總開關 | 登記表與總開關（後端），含排程工作與模組的對應快照 |
| `adr-021-perf-ui.test.mjs` | 效能紀錄 | 效能紀錄的 ui 欄（分辨 1.0／2.0） |
| `adr-021-search-f-frontend.test.mjs` | 搜尋 | 搜尋頁（前端） |
| `adr-021-search-f.test.mjs` | 搜尋 | 搜尋（後端） |
| `adr-021-settings-d-frontend.test.mjs` | 管理與設定 | 2.0 設定拆分（前端） |
| `adr-021-shell-frontend.test.mjs` | 總覽 Widget、身份 | 2.0 殼：權限、切換鈕、Tab、Apps Grid（前端） |
| `adr-021-shell.test.mjs` | 身份與配對 | feat_ui_v2 權限欄（後端） |
| `adr-021-widgets-c-frontend.test.mjs` | 總覽 Widget、天氣 | Widget 排序、財務／郵件／股票／天氣、編輯模式（前端） |
| `adr-021-widgets-c.test.mjs` | 總覽 Widget、天氣 | 財務／郵件／天氣 Widget、個人設定、天氣排程（後端） |
| `adr-022-api-cost.test.mjs` | API 成本 | callApi_ 唯一出口、流水帳、每日彙總 |
| `adr-022-cost-card.test.mjs` | API 成本 | 用量與成本卡、額度提醒 |
| `adr-022-init-reply.test.mjs` | LINE 入口 | 「初始化」回覆瘦身 |
| `adr-022-price-check.test.mjs` | API 成本 | 查價 |
| `adr-023-gmail-parsers.test.mjs` | 郵件 | 帳單解析器（用 `fixtures/gmail/` 的樣本） |
| `adr-023-library-categories-frontend.test.mjs` | 圖書館 | 圖書館分類（前端） |
| `adr-023-library-categories.test.mjs` | 圖書館 | 圖書館分類（後端） |
| `adr-023-monthly-dedupe.test.mjs` | API 成本 | 月結重複列 |
| `adr-023-render-probe.test.mjs` | 總覽 Widget | 首頁重畫頻率量測（只量、不改行為） |
| `adr-023-stock-widget-frontend.test.mjs` | 股票、總覽 Widget | 首頁股票 Widget：兩種損益、pin（前端） |
| `adr-023-stock-widget.test.mjs` | 股票、總覽 Widget | 股票 Widget：個人 pin、今日損益（後端） |
| `adr-024-clip-ai-recog.test.mjs` | 圖書館 | AI 整理讀兩種辨識結果 |
| `adr-024-clip-ocr-frontend.test.mjs` | 圖書館 | 📝 文字辨識（前端） |
| `adr-024-clip-ocr.test.mjs` | 圖書館 | 📝 文字辨識 clipOcr（後端） |
| `adr-024-clip-vision-frontend.test.mjs` | 圖書館 | 🤖 AI 辨識（前端） |
| `adr-024-clip-vision.test.mjs` | 圖書館、AI 供應商 | 🤖 AI 辨識 callAiVision_＋clipVision（後端） |
| `adr-024-ocr-probe.test.mjs` | 圖書館（探針） | 文字辨識探針與共用的 clipOcrImage_ |
| `adr-027-threads-probe.test.mjs` | 圖書館（探針） | Threads 收藏探針 probeClipThreads：網址辨識、作者串文排序、圖片下載、費用推估與結論 |
| `adr-025-read-state-frontend.test.mjs` | 圖書館 | 閱讀狀態三態（前端） |
| `adr-025-read-state.test.mjs` | 圖書館 | 閱讀狀態三態（後端） |
| `adr-026-logs.test.mjs` | PWA 同步、管理與設定 | logs 補齊（PWA 改狀態的動作都寫 logs） |
| `adr-026-mail-archive.test.mjs` | 郵件 | 規則封存、處理彙報、即時內文（後端） |
| `adr-026-mail-frontend.test.mjs` | 郵件 | 整理報告、純文字閱讀頁、郵件 Widget、封存開關（前端） |
| `archive-mail.test.mjs` | 管理與設定 | 封存改寄信給管理者 |
| `build-info.test.mjs` | LINE 入口、發布 | LINE 回覆帶後端發行號；Pages 發布白名單與 sw.js／manifest／index.html 引用的檔案交叉比對 |
| `cleanup-review.test.mjs` | 多處 | 程式審查後清理小票的回歸測試 |
| `clip-ocr-auto.test.mjs` | 圖書館、排程總管 | 排程自動跑 📝 文字辨識 |
| `cost-module.test.mjs` | API 成本、模組總開關 | 成本模組 |
| `date-local.test.mjs` | PWA 同步 | 雲端日期欄讀回前端時少一天的回歸 |
| `docs-drift.test.mjs` | 文件 | 文件與程式對齊（本目錄的防漂移檢查，見下） |
| `email-frontend.test.mjs` | 身份與配對 | 自己的 email 設定（前端） |
| `line-quick-note.test.mjs` | 雜記、LINE 入口 | LINE「幫我記/」與 App 雜記事後分類 |
| `line-source.test.mjs` | LINE 入口 | 訊息來源：一對一、群組、多人聊天室 |
| `perf-tuning.test.mjs` | 效能紀錄、LINE 入口 | 效能調整（設定更新、LINE 按鈕反應） |
| `rd-clip-probe.test.mjs` | 圖書館（探針） | 收藏擷取探針 probeClipSources |
| `sheet-guide.test.mjs` | _guide | _guide 產生、備註保留、未登記標示、PWA 寫不進去 |
| `small-tickets-20261008.test.mjs` | 多處 | 2026-10-08 小票（「只看我的」套到雜記、任務群組名、日誌重複列清理等） |
| `sw-reload.test.mjs` | PWA 同步、發布 | Service Worker 換版不讓剛開的 App 重新載入 |
| `theme.test.mjs` | 管理與設定 | 亮／暗／自動與 icon |
