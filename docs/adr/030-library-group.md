# ADR-030：圖書館群組——收藏與週報搬進專屬 LINE 群組

- **狀態**：現行（2026-11-23）
- **修訂**：ADR-020 B-1（收藏只在一對一 → 只在圖書館群組）、ADR-028 D-6（週報推一對一 → 推圖書館群組）
- **比照**：ADR-016／ADR-026 的 Mail 群組（`cmd_gmail`／`notify_gmail`）；ADR-014 的 `notify_*` 判斷
- **討論與草稿**：專案擁有者的 Notion（ADR-030 草稿頁）

## 背景

功能開始各自獨立成聊天室：Mail 已經走 `line_groups` 的 `cmd_gmail`／`notify_gmail`。圖書館收藏原本寫死只在一對一（`routeLineMessage_` 的 `if (!chatId)`），週報寫死推一對一（`clipReportNotify_` → `linePush_(lineId)`），只靠設定搬不過去，需要改程式。

## 決策

| # | 決策 |
| --- | --- |
| D-1 | 一對一不再收網址：圖書館群組是唯一 LINE 收藏入口（PWA「＋ 加網址」不變） |
| D-2 | 一對一收到網址：回「📚 收藏請丟到圖書館群組」，不收、不寫 logs |
| D-3 | 週報只推圖書館群組（啟用＋`notify_clips`＋bot 沒離開），不推一對一；沒有可推的群組 → 週報照常產生，logs 記「沒有開 notify_clips 的群組，沒有推」 |
| D-4 | 群組丟網址回「收到 ✅」；白名單＋`feat_clips` 才收、記在發話者名下；群組裡非網址、非指令的訊息照舊不回 |
| D-5 | 群組打「週報」：用 reply 回本人最近一期**成功**週報的短版（同週五通知內容，不重跑 AI、不吃推播額度）；沒有 → 「還沒有週報，週五 19:00 見 📊」；一對一打「週報」→ 「📚 請到圖書館群組查看」 |
| D-6 | `line_groups` 新增 `cmd_clips`、`notify_clips`，新列與既有列預設都關；「初始化」補欄 |

## 實作差異（相對 Notion 交棒頁）

- **其他網域只存連結（ADR-021 D-12）原本也在 `clipLineReply_` 裡**：一併搬到群組。一對一丟任何網址（IG、Threads、FB、X、一般網站）都只回指路；圖書館群組丟任何網址都照舊分流（IG／Threads 排隊抓、其他只存連結）
- **一對一的指路只給有 `feat_clips` 的人**：沒有收藏權限的人丟網址或打「週報」，照舊回「看不懂這個指令」，不叫他去一個他用不了的群組
- **群組收藏的門不走 `groupGate_`／`writeGate_`**：那兩道門擋下來會回話、寫 logs，跟「任一門不過不回、不寫 logs」衝突。改由 `groupClipReply_` 直接讀（有快取的）群組設定與白名單，門不過回 null
- **「週報」是指令（受 `cmd_clips` 管），走既有群組三道門**：在沒開 `cmd_clips` 的群組打「週報」會回「這個群組沒有開放「圖書館」」，跟其他指令一致；沒有 `feat_clips` 回權限不足（寫 logs）
- **週報只推管理者的**：群組多人共用，LINE 查不到「週報擁有者在不在這個群組」→ 只有擁有者 `is_admin` 的週報推群組；其他人的週報照常存、不推，logs 記「擁有者不是管理者」
- **短版文字抽成 `clipReportShortText_`**（週五通知與「週報」共用）；手動預覽那一期標「（預覽）」
- **共用篩選 `notifyGroups_(field)`**：Mail 彙總（`gmailPushDigest_`）與圖書館週報共用；logs 露出群組 id 前 3 碼的 `groupIdShort_` 也共用
- **「初始化」另開一步「圖書館群組」**（`installClipGroupColumns_`），不併進「欄位」步驟：補欄順序跟在 Mail 的兩欄後面，與 `LINE_GROUPS_HEADERS` 一致
- **新加入群組**：`registerGroup_` 照舊只把 `cmd_expense`／`cmd_tasks`／`cmd_query` 預設開，`cmd_clips`／`notify_clips` 空白＝關

## 後果

- 部署到在 `line_groups` 打勾之間，一對一已不收、群組還沒開，丟的網址會漏：先建群組、邀 bot，合併後傳「初始化」並立刻打勾
- 一對一聊天室只剩指令；圖書館的 LINE 入口集中在一個群組
- 週五 push 路徑只能等第一個週五實看；「週報」關鍵字只驗得到 reply 路徑
- 若未來成員也要收週報，需要另外決定「推到哪個群組」（例如每人一個圖書館群組），本 ADR 不處理
