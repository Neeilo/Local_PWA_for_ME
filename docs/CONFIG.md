# 設定鍵目錄（CONFIG）

> **只列名稱與用途，不寫任何值。** 值放在 Apps Script 指令碼屬性或 GitHub Secrets，絕不寫進 repo（見 [AGENTS.md](../AGENTS.md)）。指令碼屬性遺失時，照本檔的鍵名清單重設。
> 一律以原始碼為準；產生基準 `main@213a48a`。`tests/docs-drift.test.mjs` 會檢查程式裡以字面字串讀取的指令碼屬性鍵、`index.html` 的 `*_KEY` 常數都出現在本檔。

## Apps Script 指令碼屬性（Script Properties）

在 Apps Script 編輯器 → 專案設定 → 指令碼屬性設定。分成「人要設定的」與「程式自己維護的」兩類；後者**不要手動改**。

### 人要設定的

| 鍵 | 用途 | 讀取位置 | 沒設時 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API 的長期存取權杖（回覆、推播） | `line-router.gs` | LINE 回不了話 |
| `LINE_OA_ID` | LINE 官方帳號 ID，給前端組「開啟 LINE 傳送」按鈕 | `Code.gs` `lineOaId_` | 前端退回「複製」 |
| `GEMINI_API_KEY` | Gemini API 金鑰 | `ai.gs`、`line-router.gs` | 選 Gemini 時 AI 失敗 |
| `GEMINI_MODEL` | 覆寫 Gemini 模型（選填） | `ai.gs`、`line-router.gs` | 用程式預設 |
| `OPENAI_API_KEY` | OpenAI API 金鑰 | `ai.gs`（`aiProviders_` 的 `keyProp`） | 選 OpenAI 時失敗 |
| `OPENAI_MODEL` | 覆寫 OpenAI 模型（選填） | `ai.gs` | 用程式預設 |
| `ANTHROPIC_API_KEY` | Anthropic（Claude）API 金鑰 | `ai.gs` | 選 Claude 時失敗 |
| `CLAUDE_MODEL` | 覆寫 Claude 模型（選填） | `ai.gs` | 用程式預設 |
| `FUGLE_API_KEY` | 股票行情 API 金鑰 | `stock.gs` | 報價退回其他來源 |
| `APIFY_TOKEN` | IG 擷取服務的權杖 | `clips.gs`、`lab-clip.gs` | 收藏抓不到，記失敗原因 |
| `APIFY_ACTOR` | 指定擷取用的 actor（選填） | `clips.gs`、`lab-clip.gs` | 用程式預設 |
| `APIFY_INPUT_FIELD` | 指定 actor 的輸入欄位名（選填） | `clips.gs`、`lab-clip.gs` | 用程式預設 |
| `WEATHER_API` | 中央氣象署開放資料授權碼 | `widgets.gs`（`WEATHER_KEY_PROP`） | 天氣卡一直沒資料（「初始化」會警告） |
| `PUSH_TEST_TO` | 推播健檢工具 `testLinePush` 的對象（選填） | `line-router.gs` | 改推給第一位啟用中的管理者 |
| `JINA_API_KEY` | 實驗探針的備援擷取服務金鑰（選填） | `lab-clip.gs` | 探針略過那一段 |
| `CLIP_PROBE_URLS` | 實驗探針要測的網址清單（選填） | `lab-clip.gs` | 探針用內建清單 |
| `CLIP_OCR_PROBE_ID` | 文字辨識探針要測的那一篇（收藏 id 或 Drive 資料夾 id） | `lab-clip.gs`（`CLIP_OCR_PROBE_PROP`） | 探針提示先設定 |
| `clip_focus_` | 「我的關注」：每人一份（鍵＝`clip_focus_`＋line_id），週報送 AI 當判斷標準（ADR-028；內容不進 logs、不進 repo） | `clip-report.gs`（`CLIP_FOCUS_PREFIX`） | 空白＝用通用標準 |
| `clip_report_state` | 圖書館週報排程：這一週（週五日期）已經排過哪些人（JSON） | `clip-report.gs`（`CLIP_REPORT_STATE_KEY`） | 還沒排過 |
| `clips_settings` | 圖書館設定：IG／Threads 存不存圖片、影片，「本月超過上限仍繼續抓」的月份（JSON；管理者在圖書館設定改） | `clips.gs`（`CLIPS_SETTINGS_KEY`） | IG 都存、Threads 存圖不存影片、不強制 |
| `clips_threads_usage` | Threads 本月估算用量（列數×單價；JSON） | `clips.gs`（`CLIPS_THREADS_USAGE_KEY`） | 本月 0 |
| `clips_paused_month` | 已寫過「本月 Apify 達上限、收藏暫停」logs 的月份（一個月只寫一次） | `clips.gs`（`CLIPS_PAUSED_KEY`） | 還沒寫過 |
| `clips_threads_backfill` | 「初始化」把只存連結的 Threads 轉成等待抓取，做完的時間（只跑一次） | `clips.gs`（`CLIPS_THREADS_BACKFILL_KEY`） | 還沒做 |
| `CLIP_THREADS_PROBE_URLS` | Threads 探針要測的貼文網址（逗號分隔、全形半形都可，最多 3 篇；可直接貼 `/share/` 短網址） | `lab-clip.gs`（`CLIP_THREADS_PROBE_PROP`） | 探針提示先設定、不打 Apify |

