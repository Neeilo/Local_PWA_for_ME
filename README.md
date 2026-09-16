# Neil OS — 個人小系統

安裝在手機主畫面的個人小系統 PWA，資料主要存在本機（localStorage），並會同步備份到 Google Sheets。

🔗 **Live**: https://neeilo.github.io/Local_PWA_for_ME/

## 功能

底部導覽：**左 ｜ ⭕首頁 ｜ 右**，圓心固定，其餘六個功能由使用者在首頁的「導覽配置」自行決定**靠左／靠右／不顯示**。

**每側最多 3 個**——上限來自版面，左 3 ｜ ⭕ ｜ 右 3（共 7 格）是 320px 螢幕仍讀得清楚的極限。同一側依固定順序排列，不提供拖曳排序：手機上的拖曳很難做得好用，而這裡要解決的是「慣用手拿不拿得到」，左右歸屬就足夠了。

某側已滿時再點會**擋下並提示**，不會自作主張把別人擠掉——那種「魔法」事後最難理解。設定存壞導致某側超額時，溢出的會自動退成隱藏，畫面永遠合法。

1. 🧭 **首頁 Dashboard** — 本月支出總額 + 各類支出圓餅圖、未完成任務前 3 筆（依優先度）。兩張卡都跟著功能矩陣走，該模組沒開放就整張收起
2. 💰 **記帳** — 支出／收入、7 類分類、當月清單（可切換月份、可修改刪除）+ 當月小計
3. ☑️ **任務紀錄** — 新增 / 勾選完成 / 刪除，含優先度紅🔴黃🟡綠🟢（點燈號循環切換）
4. 🌙 **日誌** — 每日指南針（今日的刻意選擇）+ 複盤（做得好的 / 卡住的 / 明天最重要的一件事）
5. 📎 **雜記** — 靈感與雜項，**類別選填**（文章／作品／系統／分享／其他），含 JSON 備份匯出
6. 📋 **LOG** — LINE 快速輸入的交易記錄，成敗一眼可分、可依來源篩選、可「只看失敗」
7. 💚 **心情紀錄** — 五級 + 備註，頂部近 14 天心情脈搏色條

首次開啟會先問「你是誰」，從 `line_users` 白名單裡點選自己。選定的身份存這支手機，
之後記的東西都會標上 `line_id`，並在首頁／記帳／任務多一顆「只看我的／全部」的切換。
每個帳號看得到哪些分頁由白名單上的功能矩陣決定；名單上的管理者另外看得到一張
「成員與權限」卡，可以直接勾選誰能寫入、誰能用哪些功能。

雜記的類別存成內容前綴（`[作品] 做了一個 PWA`），寫進 `notes` 既有的 `text` 欄位，**分頁與欄位一個字都不用改**。代價是類別從「資料」降級成「約定」，要統計就得靠字串解析——對這個規模的系統划算。原本的成長頁（週回顧＋輸出追蹤）已移除，其中「輸出追蹤」以此形式併入雜記；兩者的舊資料從未上過雲端，移除後仍留在 `localStorage`，匯出 JSON 備份看得到。

## 技術架構

| 項目 | 選型 |
|---|---|
| 前端 | 純 HTML / CSS / JS，單檔（`index.html`） |
| 本地儲存 | `localStorage`，單一 JSON state key：`personal-os-state-v1` |
| 雲端同步 | Google Apps Script + Google Sheets（tasks / reviews / moods / notes / expenses，載入時與回前景時 pull、儲存時 push；`logs`／`line_users` 不回推） |
| PWA | `manifest.json` + Service Worker（`sw.js`，HTML network-first、其餘資產 cache-first） |
| 部署 | GitHub Pages |

資料模型：`{ tasks: [], reviews: {'date|line_id': {...}}, moods: [], notes: [], expenses: [] }`

`reviews` 的鍵是**「日期｜寫的人」的組合鍵**。其他四個模組以 `id` 為鍵（每筆天生獨立），
只有它以日期為鍵——單人時代沒問題，多人之後同一天的複盤會變成同一筆而互相覆蓋。
分隔符用 `|`：日期是 `YYYY-MM-DD`、`line_id` 是英數，兩邊都不可能出現它。

> ⚠️ 組合鍵只活在本機 `state`。雲端 `reviews` 分頁的 `review_date` 欄仍然只存純日期，
> 推上去之前一定要用 `reviewDateOf()` 拆回來。舊的純日期鍵在首次載入時自動換算
> （`migrateReviewKeys()`），沒有歸屬的**不會自動認領成自己的**。

Google Sheets 各分頁欄位：

| 分頁 | 欄位（欄序即表頭順序） |
|---|---|
| `tasks` | `id \| text \| is_completed \| created_at \| priority` |
| `reviews` | `review_date \| good \| stuck \| most_important` |
| `moods` | `id \| mood_date \| level \| note` |
| `notes` | `id \| text \| created_at` |
| `expenses` | `id \| expense_date \| type \| category \| amount \| note \| created_at` |
| `logs` | `id \| ts \| source \| status \| input \| result \| detail \| target_row \| user_id` |
| `line_users` | `line_id \| display_name \| is_active \| is_admin \| feat_expense \| feat_tasks \| feat_review \| feat_notes \| feat_mood \| feat_log \| created_at \| updated_at` |

