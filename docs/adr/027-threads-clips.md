# ADR-027：圖書館 Threads 收藏

- **狀態**：現行（2026-11-13）
- **修訂**：ADR-021 D-12「非 IG 網址只存連結」→ Threads 單篇貼文例外，比照 IG 收齊；ADR-020 的 Apify 每月 US$3 門檻從「只提示」改為「達上限暫停抓取」
- **討論與草稿**：專案擁有者的 Notion（ADR-027 草稿頁）；本檔只寫工程決策、契約與後果

## 背景

圖書館（ADR-020、ADR-021）只收 IG 全文，其他網址只存連結。Threads 收藏很多內容在作者自己的接續串文裡，只存連結等於沒收。PR-0 探針（`lab-clip.gs` 的 `probeClipThreads`）實測：

- Threads App／LINE 分享出來的一律是 `https://www.threads.com/share/短碼`；GAS 打 threads.com 會收到 HTTP 302，`Location` 是 `/@帳號/post/貼文代碼?xmt=…`
- Apify `architekture~threads-replies-scraper` 一次回主文（`recordType=post`）與回覆；作者自己的接續標 `replyType=author_thread`，帶 `parentCode` 可以串出順序
- 這支爬蟲按筆計費（主文 US$0.001、每列回覆 US$0.0025），別人的留言也計費；run 物件的 `usageTotalUsd` **不含**按筆計費

## 決策

| # | 決策 |
| --- | --- |
| D-1 | 收齊標準比照 IG：主文、圖片（照主文→串文的順序）、`raw.json`、`content.md`。主文與作者串文合併成一篇寫進 `content.md` 與 `clips.caption`：主文不加標題，之後每段加「── 串文 i／N ──」（N 含主文；合併是純函式 `clipThreadsMerge_`）。**別人的留言、作者回別人的留言都不存**（`raw.json` 也只放主文與作者串文） |
| D-2 | 入口比照 IG：LINE 一對一自動偵測、PWA「＋ 加網址」；群組不收。認得 `threads.com`／`threads.net`、有無 `www`、`/@帳號/post/代碼`、`/t/代碼`、`/share/短碼`；個人頁等非貼文網址仍只存連結。`kind`＝`threads`，平台由 `kind`／網址推導，不新增欄位 |
| D-2a | webhook 不打外部：短網址照原樣登記（`shortcode` 空白），**排程輪到時才轉址**（`followRedirects: false` 讀 `Location`），把貼文網址與代碼寫回。重複判斷用貼文代碼，不用短碼（同一篇每次分享的短碼可能不同）。轉不出來算一次失敗，走既有重試 |
| D-3 | 「初始化」一次性把只存連結、網址是 Threads 貼文或短網址的列轉成等待抓取；只改 `kind`／`status`／`url`／`shortcode`／`attempts`／`next_try_at`／`error`，閱讀狀態、筆記、分類、AI、收藏時間都保留。做過就記指令碼屬性 `clips_threads_backfill`，不再做 |
| D-4 | 成本：本月合計＝max（Apify 帳號本月用量, Threads 估算）。**達 US$3 → IG 與 Threads 新抓取都暫停**（2026-11-13 專案擁有者定案，取代草稿的「只停 Threads」），一個月寫一次 logs。圖書館設定有「本月超過上限仍繼續抓」，存的是月份，換月自動失效。Threads 估算＝每次 run 的主文列×US$0.001＋回覆列×US$0.0025，存 `clips_threads_usage` |
| D-5 | 圖書館列表與閱讀頁加來源小標籤（IG／Threads），只在 2.0 |
| D-6 | 串文被回覆上限截斷（`RUN_SUMMARY.perPost` 的 `capped` 且未 `exhausted`）、或 `parentCode` 串不起來改照時間排 → `status`＝`done`、`error`＝「串文可能不完整」當說明，**不觸發重試**（不用 `partial`） |
| D-7 | 圖書館設定（2026-11-13 專案擁有者追加）：IG／Threads 各自「存圖片」「存影片」，存指令碼屬性 `clips_settings`；IG 預設都存（維持原行為），Threads 預設存圖、**不存影片**。關掉存圖片時一張都不存也算收齊。只有管理者＋`feat_clips` 能看與改（`clipSettings`、`clipSettingsSet`），每次切換寫 logs |
| D-8 | 每輪 IG＋Threads 合計最多 5 篇（`CLIPS_PER_ROUND`）；兩個平台各跑一次 Apify run。Threads run 帶 `maxRepliesPerPost`＝30、`includeAuthorThread`、`maxTotalChargeUsd`＝每篇 US$0.1 |

## 契約

- `clips.kind`：`post`｜`reel`｜`threads`｜`link`
- `clips.error` 在 `done` 列上可能是說明：`串文可能不完整`、`影片過大未保存`（以 `；` 連接）
- PWA action：`clipSettings`（讀）、`clipSettingsSet`（`key`＝`ig_images`｜`ig_videos`｜`threads_images`｜`threads_videos`｜`force`，`value` 布林），見 [API.md](../API.md)
- 指令碼屬性：`clips_settings`、`clips_threads_usage`、`clips_paused_month`、`clips_threads_backfill`，見 [CONFIG.md](../CONFIG.md)
- 開機（管理者）帶的 `clips_usage` 多一個 `gate`（本月合計、IG／Threads 用量、`paused`、`forced`）；`apifyUsage` 工作另記 Threads 的近 3 天成功率（`threads_done`／`threads_total`／`threads_rate`），低於 80% 只在管理頁提示、不自動停

## 後果

- Threads 收藏和 IG 一樣能閱讀、筆記、分類、自動 📝 文字辨識（只要有圖）
- 每篇成本約 US$0.03～0.08（看別人的留言多寡），遠高於 IG；上限改為「達到就停」，續抓要專案擁有者在 App 明確打開
- 帳號用量是否含按筆計費未實測：閘門取兩者較大值，寧可早停不低估
- 不做：定期 AI 匯報、別人的留言、來源篩選、其他平台（YouTube、一般網頁）、搜尋納入辨識文字、重複內容偵測
