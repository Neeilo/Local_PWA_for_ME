# ADR-028：圖書館週報

- **狀態**：現行（2026-11-13）；PR-A 後端，PR-B 前端
- **關係**：建立在 ADR-020（收藏）、ADR-024（📝 圖片文字）、ADR-025（閱讀狀態）、ADR-027（Threads、圖書館設定）之上；AI 呼叫照 ADR-017（選定的那一家、失敗不換家）、記帳照 ADR-022
- **討論與草稿**：專案擁有者的 Notion（ADR-028 草稿頁）；本檔只寫工程決策與契約，不寫「我的關注」等個人脈絡

## 背景

收藏進得來（IG＋Threads），但讀不完：未讀庫存每週淨增。需要一份定期的「消化」清單——挑少數值得讀的，並把明顯不值得讀的（重複包裝、留言領取的引流文）一次放掉。

## 決策

| # | 決策 |
| --- | --- |
| D-1 | 以消化為主：每期推薦清單＋每篇一句理由；數字總覽（新收分 IG／Threads、未讀／閱讀中／已讀、未讀增減、各分類、本期判斷數、上期推薦已讀 x／y）由程式計算，不送 AI |
| D-2 | 排程：台北每週五 19:00 後（排程總管每 10 分鐘看一次「最近一個週五 19:00」，錯過的之後補），每位有 `feat_clips` 的人每週一份。另有「📊 立即產生」：規則相同，但只是預覽——不推進新收的起點、不推 LINE |
| D-3 | 候選：本人、收齊（`done`／`partial`）、未刪、未讀或閱讀中。🆕 新收＝上一份**排程**週報的 `period_end` 之後收藏的（第一次取 7 天）；📦 舊庫存＝其餘候選中，沒判過的優先、再來最久沒判的、同層最舊的，最多 20 篇。推薦上限：新收 3、舊庫存 2 |
| D-4 | 每篇給 `recommend`／`normal`／`skip`＋理由；**AI 只建議、不動手**：產生週報不改任何 `read_status`，標已讀只能由本人觸發 `clipMarkRead` |
| D-6 | 排程成功：LINE 一對一短提醒（推薦標題、可略過 N 篇）；推播成敗寫 logs |
| D-7 | 提示詞兩層：固定指令（程式維護）＋「我的關注」（每人一份，指令碼屬性 `clip_focus_<line_id>`，上限 2,000 字；空白用通用標準）。logs 只記字數，不複製內容 |
| D-8 | 要求 JSON 輸出；解析是純函式：不認得的 id 忽略、推薦超過上限降為普通、漏判的篇不寫；**一篇都解析不出來＝失敗，不存半份**。失敗寫 `clip_reports`（`status`＝`failed`＋原因）與 logs；排程的失敗 LINE 通知，不自動重試 |
| D-9 | 每篇送出最多 800 字（說明文字優先，再來圖片文字、筆記）；整體輸入 40,000 字，超過的篇這期不判。feature＝`clip_report`。走 `callAiLong_`（純文字、輸出上限 8,192 tokens）：`callAi_` 的 2,048 tokens 不夠約 45 篇的 JSON，會被截斷而整份解析失敗 |
| D-10 | 新分頁 `clip_reports` 一期一列；`clips` 最右邊加 `report_verdict`／`report_reason`／`report_id`／`report_at`（只留最新一次） |
| D-11 | 只看擁有者自己的收藏；PWA 一般讀寫碰不到 `clip_reports`（`NO_PWA_READ`／`NO_PWA_WRITE`） |

## 契約

- 新檔 `apps-script/clip-report.gs`；排程工作 `clipReport`（模組 `library`）
- PWA action：`clipReport`、`clipReportRun`、`clipMarkRead`、`clipFocus`、`clipFocusSet`，見 [API.md](../API.md)
- 指令碼屬性：`clip_report_state`（這一週排過誰）、`clip_focus_<line_id>`，見 [CONFIG.md](../CONFIG.md)
- `clip_reports.recommended`／`skippable`：JSON `[{ id, group: "new"｜"old", reason }]`；`summary`：數字總覽 JSON
- 「初始化」建 `clip_reports`、`clips` 補 `report_*` 四欄

## 實作差異（相對 Notion 交棒頁）

- 「本週新收」用 `collected_at`（收藏時間）判斷：`clips` 沒有「收齊時間」欄
- 舊庫存取「未讀或閱讀中」（與候選條件一致）
- `clip_reports` 多一欄 `week`（排程那一期的週五日期），排程的「每人每週一份」另記指令碼屬性 `clip_report_state`：先記「排過了」再產生，跑一半掛掉也不會一週推兩次
- `clips` 的判斷欄用 `report_` 前綴，避免和 AI 整理的 `ai_*` 混淆

## 後果

- 每期一次 AI 呼叫（約 45 篇 × 800 字），費用在成本卡「圖書館週報」看得到
- 推薦品質靠「上期推薦已讀 x／y」回頭檢驗；長期偏低再檢討數量或標準
- 不做：自動標已讀、刪除收藏、獨立的重複偵測、引流文標記欄位、搜尋納入辨識文字、首頁 Widget 改動