`tasks` / `reviews` / `moods` / `notes` / `expenses` 各多一欄 `line_id`（一律在最後一欄），
記錄這筆是誰寫的。**不需要手動去 Sheet 加表頭**——前端存檔走的是整包 `replaceAll`，
它會連表頭列一起重寫，下一次同步就會自己長出來。

導覽配置存在獨立的 `localStorage` key `personal-os-nav-placement`（舊的 `personal-os-nav-slot` 會在首次載入時自動遷移），**刻意不放進 `state`**——`state` 會被 `pushAllToCloud` 整包推上雲端，而這是介面偏好，不需跨裝置一致（[ADR-006] §C）。

`priority` 存 `H`/`M`/`L`，預設 `M`，無值的既有任務會在前端首次載入時自動補 `M`。`expenses.type` 為 `expense`/`income`，首頁圓餅圖只計 `expense`。Apps Script 的 `Code.gs` 為通用 `doGet`/`doPost`，新增分頁與欄位皆不需修改。

讀進 `state` 的資料會先過一層**以 `id` 為 key 的去重**（同 id 只留後者，視為較新的編輯），位置在 `load()` 與 `pullFromCloud()` 這兩個共用出口，**不在各 `render` 函式**——一次涵蓋全模組，日後新增分頁不需要記得補。pull 的合併規則是「id 不在本機就收下」，而那份 id 集合是進迴圈前算一次的，所以雲端同一個 `id` 的兩列會兩筆都被收進來；去重是這條路徑的終點閘門（[ADR-007] 票 B）。

> ⚠️ 前端去重是**遮蔽症狀，不是根除成因**。真正的根因在後端 `doPost` 以無條件 `append` 處理更新（[ADR-007] 票 A，尚未施工），以及「本機為何會先生出兩筆同 id」（未解，列為未來票）。看到「資料明明兩筆卻只顯示一筆」時，答案在這裡。

同步時序：App 啟動與**回到前景**時都會 pull 補齊（只加不刪）。`save()` 的整包 `replaceAll` 會等待進行中的 pull 完成才送出——否則本機尚未補齊的 state 會覆寫掉雲端的新資料（例如從 LINE 快速輸入新增的任務）。回前景的 pull 有 5 秒節流。

LINE 快速輸入的 Apps Script 端程式碼鏡像在 `apps-script/`，安裝與除錯見該目錄的 README。支援前綴：

| 前綴 | 格式 | 寫入 |
|---|---|---|
| `任務` | `任務/內容[/H\|M\|L]` | `tasks` |
| `記帳` | `記帳/金額/分類[/備註]` | `expenses`（`type=expense`） |
| `收入` | `收入/金額/分類[/備註]` | `expenses`（`type=income`） |
| `查` | `查/你想問的問題` | 唯讀，不寫入 |
| `Line_ID` | `Line_ID/你的userId` | `line_users`（**只建待審資料**，見下） |

分類必須是記帳模組固定 7 類其中之一，打錯字一律打回並附可用清單，**不會自動歸進「其他」**。

`查` 讀近 30 天資料組成上下文後呼叫 Gemini API，用自然語言回答。記帳部分送的是**分類彙總而非逐筆**——逐筆一旦被筆數上限截斷，AI 會拿到半個月的資料卻不知情，然後自信地給出錯誤的總額；答錯比答不出來更糟。彙總同時給**本月與近 30 天兩組**並禁止混用：「這個月」不等於「近 30 天」，只給後者會讓 AI 用含上月下旬的數字回答本月，也跟首頁的「本月支出」對不起來。未完成任務則不受 30 天窗口限制，因為「未完成」是持續狀態而非時點事件。Gemini key 存 Apps Script 指令碼屬性（`GEMINI_API_KEY`），**不進 GitHub**——它在伺服器端使用，沒有前端密鑰那種「一定會被看到」的限制。

四種前綴每次交易無論成敗都寫一列 `logs`，供除錯與狀態回查。寫 log 包 try/catch，失敗只記 `console.log`、不拖累主流程——代價是「log 沒出現」看起來什麼事都沒發生，所以另備 `diagnoseLogSheet` 健檢函式。

`logs` 是 Apps Script 單向寫入的唯讀記錄，**不進前端 `state`、不進 `pushAllToCloud`**：前端存檔是整包 `replaceAll`，一旦回推就會把 Apps Script 寫的記錄整包洗掉。

## 身份、白名單與功能權限（ADR-008）

三件事共用雲端的同一張 `line_users` 表，但責任分得很開——混在一起想，之後每一次
改動都會在錯的層級打轉：

| | 回答什麼 | 存在哪 | 誰把關 |
|---|---|---|---|
| **身份** | 我說我是誰 | 這支手機的 `localStorage`（`personal-os-line-id`） | 沒有人，這是宣告 |
| **白名單** | 誰能寫 | `line_users.is_active` | Apps Script `writeGate_` |
| **功能矩陣** | 誰看得到哪些分頁 | `line_users.feat_*` | 只有前端隱藏 |

### 選身份不是登入

首次開啟會蓋一張全螢幕的「你是誰」，從白名單裡點選自己，選定值存 `localStorage`
（比照導覽配置的慣例，**刻意不進 `state`**——`state` 會被整包推上雲端，而身份選擇
不需要跨裝置一致）。

