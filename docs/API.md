# API 目錄（PWA 動作與 LINE 入口）

> 一律以原始碼為準；產生基準 `main@213a48a`。動作分派在 `apps-script/Code.gs` 的 `routePwaSync_`，以 `if (body.action === '…')` 平鋪。
> 新增動作照 [checklists/new-action.md](checklists/new-action.md)，並在本檔加一列（`tests/docs-drift.test.mjs` 會檢查）。

## 共通規則

**入口與格式**：PWA 與 LINE 共用同一個 Web App 網址。`doPost`（`line-router.gs`）看 body：有 `events` 陣列就當 LINE Webhook，其餘交給 `handlePwaSync_` → `routePwaSync_`。PWA 一律 `POST`，body 是 JSON：`{ token, action, trigger, … }`；回應是 JSON，成功帶 `success: true`（讀取類回資料物件），失敗帶 `error: '代碼'`。

**驗證順序**（`routePwaSync_`）：

1. `pairClaim`、`session`、`renewStart` 三個動作排在驗證**之前**。
2. 其餘動作先過 `pwaCaller_` → `authDevice_`：token 雜湊要對得上 `line_devices`、沒被撤銷、沒閒置過期，再過 `writeGate_`（`line_users` 白名單、啟用中）。失敗回 `{ error: <原因> }`，原因：`no_token`、`unknown_token`、`revoked`、`token_expired`、`inactive`、`device_store_unavailable`。身份一律由後端換出，**不信任 body 裡的 `line_id`**。
3. 專用動作在各自的處理函式裡守門（下表「權限」欄）。
4. 走到最後的一般動作（`upsert`、`completeRecurring`）依序檢查：分頁在 `NO_PWA_WRITE` 或是備份分頁 → `sheet_not_writable`；模組總開關關掉 → 永久拒絕；`canUseSheet_` 不過 → `forbidden`；股票三張表只開 `upsert`；`line_users` 只限管理者。

**權限用語**：

| 用語 | 意思 |
|---|---|
| 不需驗證 | 排在 token 驗證之前（只有三個動作） |
| 成員 | 通過驗證的啟用中成員 |
| 成員＋feat_x | 還要有該功能權限（`canUse_`／`canUseSheet_`，兩者都先問模組總開關） |
| 擁有者 | 只能動自己的列（比對列上的 `line_id`） |
| 管理者 | `line_users.is_admin` 為真 |
| 管理者＋feat_x | 管理者而且有該功能權限 |

**錯誤慣例**：`permanent: true` 代表重送幾次結果都一樣（前端移出待送佇列）；`busy` 代表拿不到鎖、可重送。模組總開關關掉時回 `{ error: 'forbidden', permanent: true, reason: 'module_off', module }`。

**logs 與效能**：

- 「logs」欄：會改狀態或對外送出的動作寫 `logs`（ADR-026 D-8），只寫表名、id、動作與短摘要，不複製整筆內容；「失敗時」表示只有被拒絕或失敗才寫。
- 「效能」欄：所有**通過驗證**的請求，只要 `trigger` 在 `PERF_TRIGGERS`（`cold`、`foreground`、`poll`、`manual`、`write`、`line`、`schedule`、`zone`、`hourly`）裡，`recordPerf_` 都會排一列效能紀錄；標「分段」的另外記各階段耗時。沒通過驗證的請求不寫 `performance`，只在快取累計、每小時彙總一列。
- 通過驗證的請求會更新裝置的 `last_used_at`（一天最多寫一次）；下表「寫入」欄不重複列這一點。

## PWA 動作

### 驗證之前

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `pairClaim` | `Code.gs` `pairClaim_` | `code`（LINE「配對」拿到的 6 位碼）、`device_label` | `success`、新裝置 token 與裝置資訊 | `invalid_code`、`too_many_attempts`、`cache_unavailable`、`device_store_unavailable` | 不需驗證（碼對應的人還要過白名單） | 新增 `line_devices` 一列 | 是 | 不寫（計入未驗證彙總） |
| `session` | `Code.gs` `deviceSession_` | `token` | `{ status: 'ok', line_id, display_name, device_id, device_label }`，管理者多 `perf_rows` | `{ status: <驗證失敗原因> }` | 不需驗證（就是在查 token 狀態） | 否 | 否 | 通過才記；失敗計入未驗證彙總 |
| `renewStart` | `Code.gs` `renewStart_` | `token`（已過期的） | `success` 與續期碼（到 LINE 傳「驗證裝置 碼」） | `not_expired`、其他驗證原因 | 不需驗證（只接受「過期」的 token） | 只寫快取 | 撤銷／未知 token 時寫 | 不寫（計入未驗證彙總） |

