# NeilOS — Personal Command Center

> **2.0 試營運（Pilot）** · 更新：2026-10-20 · [開啟 PWA](https://neeilo.github.io/Local_PWA_for_ME/)

NeilOS 是個人資訊中樞：早上用 **Dashboard Widgets** 掌握重要資訊，白天用 **LINE** 登錄與查詢，透過 **Library** 閱讀收藏、做筆記，必要時才讓 AI 協助整理。2.0 已上線試營運，**1.0 仍保留切回入口**。詳見 [2.0 Pilot](docs/NEILOS_2_0_PILOT.md)。

## 2.0 已實作（以 main 原始碼為準）

| 區域 | 功能 | 目前界線 |
|---|---|---|
| Shell / Apps | 2.0 切換、五格 Tab、App Grid、模組開關 | UI 模組化，並非獨立安裝的外掛系統 |
| 總覽 Widgets | 任務、財務、郵件、股票、閱讀、天氣；排序／隱藏／釘選 | 核心摘要先載；財務與股票延後；盤中排序 |
| Tasks | Dashboard 勾選完成、雲端確認 | 寫入仍需後端驗證 |
| Library | Instagram 擷取、其他網址只存連結；閱讀、個人筆記、已讀、按需 AI 整理 | 尚無通用網頁擷取或圖片 OCR；AI 不可假裝看過未解析圖片 |
| Search | 任務、提醒、雜記、圖書館文字與筆記、記帳備註 | 關鍵字搜尋；郵件／股票／筆電檔案不納入 |
| Settings | Widget 個人化、模組總開關與既有設定拆分 | 模組總開關同時影響 1.0／2.0 |

> **尚未實作**：個人筆電遠端 Agent、跨所有來源自動全文擷取、語意／向量搜尋、可安裝 Plugin Marketplace。這些是構想，不是現行承諾。

## 架構與資料原則

```text
LINE ─┐
      ├── Google Apps Script API／授權／排程 ── Google Sheets + Google Drive
PWA ──┘                     │
  ├── 2.0 Shell / Apps       ├── modules.gs：模組總開關
  ├── Dashboard Widgets     ├── widgets.gs：摘要設定／天氣
  ├── Library               ├── clips.gs：收藏／筆記／AI
  └── Search                └── search.gs：按需關鍵字搜尋
```

- **Cloud-authoritative**：Sheets／Drive 是權威資料來源；本地只放必要設定、佇列或非權威快取，不得在衝突時靜默覆寫雲端。
- **認證**：LINE 配對取得裝置 token；後端驗證 `line_users` 白名單及功能矩陣。所有權限不可只靠前端隱藏。
- **模組管理**：`_module_registry` 的 enabled 是全域開關；個人 `feat_*` 是另一層權限。關閉模組不得造成歷史資料被清空。
- **效能**：2.0 開機只讀核心與必要 Widget 摘要；打開模組才載整筆資料；Widget 失敗應局部降級；不在開機跑搜尋或 AI。
- **背景作業**：`runScheduler` 每 5 分鐘排程派工；Instagram 收藏異步執行，LINE 收件不等待 Apify。

## 專案結構

| 位置 | 說明 |
|---|---|
| `index.html` | PWA 前端（目前仍以單一檔案為主，非多個獨立 App） |
| `sw.js`, `manifest.json` | PWA 快取與安裝 |
| `apps-script/` | GAS **正式部署來源**，不是唯讀鏡像 |
| `apps-script/README.md` | 詳細舊／新功能維運與部署紀錄 |
| `apps-script/OPERATIONS_2_0.md` | 2.0 日常維運速查 |
| `tests/` | 使用正式前端／GAS 原始碼的測試 |
| `.github/workflows/pr-check.yml` | PR 觸發測試、密鑰掃描、發布白名單檢查 |
| `.github/workflows/deploy.yml` | 合併 main 後部署 GitHub Pages 與 GAS |

## 開發與發布

```bash
npm ci
npm test
npm run scan
npm run preflight
```

1. 先閱讀 [CLAUDE.md](CLAUDE.md) 的開發契約。架構重大變動先對照 Notion ADR（決策的 source of truth）。
2. 建立分支與 PR；`pr-check` 成功後再審查合併。**PR 檢查不部署**。
3. `main` 部署分為 GitHub Pages 與 Apps Script 兩個 job；GAS 透過 `clasp push` 和 **既有 deployment ID** 發新版本，不能隨意產生新 exec 網址。
4. 部署後按需要由管理者在 LINE 私訊執行「初始化」；檢查後端授權、分頁與資料遷移，勿以綠燈直接替代實機驗收。
5. 涉及前端發行時檢查 Service Worker CACHE 版本及必要測試。

## 試營運驗收重點

- 實測 1.0／2.0 冷開機 P50／P95、首頁輪詢及搜尋耗時；勿以單次時間宣稱改善。
- LINE 建立任務 → Dashboard 顯示 → 點完成 → 雲端再讀確認。
- Library 保存 → 閱讀 → 筆記 revision 衝突 → 按需 AI → 搜尋找回。
- 權限與全域模組開關：關閉時不得由 PWA、LINE 或搜尋繞過。

相關文件：[2.0 Pilot](docs/NEILOS_2_0_PILOT.md) · [Apps Script 維運速查](apps-script/OPERATIONS_2_0.md) · [Apps Script 詳細紀錄](apps-script/README.md)。

> 歷史 1.0 規格請查 git history、既有 ADR 與測試；此首頁文件反映當前試營運，而不是保證全部未來願景已完成。