**這一步是身份宣告，不是身份驗證。** 在瀏覽器裡把 `line_id` 改成別人的並不會拿到
別人的權限，只會讓雲端把你的寫入擋下來。真要做到驗證得有自有後端跑 LINE Login
OAuth，而 PWA 是純前端靜態頁——那個複雜度跟「家人之間彼此熟識」的情境不成比例
（[ADR-008] B-1）。

### 白名單只擋寫入，不擋讀取

`doPost` 依 `line_id` 查 `line_users`，不在名單內一律拒絕。`doGet`**維持現狀不處理**：
Apps Script 讀不到 HTTP Header，exec 網址一旦外流，讀取本來就擋不住——那是
[ADR-007] 已記錄在案的既有限制，本次只把「寫入」這一層關起來，不重新設計整個安全模型。

**一律 fail-closed**：白名單讀不到、名單是空的、沒帶 `line_id`——全部拒絕，而且每一次
都寫一列 `logs`。這次是「新增」一道門，不是「維護」既有可用性；一出狀況就自動變回
全開的門，跟沒有門是同一件事。

`logs` 的 `detail` 刻意讓兩種失敗分得出來：`whitelist_unavailable`（分頁不見了／沒有
`line_id` 欄／讀取丟例外）與 `whitelist_empty`（表在、讀得到，但沒有任何一列
`is_active`）。這兩件事的修法完全不同，混在一起等於沒記。

白名單查詢走 `CacheService`，TTL 5 分鐘——改動頻率極低、讀取頻率極高的教科書場景，
而 LINE webhook 有回覆時限。**只快取成功的讀取**：把失敗也快取起來，等於一次暫時性
的 Sheet 故障要讓所有人被鎖在門外整整五分鐘。管理頁改完白名單會主動清快取，自己
這端即時生效，其他裝置最多等 5 分鐘。

### 自行註冊（`Line_ID` 前綴）

新成員不必等人去 Sheet 貼一串 32 字元的 userId，自己在 LINE 兩句話就能報到：

1. 傳 `whoami` → bot 回他的 userId
2. 把 ID 整串貼回來：`Line_ID/U1234abcd…`
3. 名單上出現一列**待審**資料，管理者在 App 的「成員與權限」按一下才生效

**註冊不等於啟用。** 寫進去的那一列 `is_active` 是留白的，在閘門眼裡跟不存在一樣。
這是刻意的——如果註冊就等於放行，白名單等於「知道這個 bot 的人都能寫」，Part D
那道門就形同虛設。註冊消滅的是**貼 userId 的摩擦**，不是「誰可以寫」的決定權。

`Line_ID` 與 `whoami` 一樣排在白名單檢查**之前**：還沒進名單的人才需要註冊，排在
閘門後面等於「要先有權限才能申請權限」。它唯一會寫的就是那一列待審資料。

**只能註冊自己**：bot 會比對貼進來的 ID 與發話者本人是否相同，不同一律退回並寫
`logs`。少了這道比對，任何人都能替別人送出註冊，待審清單就會混進不是本人申請的資料。
稱呼自動從 LINE 個人資料帶入，取不到就留空（不讓一個顯示用的字串擋掉整個註冊）。

> ⚠️ **名單空的時候，第一個註冊的人直接啟用為管理者，並打開全部功能。**
> 沒有這個例外會是死結：沒有人在名單上，就沒有人能核准第一個人。代價是部署完到
> 你註冊之間有一個空窗，誰先傳誰就是管理者——這段窗口以分鐘計，而且要先是這個 bot
> 的好友才傳得到。**部署後請立刻註冊。**
>
> 功能必須跟著全開：矩陣「有欄位但全留白」會被判讀成全部關閉（E-2b），否則第一位
> 管理者進 App 只看得到首頁。

`line_users` 分頁不存在時，註冊會**自動建表並寫入完整表頭**。建的只是表頭、不寫任何
一列資料，名單仍然是空的、閘門仍然 fail-closed，所以這個動作本身不放行任何人。

管理頁把「待審」與「已停用」分開標示，靠的是 `is_active` 留白（從沒被核准過）與寫明
`FALSE`（核准過又關掉）的差別——對閘門而言兩者一樣是擋，只有標籤不同。有人在等核准
時，卡片最上面會直接列出名字。

**這就是管理者得知有人註冊的管道**——不另做推播或信件通知。註冊本來就不急（待審期間
那個人也還不能寫入），下次開 App 看到就夠了；為了一件不急的事去吃推播額度、再多維護
一條通知路徑，不划算。

### 儀表板也跟著功能矩陣走

首頁的兩張卡（本月支出、接下來要做的）在對應模組沒開放時**整張收起**。功能矩陣本來就
只做前端隱藏，那就該藏得徹底——漏掉首頁的話，被關掉功能的人照樣看得到那張卡，點
「前往記帳 →」卻被 `switchView` 擋下來，看起來就像壞了。

> ⚠️ 原本首頁還有一張「今日指南針」快顯，已於 2026-09-15 移除。它是寫死在首頁的，
> 不跟著功能矩陣走——日誌被關掉的人照樣看得到一個寫不進去的輸入框。**指南針本身沒有
> 消失**，仍在「日誌」分頁裡（`rvCompass`），只是少了首頁的捷徑。其餘模組（雜記／心情／
> LOG）目前沒有儀表板卡片，要不要做、怎麼做另案處理。

### 功能矩陣只做前端隱藏

