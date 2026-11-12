# 資料目錄（Sheets 與 Drive）

> 一律以原始碼為準；產生基準 `main@213a48a`。分頁登記來源是 `apps-script/sheet-guide.gs` 的 `guideRegistry_()`（也是試算表 `_guide` 分頁的產生來源）；權限清單是 `apps-script/Code.gs` 的 `NO_PWA_WRITE`、`NO_PWA_READ`。
> 本檔只寫**結構**：欄位名稱與用途。任何資料值、規則內容、資源識別碼都不寫（見 [AGENTS.md](../AGENTS.md) 公開資訊分類規則）。新增分頁照 [checklists/new-sheet.md](checklists/new-sheet.md)。

## 通則

- 所有分頁在**同一個試算表**。寫入一律依**表頭名稱**對位，不寫死欄序；新欄只往右加（`ensureColumnsOnSheet_`），既有欄位與資料不動，所以 1.0 讀到陌生欄位照常運作。
- **軟刪除**：`del` 欄為 `TRUE` 代表已刪除，讀取時過濾掉。誤刪單筆就是把該列 `del` 清空。
- **封存**：`Code.gs` 的 `ARCHIVE_TARGETS`（`tasks`、`moods`、`notes`、`expenses`、`reviews`）裡 `del` 為 `TRUE` 的列，由管理者在 App 按「封存」（`archiveMail`）寄信備份給管理者後**實際刪除**。`archive` 欄是舊流程留下的旗標。
- **白板**：`tasks`、`expenses`、`notes` 的 `board` 欄為真代表釘在共用白板；只有建立者（列上的 `line_id`）能改。
- **資料歸屬**：資料表的 `line_id` 是建立者的 LINE userId；PWA 與 LINE 寫入時由後端蓋上，不信任前端送來的值。
- **備份分頁**：名稱以 `_reviews_backup_` 開頭的分頁（日誌重複列清理時產生）一律不收 PWA 寫入。

## 總表

`W`＝在 `NO_PWA_WRITE`（PWA 一般動作寫不進去，只能走專用動作或只由 GAS 寫）；`R`＝在 `NO_PWA_READ`（PWA 一般讀取讀不到）。

| 分頁 | 類別 | 鍵欄 | W | R | 軟刪除／封存 | 相關 ADR |
|---|---|---|---|---|---|---|
| `tasks` | 資料 | `id` | | | `del`、`archive`；封存 | 004、009、014、018 |
| `expenses` | 資料 | `id` | | | `del`、`archive`；封存 | 004、006、013 |
| `installments` | 資料 | `plan_id` | ✓ | | `status`（計畫狀態） | 013 |
| `reviews` | 資料（已退場） | `review_date`＋`line_id` | | | `del`、`archive`；封存 | 008、018 |
| `moods` | 資料（已退場） | `id` | | | `del`、`archive`；封存 | 018 |
| `notes` | 資料 | `id` | | | `del`、`archive`；封存 | — |
| `self_notes` | 資料 | `line_id` | ✓ | ✓ | — | 018 |
| `clips` | 資料 | `id` | ✓ | | `del` | 020、021、023、024、025 |
| `widget_config` | 資料 | `line_id` | ✓ | ✓ | — | 021 |
| `stock_trades` | 資料 | `id` | | | `del`、`archive` | 015 |
| `stock_watch` | 資料 | `symbol` | | | `is_active` | 015 |
| `stock_rules` | 資料 | `id` | | | `del` | 015 |
| `_module_registry` | 系統 | `module_id` | ✓ | ✓ | — | 021 |
| `logs` | 系統 | `id` | | | — | 006、014 |
| `line_users` | 系統 | `line_id` | | | `is_active` | 008 |
| `line_groups` | 系統 | `group_id` | ✓ | ✓ | `is_active`、`left_at` | 013、014 |
| `line_devices` | 系統 | `device_id` | ✓ | ✓ | `revoked_at` | 010 |
| `performance` | 系統 | `id` | ✓ | ✓ | — | 012、014 |
| `_expense_config` | 系統 | `kind`＋`name` | ✓ | | `is_active` | 013 |
| `_clip_categories` | 系統 | `name` | ✓ | ✓ | `is_active` | 023 |
| `stock_daily` | 系統 | `date`＋`symbol` | ✓ | ✓ | — | 015 |
| `_stock_config` | 系統 | `key` | ✓ | ✓ | — | 015 |
| `_stock_gf` | 系統 | `symbol` | ✓ | ✓ | — | 015 |
| `gmail_rules` | 功能模組 | `rule_id` | ✓ | ✓ | `is_active` | 016、026 |
| `gmail_log` | 功能模組 | `msg_id` | ✓ | ✓ | — | 016、026 |
| `api_registry` | 功能模組 | `api_id`＋`model`＋`effective_from` | ✓ | ✓ | `active` | 022 |
| `api_usage` | 功能模組 | `request_id` | ✓ | ✓ | — | 022 |
| `api_usage_daily` | 功能模組 | `date`＋`api_id` | ✓ | ✓ | — | 022 |
| `api_cost_monthly` | 功能模組 | `month`＋`api_id` | ✓ | ✓ | — | 022 |
| `ETC_Data` | 功能模組（歷史） | — | | | 凍結 | 016 |
| `_guide` | 系統 | 分頁名稱 | ✓ | | — | — |

