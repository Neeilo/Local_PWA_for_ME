# 模組索引（MODULES）

> 給第一次接手的 Agent：要改某個功能，先在這裡找到它的前端段落、後端檔案與函式、API 動作、分頁、測試與 ADR，再去讀原始碼。
> 一律以原始碼為準；查不到的寫「待確認」。產生基準：`main@213a48a`（2026-11-12）。
> 共通規則見 [AGENTS.md](../AGENTS.md)；本檔只寫「在哪裡」，契約細節（每個動作的參數與權限、每張分頁的欄位）另見同目錄的其他文件。

## 後端檔案一覽（`apps-script/`）

`apps-script/` 是 Apps Script 的**正式部署來源**（合併 `main` 後 CI `clasp push`）。各檔共用同一個全域範圍，頂層程式的執行順序跟檔案順序走，所以跨檔常數多半包在函式裡（例：`guideRegistry_()`、`apiCatalog_()`、`schedulerJobs_()`）。

| 檔案 | 主要內容 | 屬於下面哪些模組 |
|---|---|---|
| `Code.gs` | PWA 請求入口 `handlePwaSync_` → 分派 `routePwaSync_`；身份與裝置（`authDevice_`、`pairClaim_`、`renewStart_`）；權限（`writeGate_`、`canUse_`、`canUseSheet_`）；一般讀寫（`readManyFrom_`、`pwaUpsert_`、`upsertRow_`）；開機與 Widget 摘要；任務完成與週期；記帳分類設定與分期；效能紀錄；封存寄信；推播；系統設定 | 身份、PWA 同步、任務、提醒、白板、記帳、分期、Widget、效能、管理與設定 |
| `line-router.gs` | 統一入口 `doPost`；LINE Webhook（`handleLineWebhook_` → `handleLineEvent_` → `routeLineMessage_`）；前綴路由表 `ROUTE_TABLE`；「查/」AI 查詢；指令字典 `COMMANDS`；「初始化」`initSteps_`；群組入口；logs 寫入 `logTransaction_` | LINE 入口、任務、提醒、記帳、雜記、AI、管理與設定 |
| `modules.gs` | 模組登記表 `_module_registry` 與總開關 `moduleOn_`、`moduleSet_` | 模組總開關 |
| `widgets.gs` | 2.0 總覽個人設定 `widget_config`、天氣 | Widget、天氣 |
| `clips.gs` | 收藏搜集、圖書館（筆記、分類、閱讀狀態、AI 整理、文字辨識、AI 辨識） | 圖書館 |
| `search.gs` | 按需關鍵字搜尋 `search_` | 搜尋 |
| `stock.gs` | 股票報價、持股、交易把關、提醒規則、再平衡、LINE 股票指令 | 股票 |
| `gmail.gs` | Gmail 控制員、規則、封存（預設預演）、整理報告、即時內文 | 郵件 |
| `ai.gs` | AI 供應商切換與呼叫 `callAi_`、`callAiVision_` | AI 供應商 |
| `api-cost.gs` | 外部呼叫唯一出口 `callApi_`／`callApiAll_`、用量記帳、價目表與成本卡 | API 成本 |
| `scheduler.gs` | 唯一的時間觸發器 `runScheduler` 與工作登記表 `schedulerJobs_()` | 排程總管 |
| `sheet-guide.gs` | 分頁登記表 `guideRegistry_()` 與 `_guide` 產生器 `refreshGuide` | `_guide` |
| `lab-clip.gs` | **實驗用探針，不是功能**：`probeClipSources()`、`probeClipOcr()`，只在編輯器手動執行。目前隨正式版一起部署 | 圖書館（探針） |
| `appsscript.json` | Apps Script 專案設定（時區、授權範圍） | — |
| `build-info.gs` | **不在 repo**：CI 部署時產生的發行號 `BUILD_INFO` | LINE 入口（版本尾行） |

前端只有一個檔案 `index.html`（HTML＋CSS＋JS）；`sw.js` 是 Service Worker；發布到 GitHub Pages 的檔案由 `scripts/site-files.mjs` 的白名單決定。

---

## 模組

每個模組 13 個欄位：名稱、用途、負責範圍、不負責的事、前端入口、後端入口、相關 API action、主要分頁、外部服務、主要副作用、相關測試檔、相關 ADR、已知限制。前端入口寫的是 `index.html` 的段落標題（`/* ---------- 標題 ---------- */`），可直接搜尋。

### 1. 身份與配對

| 欄位 | 內容 |
|---|---|
| 用途 | 確認「這個請求是誰、能不能進來」：LINE 配對換裝置 token、白名單、續期、撤銷 |
| 負責範圍 | 配對碼發放與兌換、裝置 token（只存雜湊）、閒置過期與續期、裝置清單與撤銷、白名單（`line_users.is_active`）、管理者旗標、功能矩陣 `feat_*`、自行註冊、自己的 email |
| 不負責的事 | 模組總開關（見「模組總開關」）；各模組自己的擁有者檢查（例如收藏只限擁有者） |
| 前端入口 | 「身份、白名單與功能矩陣（ADR-008 → ADR-010）」「身份：讀取與套用」「配對／續期／停用的蓋版（ADR-010 D-3）」「流程 C：過期續期」「身份卡」「自己的 Email（2026-10-01）」「成員與權限（is_admin，ADR-008 D-4）」「已配對的裝置（ADR-010 D-7）」「功能清單（權限矩陣的順序與標籤）」 |
| 後端入口 | `Code.gs`：`authDevice_`、`pwaCaller_`、`writeGate_`、`canUse_`、`canUseSheet_`、`pairClaim_`、`deviceSession_`、`renewStart_`、`issuePairCode_`、`listDevices_`、`revokeDevices_`、`setMyEmail_`；`line-router.gs`：「配對」「驗證裝置」「whoami」「Line_ID/」的處理 |
| 相關 API action | `pairClaim`、`session`、`renewStart`（三個在驗證之前）、`listDevices`、`revokeDevice`、`setMyEmail`；成員名單經一般 `upsert` 寫 `line_users`（只限管理者） |
| 主要分頁 | `line_users`、`line_devices` |
| 外部服務 | LINE（回覆配對碼） |
| 主要副作用 | 寫 `line_devices`（新增裝置、撤銷、最後使用時間）、寫 `line_users`（註冊、email、管理者改名單）；被拒絕的請求寫 logs；未驗證請求只在快取累計，每小時彙總一列效能紀錄 |
| 相關測試檔 | `adr-010-auth.test.mjs`、`adr-010-frontend.test.mjs`、`email-frontend.test.mjs`、`admin-settings.test.mjs`、`adr-009.test.mjs`（白名單閘門） |
| 相關 ADR | 名單集中一份、查不到就拒絕（ADR-008）；讀取也要驗證、改用裝置 token、關閉 `doGet`（ADR-010） |
| 已知限制 | 配對碼與續期碼只放 CacheService（TTL 10 分鐘）；`canUse_` 對「完全沒有 `feat_` 欄」的列一律開放（矩陣未佈署時的相容行為） |

### 2. LINE 入口