`feat_expense` / `feat_tasks` / `feat_review` / `feat_notes` / `feat_mood` / `feat_log`
控制導覽列顯不顯示那一格，**後端不驗證**。沿用既有 `SHOW_MOOD` 的模式：被繞過的代價
僅止於「多看了一個空白分頁」，不涉及資料外洩或寫壞資料，跟寫入資格不是同一個量級
（[ADR-008] E-2）。首頁不在矩陣上——它是進 App 的第一頁，關掉沒意義。

**空白 = 關閉**（E-2b）：新功能加一欄之後，既有使用者在該欄是空的，就該是關的，需要
手動逐人勾開。但「欄位根本不存在」是另一回事——那代表矩陣還沒佈到 Sheet 上，這時
一律視為開放，否則第一次部署會把所有分頁都藏起來，看起來就像 App 壞了。

功能矩陣與導覽配置是**兩套不同機制，實作上沒有混在一起**（[ADR-008] H-8）：功能被
關掉不會動到 `personal-os-nav-placement` 的值，日後重新開放時，使用者原本選的左右
位置還在。每側 3 個的上限只算「畫面上真的有幾格」——被關掉的分頁不佔版面，自然
不該佔額度。

### 只看我的／全部

純前端 filter，依 `line_id` 篩選。`line_id` 在這裡只是**篩選鍵，不是存取權限鍵**——
家人之間資料互相看得到是預期行為（記帳／任務本來就要協作）。真的需要隔離時欄位
已就位，加一層是小票不是砍掉重練（[ADR-008] C-2）。名單上只有一個人時這顆開關
不會出現，因為兩邊永遠是同一個結果。

> ⚠️ 改版前的舊資料沒有 `line_id`，切到「只看我的」會看不到。**刻意不自動蓋章**——
> 那等於連 LINE 那端別人記的帳都一起認領走，冒名比空白難查得多。身份卡上有一顆
> 「認領舊資料」，由人明確決定要不要認。

### 日誌為什麼要換鍵

`line_id` 是**欄位**，解決的是「這筆是誰寫的」；`reviews` 原本的鍵只有日期，問題在
**鍵**，補欄位擋不住：

1. 你和家人同一天各寫一篇複盤 → 在資料模型裡是同一筆
2. pull 的合併規則是「這個日期本機沒有才收下」→ 你不會收到他的
3. 你的整包 `replaceAll` 把他那筆從雲端抹掉

改成組合鍵之後，同一天不同人是兩筆、各自有鍵，pull 收得下、push 各推一列。

清單的排序不受影響——日期在鍵的前面，字串排序仍然等於日期排序。清單只濾掉
**自己今天那筆**（它正在上面的表單裡編輯，列出來會像有兩份），別人今天的照常出現
並標上作者名。日誌頁也跟著多一顆「只看我的／全部」。

> ⚠️ 認領舊日誌等於**換鍵**，所以會跳過「換完鍵會撞到自己已經寫過的同一天」的那幾筆——
> 硬換會直接覆蓋掉自己那天的複盤。可認領的數量也照同一套規則算，不會按下去才發現少認了。

### 成員與權限（管理頁）

`is_admin` 的人在首頁多一張卡，可以勾選誰能寫入、誰是管理者、誰能用哪些功能。
**範圍刻意只到這裡，不含刪除他人資料**——那種等級的操作不能只靠前端藏，必須疊一層
後端驗證，等於在同一套系統裡開了兩種深淺不同的安全模型（[ADR-008] D-4）。

寫回走**單列 upsert（`action:'append'` + `key_field:'line_id'`），不走 `replaceAll`**：
整包覆蓋一旦送出不完整的名單，會把所有人——包含正在按按鈕的自己——鎖在門外。後端
也把 `line_users` 與 `logs` 的 `replaceAll` 直接擋掉了。前端另有兩道自毀防護：不能關掉
自己的寫入資格或管理權限，也不能把最後一個啟用中的成員停用。

> ⚠️ 已知取捨：管理頁只靠前端 `is_admin` 隱藏，後端只驗「能不能寫」，不驗「能不能寫
> `line_users`」。也就是**任何一個白名單內的人，繞過前端就能改權限表**。這與 E-2 是
> 同一套安全深淺，在「家庭成員、彼此熟識、非公開」的前提下是刻意接受的；前提一變，
> 這裡就是第一個要補後端驗證的地方。

### LINE Bot 共用同一張表

`ALLOWED_USER_IDS` 指令碼屬性**已不再被讀取**，LINE 端改查同一張 `line_users`
（[ADR-008] F-2）。同一批人、同一個 `line_id`，沒道理維護兩份名單。確認新路徑正常後
可以把舊屬性刪掉。

> ⚠️ **語意變了**：改版前「屬性沒設 = 不限制任何人」，現在「白名單查不到 = 拒絕」。
> `line_users` 還沒建好之前，LINE 這端會全部擋下來，這是刻意的。

`whoami` 仍排在白名單檢查**之前**——它是用來取得要填進 `line_users` 的值，也是萬一
填錯、把自己擋在門外時唯一的救援途徑。卡住時另有 `diagnoseLineUsers()`，在 Apps
Script 編輯器直接執行就會印出它實際讀到什麼，不需重新部署。

### 離線與部署順序