另外，權限函式 `canUseSheet_` 對兩張表有特例：`logs` 只有管理者讀寫得到；`line_users` 的任何一般寫入只有管理者可以（`routePwaSync_`）。

## 各分頁

### `tasks`
- **用途**：待辦與提醒。`kind`＝`todo`／`reminder`（空白當待辦）。
- **主要欄位**：`id`、`text`、`is_completed`、`created_at`、`priority`、`line_id`、`del`、`archive`、`board`、`due_date`、`recur_interval`、`recur_unit`、`notified`、`origin_chat`（在哪個 LINE 群組交代的）、`kind`。
- **寫入者**：PWA 一般 `upsert`／`completeRecurring`／`taskDone`；LINE「任務/」「提醒/」與日期、重複按鈕；到期檢查排程（寫 `notified`、提醒翻頁改 `due_date`、過期 30 天以上的單次提醒設 `del`）。`origin_chat` 只有 LINE 寫，PWA 送來的值會被雲端原值蓋回。
- **讀取者**：PWA、「查/」、到期檢查、搜尋、總覽任務 Widget。

### `expenses`
- **用途**：收支記帳（大類＋細項＋對象）；分期的各期也是這裡帶 `plan_id` 的列。
- **主要欄位**：`id`、`expense_date`、`type`（`expense`／`income`）、`category`、`subcategory`、`targets`、`amount`、`note`、`created_at`、`line_id`、`del`、`archive`、`board`、`plan_id`、`plan_seq`。
- **寫入者**：PWA 一般 `upsert`；LINE「記帳/」「收入/」；分期專用動作（各期）。
- **讀取者**：PWA、「查/」、搜尋（備註）、總覽財務 Widget。

### `installments`
- **用途**：分期計畫，一個計畫一列。
- **主要欄位**：`plan_id`、`source_expense_id`、`total`、`down_payment`、`periods`、`per_amount`、`first_date`、`category`、`subcategory`、`targets`、`note`、`card`、`line_id`、`status`、`created_at`、`ended_at`。
- **專用寫入路徑**：只走 `planCreate`、`planDelete`、`planEnd`、`planAdjust`（同時改計畫與 `expenses` 的各期）。一般 `upsert` 改得到計畫列卻改不到各期，所以擋下。
- **讀取者**：PWA（`boot`／`readMany` 讀記帳時附帶）。

### `reviews`、`moods`（已退場）
- **用途**：每日複盤、心情紀錄。ADR-018 退場，介面已移除、資料保留。
- **寫入者**：無（停用）。封存流程仍會處理已軟刪除的列。`reviews` 的鍵是 `review_date`＋`line_id`（沒有 `id` 欄）。

### `notes`
- **用途**：雜記。類別存成內容開頭的 `[類別]`（約定，不是欄位）。
- **主要欄位**：`id`、`text`、`created_at`、`line_id`、`del`、`archive`、`board`。
- **寫入者**：PWA 一般 `upsert`（新增、刪除、事後分類）；LINE「幫我記/」（不帶分類）。
- **讀取者**：PWA、「查/」（問題帶 `[類別]` 時只看那一類）、搜尋。

### `self_notes`
- **用途**：給自己的一段話，一人一列，只有本人讀得到。
- **主要欄位**：`line_id`、`text`、`updated_at`。
- **專用寫入路徑**：只走 `selfNoteSet`（只能寫自己那列）；讀取只走 `boot`（只帶自己那列）。