### 程式自己維護的（不要手動改）

| 鍵 | 用途 | 寫入者 |
|---|---|---|
| `AI_PROVIDER` | 目前選用的 AI 供應商 | `aiConfigSet`（管理者在 App 切換） |
| `AI_LAST_ERROR` | AI 最後一次失敗的摘要 | `ai.gs` |
| `gmail_archive_live` | 郵件正式封存開關：空＝預演；有值＝正式封存的開啟時間。**只由管理者在 App 切換，不要在編輯器手動設** | `gmailArchiveSet` |
| `gmail_last_run` | 郵件控制員最後一次完成的摘要 | 排程 `gmail` |
| `sched_state` | 排程總管：各工作上次執行時間、今天是否做完、心跳統計 | `runScheduler` |
| `weather_cache` | 天氣預報快取（**是指令碼屬性，不是分頁**） | 排程 `weather` |
| `weather_api_paused_until` | 氣象署 API 暫停到何時（被擋時改讀鏡像） | 排程 `weather` |
| `clips_usage` | 擷取服務本月用量與近 3 天收藏成功率 | 排程 `apifyUsage` |
| `clips_md_bom` | 「收藏 content.md 重產」做過的旗標 | 「初始化」 |
| `clips_read_reset` | 「收藏閱讀狀態重設」做過的旗標 | 「初始化」 |
| `clip_ocr_auto_fails` | 自動文字辨識每篇的失敗次數（滿 3 次不再自動試） | 排程 `clipsOcr` |
| `api_alerts` | 用到 100% 額度的 API 清單（開機帶給管理者） | 排程 `apiFlush` |
| `api_alert_state` | 已推過 80% 額度提醒的週期 | 排程 `apiFlush` |
| `apid_drained` | API 計次已搬到哪一個小時 | 排程 `apiFlush` |
| `apid_<日期>` | 當天已搬進來的 API 呼叫次數小計（前綴 `apid_`） | 排程 `apiFlush` |
| `apiq_<…>` | 付費型 API 用量排隊，一筆一個鍵（前綴 `apiq_`） | `callApi_`；`apiFlush` 落地後刪除 |
| `perfq_<…>` | 效能紀錄排隊，一批一個鍵（前綴 `perfq_`） | `recordPerf_` 等；`perfFlush` 落地後刪除 |

### 已退場（程式不再讀取）

| 鍵 | 說明 |
|---|---|
| `ALLOWED_USER_IDS` | 舊的 LINE 白名單。ADR-008 起改查 `line_users`，確認新路徑正常後可以刪 |
| `CLOUD_SECRET` | 舊的共用密鑰。ADR-010 起改用裝置 token，整條退場 |

## CacheService（快取，不是設定）

短期狀態，過期就消失，不需要也不應該手動設定。列出前綴方便除錯：`adr008_line_users_v1`（成員名單）、`adr013_line_groups_v1`（群組）、`adr013_expense_config_v1`（記帳分類）、`adr015_members_v1`（股票家人名單）、`adr021_modules`（模組開關）、`api_prices`（價目）、`adr010_dev_`（裝置）、`adr010_pair_`／`adr010_renew_`（配對碼、續期碼，TTL 10 分鐘）、`adr010_pair_fail`／`adr010_pair_lock`（配對錯誤次數與鎖）、`adr014_unauth_`（未驗證請求計數）、`adr015_q_`（報價）、`adr015_fugle429`、`adr015_unk_`、`adr013_qr_`、`adr014_td_`、`adr018_tr_`（Quick Reply 按鈕的一次性碼）、`apic_`／`apir_`（每小時 API 呼叫與被擋次數）。

## GitHub Actions Secrets

在 repo → Settings → Secrets and variables → Actions 設定。