名單讀不到時（離線、雲端不通）**不會把人擋在選身份的畫面上**：快取裡有舊名單就先用，
完全沒有就給一顆「先在本機用」——資料照樣存 `localStorage`，只是暫時不推雲端，身份卡
會用紅底講清楚同步是停的。名單一旦讀得到，這個逃生門會自動失效並請人選身份，因為
它是逃生門，不是一種模式。

> ⚠️ **部署順序**：後端一上線就開始 fail-closed，而還沒更新的舊版頁面不會送 `line_id`，
> 寫入會被擋（本機資料不會掉，`logs` 會留記錄）。先把 `line_users` 建好、`is_active`
> 勾起來，前端 HTML 是 network-first，重開一次 App 就會拿到新版。

## 檔案結構

```
index.html      主程式（含樣式與邏輯）
manifest.json   PWA manifest
sw.js           Service Worker（離線快取）
icon-192.png    App icon 192x192
icon-512.png    App icon 512x512
apps-script/    Apps Script 端程式碼（Code.gs 同步 + line-router.gs LINE 路由）
scripts/        本機與 CI 共用的閘門（密鑰掃描、clasp preflight）
tests/          單元測試（`npm test`）。後端跑的是 apps-script/Code.gs 本人，
                前端跑的是 index.html 的 <script> 本人，兩邊都不測副本
```

## 開發須知

修改任何發布檔案後，需同步更新 `sw.js` 的 CACHE 版號（例如 `neil-os-v5` → `v6`），否則舊快取會擋住新版本。

`index.html` 裡的 `CLOUD_URL` / `CLOUD_SECRET` 是 `__CLOUD_URL__` / `__CLOUD_SECRET__` 佔位字串，**不會**存真正的值。部署交給 `.github/workflows/deploy.yml`：push 到 `main` 時由 GitHub Actions 用 repo 的 `CLOUD_URL` / `CLOUD_SECRET` Secrets 取代佔位字串後再發布到 GitHub Pages，真正的值只存在 GitHub Secrets，不進 git history。

設定方式：Repo → Settings → Secrets and variables → Actions，新增 `CLOUD_URL`、`CLOUD_SECRET` 兩個 Repository secret；並把 Settings → Pages → Build and deployment → Source 切成「GitHub Actions」（原本若是「Deploy from a branch」要一併關掉，避免兩邊搶著部署）。

> 注意：即使密鑰不進 git，部署出去的頁面原始碼裡還是看得到（純前端架構無法真正隱藏密鑰），這個設計只解決「密鑰留在 git history 裡」的問題，不是解決「密鑰對外不可見」——真正解法是密鑰一旦外流就要重新產生。

### 後端單元測試

```bash
npm test        # node --test，內建，不需要任何相依套件
```

`tests/fake-apps-script.mjs` 把 `apps-script/Code.gs` **整份**載進一個假的 Apps Script 環境再測——Sheet 是二維陣列，列號語意（1-based、含表頭偏移、刪列會把下面的列往上位移）與真的一致。刻意不把邏輯抄一份出來測：兩份實作遲早會漂移，那時候測到的就不是上線那份了。

這道閘門同時掛在 CI 的 Apps Script job 上，擋在 `clasp push` **前面**——「測試失敗不部署」，部署成功不能拿來當驗收。

假環境有一個非直覺處，動它之前先知道：`vm` 開的是另一個 realm，裡面造出來的陣列跟外面的 `Array.prototype` 不是同一個，結構一樣的兩個陣列 `deepStrictEqual` 仍會判定不相等。所以 `call()` 與 `read()` 在邊界上做了一次結構複製（`toHost`），而且複製陣列要用外面這一側的 `Array.from`——對面陣列的 `.map()` 依 species 造出來的還是對面的陣列。

### Apps Script 的部署管道（ADR-007 Part B）

`main` 有什麼，線上就是什麼——`.github/workflows/deploy.yml` 的 `apps-script` job 會
`clasp push` 後 `clasp deploy -i`，取代人工的「管理部署作業 → 編輯 → 版本選新版本」，
也就是這個專案踩過三次的那個坑。**本機不 push**（工作目錄可能有沒 commit 的東西），
`package.json` 裡刻意只留 `pull`。

**管道自 2026-09-14 起運作中**（首次部署 `Deployed @13`，exec 網址未變）。
`apps-script/` 是**部署來源，不是鏡像**——編輯器裡直接改的東西會在下次部署時被
靜默覆蓋，緊急改動後必須 `npm run pull` 回來補 commit。三個 Secret（`CLASPRC_JSON` /
`SCRIPT_ID` / `CLASP_DEPLOYMENT_ID`）與維運說明見
[`apps-script/README.md`](apps-script/README.md)。

安全閘門：`apps-script/appsscript.json` 不存在時整個 job 跳過（`clasp push` 是整包
覆蓋，鏡像不完整時推送會刪掉線上檔案）；三個 Secret 任一為空即紅燈；`clasp` 未登入時
`show-authorized-user` 仍會 exit 0，所以改比對輸出字串。

Apps Script 與 Pages 分成兩個 job：認證與 scriptId 完全不會進到 Pages 的 artifact，
一邊掛了也不會連坐另一邊。Pages job 上傳前會 `rm -rf apps-script`（刪 runner 上的暫存
副本，不動 repo），讓後端程式碼不再跟著發布到公開網址。

## 專案狀態

