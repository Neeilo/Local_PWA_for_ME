# CLAUDE.md — NeilOS PWA 開發協作契約

> 2026-10-20｜NeilOS 2.0 試營運。此檔是 **Claude Code 常駐工作規則**，不是 PRD、歷史紀錄或 API 手冊。重大決策以 Notion ADR 為準；「已實作」以最新程式和測試為準。

## 專案速覽
- 純 HTML/CSS/JS PWA（`index.html`）、Google Apps Script（`apps-script/`）、Google Sheets／Drive、LINE、GitHub Pages。2.0 包含 Shell、Widget、Apps、Library、Search；**不是微服務或可安裝外掛系統**。
- **雲端是唯一權威來源**（Cloud-authoritative）；本機設定、待送佇列與快取不得無聲覆蓋雲端資料。先了解既有同步機制，再修改讀寫。
- 身份透過 LINE 配對與裝置 token；後端 `authDevice_`、`line_users`／`canUse_`、`_module_registry` 一起決定實際權限。2.0 保留 1.0 切回。
- PR workflow `.github/workflows/pr-check.yml` 會跑測試、密鑰掃描及資產檢查；合併 `main` 後才由 `deploy.yml` 部署 Pages／GAS。兩者不可混為一談。
- 每個雲端動作填明 `trigger`（cold／foreground／poll／manual／write／zone 等），保留效能可觀測性。

## 12 條工作原則（延續原專案的決策精神）

1. **先想清楚，不要猜。** 不確定的同步、刪除、離線、權限行為，先查程式、測試與 ADR；不能自創折衷方案。
2. **簡單至上。** 僅增加解決當前問題的最少程式，不為假設的未來先引入框架、微服務、泛化抽象。
3. **手術式修改。** 不順手重構無關功能；tasks／notes／expenses 的提醒、白板、分期可能共享欄位或寫入路徑。
4. **目標導向，可驗證完成。** 事先定義實測驗收；提交、測試、部署成功分別是不同證據。
5. **判斷力用在對的地方。** 權限、路由、排程、計算以確定性規則為主；AI 僅在必要時使用，不假裝看過未擷取圖片或外部內容。
6. **控管 Token／上下文預算。** 大任務拆成可驗證階段，接近上限就輸出已完成、驗證與剩餘工作。
7. **衝突要攤開講。** 現有規則與新需求衝突時列出差異與風險，不靜默把兩套相反邏輯合在一起。
8. **寫之前先讀。** 改同步、權限、tombstone／archive 前追蹤 LINE → GAS → Sheet／Drive → PWA → localStorage／佇列完整資料流。
9. **測試要驗證原因。** 真實載入 `Code.gs` 與 `index.html` 的測試優先；涵蓋併發、衝突、失敗回復、拒絕存取，不靠測試副本假綠燈。
10. **重要步驟必須回報。** 每階段說明做了什麼、驗證了什麼、還缺什麼，能直接交接到 Notion。
11. **遵循現有慣例。** 新做法先提出理由和風險，取得決策後才替換，不在同一系統暗中並存兩種標準。
12. **主動揭露失敗。** 部分成功、缺少授權、無法驗證、未部署都如實告知，不把「沒有報錯」寫成完成。

## NeilOS 2.0 不可破壞的契約

- **雲端寫入**：以 GAS 確認為準；Library 筆記使用 revision 與鎖內檢查。衝突不能自動蓋過另一裝置修改，必須保留使用者輸入並提示。
- **權限**：裝置 token／白名單／feat_*／模組 enabled 都在後端強制執行；個人資料搜尋不得越權。模組關閉不等於刪資料。
- **效能**：首頁只取必要摘要，完整模組按需載入。搜尋、AI、資料擷取不放入冷開機路徑；一個 Widget 失敗不可拖垮其他 Widget。
- **相容性**：試營運中 1.0 與 2.0 共存，任何新增欄位、切換或資料遷移都須測試 1.0 不受損。
- **部署**：`apps-script/` 是來源；不要在 GAS 編輯器直接維護。必要的緊急修改要 `npm run pull` 回收進版本庫；不要在本機手動 `clasp push`。
- **安全**：金鑰／憑證僅留 Secret 或 GAS Properties；不寫入 repo。新 Sheet 須同步更新 `guideRegistry_()`，避免結構文件漂移。

## 工作流程

1. 讀本檔與任務相關來源；必要時參考 [2.0 Pilot](docs/NEILOS_2_0_PILOT.md)、[GAS 維運速查](apps-script/OPERATIONS_2_0.md) 與 Notion ADR。
2. 先列受影響模組、跨端讀寫和可驗收條件；小改動保持簡單。
3. 修改程式與針對性測試；執行 `npm test`、`npm run scan`。
4. PR 顯示修改範圍、回歸風險、驗證結果與未確認事項；PR CI 綠燈才考慮合併。部署成功後仍需實機驗收。

> 保持此檔短而有效。長篇行為範例、表格欄位、維運操作放到專門文件；更新規則時應保留「為什麼要這樣做」。