### 開機、讀取、搜尋

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `boot` | `Code.gs` `bootResponse_`／`bootCoreResponse_` | `core: true`（2.0 核心層） | 開機資料：各資料表（依權限）、模組登記、自己的設定與一段話；管理者多帶系統資訊 | 驗證失敗 | 成員（內容逐項依 feat 與模組過濾） | 否 | 否 | 是（分段） |
| `widgets` | `Code.gs` `widgetsResponse_` → `bootWidgets_` | `only`（要哪幾個 Widget） | 各 Widget 摘要；一個失敗不影響其他 | 驗證失敗 | 成員（任務需 feat_tasks、閱讀需 feat_clips、財務需記帳權限、郵件需管理者＋feat_gmail） | 否 | 否 | 是（分段） |
| `readMany` | `Code.gs` `readManyFrom_` | `sheets`（分頁名陣列）、`groups: true`（要任務群組名） | `{ data: { 分頁: 列[] }, denied: [] }`；讀到記帳會附分類設定與分期、讀到收藏附分類清單 | 讀不到的分頁放進 `denied` | 成員＋各表 feat（`NO_PWA_READ` 一律拒；`clips` 只回自己的列；`logs` 只限管理者）。`tasks`／`notes`／`expenses` 回**全家的列**（「只看我的」是前端篩選） | 否 | 否 | 是（分段） |
| `read` | `Code.gs` `readSheetResponse_` | `sheet` | 該分頁資料 | `forbidden`、`sheet_not_readable` | 同 `readMany` | 否 | 否 | 是 |
| `stock` | `stock.gs` `stockResponse_` | 見函式註解（報價、持股、規則、再平衡） | 股票頁資料 | `forbidden`、`stock_failed` | 成員＋feat_stock（再平衡設定只給管理者） | 否 | 否 | 是（分段） |
| `search` | `search.gs` `search_` | `q` | 依模組分組的結果（每組最多 20 筆＋總數） | `empty_query`、`too_long` | 成員（逐表 `canUseSheet_`；只搜自己的列，白板例外） | 否 | 否 | 是（分段） |
| `commandDict` | `line-router.gs` `commandDictForPwa_` | — | 這個人能用的 LINE 指令字典 | 驗證失敗 | 成員（只列自己能用的） | 否 | 否 | 是 |

### 一般寫入

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `upsert` | `Code.gs` `pwaUpsert_` → `upsertRow_`（股票表走 `writeStockRow_`） | `sheet`、`record`、`key_field`（預設 `id`） | `success` | `sheet_not_writable`、`forbidden`（含白板不是建立者、模組關掉）、`busy`、`sheet_not_found`；股票表另有被擋原因 | 成員＋該表 feat；`line_users` 限管理者；`logs` 限管理者；別人的列**只有在白板上時**才擋（`boardOwnerDenied_`），不在白板上的別人的列可以改；股票表強制持有者與規則 | 是（整段包 script lock） | 是 | 是 |
| `completeRecurring` | `Code.gs` `completeRecurring_` | `sheet`、`record`、`today`（測試用） | `success`（推進到下一期） | `reminder_not_completable`、`forbidden`、`busy` | 同 `upsert`（提醒不能完成） | 是 | 是 | 是 |
| `taskDone` | `Code.gs` `taskDone_` | 任務 id 等（見函式註解） | `success` | `not_found`、`reminder_not_completable`、`busy`、`forbidden` | 成員＋feat_tasks（任務模組開著）；擁有者規則同 `upsert`（經 `completeRecurring_`） | 是 | 是 | 是 |
| `replaceAll` | `Code.gs` `routePwaSync_` | — | — | 一律 `action_retired` | 已退場 | 否 | 是（記一筆拒絕） | 是 |

### 設定與個人資料

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `widgetConfigSet` | `widgets.gs` `widgetConfigSet_` | `config`：`order`、`hidden`、`pinned`、`apps_pinned`、`apps_hidden`、`stock_pins`、天氣地點 | `success` | `busy`、`invalid_location`、`pins_full` | 成員（只改自己那列） | `widget_config` | 是 | 是 |
| `setMyEmail` | `Code.gs` `setMyEmail_` | `email` | `success` | `invalid_email`、`not_on_whitelist`、`sheet_not_found` | 成員（只改自己） | `line_users.email` | 是（不寫 email 本身） | 是 |
| `selfNoteSet` | `Code.gs` `selfNoteSet_` | `text` | `success` | `too_long`、`busy`、`sheet_not_found` | 成員（只改自己那列） | `self_notes` | 是（只寫字數） | 是 |
| `listDevices` | `Code.gs` `listDevices_` | `line_id`（看誰的） | 裝置清單（不含 token 雜湊） | `forbidden`、`device_store_unavailable` | 成員看自己的；看別人限管理者 | 否 | 否 | 是 |
| `revokeDevice` | `Code.gs` `revokeDevices_` | `device_id` 或 `all_of`（某人全部） | `success` | `forbidden`、`missing_target`、`device_not_found`、`device_store_unavailable` | 成員撤自己的；撤別人限管理者 | `line_devices`（撤銷時間） | 是 | 是 |