| 欄位 | 內容 |
|---|---|
| 用途 | 讓家人在 LINE 一對一或群組裡快速記錄、查詢、管理 |
| 負責範圍 | Webhook 分流、前綴路由（`ROUTE_TABLE`：任務、提醒、記帳、收入、幫我記）、股票前綴、「查/」AI 查詢、「分類」、「初始化」、指令字典「?」、IG 網址收藏登記、Quick Reply 按鈕（postback）、群組加入／離開、群組指令開關、logs |
| 不負責的事 | 各分頁的資料規則（由寫入的模組負責）；LINE 簽章驗證（Apps Script 讀不到 HTTP 標頭，見「已知限制」） |
| 前端入口 | 無（PWA 端只有「📖 指令字典（ADR-018 B-3）」與「📣 群組推播（ADR-014 D-19）」兩個相關畫面） |
| 後端入口 | `line-router.gs`：`doPost` → `handleLineWebhook_` → `runLineEvent_` → `handleLineEvent_` → `routeLineMessage_`／`groupMessageReply_`；`recordRoute_`、`appendToSheet_`、`handleQuery_`、`handleInitCommand_`、`initSteps_`、`COMMANDS`、`lineReply_`、`linePush_`、`logTransaction_` |
| 相關 API action | 不走 PWA 動作；PWA 端相關的是 `commandDict`、`groupSet`、`pushPreview`、`pushSend` |
| 主要分頁 | `logs`、`line_groups`；寫入目標 `tasks`、`expenses`、`notes`、`stock_trades`、`clips` |
| 外部服務 | LINE Messaging API（回覆、推播、查詢）；「查/」呼叫 AI 供應商 |
| 主要副作用 | 依前綴新增資料列；每筆認得的前綴無論成敗寫一列 logs（回覆送出後才落地）；「初始化」會補欄、建表、重裝排程觸發器 |
| 相關測試檔 | `adr-018-commands.test.mjs`、`adr-013-line-groups.test.mjs`、`adr-018-query.test.mjs`、`adr-022-init-reply.test.mjs`、`line-source.test.mjs`、`line-quick-note.test.mjs`、`adr-018-reminders.test.mjs`、`adr-013-expense-config.test.mjs` |
| 相關 ADR | 前綴路由與 logs（ADR-006）；白名單（ADR-008）；群組入口（ADR-013）；推播路由（ADR-014）；指令字典與減法（ADR-018）；AI 供應商（ADR-017） |
| 已知限制 | `doPost` 只要看到 `events` 陣列就當成 LINE 事件，無法驗證 LINE 簽章，防線只有 `writeGate_` 白名單；沒有以 `webhookEventId` 去重，同一事件重送會寫兩列；回覆後才寫 logs，GAS 中斷時 logs 可能少一筆 |

### 3. PWA 同步與待送佇列

| 欄位 | 內容 |
|---|---|
| 用途 | PWA 與雲端之間的唯一通道：雲端是真相，寫入先進待送佇列，送成功才算數 |
| 負責範圍 | 雲端請求出口、待送佇列（上限、重送、永久拒絕移出）、輪詢、開機讀取、單筆 upsert 與寫入鎖、軟刪除（`del`）、離線顯示連線錯誤 |
| 不負責的事 | 各分頁的業務規則（由各模組的守門函式負責）；收藏、分期、設定等「專用動作」的寫入 |
| 前端入口 | 「雲端請求的唯一出口（ADR-010 D-9）」`cloudPost`；「待送佇列（ADR-009 §一.2 的落地方式）」`outboxAdd`、`flushOutbox`、`sendJob`、`queueUpsert`；「各模組的單筆送出（取代整包 replaceAll）」；「連線狀態」；「輪詢（ADR-009 §二）」；「讀取：雲端是真相（ADR-009 §一.1）」`pullFromCloud`；「2.0 分層載入（ADR-021 D-1｜PR-B）」；「儲存」 |
| 後端入口 | `Code.gs`：`handlePwaSync_`、`routePwaSync_`、`readManyFrom_`、`readSheetResponse_`、`pwaUpsert_`、`upsertRow_`、`completeRecurring_`、`bootResponse_`、`bootCoreResponse_` |
| 相關 API action | `boot`、`readMany`、`read`、`upsert`、`completeRecurring`；`replaceAll` 已退場（呼叫會被拒絕並寫 logs） |
| 主要分頁 | `tasks`、`expenses`、`notes`（一般讀寫）；`NO_PWA_WRITE`／`NO_PWA_READ` 列出的分頁不收一般讀寫 |
| 外部服務 | 無 |
| 主要副作用 | upsert 寫入對應分頁並寫 logs（ADR-026 D-8）；每次請求依 `trigger` 排一列效能紀錄；待送佇列存在 `localStorage` |
| 相關測試檔 | `adr-009.test.mjs`、`adr-009-frontend.test.mjs`、`adr-009-readpath.test.mjs`、`adr-009-endpoints.test.mjs`、`adr-019-write-guard.test.mjs`、`adr-019-write-guard-frontend.test.mjs`、`adr-012-boot.test.mjs`、`adr-012-boot-frontend.test.mjs`、`adr-021-core-boot.test.mjs`、`adr-021-core-frontend.test.mjs`、`adr-018-boot-stages.test.mjs`、`adr-026-logs.test.mjs` |
| 相關 ADR | 雲端為唯一真相、單筆 upsert、軟刪除、離線顯示錯誤（ADR-009）；一趟開機（ADR-012、ADR-018）；佇列上限與 upsert 鎖（ADR-019）；2.0 分層載入（ADR-021） |
| 已知限制 | 新版前端產生的待送資料能否被舊版後端接受，沒有契約測試（待確認）；開機速度與自適應輪詢仍待議 |

### 4. 任務（待辦）

| 欄位 | 內容 |
|---|---|
| 用途 | 個人與家庭待辦：新增、完成、優先度、到期日、週期 |
| 負責範圍 | `tasks` 中 `kind` 為 `todo`（或空白）的列；完成與週期推進；LINE「任務/」；首頁與總覽的任務摘要 |
| 不負責的事 | 提醒（同一張表的 `kind=reminder`，見「提醒」）；白板共享（見「白板」） |
| 前端入口 | 「任務」「改到期日與週期（ADR-014 D-22）」「任務優先度」「到期天數」「總覽 Widget（ADR-021 D-6、D-13｜PR-B：Tasks、Reading）」「深入（C-1 ③）：待辦｜提醒｜白板」 |
| 後端入口 | `Code.gs`：`pwaUpsert_`（tasks 分支）、`taskDone_`、`completeRecurring_`、`nextDueDate_`、`tasksWidget_`；`line-router.gs`：`ROUTE_TABLE['任務']`、`buildTaskRow_`、`taskDatePrompt_` |
| 相關 API action | `upsert`（sheet=tasks）、`completeRecurring`、`taskDone`、`readMany` |
| 主要分頁 | `tasks` |
| 外部服務 | LINE（任務建好後問到期日的 Quick Reply） |
| 主要副作用 | 寫 `tasks`、寫 logs；週期任務完成時推進下一期 |
| 相關測試檔 | `adr-009-recurrence.test.mjs`、`adr-009-recur-complete.test.mjs`、`adr-009-recur-frontend.test.mjs`、`adr-009-board-due.test.mjs`、`adr-019-due-cards.test.mjs`、`adr-021-widgets-c.test.mjs`、`date-local.test.mjs` |
| 相關 ADR | 週期跟著完成走（ADR-009）；到期日 Quick Reply（ADR-014）；待辦與提醒分家（ADR-018） |
| 已知限制 | LINE 寫入的 id 是 `Date.now()`，同一事件重送會寫兩列（見 LINE 入口） |

