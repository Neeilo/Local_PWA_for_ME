# Neil OS — 個人小系統

安裝在手機主畫面的個人小系統 PWA，資料主要存在本機（localStorage），並會同步備份到 Google Sheets。

🔗 **Live**: https://neeilo.github.io/Local_PWA_for_ME/

## 功能

底部導覽：**左 ｜ ⭕首頁 ｜ 右**，圓心固定，其餘六個功能由使用者在首頁的「導覽配置」自行決定**靠左／靠右／不顯示**。

**每側最多 3 個**——上限來自版面，左 3 ｜ ⭕ ｜ 右 3（共 7 格）是 320px 螢幕仍讀得清楚的極限。同一側依固定順序排列，不提供拖曳排序：手機上的拖曳很難做得好用，而這裡要解決的是「慣用手拿不拿得到」，左右歸屬就足夠了。

某側已滿時再點會**擋下並提示**，不會自作主張把別人擠掉——那種「魔法」事後最難理解。設定存壞導致某側超額時，溢出的會自動退成隱藏，畫面永遠合法。

1. 🧭 **首頁 Dashboard** — 本月支出總額 + 各類支出圓餅圖、未完成任務前 3 筆（依優先度）、今日指南針（可直接作答）
2. 💰 **記帳** — 支出／收入、7 類分類、當月清單（可切換月份、可修改刪除）+ 當月小計
3. ☑️ **任務紀錄** — 新增 / 勾選完成 / 刪除，含優先度紅🔴黃🟡綠🟢（點燈號循環切換）
4. 🌙 **日誌** — 每日指南針（今日的刻意選擇）+ 複盤（做得好的 / 卡住的 / 明天最重要的一件事）
5. 📎 **雜記** — 靈感與雜項，**類別選填**（文章／作品／系統／分享／其他），含 JSON 備份匯出
6. 📋 **LOG** — LINE 快速輸入的交易記錄，成敗一眼可分、可依來源篩選、可「只看失敗」
7. 💚 **心情紀錄** — 五級 + 備註，頂部近 14 天心情脈搏色條

雜記的類別存成內容前綴（`[作品] 做了一個 PWA`），寫進 `notes` 既有的 `text` 欄位，**分頁與欄位一個字都不用改**。代價是類別從「資料」降級成「約定」，要統計就得靠字串解析——對這個規模的系統划算。原本的成長頁（週回顧＋輸出追蹤）已移除，其中「輸出追蹤」以此形式併入雜記；兩者的舊資料從未上過雲端，移除後仍留在 `localStorage`，匯出 JSON 備份看得到。

## 技術架構

| 項目 | 選型 |
|---|---|
| 前端 | 純 HTML / CSS / JS，單檔（`index.html`） |
| 本地儲存 | `localStorage`，單一 JSON state key：`personal-os-state-v1` |
| 雲端同步 | Google Apps Script + Google Sheets（tasks / reviews / moods / notes / expenses，載入時與回前景時 pull、儲存時 push；`logs` 唯讀不回推） |
| PWA | `manifest.json` + Service Worker（`sw.js`，HTML network-first、其餘資產 cache-first） |
| 部署 | GitHub Pages |

資料模型：`{ tasks: [], reviews: {date: {...}}, moods: [], notes: [], expenses: [] }`

Google Sheets 各分頁欄位：

| 分頁 | 欄位（欄序即表頭順序） |
|---|---|
| `tasks` | `id \| text \| is_completed \| created_at \| priority` |
| `reviews` | `review_date \| good \| stuck \| most_important` |
| `moods` | `id \| mood_date \| level \| note` |
| `notes` | `id \| text \| created_at` |
| `expenses` | `id \| expense_date \| type \| category \| amount \| note \| created_at` |
| `logs` | `id \| ts \| source \| status \| input \| result \| detail \| target_row \| user_id` |

導覽配置存在獨立的 `localStorage` key `personal-os-nav-placement`（舊的 `personal-os-nav-slot` 會在首次載入時自動遷移），**刻意不放進 `state`**——`state` 會被 `pushAllToCloud` 整包推上雲端，而這是介面偏好，不需跨裝置一致（[ADR-006] §C）。