### `clips`
- **用途**：圖書館收藏，一篇一列。IG 貼文存全文與圖片；其他網址只存連結（`kind`／`status`＝`link`）。
- **主要欄位**：
  - 收集：`id`、`line_id`、`source_text`、`url`、`shortcode`、`kind`、`status`（`pending`／`done`／`partial`／`failed`／`link`）、`attempts`、`next_try_at`、`error`、`author`、`posted_at`、`caption`、`media_expected`、`media_saved`、`drive_folder_id`、`image_ids`、`video_saved`、`collected_at`、`last_collected_at`
  - 整理：`category`（單選、存名稱）、`read_status`（空白＝未讀／`reading`／`read`）、`last_read_at`、`note`、`note_revision`、`note_updated_at`、`ai_output`、`ai_provider`、`ai_at`
  - 圖片辨識：`ocr_output`、`ocr_at`（捨棄時清空結果、`ocr_at` 記捨棄時間）、`vision_output`、`vision_provider`、`vision_at`
  - 共通：`del`、`created_at`、`updated_at`
- **專用寫入路徑**：LINE 一對一貼網址（登記）；排程 `clips`（抓取、存 Drive、重試）、`clipsOcr`（自動文字辨識）；PWA 只走 `clipRetry`、`clipDelete`、`clipRead`、`clipReadState`、`clipNote`、`clipAi`、`clipAdd`、`clipCategory`、`clipOcr`、`clipVision`（除 `clipAdd` 外只限擁有者）。
- **讀取者**：PWA（`readMany` 只回自己的列）、搜尋、總覽閱讀 Widget。

### `widget_config`
- **用途**：2.0 總覽的個人設定，一人一列。
- **主要欄位**：`line_id`、`widget_order`、`widget_hidden`、`widget_pinned`、`apps_pinned`、`apps_hidden`、`weather_county`、`weather_district`、`stock_pins`、`updated_at`。
- **專用寫入路徑**：只走 `widgetConfigSet`（只能改自己那列）；「初始化」建表。
- **讀取者**：`boot`（只帶自己那列）、天氣排程（彙整要抓哪些地點）。

### `stock_trades`、`stock_watch`、`stock_rules`
- **用途**：交易紀錄（股票與黃金）、全家共用的自選股、個人的提醒規則。
- **主要欄位**：
  - `stock_trades`：`id`、`trade_date`、`symbol`、`side`、`qty`、`price`、`fee`、`owner`、`note`、`line_id`、`created_at`、`del`、`archive`
  - `stock_watch`：`symbol`、`name`、`sort`、`is_active`、`added_by`、`created_at`
  - `stock_rules`：`id`、`symbol`、`type`、`params`（JSON）、`enabled`、`auto_push`、`cooldown_days`、`last_fired_at`、`line_id`、`created_at`、`del`
- **寫入者**：PWA 一般 `upsert`（只開 upsert；後端強制持有者、擋賣超、自選只有管理者能改、規則只能改自己的）；LINE「買/」「賣/」；規則排程寫 `last_fired_at`。
- **讀取者**：PWA（有 feat_stock）、LINE「股/」、規則排程。

### `_module_registry`
- **用途**：模組登記表與總開關。`enabled` 關掉＝所有人、1.0／2.0 都停用，連資料都碰不到（不刪資料）。
- **主要欄位**：`module_id`、`name`、`category`、`icon`、`enabled`、`permission`（只是給人看的登記，實際權限看 `line_users` 的 `feat_*`）、`load_policy`、`sort`。
- **專用寫入路徑**：只走 `moduleSet`（管理者）；「初始化」補預設列，不會把已關掉的打開。

### `logs`
- **用途**：LINE 與系統的交易紀錄（成功與失敗都記），用來回頭查「那筆記到哪去了」。
- **主要欄位**：`id`、`ts`、`source`、`status`、`input`、`result`、`detail`、`target_row`、`user_id`。
- **寫入者**：GAS（`logTransaction_`）。
- **讀取者**：App 設定頁的 LOG（只限管理者）。
- ⚠️ `logs` 不在 `NO_PWA_WRITE`：管理者可經一般 `upsert` 改寫（稽核紀錄可被改寫，Phase 2 候選）。