| 名稱 | 用途 | 使用的 workflow |
|---|---|---|
| `CLOUD_URL` | Apps Script Web App 網址；部署時注入 `index.html` 的 `__CLOUD_URL__` | `deploy.yml`（Pages） |
| `CLASPRC_JSON` | clasp 登入憑證（整份 `.clasprc.json`） | `deploy.yml`（Apps Script） |
| `SCRIPT_ID` | Apps Script 專案 ID | `deploy.yml`（Apps Script） |
| `CLASP_DEPLOYMENT_ID` | **既有**的正式部署 ID；每次部署更新這一個，exec 網址不變。不要換成新的 | `deploy.yml`（Apps Script） |

`pr-check.yml` 不用任何 Secret。

## 前端 `localStorage`

鍵都在 `index.html`，常數名以 `_KEY` 結尾。

| 常數 | 鍵 | 用途 | 清掉的後果 |
|---|---|---|---|
| `STORAGE_KEY` | `personal-os-state-v1` | 本機狀態（雲端資料的非權威快取） | 重新從雲端讀 |
| `OUTBOX_KEY` | `personal-os-outbox-v1` | 待送佇列 | **還沒送出的修改會遺失** |
| `DEVICE_TOKEN_KEY` | `personal-os-device-token` | 裝置 token | 要重新配對 |
| `LINE_ID_KEY` | `personal-os-line-id` | `session` 回傳後的快取，只為了開機先把名字畫上去；身份以 token 為準 | 開機重新取得 |
| `LOCAL_ONLY_KEY` | `personal-os-local-only` | 還沒配對先用（雲端同步暫停）的旗標；配對成功後清除 | 開機時回到配對畫面 |
| `SCOPE_KEY` | `personal-os-scope` | 「只看我的／全部」 | 回到預設 |
| `UI_KEY` | `personal-os-ui` | 選用 1.0 或 2.0 介面（沒有 `feat_ui_v2` 時一律 1.0） | 回到 1.0 |
| `ZONE_KEY` | `personal-os-zone` | 1.0 兩區版面目前在哪一區 | 回到預設區 |
| `ZONE_HINT_KEY` | `personal-os-zone-hint` | 兩區切換提示看過的旗標 | 再提示一次 |
| `THEME_KEY` | `personal-os-theme` | 亮／暗／自動 | 回到自動 |
| `COMPASS_KEY` | `personal-os-compass-v1` | 舊「今日指南針」的本機資料（ADR-018 退場） | 無 |
| `LEGACY_ROSTER_CACHE_KEY` | `personal-os-line-users` | 舊版成員名單快取，開機時清除 | 無 |
| `LEGACY_NAV_KEYS` | `personal-os-nav-placement`、`personal-os-nav-slot` | 舊導覽配置，開機時清除 | 無 |

清除網站資料是最後手段：會同時清掉待送佇列與裝置 token，需要重新配對（見 [RUNBOOK.md](RUNBOOK.md)）。

## 功能權限（`line_users` 的 `feat_*`）

由管理者在 App「成員與權限」或 Sheet 上打勾。規則：那一列**完全沒有** `feat_` 欄 → 全開（矩陣還沒佈署時的相容行為）；有欄但留空 → 關閉。

| 欄位 | 功能 | 對應分頁／模組 |
|---|---|---|
| `feat_tasks` | 任務、提醒 | `tasks`／任務、提醒模組 |
| `feat_expense` | 記帳、分期 | `expenses`、`installments`／記帳、分期模組 |
| `feat_notes` | 雜記 | `notes`／雜記模組 |
| `feat_stock` | 股票 | `stock_*`／股票模組 |
| `feat_gmail` | 郵件（還要是管理者） | `gmail_*`／郵件模組 |
| `feat_clips` | 圖書館 | `clips`／圖書館模組 |
| `feat_ui_v2` | 能不能切到 2.0 介面（不擋任何讀寫） | — |
| `feat_review`、`feat_mood` | 日誌、心情（已退場，欄位保留） | `reviews`、`moods` |

`is_admin` 不是 `feat_*`，但決定所有管理者動作與 `logs` 的存取。

## 模組總開關（`_module_registry` 的 `enabled`）

管理者在 App 切換（`moduleSet`）。關掉＝對所有人、1.0 與 2.0 都停用，PWA、LINE、「查/」、搜尋、排程一起擋，**不刪資料**。

| `module_id` | 名稱 | 對應功能權限 |
|---|---|---|
| `expenses` | 記帳 | `feat_expense` |
| `plans` | 分期 | `feat_expense` |
| `stocks` | 股票 | `feat_stock` |
| `tasks` | 任務 | `feat_tasks` |
| `reminders` | 提醒 | `feat_tasks` |
| `board` | 白板 | — |
| `notes` | 雜記 | `feat_notes` |
| `mail` | 郵件 | `feat_gmail` |
| `library` | 圖書館 | `feat_clips` |
| `costs` | 成本 | 管理者（關掉只擋「看」與查價，用量記帳照常） |