- **Phase 1** — 原型驗證：✅ 已完成（2026-07-02）
- **Phase 2** — 正式發布（manifest + Service Worker + localStorage，部署至 GitHub Pages）：✅ 已完成（2026-07-03）
- **Phase 3** — 功能增強：
  - ✅ 每日指南針、成長分頁（週回顧 + 輸出追蹤）（2026-07-06）
  - ✅ PWA 自動更新修正（network-first + controllerchange reload）（2026-07-06）
  - ✅ Google Sheets 雲端同步（tasks / reviews / moods / notes）（2026-07-07）
- **v3 改版**（依 [ADR-004]，2026-08-17）：✅ 已完成
  - ✅ 導覽重構：中央圓形首頁 + 兩側各 2 個方形分頁
  - ✅ 首頁 Dashboard：本月支出 + 圓餅圖 / 未完成任務前 3 筆 / 今日指南針
  - ✅ 任務優先度 `priority`（H/M/L，紅黃綠燈，預設 M，既有任務自動補 M）
  - ✅ 心情與成長分頁 feature flag 隱藏（資料三層全保留）
  - ✅ 記帳模組 v1（極簡版：新增 + 當月清單 + 當月小計）
  - ⏳ 未來票（低優先）：Scriptable iOS 主畫面 widget（PWA 原生 widget 已查證不可行）
- **v4 改版**（依 [ADR-006]，2026-09-10）：✅ 已完成
  - ✅ A：LINE 記帳／收入前綴（`記帳`、`收入` 寫入 expenses 分頁）
  - ✅ D：`logs` 分頁交易記錄（四種前綴、成敗都寫、失敗不拖累主流程）
  - ✅ C：導覽版位開關（第 5 格四選一，即時反映、只存本機）+ LOG 頁面
- **v5 改版**（2026-09-10）：✅ 已完成
  - ✅ 導覽配置擴充為左／右／不顯示三態，每側上限 3（最多 左3 ｜ ⭕ ｜ 右3 共 7 格）
  - ✅ 移除成長頁（週回顧 + 輸出追蹤）
  - ✅ 「創造」以類別選填的形式併入雜記，存成 `[類別] 內容`
  - ✅ B：查詢 MVP（`查` 前綴 + Gemini API，記帳送彙總確保總額精確）
  - ⏳ 未來票：`logs` 列數上限與自動修剪（構想：超過 500 列自動修剪）
- **ADR-007**（依 [ADR-007]，2026-09-14）：✅ 已完成
  - ✅ 票 B：前端 `state` 讀取層以 `id` 去重（同 id 留後者），SW v9→v10
  - ✅ 票 A：後端去重閘門。**位置依實讀程式碼後的查證結果修正**——原規格掛在 `append`，但前端從未使用 `append`（只送 `replaceAll`），照做會是死碼；改為 `replaceAll` 寫入前以 `id` 去重，`append` 一併補上 `upsertRow_`，清理動作都寫 `logs`
  - ✅ clasp ①②③④：基準對齊 → CI 管道建置 → 空跡部署驗證（`Deployed @13`）→ 單向紀律警語改寫
  - ⏳ 未來票：本機為何先生出兩筆同 id（唯一未解的成因，票 A 與票 B 都只是攔截症狀）
  - ⏳ 未來票：輪替 `CLOUD_SECRET`（搬進指令碼屬性只解決「不進 git history」，它仍公開在部署出去的 `index.html` 裡）
  - ⏳ 未來票：`doGet` 沒有任何驗證 + web app 是 `ANYONE_ANONYMOUS`，任何人拿到 exec 網址就能讀取全部分頁