### `line_users`
- **用途**：白名單、功能權限矩陣、email（管理者收封存備份信）、`member`（股票持有者對應的家人）。
- **主要欄位**：`line_id`、`display_name`、`is_active`、`is_admin`、`feat_expense`、`feat_tasks`、`feat_review`、`feat_notes`、`feat_mood`、`feat_stock`、`feat_gmail`、`feat_clips`、`feat_ui_v2`、`created_at`、`updated_at`、`email`、`member`。
- **寫入者**：LINE「Line_ID/」自行註冊；`setMyEmail`（只改自己的 email）；管理者經一般 `upsert` 改名單；「初始化」補欄。
- **讀取者**：GAS 閘門（有 5 分鐘快取）、PWA（管理者的成員與權限頁）。

### `line_groups`
- **用途**：bot 加入過的 LINE 群組：啟用、開放哪些指令、要不要推到期提醒與郵件摘要。
- **主要欄位**：`group_id`、`name`、`is_active`、`cmd_expense`、`cmd_tasks`、`cmd_query`、`cmd_gmail`、`notify_due`、`notify_gmail`、`joined_at`、`left_at`、`created_at`、`updated_at`。
- **專用寫入路徑**：GAS（join／leave 事件、群組第一次下指令時建列）；管理者在 App 用 `groupSet` 或直接在 Sheet 上改。

### `line_devices`
- **用途**：已配對的裝置。token **只存雜湊**。
- **主要欄位**：`device_id`、`token_hash`、`line_id`、`device_label`、`created_at`、`last_used_at`（一天最多寫一次）、`revoked_at`、`revoked_by`。
- **專用寫入路徑**：`pairClaim`（新增）、LINE「驗證裝置」（續期）、`revokeDevice`（撤銷）；管理頁看裝置走 `listDevices`（不回雜湊）。

### `performance`
- **用途**：每次請求、LINE 事件、排程的耗時。不存 token、不存資料內容。
- **主要欄位**：`id`、`ts`、`action`、`trigger`、`client_ms`、`server_ms`、`auth_ms`、`open_ms`、`read_ms`、`sheets`、`rows`、`device_id`、`line_id`、`reply_ms`、`stages`、`request_id`、`ui`（`v1`／`v2`）。
- **專用寫入路徑**：只有 GAS——先排隊在指令碼屬性，由排程 `perfFlush` 單一寫入者落地；管理者讀摘要走 `perfSummary`、清理走 `perfPurge`。

### `_expense_config`
- **用途**：記帳的大類、細項、對象。改名＝新增一列並停用舊的。
- **主要欄位**：`kind`、`name`、`parent`、`targets`、`aliases`、`color`、`sort`、`is_active`。
- **寫入者**：專案擁有者直接在 Sheet 上改；不存在時 GAS 自動建表寫初版；**管理者也可經 `configSet`／`configAdd` 寫入**。
- ⚠️ 文件與程式不一致：`_guide` 的說明寫「PWA 不可寫」，但程式有管理者專用的 `configSet`／`configAdd`。以程式為準；`_guide` 文字未修改（改它會改變 `_guide` 分頁的輸出）。
- **讀取者**：GAS（`boot` 送前端、LINE 記帳、「查/」）、`adminView`。

### `_clip_categories`
- **用途**：圖書館分類清單。停用的不出現在按鈕，已歸類的篇照樣顯示原名。
- **主要欄位**：`name`、`icon`、`sort`、`is_active`。
- **寫入者**：「初始化」第一次建表寫初始分類；之後直接在 Sheet 上改。
- **讀取者**：`readMany` 讀 `clips` 時附帶整理好的清單；`clipCategory` 檢查分類是否啟用。

### `stock_daily`、`_stock_config`、`_stock_gf`
- **用途**：每日收盤價（非交易時段的報價來源）；再平衡設定；GOOGLEFINANCE 備援報價的公式暫存。
- **主要欄位**：`stock_daily`：`date`、`symbol`、`close`、`prev_close`、`source`；`_stock_config`：`key`、`value`；`_stock_gf`：公式暫存，每次用到整張重寫。
- **專用寫入路徑**：`stock_daily` 只由盤後排程寫；`_stock_config` 只走 `stockConfigSet`（管理者），初始化寫初版；`_stock_gf` 只由報價層寫。