`priority` 存 `H`/`M`/`L`，預設 `M`，無值的既有任務會在前端首次載入時自動補 `M`。`expenses.type` 為 `expense`/`income`，首頁圓餅圖只計 `expense`。Apps Script 的 `Code.gs` 為通用 `doGet`/`doPost`，新增分頁與欄位皆不需修改。

同步時序：App 啟動與**回到前景**時都會 pull 補齊（只加不刪）。`save()` 的整包 `replaceAll` 會等待進行中的 pull 完成才送出——否則本機尚未補齊的 state 會覆寫掉雲端的新資料（例如從 LINE 快速輸入新增的任務）。回前景的 pull 有 5 秒節流。

LINE 快速輸入的 Apps Script 端程式碼鏡像在 `apps-script/`，安裝與除錯見該目錄的 README。支援前綴：

| 前綴 | 格式 | 寫入 |
|---|---|---|
| `任務` | `任務/內容[/H\|M\|L]` | `tasks` |
| `記帳` | `記帳/金額/分類[/備註]` | `expenses`（`type=expense`） |
| `收入` | `收入/金額/分類[/備註]` | `expenses`（`type=income`） |
| `查` | `查/你想問的問題` | 唯讀，不寫入 |

分類必須是記帳模組固定 7 類其中之一，打錯字一律打回並附可用清單，**不會自動歸進「其他」**。

`查` 讀近 30 天資料組成上下文後呼叫 Gemini API，用自然語言回答。記帳部分送的是**分類彙總而非逐筆**——逐筆一旦被筆數上限截斷，AI 會拿到半個月的資料卻不知情，然後自信地給出錯誤的總額；答錯比答不出來更糟。彙總同時給**本月與近 30 天兩組**並禁止混用：「這個月」不等於「近 30 天」，只給後者會讓 AI 用含上月下旬的數字回答本月，也跟首頁的「本月支出」對不起來。未完成任務則不受 30 天窗口限制，因為「未完成」是持續狀態而非時點事件。Gemini key 存 Apps Script 指令碼屬性（`GEMINI_API_KEY`），**不進 GitHub**——它在伺服器端使用，沒有前端密鑰那種「一定會被看到」的限制。

四種前綴每次交易無論成敗都寫一列 `logs`，供除錯與狀態回查。寫 log 包 try/catch，失敗只記 `console.log`、不拖累主流程——代價是「log 沒出現」看起來什麼事都沒發生，所以另備 `diagnoseLogSheet` 健檢函式。

`logs` 是 Apps Script 單向寫入的唯讀記錄，**不進前端 `state`、不進 `pushAllToCloud`**：前端存檔是整包 `replaceAll`，一旦回推就會把 Apps Script 寫的記錄整包洗掉。

## 檔案結構

```
index.html      主程式（含樣式與邏輯）
manifest.json   PWA manifest
sw.js           Service Worker（離線快取）
icon-192.png    App icon 192x192
icon-512.png    App icon 512x512
apps-script/    Apps Script 端程式碼鏡像（LINE 路由；非部署來源）
```

## 開發須知

修改任何發布檔案後，需同步更新 `sw.js` 的 CACHE 版號（例如 `neil-os-v5` → `v6`），否則舊快取會擋住新版本。

`index.html` 裡的 `CLOUD_URL` / `CLOUD_SECRET` 是 `__CLOUD_URL__` / `__CLOUD_SECRET__` 佔位字串，**不會**存真正的值。部署交給 `.github/workflows/deploy.yml`：push 到 `main` 時由 GitHub Actions 用 repo 的 `CLOUD_URL` / `CLOUD_SECRET` Secrets 取代佔位字串後再發布到 GitHub Pages，真正的值只存在 GitHub Secrets，不進 git history。

設定方式：Repo → Settings → Secrets and variables → Actions，新增 `CLOUD_URL`、`CLOUD_SECRET` 兩個 Repository secret；並把 Settings → Pages → Build and deployment → Source 切成「GitHub Actions」（原本若是「Deploy from a branch」要一併關掉，避免兩邊搶著部署）。

> 注意：即使密鑰不進 git，部署出去的頁面原始碼裡還是看得到（純前端架構無法真正隱藏密鑰），這個設計只解決「密鑰留在 git history 裡」的問題，不是解決「密鑰對外不可見」——真正解法是密鑰一旦外流就要重新產生。

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