### 管理者

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `archiveMail` | `Code.gs` `archiveByMail_` | — | `success` 與各表封存筆數 | `archive_failed`（`stage`：permission／lock／collect／mail） | 管理者 | 寄信給管理者後**實際刪除**已軟刪除的列 | 是 | 是 |
| `perfSummary` | `Code.gs` `perfSummary_` | — | 效能摘要（雲端算好） | `forbidden` | 管理者 | 否 | 失敗時 | 是 |
| `perfPurge` | `Code.gs` `perfPurge_` | `days` | `success` | `forbidden`、`busy` | 管理者 | 刪 `performance` 舊列 | 是 | 是 |
| `adminView` | `Code.gs` `adminView_` | `what`：`groups`／`config`／`guide` | 對應的系統資料 | `forbidden`、`unknown_view`、`read_failed` | 管理者 | 否 | 失敗時 | 是 |
| `groupSet` | `Code.gs` `groupSet_` | `group_id`、`field`、`value` | `success` | `forbidden`、`group_not_found`、`invalid_field`、`read_failed` | 管理者 | `line_groups` | 是 | 是 |
| `configSet` | `Code.gs` `configSet_` | `key`、`field`、`value` | `success` | `forbidden`、`config_not_found`、`invalid_field`、`invalid_color`、`invalid_sort` | 管理者 | `_expense_config` | 是 | 是 |
| `configAdd` | `Code.gs` `configAdd_` | `record` | `success` | `forbidden`、`duplicate_name`、`invalid_kind`、`invalid_name`、`parent_not_found`、`parent_required`、`invalid_color` | 管理者 | `_expense_config`（新增一列） | 是 | 是 |
| `pushPreview` | `Code.gs` `pushPreview_` | 推播對象與內容 | 預覽文字與額度 | `forbidden` | 管理者 | 否 | 失敗時 | 是 |
| `pushSend` | `Code.gs` `pushSend_` | 推播對象與內容 | `success` | `forbidden`、`push_failed` | 管理者 | LINE 推播到群組 | 是 | 是 |
| `moduleSet` | `modules.gs` `moduleSet_` | `module_id`、`enabled`（布林） | `success` 與最新模組清單 | `forbidden`、`unknown_module`、`busy` | 管理者 | `_module_registry` | 是 | 是 |
| `aiConfigGet` | `ai.gs` `aiConfigGet_` | — | 目前供應商、模型、最後錯誤 | `forbidden` | 管理者 | 否 | 失敗時 | 是 |
| `aiConfigSet` | `ai.gs` `aiConfigSet_` | `provider`、`model` | `success` | `forbidden`、`unknown_provider`、`no_key` | 管理者 | 指令碼屬性 | 是 | 是 |
| `apiPriceCheck` | `api-cost.gs` `apiPriceCheck_` | — | 與公開價目的差異（不寫） | `forbidden`、模組關掉、`fetch_failed`、`bad_json` | 管理者（成本模組開著） | 否（呼叫外部價目表） | 是 | 是 |
| `apiPriceApply` | `api-cost.gs` `apiPriceApply_` | 要套用的價目 | `success` | `forbidden`、模組關掉、`invalid`、`busy` | 管理者（成本模組開著） | `api_registry` | 是 | 是 |
| `apiCostSummary` | `api-cost.gs` `apiCostSummary_` | — | 本月用量與估算費用 | `forbidden`、模組關掉 | 管理者（成本模組開著） | 否 | 失敗時 | 是 |

