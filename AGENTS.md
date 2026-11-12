# AGENTS.md — NeilOS PWA 開發協作契約（所有 AI Agent 的共同入口）

> 這份是跨 Agent 的中立入口（Claude Code、Codex 或其他工具都先讀這裡）。內容自 `CLAUDE.md` 搬來，**規則只搬位置、不改內容**；12 條原則的編號沿用原本的編號，程式註解與交棒紀錄裡的「CLAUDE.md 原則 5」「Rule 9」指的就是這裡的同號原則。
> 「已實作」以最新程式和測試為準；重大決策以 ADR 為準（ADR-004～026 的正文在專案擁有者的 Notion）。

## 專案速覽
- 純 HTML/CSS/JS PWA（`index.html`）、Google Apps Script（`apps-script/`）、Google Sheets／Drive、LINE、GitHub Pages。2.0 包含 Shell、Widget、Apps、Library、Search；**不是微服務或可安裝外掛系統**。
- **雲端是唯一權威來源**（Cloud-authoritative）；本機設定、待送佇列與快取不得無聲覆蓋雲端資料。先了解既有同步機制，再修改讀寫。
- 身份透過 LINE 配對與裝置 token；後端 `authDevice_`、`line_users`／`canUse_`、`_module_registry` 一起決定實際權限。2.0 保留 1.0 切回。
- PR workflow `.github/workflows/pr-check.yml` 會跑測試、密鑰掃描及資產檢查；合併 `main` 後才由 `deploy.yml` 部署 Pages／GAS。兩者不可混為一談。
- **新增任何雲端動作必須帶 trigger**（cold／foreground／poll／manual／write／zone 等），保留效能可觀測性；`tests/adr-014-perf-push.test.mjs` 會檢查 `index.html`，只有 `pairClaim`／`renewStart` 例外。

## 12 條工作原則（延續原專案的決策精神）

1. **寫前思考，不盲目猜。** 先查程式、測試與 ADR，釐清假設、歧義和更簡單的解法。若不確定性會影響資料正確性、權限或不可逆操作，停止實作並詢問；低風險歧義可採保守假設，但須明示。
2. **簡單至上，保留原型彈性。** 正式功能只做當下所需，不因推測性需求引入框架或抽象層；PoC 可快速試錯，但須隔離正式資料、標註實驗範圍，驗證前不直接轉為正式功能。
3. **手術式修改。** 不順手重構無關功能；tasks／notes／expenses 的提醒、白板、分期可能共享欄位或寫入路徑。
4. **目標導向，可驗證完成。** 事先定義實測驗收；提交、測試、部署成功分別是不同證據。
5. **讓 AI 處理判斷，而非確定性邏輯。** 摘要、語意分類與草擬可使用 AI；權限、狀態碼、重試、去重、排程及金額計算使用可測試的傳統程式。未擷取的圖片、網頁不得聲稱已閱讀。
6. **管理上下文與檢查點。** 長任務拆成可驗證的小階段；依任務大小規劃檢查點，不設固定 token 硬上限。工作範圍失控或上下文不足時先整理已完成、驗證證據與剩餘工作，避免盲目延續。
7. **衝突要攤開講。** 現有規則與新需求衝突時列出差異與風險，不靜默把兩套相反邏輯合在一起。
8. **寫之前讀懂影響面。** 至少檢查目標函式、直接呼叫者、被呼叫的共用工具與相關測試。更動同步、權限、tombstone／archive 時，再完整追蹤 LINE → GAS → Sheet／Drive → PWA → localStorage／佇列。
9. **測試要驗證為什麼。** 先說明行為目的與失效影響，再測實際的 `Code.gs`、`index.html`；涵蓋併發、衝突、失敗恢復與拒絕存取。另驗證匯出中途失敗、同筆連續快速寫入，以及離線時顯示連線錯誤而非假裝呈現最新快取；禁止硬編回傳、修改期待值或測副本只求綠燈。
10. **長任務分段回報。** 每個重要檢查點說明已做、已驗證及尚未完成的部分，留下可交接到 Notion 的紀錄；若喪失上下文或無法解釋現況，先停止並恢復事實，不靠猜測繼續。
11. **遵循現有慣例。** 新做法先提出理由和風險，取得決策後才替換，不在同一系統暗中並存兩種標準。
12. **主動揭露失敗。** 部分成功、缺少授權、無法驗證、未部署都如實告知，不把「沒有報錯」寫成完成。

## NeilOS 2.0 不可破壞的契約