### 5. 提醒

| 欄位 | 內容 |
|---|---|
| 用途 | 跟著時間走的提醒（繳費、續約）：到期推播、週期自動翻頁 |
| 負責範圍 | `tasks` 中 `kind=reminder` 的列；每天到期檢查與推播；週期提醒翻頁；過期單次提醒的清理 |
| 不負責的事 | 「完成」（提醒不能標完成，後端會擋） |
| 前端入口 | 「深入（C-1 ③）：待辦｜提醒｜白板」「改到期日與週期（ADR-014 D-22）」 |
| 後端入口 | `Code.gs`：`checkDueReminders`、`isReminder_`、`guardReminderDone_`；`line-router.gs`：`ROUTE_TABLE['提醒']`、`parseReminder_`；排程登記 `dueCheck` |
| 相關 API action | `upsert`（sheet=tasks，`kind=reminder`）；提醒模組關掉時新增或修改提醒都被拒絕 |
| 主要分頁 | `tasks`、`line_groups`（推回群組） |
| 外部服務 | LINE 推播 |
| 主要副作用 | 推播到期提醒；寫 `notified`、翻頁改 `due_date`；過期 30 天以上的單次提醒設 `del`；寫 logs |
| 相關測試檔 | `adr-018-reminders.test.mjs`、`adr-018-reminders-frontend.test.mjs`、`adr-014-due-reminders.test.mjs`、`adr-009-duecheck.test.mjs` |
| 相關 ADR | 到期提醒與推回群組（ADR-014）；提醒與待辦分家、跟著時間翻頁（ADR-018） |
| 已知限制 | 每天的檢查在排程總管 9 點後第一輪，最多晚 5 分鐘；月底沿用既有算法，可能漂移 |

### 6. 白板

| 欄位 | 內容 |
|---|---|
| 用途 | 全家共用的釘選板：把任務、記帳、雜記釘起來給大家看 |
| 負責範圍 | `tasks`／`expenses`／`notes` 的 `board` 欄；只有建立者能改自己釘的列 |
| 不負責的事 | 列本身的內容規則（由所屬模組負責） |
| 前端入口 | 「共用白板（ADR-009 §三）」`toggleBoard`、`boardLocked`；「深入（C-1 ③）：待辦｜提醒｜白板」 |
| 後端入口 | `Code.gs`：`BOARD_SHEETS`、`boardOwnerDenied_`、`keepStoredBoard_`、`boardRowsOf_` |
| 相關 API action | `upsert`（帶 `board`）、`boot`（帶回白板列） |
| 主要分頁 | `tasks`、`expenses`、`notes` |
| 外部服務 | 無 |
| 主要副作用 | 白板模組關掉時，upsert 一律保留雲端原本的 `board` 值 |
| 相關測試檔 | `adr-009-board-due.test.mjs`、`adr-019-write-guard.test.mjs`、`adr-021-modules.test.mjs` |
| 相關 ADR | 標籤式共用白板（ADR-009）；白板只改自己的（ADR-019） |
| 已知限制 | 待確認 |

### 7. 記帳

| 欄位 | 內容 |
|---|---|
| 用途 | 收支記錄：大類、細項、對象、備註 |
| 負責範圍 | `expenses` 的一般列；分類設定 `_expense_config` 的讀取與管理者修改；LINE「記帳/」「收入/」「分類」；首頁財務摘要 |
| 不負責的事 | 分期計畫（見「分期」）；信用卡連動（已廢止） |
| 前端入口 | 「記帳」`submitExpense`；「記帳分類（ADR-013：大類 × 細項 × 對象，改由雲端 _expense_config 維護）」；「首頁 Dashboard」；「Finance／Mail／Stocks／Weather Widget」 |
| 後端入口 | `Code.gs`：`expenseConfig_`、`expenseConfigPublic_`、`withExpenseConfig_`、`configSet_`、`configAdd_`、`financeWidget_`、`installAdr013`；`line-router.gs`：`parseExpense_`、`buildExpenseRow_`、`quickCategoryPrompt_`、`handleCategoryCommand_` |
| 相關 API action | `upsert`（sheet=expenses）、`readMany`、`configSet`、`configAdd`、`adminView` |
| 主要分頁 | `expenses`、`_expense_config` |
| 外部服務 | 無 |
| 主要副作用 | 寫 `expenses`、寫 logs；管理者改分類寫 `_expense_config` |
| 相關測試檔 | `adr-013-expense-config.test.mjs`、`adr-015-donut.test.mjs`、`adr-023-monthly-dedupe.test.mjs`、`admin-settings.test.mjs` |
| 相關 ADR | 記帳首頁（ADR-004）；前綴路由（ADR-006）；細項與對象、分類改由雲端維護（ADR-013） |
| 已知限制 | `_guide` 寫 `_expense_config`「PWA 不可寫」，但管理者可經 `configSet`／`configAdd` 寫入（文件與程式不一致，以程式為準） |

### 8. 分期

| 欄位 | 內容 |
|---|---|
| 用途 | 把一筆支出轉成分期：計畫一列、各期是 `expenses` 裡帶 `plan_id` 的列 |
| 負責範圍 | 建立、結束、刪除、調整分期計畫 |
| 不負責的事 | 一般記帳列 |
| 前端入口 | 「分期（ADR-013 T4）」「調整計畫（ADR-018 E-2）」 |
| 後端入口 | `Code.gs`：`planCreate_`、`planDelete_`、`planEnd_`、`planAdjust_`、`planForbidden_`、`installmentPlans_` |
| 相關 API action | `planCreate`、`planDelete`、`planEnd`、`planAdjust` |
| 主要分頁 | `installments`、`expenses` |
| 外部服務 | 無 |
| 主要副作用 | 同時寫 `installments` 與 `expenses` 的各期列；寫 logs |
| 相關測試檔 | `adr-013-installments.test.mjs`、`adr-018-plan-adjust.test.mjs` |
| 相關 ADR | 分期只走專用動作（ADR-013）；調整計畫（ADR-018） |
| 已知限制 | `installments` 在 `NO_PWA_WRITE`：一般 upsert 改得到計畫列卻改不到各期，所以只開專用動作 |

### 9. 雜記