- **ADR-008**（依 [ADR-008]，2026-09-15）：✅ 已完成
  - ✅ B：「選身份」畫面（`line_users` 白名單點選，存 `localStorage`，不進 `state`），明確標示為身份宣告而非驗證
  - ✅ C：`tasks`／`reviews`／`moods`／`notes`／`expenses` 各補 `line_id` 欄（由 `replaceAll` 的表頭自動長出，不需手動加）＋ 首頁／記帳／任務的「只看我的／全部」切換
  - ✅ D：`doPost` 寫入前查 `line_users` 白名單，`CacheService` 快取 TTL 5 分鐘（**只快取成功的讀取**），fail-closed 且「讀不到」與「名單為空」在 `logs` 的 `detail` 分得出來；`doGet` 依約定不動
  - ✅ D-4：`is_admin` 管理頁（首頁卡片形式，不佔導覽格），走單列 upsert 不走 `replaceAll`，另加「不能關掉自己的權限」與「至少留一個啟用成員」兩道自毀防護
  - ✅ E：功能矩陣 `feat_*` 只做前端隱藏；空白＝關閉，但**欄位不存在＝視為開放**（否則首次部署會把所有分頁藏光）；與導覽配置維持兩套獨立機制（H-8）
  - ✅ F-2：LINE Bot 白名單改查同一張 `line_users`，`ALLOWED_USER_IDS` 退場；語意由 fail-open 改為 fail-closed，`whoami` 仍排在閘門之前作為救援途徑
  - ✅ 後端一併擋掉 `line_users` 與 `logs` 的 `replaceAll`（整包覆蓋會把白名單清空、順便鎖上所有人）
  - ✅ `diagnoseLineUsers()` 健檢函式（比照 `diagnoseLogSheet`），SW v10→v11
  - ✅ 延伸（2026-09-15，ADR 之外的追加需求）：`Line_ID/<自己的userId>` 自行註冊。只建 `is_active` 留白的待審資料，管理者核准才生效；只能註冊自己（ID 與發話者不符即退回並寫 `logs`）；名單空時第一位直接啟用為管理者且功能全開（否則沒人能核准第一個人）；分頁不存在時自動建表。管理頁把「待審」與「已停用」分開標示
  - ✅ 延伸（2026-09-15）：`reviews` 改用「日期｜寫的人」組合鍵。原本只以日期為鍵，多人同一天的複盤會被判成同一筆而互相覆蓋（`line_id` 欄位擋不住，根因在鍵）。含舊鍵自動換算、推雲端時拆回純日期、認領時換鍵且避開撞鍵、清單標作者名、日誌頁加「只看我的」
  - ✅ 延伸（2026-09-15）：首頁儀表板補上功能矩陣的判斷。記帳／任務兩張卡在模組未開放時整張收起；「今日指南針」快顯移除（寫死在首頁、不跟著矩陣走，日誌被關掉的人會看到一個寫不進去的輸入框），指南針本體仍在日誌分頁
  - ⏳ 未來票：其餘模組（雜記／心情／LOG）的儀表板 UI 待設計；日誌是否以別種形式回到首頁一併考慮
  - ⏳ 未來票（承 ADR-008 Part I）：商業模式可行時的公開開放評估
  - ⏳ 未來票：是否需要真正的資料隔離（目前只有前端 filter，非存取權限層）
  - ⏳ 未來票：功能矩陣欄位若持續增加，是否改為正規化的多對多關聯表
  - ⏳ 未來票：任何白名單內的人繞過前端就能改 `line_users`（管理頁只靠前端 `is_admin` 隱藏）——與 E-2 同一套安全深淺，前提一變就是第一個要補後端驗證的地方
  - ⏳ 未來票：`doGet` 讀取層的驗證強化（與 ADR-007 未來票同一個根，本次刻意不處理）
- **⚠️ 懸置中**：2026-09-16 那份「安全性與 Code Review 改善計畫」（Notion）原定在 `codex/security-sync-hardening-20260916` 實作，該分支未推上遠端且已決定不再等待。其中 **DATA-01／03／04 與 tombstone** 由 ADR-009 從根本解掉（整包 `replaceAll` 退場，改即時單筆 upsert），但以下項目**沒有任何一條線在處理**，需要另開一輪：
  - `SEC-01` 公開共享密鑰及匿名讀取／`SEC-02` 偽造 LINE webhook／`SEC-03` 非管理員升權／`SEC-04` 任意分頁與 logs 寫入／`SEC-05` 公式與 schema 防護
  - `DATA-05` 日期／compass／時間戳（ADR-009 的 `keyValue_` 只處理了鍵欄比對這一面，`doGet` 走 `JSON.stringify` 時 Date 轉 UTC 的那一面仍在）
  - `AI-01`／`AI-02` 查詢期間、身份與截斷提示／`PWA-01` 快取清理與本地保存／`CI-01` 部署取消範圍／`CI-02` 缺檔 preflight
  - （`CI-03` 的「持久化測試」部分已由 ADR-009 的 `tests/` 與 CI 閘門完成，branch guard 與掃描未做）