### `gmail_rules`、`gmail_log`
- **用途**：郵件控制員的認信規則；處理過的信，一封一列（`msg_id` 是去重依據）。**不存卡號、不存內文。**
- **主要欄位**：
  - `gmail_rules`：`rule_id`、`is_active`、`source_name`、`mail_type`、`bill_category`、`from`、`subject_kw`、`label`、`save_attachment`、`notify`、`parser`、`note`、`inbox_action`（`keep`／`archive`）、`bucket`（`pay`／`fyi`／`news`）
  - `gmail_log`：`msg_id`、`received_at`、`rule_id`、`mail_type`、`source_name`、`subject`、`amount`、`due_date`、`status`、`attachment_url`、`gmail_link`、`processed_at`、`bucket`、`requested_inbox_action`、`inbox_action_status`（`kept`／`dry_run`／`archived`／`skipped`／`failed`）、`inbox_action_at`、`inbox_action_note`
- **專用寫入路徑**：規則走 `gmailRuleSet`（管理者＋feat_gmail）或直接在 Sheet 上改；處理紀錄只由排程 `gmail` 寫。
- **讀取者**：GAS 控制員；App 的管理者（`gmailView`、首頁郵件 Widget）。

### `api_registry`、`api_usage`、`api_usage_daily`、`api_cost_monthly`
- **用途**：API 價目表與免費額度；AI 呼叫一次一列；計次型 API 每天一列；每月每個 API 的估算費用。
- **主要欄位**：
  - `api_registry`：`api_id`、`model`、`price_key`、`billing_mode`、`input_per_token`、`output_per_token`、`cache_read_per_token`、`cache_write_per_token`、`unit_price`、`quota`、`quota_period`、`quota_unit`、`effective_from`、`source_url`、`checked_at`、`active`（改價＝新增一列帶 `effective_from`，舊列不改）
  - `api_usage`：`ts`、`request_id`、`api_id`、`model`、`feature`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`units`、`unit_price_in`、`unit_price_out`、`unit_price_other`、`cost_usd`、`priced`
  - `api_usage_daily`：`date`、`api_id`、`calls`、`rate_limited`、`quota`、`quota_period`、`used_in_period`、`pct`
  - `api_cost_monthly`：`month`、`api_id`、`est_cost_usd`、`actual_amount`、`actual_currency`、`note`
- **專用寫入路徑**：呼叫當下只排隊，由排程 `apiFlush` 落地；價目由「初始化」補登記、`apiPriceApply`（管理者）套用；`actual_*` 由專案擁有者手填對帳。

### `ETC_Data`
- **用途**：舊郵件分析程式留下的紀錄，歷史資料，凍結。不再寫入、不搬移。

### `_guide`
- **用途**：本試算表的導覽表，由 `refreshGuide()` 依 `guideRegistry_()` **整張重寫**（只保留「備註」欄）。
- **欄位**：`分頁`、`類別`、`用途`、`誰寫入`、`誰讀取`、`主鍵`、`相關 ADR`、`欄位`、`筆數`、`狀態`、`備註`。
- **寫入者**：只有 `refreshGuide()`（排程每天 6 點後第一輪、「初始化」時）。PWA 任何動作都寫不進去。

## Drive

只寫資料夾結構，不寫任何資料夾或檔案 ID。

```text
<專案根資料夾>/
├── 收藏/
│   └── YYYY-MM/
│       └── YYYYMMDD_作者_貼文代碼/
│           ├── 01.jpg、02.jpg…   圖片（只有圖片檔開「知道連結可檢視」）
│           ├── raw.json          擷取原始資料（私人）
│           ├── content.md        整理後的全文（私人）
│           └── video.mp4         Reels 影片（私人；過大時不存）
└── Gmail 附件/
    └── <信種>/
        └── YYYY-MM/              帳單附件原檔
```

- 收藏的資料夾 ID 與圖片 ID 存在 `clips.drive_folder_id`、`clips.image_ids`。
- 文字辨識時會在 Drive 暫時建立名稱以 `tmp_ocr_` 開頭的 Google 文件，讀完立刻**永久刪除**；刪不掉時 logs 會記下，要人工清理。
- 重抓一篇收藏時，同一資料夾內的舊檔丟進垃圾桶（不是永久刪除）。

## 不是分頁的狀態

這些看起來像資料，但存在**指令碼屬性**或 **CacheService**，不在試算表裡：排程狀態、天氣快取、Gmail 封存開關、各種排隊區。完整清單見 [CONFIG.md](CONFIG.md)。