| 欄位 | 內容 |
|---|---|
| 用途 | 隨手記：靈感、備忘；類別存成內容開頭的 `[類別]` |
| 負責範圍 | `notes`；App 新增／刪除／事後分類（🏷️）；LINE「幫我記/」（不帶分類） |
| 不負責的事 | 圖書館收藏（見「圖書館」） |
| 前端入口 | 「雜記」`addNote`、`setNoteTag`；「雜記類別（原成長頁的「創造」類型）」`NOTE_TAGS` |
| 後端入口 | 一般 upsert；`line-router.gs`：`ROUTE_TABLE['幫我記']`、`parseNote_`、`buildNoteRow_` |
| 相關 API action | `upsert`（sheet=notes）、`readMany` |
| 主要分頁 | `notes` |
| 外部服務 | 無 |
| 主要副作用 | 寫 `notes`、寫 logs（來源「雜記」） |
| 相關測試檔 | `line-quick-note.test.mjs`、`small-tickets-20261008.test.mjs`、`adr-009-frontend.test.mjs` |
| 相關 ADR | 待確認（類別約定見 `index.html` 的註解；LINE 快記為 2026-11-12 的小改，沒有獨立 ADR） |
| 已知限制 | 類別是字串約定、不是欄位，統計要靠字串解析 |

### 10. 圖書館（收藏）

| 欄位 | 內容 |
|---|---|
| 用途 | 收 IG 貼文全文與圖片、其他網址只存連結；閱讀、筆記、分類、閱讀狀態、圖片辨識、AI 整理 |
| 負責範圍 | `clips` 全部生命週期：LINE 或 App 登記 → 排程抓取存 Drive → 閱讀頁；只限擁有者的各種修改；排程自動文字辨識 |
| 不負責的事 | 通用網頁全文擷取（未實作）；辨識文字納入搜尋（未實作） |
| 前端入口 | 「📚 收藏（ADR-020 RD-2）」`loadClips`；「📚 圖書館（ADR-021 D-10～D-13｜PR-E，只在 2.0）」；「圖書館分類（ADR-023 D-7、D-8，只在 2.0）」；「圖片辨識（ADR-024，只在 2.0）」 |
| 後端入口 | `clips.gs`：`clipLineReply_`、`clipsRegister_`、`runClipsJob_`、`runClipOcrJob_`、`runApifyUsageJob_`、`clipOwnRow_`、`clipPwaAction_`、`clipNote_`、`clipAi_`、`clipAdd_`、`clipReadStateSet_`、`clipCategorySet_`、`clipOcr_`、`clipVision_`、`clipsVisibleTo_`；探針 `lab-clip.gs` |
| 相關 API action | `clipRetry`、`clipDelete`、`clipRead`、`clipNote`、`clipAi`、`clipAdd`、`clipReadState`、`clipCategory`、`clipOcr`、`clipVision`、`readMany`（只回自己的列） |
| 主要分頁 | `clips`、`_clip_categories` |
| 外部服務 | Apify（IG 擷取）、圖片下載、Drive API（文字辨識）、AI 供應商（AI 整理、AI 辨識）；探針另用 Jina |
| 主要副作用 | 寫 `clips`；在 Drive 建資料夾、存圖片與原始檔；文字辨識建暫存文件後永久刪除；寫 logs |
| 相關測試檔 | `adr-020-clips.test.mjs`、`adr-020-clips-frontend.test.mjs`、`adr-021-library-e.test.mjs`、`adr-021-library-e-frontend.test.mjs`、`adr-023-library-categories.test.mjs`、`adr-023-library-categories-frontend.test.mjs`、`adr-024-clip-ocr.test.mjs`、`adr-024-clip-ocr-frontend.test.mjs`、`adr-024-clip-vision.test.mjs`、`adr-024-clip-vision-frontend.test.mjs`、`adr-024-clip-ai-recog.test.mjs`、`adr-024-ocr-probe.test.mjs`、`adr-025-read-state.test.mjs`、`adr-025-read-state-frontend.test.mjs`、`clip-ocr-auto.test.mjs`、`rd-clip-probe.test.mjs` |
| 相關 ADR | 收藏搜集器（ADR-020）；圖書館閱讀、筆記 revision、AI 整理（ADR-021）；分類（ADR-023）；圖片辨識（ADR-024）；閱讀狀態（ADR-025） |
| 已知限制 | `lab-clip.gs` 實驗探針目前隨正式版部署；文字辨識一張圖 3 個 Drive 請求，暫存刪不掉時要人工到 Drive 搜 `tmp_ocr_` |

### 11. 郵件

| 欄位 | 內容 |
|---|---|
| 用途 | Gmail 控制員：依規則認信、貼標籤、存帳單附件、彙報；規則封存（預設預演） |
| 負責範圍 | 規則表、處理紀錄、封存開關、整理報告、即時讀純文字內文、首頁郵件摘要 |
| 不負責的事 | 刪信、標已讀、動星號（契約禁止）；信件內文保存 |
| 前端入口 | 「📬 郵件（ADR-016 T7）」「📊 整理報告（ADR-026 D-4）」「純文字閱讀頁（ADR-026 D-10）」「📬 郵件封存開關（ADR-026 D-3，設定▸管理）」 |
| 後端入口 | `gmail.gs`：`runGmailController_`、`gmailArchiveSweep_`、`gmailView_`、`gmailRuleSet_`、`gmailArchiveSet_`、`gmailBody_`、`gmailForbidden_`、`installGmail_` |
| 相關 API action | `gmailView`、`gmailRuleSet`、`gmailArchiveSet`、`gmailBody`（皆限管理者＋`feat_gmail`） |
| 主要分頁 | `gmail_rules`、`gmail_log`、`ETC_Data`（歷史，凍結） |
| 外部服務 | Gmail、Drive、LINE 推播 |
| 主要副作用 | Gmail 貼標籤、（開啟正式封存時）封存；Drive 存附件；寫 `gmail_log`；推播摘要；寫 logs |
| 相關測試檔 | `adr-016-controller.test.mjs`、`adr-016-frontend.test.mjs`、`adr-016-probe.test.mjs`、`adr-023-gmail-parsers.test.mjs`、`adr-026-mail-archive.test.mjs`、`adr-026-mail-frontend.test.mjs` |
| 相關 ADR | Gmail 控制員（ADR-016）；Mail 整理 v2 與 logs 補齊（ADR-026，正式封存開關只由專案擁有者在 App 開啟） |
| 已知限制 | 不得對真實 Gmail 做批次封存或測試性操作；內文與金額不進 logs／performance／fixtures |

### 12. 股票

| 欄位 | 內容 |
|---|---|
| 用途 | 自選股、持股、交易紀錄、提醒規則、再平衡試算 |
| 負責範圍 | 報價（多來源備援）、持股計算、交易與自選的寫入把關、規則觸發推播、盤後收盤價、LINE「買/」「賣/」「股/」、首頁股票摘要 |
| 不負責的事 | 下單（只記錄） |
| 前端入口 | 「股票（ADR-015 T4）」「交易表單」「自選清單（管理者）」「股票 PR-B：提醒規則、再平衡、首頁卡片（ADR-015 T5／T6／T8）」 |
| 後端入口 | `stock.gs`：`stockResponse_`、`quote_`、`guardStockTrade_`、`guardStockWatch_`、`guardStockRule_`、`writeStockRow_`、`computeRebalance_`、`evaluateRule_`、`checkStockRules`、`fetchStockDaily`、`stockConfigSet_`、`stockPushMe_`、`handleStockCommand_`、`installStock_` |
| 相關 API action | `stock`、`stockConfigSet`、`stockPushMe`、`upsert`（sheet=stock_trades／stock_watch／stock_rules，只開 upsert） |
| 主要分頁 | `stock_trades`、`stock_watch`、`stock_rules`、`stock_daily`、`_stock_config`、`_stock_gf` |
| 外部服務 | 行情 API（`fugle`）、證交所（`twse`）、櫃買中心（`tpex`）、GOOGLEFINANCE（公式備援）、LINE 推播 |
| 主要副作用 | 寫交易、自選、規則與收盤價；規則觸發時推播並寫 `last_fired_at`；寫 logs |
| 相關測試檔 | `adr-015-stock.test.mjs`、`adr-015-frontend.test.mjs`、`adr-015-probe.test.mjs`、`adr-023-stock-widget.test.mjs`、`adr-023-stock-widget-frontend.test.mjs` |
| 相關 ADR | 自選、持股、提醒規則（ADR-015）；首頁股票 pin 與兩種損益（ADR-023） |
| 已知限制 | 部分標的與規則是寫死的常數（盤點中，Phase 2 候選） |