- **ADR-009**（依 [ADR-009]，2026-09-16）：🚧 Phase 0 完成並已合併；測試報告已確認放行，Phase 2 施工中
  - ✅ Phase 0：`upsertRow_` 擴充複合鍵（`review_date`＋`line_id`，reviews 沒有 `id` 欄）、墓碑過濾 `withoutTombstones_`、兩段式封存 `tombstoneRows_`／`purgeTombstoneRows_`、欄位安裝 `ensureAdr009Columns()`、LINE Push 前置驗證 `testLinePush()`
  - ✅ Phase 0：後端單元測試 27 項（含兩次突變測試，確認測試真的抓得到回歸），並接進 CI 擋在 `clasp push` 前面。報告見 [`tests/ADR-009-phase0-test-report.md`](tests/ADR-009-phase0-test-report.md)
  - ⚠️ **新函式目前全部沒有呼叫端，是刻意的**。ADR-009「待其他環境知道的事 #1」要求測試先行、報告經確認才准接手既有模組的讀寫路徑，不可以先動工、測試事後補。唯二會執行的是 `ensureAdr009Columns()` 與 `testLinePush()`，兩支都要在 Apps Script 編輯器手動跑（比照 `diagnoseLineUsers()`）
  - 📌 實作時發現、ADR 沒寫到的：Sheet 讀回來的 `review_date` 是 Date 物件、前端送的是 `YYYY-MM-DD` 字串，不正規化的話複合鍵永遠對不上，每次 upsert 都退化成 append——與安全性改善計畫的 DATA-05 同一個根。取本地年月日而非 `toISOString()`（UTC 在 UTC+8 會算成前一天）
  - ⏭️ **部署後要在 Apps Script 編輯器手動執行一次**：`installAdr009Triggers()`（建立每日到期檢查觸發器，可重複執行不會累積）
  - ✅ 2026-09-16：`ensureAdr009Columns()` 已執行，五張分頁的新欄位到位；`testLinePush()` 實測成功——**ADR-009 C5 的條件式決策條件成立，週期提醒的通知管道確定走 LINE Push，不移入未來票**
  - ✅ Phase 2-a：週期提醒的日期算法（`nextDueDate_`／`dueBucket_`／`shouldNotify_`）＋ 22 項測試。全新程式碼、純函式、仍未接線——先做這一半是因為它與 security 分支零重疊
  - ⚠️ **已知限制（需 schema 裁決）**：月底錨點會漂移。`1/31` 的下一期被夾成 `2/28` 後，再下一期是 `3/28` 而非 `3/31`——每一期只把上一期的 `due_date` 傳下去，ADR 說的「**原訂**到期日」在第一次夾值後就遺失了。修法需要一個記住原始錨點的欄位（ADR 欄位清單沒有），未經裁決不自行擴充 schema。測試已把這個行為釘住，不假裝它不存在
  - ⚠️ **ADR 沒寫到的兩個缺口**：到期區塊寫的是「1／3／5／7 天以上四個門檻」，但第 6 天沒有歸屬（現採唯一能整除的讀法 ≤1／≤3／≤5／其餘）；「已過期」也沒寫，現另回 `overdue` 由呼叫端決定要獨立一塊還是併進最急那塊
  - ✅ Phase 2-b（後端接線）：`doGet` 一律過濾 `del=true`，另開 `?only=tombstones` 供封存第一段匯出；`doPost` 加 `upsert`（`append` 保留為別名）與 `archivePurge` 兩個 action。16 項端點測試
  - ✅ Phase 2-c（前端寫入路徑）：五個模組全部改成即時單筆 upsert，`pushAllToCloud`／`cloudReplaceAll` 退場；刪除改為軟刪除（標 `del` 送出後才從本機移除）。SW v14→v15
  - ✅ 前端測試環境 `tests/fake-browser.mjs`：把 `index.html` 的 `<script>` 整段載進假瀏覽器，測的是上線那份而非副本（與 `fake-apps-script.mjs` 同一套理由）。14 項前端測試
  - 📌 **待送佇列是 ADR 之外的追加**，但不加會**比改版前更糟**：舊架構整包 `replaceAll` 天生有重試（下次存檔會把沒送成的一起帶上去），改成單筆之後一次失敗就是那一筆永遠不見。佇列存 localStorage、關掉 App 仍在、同鍵只留最後一次編輯、送出期間的新編輯不會被連坐移除；標題下方的徽章顯示待送筆數（DATA-02「推送失敗完全無感知」）
  - 📌 一次性補推（選完身份後）改成逐筆排隊送，比 `replaceAll` 慢得多。換掉的是「每次存檔都整包覆蓋」這個天天發生的風險，划算
  - ✅ Phase 2-d（讀取路徑）：`pullFromCloud` 由「只補不刪的合併」改為**覆蓋式**，雲端成為畫面的真相；`load()` 不再拿 localStorage 填畫面（降級為備援，仍寫入但不再讀來顯示）；連線異常改用狀態列明示；15 秒輪詢（背景暫停）＋標題列手動刷新鈕。13 項讀取路徑測試，SW v15→v16
  - ⚠️ **這次改動裡最危險的一處**：`cloudGet` 原本把任何讀取失敗都吞掉回傳空陣列。合併式的舊規則下無所謂（只補不刪），但覆蓋式之下「空陣列」等於「這張表本來就沒東西」——**一次網路抖動就會清光五張表**。現已改為失敗一律往上拋、整次 pull 不算數、state 原地不動；只有 `sheet_not_found` 被當成真的空。突變測試專門盯這一條
  - 📌 待送佇列的內容會在覆蓋式 pull 之後疊回畫面：那幾筆在雲端還不存在，被洗掉的話使用者會看著自己剛打的字消失——東西其實好好躺在佇列裡，但那不是他看得到的地方
  - ✅ Phase 2-e（到期檢查與通知後端）：`checkDueReminders()` 每日到期檢查、`installAdr009Triggers()`／`uninstallAdr009Triggers()` 觸發器安裝與移除、`dueReminderMessage_()` 通知內容。15 項測試
  - ⚠️ **推失敗不標記 `notified`**：標了就等於這筆從此不再提醒，而使用者根本不知道有過這件事。寧可明天再推一次，也不要安靜地漏掉。失敗一併寫進 `logs`
  - ⚠️ **觸發器重複安裝不會累積**：`installAdr009Triggers()` 先刪同名的舊觸發器再建——三個同名觸發器就是一天推三次。另附乾淨的移除函式
  - 📌 觸發器寫成程式碼裡的安裝函式而非在編輯器手動加（待其他環境知道的事 #5）：手動加的觸發器不在 repo 裡，換人接手時沒有任何線索告訴他「有個東西每天早上九點會自己跑」
  - 📌 `checkDueReminders(todayKey)` 的參數只給測試用。綁死系統時鐘的測試會跟著真實日期漂，某天突然變紅而沒有人改過任何東西；觸發器呼叫時不帶參數，走的仍然是今天
  - ⏳ Phase 2-f（剩下的 UI）：兩段式封存接 `exportData()`、共用白板、週期提醒的輸入與儀表板區塊
  - 📌 分支裁決（2026-09-16，已變更）：原訂與 `codex/security-sync-hardening-20260916` 併成同一條線，但該分支始終沒推上遠端（Notion 記載建立遠端分支時回傳 403），**2026-09-16 決定不再等待**，ADR-009 單獨走完
