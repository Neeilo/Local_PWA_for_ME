# Neil OS — 個人小系統

安裝在手機主畫面的個人小系統 PWA，資料主要存在本機（localStorage），並會同步備份到 Google Sheets。

🔗 **Live**: https://neeilo.github.io/Local_PWA_for_ME/

## 功能

底部導覽（左→右）：**記帳、雜記 ｜ ⭕首頁 ｜ 任務、日誌**

1. 🧭 **首頁 Dashboard** — 本月支出總額 + 各類支出圓餅圖、未完成任務前 3 筆（依優先度）、今日指南針（可直接作答）
2. 💰 **記帳** — 支出／收入、7 類分類、當月清單（可切換月份、可修改刪除）+ 當月小計
3. ☑️ **任務紀錄** — 新增 / 勾選完成 / 刪除，含優先度紅🔴黃🟡綠🟢（點燈號循環切換）
4. 🌙 **日誌** — 每日指南針（今日的刻意選擇）+ 複盤（做得好的 / 卡住的 / 明天最重要的一件事）
5. 📎 **雜記** — 靈感與雜項，含 JSON 備份匯出

以下兩個模組以 feature flag 隱藏入口（`SHOW_MOOD` / `SHOW_GROWTH` = `false`），**程式碼、localStorage 與雲端分頁全數保留**，改一行即可重啟：

- 💚 **心情紀錄** — 五級 + 備註，頂部近 14 天心情脈搏色條
- 🌱 **成長** — 週回顧（決策動機、驅動力來源、逃避偵測器）+ 輸出追蹤

## 技術架構

| 項目 | 選型 |
|---|---|
| 前端 | 純 HTML / CSS / JS，單檔（`index.html`） |
| 本地儲存 | `localStorage`，單一 JSON state key：`personal-os-state-v1` |
| 雲端同步 | Google Apps Script + Google Sheets（tasks / reviews / moods / notes / expenses，載入時 pull、儲存時 push） |
| PWA | `manifest.json` + Service Worker（`sw.js`，HTML network-first、其餘資產 cache-first） |
| 部署 | GitHub Pages |

資料模型：`{ tasks: [], reviews: {date: {...}}, moods: [], notes: [], weeklyReviews: [], outputs: [], expenses: [] }`

Google Sheets 各分頁欄位：

| 分頁 | 欄位（欄序即表頭順序） |
|---|---|
| `tasks` | `id \| text \| is_completed \| created_at \| priority` |
| `reviews` | `review_date \| good \| stuck \| most_important` |
| `moods` | `id \| mood_date \| level \| note` |
| `notes` | `id \| text \| created_at` |
| `expenses` | `id \| expense_date \| type \| category \| amount \| note \| created_at` |

`priority` 存 `H`/`M`/`L`，預設 `M`，無值的既有任務會在前端首次載入時自動補 `M`。`expenses.type` 為 `expense`/`income`，首頁圓餅圖只計 `expense`。Apps Script 的 `Code.gs` 為通用 `doGet`/`doPost`，新增分頁與欄位皆不需修改。

## 檔案結構

```
index.html      主程式（含樣式與邏輯）
manifest.json   PWA manifest
sw.js           Service Worker（離線快取）
icon-192.png    App icon 192x192
icon-512.png    App icon 512x512
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