### 13. 搜尋

| 欄位 | 內容 |
|---|---|
| 用途 | 2.0 按需關鍵字搜尋 |
| 負責範圍 | 任務、提醒、雜記、圖書館（標題、全文、筆記；只存連結比網址）、記帳備註；只搜自己的列（白板例外） |
| 不負責的事 | 郵件、股票、辨識文字；語意或向量搜尋 |
| 前端入口 | 「🔎 搜尋（ADR-021 D-5｜PR-F）」`runSearch` |
| 後端入口 | `search.gs`：`search_`、`searchGroup_` |
| 相關 API action | `search` |
| 主要分頁 | `tasks`、`notes`、`clips`、`expenses`（唯讀） |
| 外部服務 | 無 |
| 主要副作用 | 無寫入；記效能紀錄 |
| 相關測試檔 | `adr-021-search-f.test.mjs`、`adr-021-search-f-frontend.test.mjs` |
| 相關 ADR | 2.0 搜尋（ADR-021） |
| 已知限制 | 每次搜尋會讀多張 Sheet，不可放進冷開機路徑 |

### 14. 總覽 Widget

| 欄位 | 內容 |
|---|---|
| 用途 | 2.0 首頁的摘要卡片：任務、財務、郵件、股票、閱讀、天氣 |
| 負責範圍 | 核心層開機、Widget 摘要（一個失敗不拖垮其他）、個人排序／隱藏／釘選、Apps 常用與隱藏 |
| 不負責的事 | 各模組的完整資料（點進模組才載） |
| 前端入口 | 「2.0 殼（ADR-021 PR-A：D-2、D-3、D-4、D-9、D-20）」「總覽 Widget（ADR-021 D-6、D-13｜PR-B：Tasks、Reading）」「Finance／Mail／Stocks／Weather Widget」「Widget 順序與個人設定（ADR-021 D-7、D-8｜PR-C）」「總覽編輯模式：拖曳排序、隱藏、📌 釘選（D-8、D-19）」「Apps 編輯模式：📌 常用、隱藏圖示（D-9 ③）」「首頁重畫量測（ADR-023 D-12：只量、不改行為，只在 2.0）」 |
| 後端入口 | `Code.gs`：`bootCoreResponse_`、`widgetsResponse_`、`bootWidgets_`、`widgetSafe_`；`widgets.gs`：`widgetConfigSet_`、`widgetConfigOf_` |
| 相關 API action | `boot`（`core:true`）、`widgets`、`widgetConfigSet` |
| 主要分頁 | `widget_config`（＋各 Widget 讀的資料分頁） |
| 外部服務 | 無（天氣見下一節） |
| 主要副作用 | `widgetConfigSet` 只寫自己那一列並寫 logs |
| 相關測試檔 | `adr-021-widgets-c.test.mjs`、`adr-021-widgets-c-frontend.test.mjs`、`adr-021-shell.test.mjs`、`adr-021-shell-frontend.test.mjs`、`adr-021-perf-ui.test.mjs`、`adr-023-render-probe.test.mjs`、`adr-018-home.test.mjs` |
| 相關 ADR | 2.0 Shell 與 Widget 首頁（ADR-021）；首頁重畫量測（ADR-023） |
| 已知限制 | 1.0 首頁（ADR-018 三層）在試營運期間仍保留 |

### 15. 天氣

| 欄位 | 內容 |
|---|---|
| 用途 | 總覽天氣卡：依個人設定的地點顯示鄉鎮預報 |
| 負責範圍 | 每小時依縣市抓一次預報、快取、API 擋下時改讀鏡像、失敗不洗掉上一份 |
| 不負責的事 | 「沒資料」不代表「沒下雨」，前端要顯示失敗 |
| 前端入口 | 「設定：天氣地點（D-15，只在 2.0）」「Finance／Mail／Stocks／Weather Widget」 |
| 後端入口 | `widgets.gs`：`runWeatherJob_`、天氣快取讀寫；排程登記 `weather` |
| 相關 API action | `widgets`（`only` 含 weather）、`widgetConfigSet`（改地點） |
| 主要分頁 | `widget_config`（地點）；快取在指令碼屬性 `weather_cache`，不是分頁 |
| 外部服務 | 中央氣象署開放資料（`cwa`）、官方 AWS 鏡像（`cwa_mirror`） |
| 主要副作用 | 寫指令碼屬性 `weather_cache`、`weather_api_paused_until` |
| 相關測試檔 | `adr-021-widgets-c.test.mjs`、`adr-021-widgets-c-frontend.test.mjs`（天氣部分）、`adr-019-scheduler.test.mjs`（排程登記） |
| 相關 ADR | 2.0 總覽天氣（ADR-021 D-15） |
| 已知限制 | 授權碼放指令碼屬性 `WEATHER_API`，沒設定時天氣卡一直沒資料 |

### 16. AI 供應商

| 欄位 | 內容 |
|---|---|
| 用途 | 統一切換與呼叫 AI（Gemini、OpenAI、Claude） |
| 負責範圍 | 供應商與模型選擇、文字與看圖呼叫、最後一次錯誤 |
| 不負責的事 | 權限、金額計算、去重等確定性邏輯（原則 5） |
| 前端入口 | 「🤖 AI 供應商（ADR-017 D-1～D-4、D-6）」 |
| 後端入口 | `ai.gs`：`callAi_`、`callAiVision_`、`aiProviders_`、`aiConfigGet_`、`aiConfigSet_`；呼叫者 `line-router.gs` 的 `handleQuery_`、`clips.gs` 的 `clipAi_`／`clipVision_` |
| 相關 API action | `aiConfigGet`、`aiConfigSet`（限管理者） |
| 主要分頁 | 無（設定在指令碼屬性） |
| 外部服務 | Gemini、OpenAI、Anthropic API（皆經 `callApi_`） |
| 主要副作用 | 寫指令碼屬性 `AI_PROVIDER`、各家 `*_MODEL`、`AI_LAST_ERROR`；用量排隊記帳 |
| 相關測試檔 | `adr-017-ai.test.mjs`、`adr-018-query.test.mjs` |
| 相關 ADR | AI 供應商切換（ADR-017） |
| 已知限制 | 失敗不自動換家 |

