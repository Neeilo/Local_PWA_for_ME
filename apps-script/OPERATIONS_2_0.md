# NeilOS 2.0｜Apps Script 維運速查

> 2026-10-20。本檔是 **現行操作入口**；各模組的完整歷史背景請讀 [README.md](README.md)。不要把此檔當成手動修改線上程式的授權。

## 正式架構

- `apps-script/` 是**正式來源**：推送 main 後 GitHub Actions 執行 `clasp push --force` 與 `clasp deploy -i <既有部署>`。
- `doGet` 已停用；PWA 請求經 LINE 配對的裝置 token、白名單與功能權限驗證。
- GitHub Actions PR 的 `pr-check` **僅測試不部署**；`deploy.yml` 在 main 部署 Pages 與 GAS（獨立 jobs）。
- GAS 編輯器緊急修改後，必須 `npm run pull`、確認 diff、提交 repo，否則下次部署會被覆寫。

## 每次合併／部署後檢查

1. GitHub Actions 確認 Pages 和 Apps Script jobs 各自成功；若任何一項失敗，不能聲稱全面部署完成。
2. 執行需要的 **LINE 一對一「初始化」**（僅管理者）；檢查結果中的欄位、模組登記、`widget_config`、`feat_ui_v2`、天氣／Apify 等警告。
3. 查 Script Properties：`APIFY_TOKEN`（IG 擷取）、`WEATHER_API`（天氣），以及 LINE／AI／Gmail／股票所需屬性；**絕不貼入 repo**。
4. 驗證 PWA 可登入；1.0、2.0 切換；2.0 Widget 部分錯誤不阻止其他功能。
5. 驗證 LINE 任務輸入、雲端任務完成、Library 收藏與搜尋、Apps 權限和模組總開關。
6. 檢查排程總管 `runScheduler` 心跳、`logs` 與 `performance`；部署成功不代表排程與資料授權都正常。

## 主要檔案／維運範圍

| 檔案 | 目的 |
|---|---|
| `Code.gs` | PWA API、驗證、Sheet 存取與 Widget 摘要入口 |
| `line-router.gs` | LINE 指令與管理者初始化 |
| `modules.gs` | `_module_registry` 與全域模組總開關 |
| `widgets.gs` | `widget_config`、天氣快取／排程 |
| `clips.gs` | Instagram 擷取、圖書館 URL、筆記 revision、AI 整理 |
| `search.gs` | 按需跨模組關鍵字搜尋 |
| `scheduler.gs` | 唯一 5 分鐘排程總管 |
| `stock.gs` | 股票報價、自選、交易與規則 |
| `gmail.gs` | Gmail 標籤控制、摘要與附件 |
| `sheet-guide.gs` | Sheets 分頁登記與 `_guide` |

## 原則與故障排查

- **資料不一致**：先看當次裝置／使用者、`logs`、雲端列與 revision，不要直接用本機 state 覆蓋 Sheet。
- **權限被拒**：辨識 `authDevice_`、`line_users` feat_*、`_module_registry` 是否停用，拒絕和連線錯誤處理不同。
- **首頁慢**：比對 `performance` 的 `ui` 標記，區分 core boot、延後的財務／股票 Widget 與停留頁面輪詢，不做全表重新讀取。
- **天氣沒資料**：檢查 `WEATHER_API`、地點設定、排程更新、`weather_cache`（Apps Script **指令碼屬性**，由 `widgets.gs` 的 `WEATHER_CACHE_KEY` 指定，**不是 Google Sheets 分頁**），勿把失敗當作「沒有下雨」。
- **Library 故障**：檢查 Apify 用量／成功率、`clips` status、Drive 原始素材；AI 整理失敗不得覆蓋 `caption` 或 `note`。
- **搜尋慢**：按需搜尋會讀取多張 Sheet，觀察資料量及時間，切勿改成開機自動搜尋。
- **新分頁**：同步更新 `guideRegistry_()`；執行初始化只補缺少的欄位／表，不得重置使用者設定。

## 安全紅線

不公開權杖、裝置 token、GAS scriptId 憑證與私人雲端檔案。不在本機手動 clasp push。不要更換正式 deployment ID；新 exec URL 會使 LINE Webhook 與 PWA 指向不同後端。

詳見：[`../CLAUDE.md`](../CLAUDE.md) 與 [2.0 Pilot](../docs/NEILOS_2_0_PILOT.md)。