### 分期

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `planCreate` | `Code.gs` `planCreate_` | `expense_id`、`periods`、`down_payment`、`dry_run` 等 | `{ success, plan_id, schedule }`；`dry_run` 只回試算 | `expense_not_found`、`already_planned`、`invalid_periods`、`invalid_amount`、`amount_too_small`、`invalid_down_payment`、`invalid_date`、`not_an_expense`、`busy`、`forbidden` | 成員＋記帳權限（分期模組開著） | `installments`＋`expenses` 各期 | 是 | 是 |
| `planDelete` | `Code.gs` `planDelete_` | `plan_id` | `success` | `plan_already_deleted`、`busy`、`forbidden` | 同上 | 同上（軟刪除） | 是 | 是 |
| `planEnd` | `Code.gs` `planEnd_` | `plan_id`、`today`（測試用） | `success` | `plan_not_active`、`busy`、`forbidden` | 同上 | 同上 | 是 | 是 |
| `planAdjust` | `Code.gs` `planAdjust_` | `plan_id`、`remaining_periods`、`per_amount`、`card`、`dry_run` | `success` | `plan_not_active`、`invalid_periods`、`invalid_per_amount`、`expense_not_found`、`busy`、`forbidden` | 管理者或計畫建立者（＋記帳權限、分期模組開著） | 同上 | 是 | 是 |

### 股票

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `stockConfigSet` | `stock.gs` `stockConfigSet_` | `key`、`value` | `success` | `forbidden`、`invalid_key`、`invalid_value`、`invalid_symbol`、`owner_not_member` | 管理者 | `_stock_config` | 是 | 是 |
| `stockPushMe` | `stock.gs` `stockPushMe_` | `symbol` | `success` | `forbidden`、`no_hit`、`push_failed` | 成員＋feat_stock | LINE 推播給自己 | 是 | 是 |

股票的交易、自選、規則經一般 `upsert` 寫入（`stock_trades`、`stock_watch`、`stock_rules`），後端強制持有者、擋賣超、自選只有管理者能改、規則只能改自己的。

### 郵件（ADR-016、ADR-026）

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `gmailView` | `gmail.gs` `gmailView_` | `what`：`rules`／`log`／`report`／`archive`；`days` | 對應的資料 | `forbidden`、`unknown_view` | 管理者＋feat_gmail | 否 | 失敗時 | 是 |
| `gmailRuleSet` | `gmail.gs` `gmailRuleSet_` | `record` | `success` | `forbidden`、`rule_not_found`、`empty_query`、`missing_source_name`、`invalid_mail_type`、`invalid_bucket`、`invalid_inbox_action`、`unknown_parser` | 管理者＋feat_gmail | `gmail_rules` | 是 | 是 |
| `gmailArchiveSet` | `gmail.gs` `gmailArchiveSet_` | `live`（布林） | `success` | `forbidden`、`invalid_value`、`save_failed` | 管理者＋feat_gmail | 指令碼屬性 `gmail_archive_live` | 是 | 是 |
| `gmailBody` | `gmail.gs` `gmailBody_` | `msg_id` | 即時讀出的純文字內文（不存副本） | `forbidden`、`missing_msg_id` | 管理者＋feat_gmail | 否（讀 Gmail） | 是（不含內文） | 是 |

### 圖書館（收藏）

除了 `clipAdd`，全部經 `clipOwnRow_` 守門：沒有 feat_clips → `{ error: 'forbidden', permanent: true, reason: 'feature' }`；不是擁有者 → `reason: 'not_owner'`；找不到或已刪除 → `not_found`；缺欄（還沒初始化）→ `not_ready`。