### 17. API 成本

| 欄位 | 內容 |
|---|---|
| 用途 | 所有外部 HTTP 呼叫的唯一出口與用量、費用記帳 |
| 負責範圍 | `callApi_`／`callApiAll_`、api_id 登記表、AI 照 token 計費、其他只計次、每日小計、月結估算、價目查核、額度警示、成本卡 |
| 不負責的事 | 實際帳單對帳（`actual_amount` 由專案擁有者手填） |
| 前端入口 | 「效能紀錄（ADR-012 T1）」宣告的 `costSummary`／`apiAlerts`；「2.0：模組自己的設定搬回模組（ADR-021 D-14｜PR-D）」的查價 |
| 後端入口 | `api-cost.gs`：`callApi_`、`callApiAll_`、`apiCatalog_`、`flushApiUsage`、`apiPriceCheck_`、`apiPriceApply_`、`apiCostSummary_`、`installApiCost_` |
| 相關 API action | `apiPriceCheck`、`apiPriceApply`、`apiCostSummary`（限管理者，且成本模組要開） |
| 主要分頁 | `api_registry`、`api_usage`、`api_usage_daily`、`api_cost_monthly` |
| 外部服務 | LiteLLM 公開價目表（查價） |
| 主要副作用 | 呼叫當下只排隊（指令碼屬性與快取），排程 `apiFlush` 落地 |
| 相關測試檔 | `adr-022-api-cost.test.mjs`、`adr-022-cost-card.test.mjs`、`adr-022-price-check.test.mjs`、`cost-module.test.mjs` |
| 相關 ADR | API 成本與外部呼叫唯一出口（ADR-022） |
| 已知限制 | 出口檢查 `scripts/check-api-exit.mjs` 只在 `pr-check` 執行，不在 `npm test` 內；成本模組關掉只擋「看」與查價，記帳照常 |

### 18. 排程總管

| 欄位 | 內容 |
|---|---|
| 用途 | 整個專案唯一的時間觸發器，依序派工，讓排程不可能重疊 |
| 負責範圍 | `runScheduler`（每 5 分鐘）、到期判斷 `schedulerDue_`、整輪 4 分鐘預算、單一工作失敗不影響後面、心跳與慢執行 logs、模組關掉時跳過 |
| 不負責的事 | 各工作本身的邏輯（在各自的檔案） |
| 前端入口 | 無 |
| 後端入口 | `scheduler.gs`：`runScheduler`、`schedulerJobs_`、`schedulerDue_`、`installScheduler_`（由「初始化」呼叫） |
| 相關 API action | 無 |
| 主要分頁 | `logs`（心跳、失敗、慢） |
| 外部服務 | 無（各工作自己的） |
| 主要副作用 | 狀態存指令碼屬性 `sched_state`；每個工作的副作用見各模組 |
| 相關測試檔 | `adr-019-scheduler.test.mjs`、`clip-ocr-auto.test.mjs`（登記） |
| 相關 ADR | 排程總管（ADR-019） |
| 已知限制 | 總管是單點，掛了全部停；靠每日心跳與慢執行 logs 發現 |

目前登記的工作（順序即執行順序，以 `schedulerJobs_()` 為準）：股票提醒規則、到期提醒、Gmail 控制員、`_guide` 導覽、未驗證彙總、盤後收盤價、收藏搜集、圖書館文字辨識、Apify 用量、天氣、API 用量記帳、效能紀錄落地。

### 19. 效能紀錄

| 欄位 | 內容 |
|---|---|
| 用途 | 每個請求、LINE 事件、排程的耗時，用來找慢的地方 |
| 負責範圍 | 依 `trigger` 記錄、分段計時、先排隊再由排程單一寫入者落地、管理者摘要與清理、未驗證請求每小時彙總 |
| 不負責的事 | 資料內容（不存 token、不存內容） |
| 前端入口 | 「效能紀錄（ADR-012 T1）」`perfNote`；「效能紀錄的管理頁（ADR-012 T1 1-4）」；「等待畫面」 |
| 後端入口 | `Code.gs`：`recordPerf_`、`queuePerfRows_`、`flushPerfQueue`、`flushUnauthPerf`、`recordSchedulePerf_`、`perfSummary_`、`perfPurge_` |
| 相關 API action | `perfSummary`、`perfPurge`（限管理者）；所有已驗證動作都會依 `trigger` 記一列 |
| 主要分頁 | `performance` |
| 外部服務 | 無 |
| 主要副作用 | 排隊存在指令碼屬性（`perfq_*`），排程 `perfFlush` 寫入分頁 |
| 相關測試檔 | `adr-012-perf.test.mjs`、`adr-012-perf-frontend.test.mjs`、`adr-019-perf.test.mjs`、`adr-019-perf-frontend.test.mjs`、`adr-014-perf-push.test.mjs`、`adr-018-speed-backend.test.mjs`、`adr-018-speed-frontend.test.mjs`、`adr-021-perf-ui.test.mjs`、`perf-tuning.test.mjs` |
| 相關 ADR | 效能紀錄（ADR-012）；trigger 規則與未驗證彙總（ADR-014）；單一寫入者（ADR-019） |
| 已知限制 | 新增雲端動作必須帶 trigger，否則不會被記錄（測試守門） |

### 20. 模組總開關

| 欄位 | 內容 |
|---|---|
| 用途 | 一個開關讓某個模組對所有人、1.0／2.0 都停用，但不刪資料 |
| 負責範圍 | `_module_registry`（記帳、分期、股票、任務、提醒、白板、雜記、郵件、圖書館、成本）；`canUse_` 先問總開關；欄位級擋（提醒、白板、分期）；排程工作跳過 |
| 不負責的事 | 個人權限 `feat_*`（見身份）；刪資料 |
| 前端入口 | 「2.0 殼（ADR-021 PR-A…）」；「設定：天氣地點（D-15，只在 2.0）」段落裡的 `moduleBusy`（總開關切換） |
| 後端入口 | `modules.gs`：`moduleOn_`、`modulesOff_`、`moduleSet_`、`modulesForPwa_`、`ensureModuleRegistry_`、`MODULE_OF_FEATURE`；`Code.gs`：`sheetModuleOff_`、`moduleOffDenied_` |
| 相關 API action | `moduleSet`（限管理者）；`boot` 帶回登記表 |
| 主要分頁 | `_module_registry` |
| 外部服務 | 無 |
| 主要副作用 | 改 `_module_registry`、清模組快取、寫 logs |
| 相關測試檔 | `adr-021-modules.test.mjs`、`adr-021-modules-frontend.test.mjs`、`cost-module.test.mjs` |
| 相關 ADR | 模組總開關（ADR-021 D-9） |
| 已知限制 | 關掉的模組被拒絕是「永久拒絕」，前端會把那筆移出待送佇列 |

### 21. `_guide` 導覽