- **雲端寫入**：以 GAS 確認為準；Library 筆記使用 revision 與鎖內檢查。衝突不能自動蓋過另一裝置修改，必須保留使用者輸入並提示。
- **權限**：裝置 token／白名單／feat_*／模組 enabled 都在後端強制執行；個人資料搜尋不得越權。模組關閉不等於刪資料。
- **效能**：首頁只取必要摘要，完整模組按需載入。搜尋、AI、資料擷取不放入冷開機路徑；一個 Widget 失敗不可拖垮其他 Widget。
- **相容性**：試營運中 1.0 與 2.0 共存，任何新增欄位、切換或資料遷移都須測試 1.0 不受損。
- **部署**：`apps-script/` 是來源；不要在 GAS 編輯器直接維護。必要的緊急修改要 `npm run pull` 回收進版本庫；不要在本機手動 `clasp push`。
- **安全**：金鑰／憑證僅留 Secret 或 GAS Properties；不寫入 repo。新 Sheet 須同步更新 `guideRegistry_()`，避免結構文件漂移。
- **Gmail（ADR-026）**：封存只由規則決定、預設預演；正式封存開關（屬性 `gmail_archive_live`）只有 Neil 在 App 親手打開。不得對真實 Gmail 批次封存或做測試性操作，不刪信、不標已讀、不動星號；內文即時讀、不存副本，內文與金額不進 logs／performance／fixtures。

## 工作流程

1. 讀本檔與任務相關來源；必要時參考 [2.0 Pilot](docs/NEILOS_2_0_PILOT.md)、[GAS 維運速查](apps-script/OPERATIONS_2_0.md) 與 Notion ADR。
2. 先列受影響模組、跨端讀寫和可驗收條件；小改動保持簡單。
3. 修改程式與針對性測試；執行 `npm test`、`npm run scan`。
4. PR 顯示修改範圍、回歸風險、驗證結果與未確認事項；PR CI 綠燈才考慮合併。部署成功後仍需實機驗收。

## 文件導覽

先讀本檔，再依任務挑下面的文件。所有文件都以原始碼為準；文件與程式不一致時，以程式為準並回報差異。

| 文件 | 什麼時候讀 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 第一次接手：一頁看懂元件、資料流、同步與權限、部署管線、LINE 入口的安全邊界 |
| [docs/MODULES.md](docs/MODULES.md) | 要改某個功能：找它的前端段落、後端檔案與函式、API 動作、分頁、測試、ADR |
| [docs/API.md](docs/API.md) | 每個 PWA 動作的參數、回應、權限、寫入與 logs；LINE 指令與事件 |
| [docs/DATA.md](docs/DATA.md) | 每張分頁的用途、鍵欄、欄位、寫入者與讀取者；Drive 資料夾結構 |
| [docs/CONFIG.md](docs/CONFIG.md) | 指令碼屬性、GitHub Secrets、`localStorage` 鍵、`feat_*`、模組開關（只有名稱與用途） |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | 部署、確認線上版本、回退、資料還原、常見故障 |
| [docs/checklists/new-action.md](docs/checklists/new-action.md) | 新增一個 PWA 雲端動作 |
| [docs/checklists/new-sheet.md](docs/checklists/new-sheet.md) | 新增一張 Sheet 分頁 |
| [docs/checklists/new-static-asset.md](docs/checklists/new-static-asset.md) | 前端新增圖示、檔案等靜態資源 |
| [docs/checklists/new-scheduled-job.md](docs/checklists/new-scheduled-job.md) | 新增排程工作 |
| [docs/NEILOS_2_0_PILOT.md](docs/NEILOS_2_0_PILOT.md) | 2.0 試營運的範圍與驗收重點 |
| [apps-script/OPERATIONS_2_0.md](apps-script/OPERATIONS_2_0.md) | 部署後檢查與常見故障 |
| [apps-script/README.md](apps-script/README.md) | 各 `.gs` 檔的詳細歷史與安裝步驟 |

## 公開資訊分類規則

**這個 repo 是公開的。** 寫進 repo 的任何東西（程式、測試、文件、commit message、PR 說明）都當成會被所有人看到。

| 資訊 | 公開 repo | 留在私人位置 |
| --- | --- | --- |
| 架構、資料流、API 與資料契約、流程 | 可以放 | — |
| 設定鍵 | 只放名稱與用途 | 值與輪替紀錄 |
| 資源識別碼：試算表、指令碼、部署、Drive 資料夾、LINE 群組與使用者 | 不放 | Secrets、指令碼屬性、私人筆記 |
| 規則表內容：郵件規則、分類清單、自選股、提醒條件 | 只放欄位結構 | Sheet |
| 人 | 用角色代稱，如「管理者」「成員 A」 | 姓名、稱謂、帳號、信箱 |
| 金融機構與持有的產品 | 新增時以類型命名，不寫機構名 | 私人對照表 |
| 營運數據：金額、持股、信件內容、個人待辦 | 不放 | Sheet、Notion |
| 測試樣本 | 合成資料與保留網域（`example.com`） | — |
| ADR | 工程決策、契約、取代關係 | 決策背後的家庭與財務脈絡 |

只移除姓名不算去識別：稱謂、銀行、持股、規則內容組合起來仍能拼出家庭與財務輪廓。

既有程式與測試裡已經存在的私人資訊，不要在新文件、PR 或 issue 中引用或列舉它們的值；要處理時另開票、先取得授權。