| 動作 | 檔案與函式 | 主要參數 | 成功回應 | 主要錯誤 | 權限 | 寫入 | logs | 效能 |
|---|---|---|---|---|---|---|---|---|
| `clipRetry` | `clips.gs` `clipPwaAction_` | `id` | `success` | 共通、`busy` | 擁有者＋feat_clips | `clips`（排回重抓） | 是 | 是 |
| `clipDelete` | `clips.gs` `clipPwaAction_` | `id` | `success` | 共通、`busy` | 擁有者＋feat_clips | `clips.del`（Drive 檔保留） | 是 | 是 |
| `clipRead` | `clips.gs` `clipPwaAction_` | `id` | `success` | 共通、`busy` | 擁有者＋feat_clips | `last_read_at`、未讀改閱讀中 | 否（開頁屬讀取） | 是 |
| `clipReadState` | `clips.gs` `clipReadStateSet_` | `id`、`state`（空白／`reading`／`read`） | `success` | 共通、`invalid_state`、`busy` | 擁有者＋feat_clips | `read_status` | 是 | 是 |
| `clipCategory` | `clips.gs` `clipCategorySet_` | `id`、`category`（空白＝未分類） | `success` | 共通、`invalid_category`、`busy` | 擁有者＋feat_clips | `category` | 是 | 是 |
| `clipSettings` | `clips.gs` `clipSettingsView_` | — | `success`、`settings`、`gate`（本月合計、IG／Threads 用量、是否暫停、是否強制續抓）、`threads` | `forbidden` | 管理者＋feat_clips | — | 否 | 是 |
| `clipSettingsSet` | `clips.gs` `clipSettingsSet_` | `key`（`ig_images`／`ig_videos`／`threads_images`／`threads_videos`／`force`）、`value`（布林） | `success`、`settings`、`gate`、`threads` | `forbidden`、`invalid_key`、`invalid_value`、`save_failed` | 管理者＋feat_clips | 指令碼屬性 `clips_settings` | 是 | 是 |
| `clipNote` | `clips.gs` `clipNote_` | `id`、`note`、`revision` | `success` 與新 `revision` | 共通、`conflict`（附雲端新版）、`too_long`、`busy` | 擁有者＋feat_clips | `note`、`note_revision`、`note_updated_at` | 是（只寫字數） | 是 |
| `clipAi` | `clips.gs` `clipAi_` | `id`、`discard` | `success` 與整理結果 | 共通、`empty`、`busy`、AI 失敗 | 擁有者＋feat_clips | `ai_output` 等三欄（不動原文與筆記） | 是 | 是 |
| `clipOcr` | `clips.gs` `clipOcr_` | `id`、`discard` | `success`、`ocr_output`、`ocr_at` | 共通、`no_images`、`ocr_failed`、`busy` | 擁有者＋feat_clips | `ocr_output`、`ocr_at`（捨棄時清空結果、`ocr_at` 記捨棄時間） | 是 | 是 |
| `clipVision` | `clips.gs` `clipVision_` | `id`、`discard` | `success` 與看圖結果 | 共通、`no_images`、`busy`、AI 失敗 | 擁有者＋feat_clips | `vision_output` 等三欄 | 是 | 是 |
| `clipAdd` | `clips.gs` `clipAdd_` | `url` | `success` | `forbidden`（沒有 feat_clips）、`invalid_url`、`busy` | 成員＋feat_clips | `clips` 新增一列（IG 排隊抓取，其他只存連結） | 是 | 是 |

## LINE 入口

**事件類型**（`handleLineEvent_`）：`message`（文字）、`postback`（Quick Reply 按鈕）、`join`／`leave`（群組加入、離開）。其他類型略過。不論內部成敗一律回 200（LINE 收到非 2xx 會重送）。

**一對一的文字訊息**依序判斷：

| 訊息 | 說明 | 權限 |
|---|---|---|
| `whoami` | 回自己的 LINE userId（群組裡多回群組 ID） | 任何人（在白名單檢查之前） |
| `Line_ID/<userId>` | 自行註冊（貼回來的 ID 必須是發話者本人） | 還不在名單的人 |
| `?`、`？`、`指令` | 指令字典（只列自己能用的） | 成員 |
| `查/問題` | AI 查詢近 30 天資料（不寫資料） | 成員；各資料依 feat 過濾 |
| `分類` | 回記帳分類表 | 成員＋feat_expense |
| `初始化` | 部署後的安裝步驟（可重複執行） | 管理者，只限一對一 |
| `買/`、`賣/`、`股/` | 股票交易與報價 | 成員＋feat_stock，只限一對一 |
| `任務/`、`提醒/` | 寫 `tasks` | 成員＋feat_tasks（提醒另看提醒模組） |
| `記帳/`、`收入/` | 寫 `expenses`；只打金額會跳分類按鈕 | 成員＋feat_expense |
| `幫我記/` | 寫 `notes`，不帶分類；logs 來源記「雜記」 | 成員＋feat_notes，只限一對一 |
| `配對`、`驗證裝置 碼` | 發配對碼、完成續期 | 成員，只限一對一 |
| 含 IG 網址的訊息 | 登記收藏（其他網址只存連結） | 成員＋feat_clips，只限一對一 |
| 其他 | 回「看不懂這個指令」與後端發行號 | — |

前綴路由的寫入都過三道門：模組總開關 → 功能權限 → 內容不可空；認得的前綴無論成敗寫一列 logs（回覆送出之後才落地）。

**群組**：沒啟用（`line_groups.is_active`）的群組一律不回；啟用的群組只收 `cmd_*` 開放的指令（記帳、收入、分類 → `cmd_expense`；任務、提醒 → `cmd_tasks`；查 → `cmd_query`），發話者本人還要過白名單與功能權限。不是指令的訊息不回、不寫 logs。

**安全邊界**：Apps Script 的 `doPost` 讀不到 HTTP 標頭，無法驗證 LINE 簽章；防線是 `writeGate_` 白名單，所以任何成員的 LINE userId 都不能出現在公開位置。詳見 [ARCHITECTURE.md](ARCHITECTURE.md)。