| 欄位 | 內容 |
|---|---|
| 用途 | 試算表裡每張分頁是做什麼的；由 repo 的登記表產生，避免說明漂移 |
| 負責範圍 | `guideRegistry_()` 登記表、`refreshGuide` 整張重寫（只保留「備註」欄）、App 系統設定的導覽分頁 |
| 不負責的事 | 分頁本身的建立（各模組的安裝函式） |
| 前端入口 | 「系統設定（管理員，2026-10-06）」 |
| 後端入口 | `sheet-guide.gs`：`guideRegistry_`、`refreshGuide`、`guideRows_` |
| 相關 API action | `adminView`（`what` 為導覽） |
| 主要分頁 | `_guide` |
| 外部服務 | 無 |
| 主要副作用 | 每天 6 點後第一輪整張重寫 `_guide`；寫 logs |
| 相關測試檔 | `sheet-guide.test.mjs` |
| 相關 ADR | 待確認（2026-09-23 交棒票決定，沒有獨立 ADR） |
| 已知限制 | 沒登記的分頁標「⚠️ 未登記」，不會報錯 |

### 22. 管理與設定

| 欄位 | 內容 |
|---|---|
| 用途 | 管理者的系統設定與家人的個人設定 |
| 負責範圍 | 封存寄信（已刪除列寄給管理者後實際刪除）、群組推播、群組開關、記帳分類修改、系統設定檢視、指令字典、給自己的一段話、顯示主題、LOG 頁 |
| 不負責的事 | 各模組自己的設定（2.0 已搬回各模組） |
| 前端入口 | 「設定頁（ADR-014 D-9、D-10）」「系統設定（管理員，2026-10-06）」「封存：寄信給管理者」「📣 群組推播（ADR-014 D-19）」「LOG 頁（ADR-006 §C／§D）」「給自己的一段話（C-4）」「顯示設定：亮／暗／自動（2026-09-24 晨曦配色票 ①）」「📖 指令字典（ADR-018 B-3）」 |
| 後端入口 | `Code.gs`：`archiveByMail_`、`pushPreview_`、`pushSend_`、`groupSet_`、`configSet_`、`configAdd_`、`adminView_`、`selfNoteSet_`、`adminForbidden_`；`line-router.gs`：`commandDictForPwa_` |
| 相關 API action | `archiveMail`、`pushPreview`、`pushSend`、`groupSet`、`configSet`、`configAdd`、`adminView`、`selfNoteSet`、`commandDict`、`read`（sheet=logs，限管理者） |
| 主要分頁 | `logs`、`line_groups`、`_expense_config`、`self_notes`、各資料分頁（封存） |
| 外部服務 | MailApp（封存寄信）、LINE 推播 |
| 主要副作用 | 封存會**實際刪除**已軟刪除的列（先寄信備份）；推播會送到 LINE 群組；寫 logs |
| 相關測試檔 | `archive-mail.test.mjs`、`adr-009-archive.test.mjs`、`admin-settings.test.mjs`、`adr-014-frontend.test.mjs`、`adr-014-zones.test.mjs`、`adr-021-settings-d-frontend.test.mjs`、`adr-018-home.test.mjs`、`theme.test.mjs`、`cleanup-review.test.mjs` |
| 相關 ADR | LOG 頁（ADR-006）；封存改為寄信（ADR-011）；設定頁與推播路由（ADR-014）；首頁三層與指令字典（ADR-018） |
| 已知限制 | 管理者可經一般 upsert 改寫 `logs`（稽核紀錄可被改寫，Phase 2 候選） |

### 已退場

- **日誌（reviews）、心情（moods）**：ADR-018 退場，介面已移除、資料保留；封存流程仍處理已刪除的列。
- **兩區版面**：ADR-014 的兩區在 2.0 退場（ADR-021），相關前端段落仍在（「兩區（ADR-014 D-1～D-8）」等），1.0 仍會用到部分。

---

## 前端段落索引（`index.html`）

`index.html` 用 `/* ---------- 標題 ---------- */` 分段。以**標題文字**當錨點（直接搜尋），行號只是產生當時（`main@213a48a`）的參考，會漂移。前 5 段在 `<style>` 裡，是 CSS。

「主要全域狀態」列的是該段落宣告的 `let` 變數，以及讀寫的 `state.*` 欄位。

| 行號（參考） | 段落標題 | 所屬模組 | 主要全域狀態 |
|---|---|---|---|
| 468 | 首頁：導覽版位開關（ADR-006 §C） | CSS | — |
| 501 | LOG 頁（ADR-006 §C） | CSS | — |
| 538 | 配對／白名單／功能矩陣（ADR-008 → ADR-010） | CSS | — |
| 718 | ADR-014：兩區切換的動畫（D-8） | CSS | — |
| 792 | ADR-014：右上角大頭貼與設定頁（D-9、D-10） | CSS | — |
| 1481 | 功能清單（權限矩陣的順序與標籤） | 身份與配對 | 常數 `FEATURE_ITEMS` |
| 1497 | 兩區（ADR-014 D-1～D-8） | 管理與設定（1.0 版面） | `zone`、`zoneTransition`、`zonePressAt` |
| 1516 | 身份、白名單與功能矩陣（ADR-008 → ADR-010） | 身份與配對 | `cloudDenied`、`modules`、`deviceToken`、`myLineId`、`myDeviceId`、`roster` |
| 1623 | 身份：讀取與套用 | 身份與配對 | — |
| 1633 | 雲端請求的唯一出口（ADR-010 D-9） | PWA 同步 | `cloudPost` |
| 1666 | 效能紀錄（ADR-012 T1） | 效能紀錄、API 成本 | `perfPending`、`lastRequestId`、`apiAlerts`、`costSummary`、`unauthAlert`、`clipsUsage` |
| 1930 | 配對／續期／停用的蓋版（ADR-010 D-3） | 身份與配對 | `pairBusy` |
| 2042 | 流程 C：過期續期 | 身份與配對 | `renew`、`renewBusy`、`renewPollTimer` |
| 2118 | 身份卡 | 身份與配對 | — |
| 2139 | 自己的 Email（2026-10-01） | 身份與配對 | `emailEditing` |
| 2232 | 只看我的／全部（ADR-008 C-3） | 身份與配對 | `scopeMine`（宣告在「身份、白名單與功能矩陣」段落） |
| 2260 | 成員與權限（is_admin，ADR-008 D-4） | 身份與配對 | `adminOpen`、`adminDevices` |
| 2273 | 已配對的裝置（ADR-010 D-7） | 身份與配對 | — |
| 2455 | 雜記類別（原成長頁的「創造」類型） | 雜記 | `selectedNoteTag`、`taggingNoteId` |
| 2466 | LOG 頁（ADR-006 §C／§D） | 管理與設定 | `logsCache`、`logsLoading`、`logsFailed`、`logFilter*` |
| 2478 | 任務優先度 | 任務 | — |
| 2484 | 記帳分類（ADR-013：大類 × 細項 × 對象，改由雲端 _expense_config 維護） | 記帳、分期 | `expenseConfig`、`installmentPlans`、`planDraft`、`planAdjDraft`、`state` |
| 2515 | 工具 | 共用 | — |
| 2553 | 儲存 | PWA 同步 | `state`（本機） |
| 2566 | 日誌的鍵：日期 ＋ 寫的人 | 已退場（日誌） | `state.reviews`、`state.tasks` |
| 2597 | 待送佇列（ADR-009 §一.2 的落地方式） | PWA 同步 | `outbox` |
| 2771 | 各模組的單筆送出（取代整包 replaceAll） | PWA 同步 | `state.reviews` |
| 2791 | 連線狀態（ADR-009 §一.1 的代價，要讓人看得懂） | PWA 同步 | — |
| 2810 | 輪詢（ADR-009 §二） | PWA 同步 | `pollTimer`、`hiddenAt`、`pullPromise` |
| 2880 | 讀取：雲端是真相（ADR-009 §一.1） | PWA 同步 | `cloudOnline`、`cloudRows`；`state.tasks／notes／expenses／reviews／moods` |
| 3025 | 封存：寄信給管理者（2026-10-01 …，取代 ADR-009 §一.4 的下載流程） | 管理與設定 | — |
| 3073 | 效能紀錄的管理頁（ADR-012 T1 1-4） | 效能紀錄 | — |
| 3157 | 📖 指令字典（ADR-018 B-3） | LINE 入口 | `dictState` |
| 3180 | 🤖 AI 供應商（ADR-017 D-1～D-4、D-6） | AI 供應商 | `aiState` |
| 3255 | 系統設定（管理員，2026-10-06） | 管理與設定、`_guide` | `sysTab`、`sysData`、`sysLoading` |
| 3305 | 2.0：模組自己的設定搬回模組（ADR-021 D-14｜PR-D） | 管理與設定、API 成本 | `priceCheckData` |
| 3658 | 📬 郵件（ADR-016 T7） | 郵件 | `mailData`、`mailLoading`、`mailType`、`mailReport`、`mailReader` |
| 3737 | 📊 整理報告（ADR-026 D-4） | 郵件 | — |
| 3795 | 純文字閱讀頁（ADR-026 D-10） | 郵件 | — |
| 3865 | 📬 郵件封存開關（ADR-026 D-3，設定▸管理） | 郵件、分期 | `mailArchiveState`、`planShowEnded` |
| 3951 | 調整計畫（ADR-018 E-2） | 分期 | — |
| 4042 | 股票（ADR-015 T4） | 股票 | `stockData`、`stockFailed`、`stockTab`、`stockOwnerFilter`、`stockEditId`、`stockSide` |
| 4238 | 交易表單 | 股票 | — |
| 4316 | 自選清單（管理者） | 股票 | — |
| 4333 | 股票 PR-B：提醒規則、再平衡、首頁卡片（ADR-015 T5／T6／T8） | 股票 | `stockConfigSaving` |
| 4477 | 導覽 | 共用（1.0／2.0） | — |
| 4532 | 兩區：導覽、首頁鈕、切換（ADR-014 D-1～D-8） | 管理與設定（1.0 版面） | — |
| 4638 | 2.0 殼（ADR-021 PR-A：D-2、D-3、D-4、D-9、D-20） | 總覽 Widget、模組總開關 | `uiV2Applied` |
| 4700 | 2.0 分層載入（ADR-021 D-1｜PR-B） | PWA 同步 | `v2Loaded`、`v2JustLoaded` |
| 4752 | 總覽 Widget（ADR-021 D-6、D-13｜PR-B：Tasks、Reading） | 總覽 Widget、任務 | `widgets`、`widgetSyncing`、`widgetDoneIds`、`v2TaskSeg` |
| 4824 | 首頁重畫量測（ADR-023 D-12：只量、不改行為，只在 2.0） | 總覽 Widget | `renderProbe` |
| 4962 | Finance／Mail／Stocks／Weather Widget（ADR-021 D-6、D-15、D-16｜PR-C） | 總覽 Widget、天氣 | — |
| 5052 | Widget 順序與個人設定（ADR-021 D-7、D-8｜PR-C） | 總覽 Widget | `widgetConfig`、`widgetsMeta`、`longPress` |
| 5110 | 總覽編輯模式：拖曳排序、隱藏、📌 釘選（D-8、D-19） | 總覽 Widget | `widgetEditing` |
| 5221 | Apps 編輯模式：📌 常用、隱藏圖示（D-9 ③） | 總覽 Widget | `appsEditing` |
| 5243 | 設定：天氣地點（D-15，只在 2.0） | 天氣、模組總開關 | `appZoomFrom`、`moduleBusy` |
| 5360 | 導覽版位開關（ADR-006 §C） | 共用 | — |
| 5363 | 任務 | 任務 | `state.tasks` |
| 5458 | 改到期日與週期（ADR-014 D-22） | 任務、提醒 | `state.tasks` |
| 5576 | 雜記 | 雜記 | `state.notes` |
| 5649 | 📚 收藏（ADR-020 RD-2） | 圖書館 | `noteSeg`、`clipsData`、`clipsLoading`、`clipOpenId` |
| 5829 | 📚 圖書館（ADR-021 D-10～D-13｜PR-E，只在 2.0） | 圖書館 | `clipFilter`、`clipNoteDraft`、`clipNoteConflict`、`clipBusy` |
| 5882 | 圖書館分類（ADR-023 D-7、D-8，只在 2.0） | 圖書館 | `clipCats`、`clipCatFilter` |
| 5952 | 圖片辨識（ADR-024，只在 2.0） | 圖書館 | — |
| 6102 | 🔎 搜尋（ADR-021 D-5｜PR-F） | 搜尋 | `searchState`；讀 `state.tasks／notes／expenses` |
| 6153 | 週回顧 | 已退場 | — |
| 6157 | 輸出追蹤 | 已退場 | — |
| 6159 | 記帳 | 記帳 | `state.expenses` |
| 6340 | 分期（ADR-013 T4） | 分期 | `state.expenses` |
| 6512 | 首頁 Dashboard | 記帳（1.0 首頁） | `donutOpen` |
| 6657 | 首頁三層（ADR-018 C-1～C-6） | 管理與設定（1.0 首頁） | `firstLoadDone`、`selfNote`、`selfNoteEditing`、`mailSummary`、`deepPane` |
| 6762 | 給自己的一段話（C-4） | 管理與設定 | `state.expenses`、`state.notes` |
| 6839 | 深入（C-1 ③）：待辦｜提醒｜白板 | 任務、提醒、白板 | — |
| 6906 | 等待畫面（ADR-012 D-5 → ADR-018 D-1／D-3） | 效能紀錄、PWA 同步 | `progressTimers` |
| 6966 | 共用白板（ADR-009 §三） | 白板 | — |
| 7014 | 到期天數 | 任務、提醒 | — |
| 7033 | 顯示設定：亮／暗／自動（2026-09-24 晨曦配色票 ①） | 管理與設定 | — |
| 7072 | 設定頁（ADR-014 D-9、D-10） | 管理與設定 | `settingsOpen`、`settingsTab`、`foldOpen`、`myDevices` |
| 7155 | 📣 群組推播（ADR-014 D-19） | 管理與設定、LINE 入口 | `pushState` |
| 7260 | LOG 頁（ADR-006 §C／§D） | 管理與設定 | — |
| 7396 | Service Worker 換版（2026-10-07 效能調查） | PWA 同步 | — |

> 少數段落標題較長，本索引只寫可搜尋的開頭（以「…」表示省略）。
