# Apps Script 端程式碼（鏡像）

這裡的檔案**不是**部署來源——真正在跑的是 Google Apps Script 專案裡的副本。
放在 repo 是為了版控與跨環境交接，避免「哪一版才是對的」變成猜謎。
修改後請記得同步貼回 Apps Script 並重新部署。

| 檔案 | 用途 |
|---|---|
| `line-router.gs` | LINE 快速輸入 → Sheets 路由（加掛檔，不含既有 PWA 同步邏輯） |

> ⚠️ 這個 repo 會整包發布到 GitHub Pages，此資料夾也會公開。
> **任何權杖、SECRET 一律放 Apps Script 的「指令碼屬性」，不要寫進這裡的檔案。**

## line-router.gs 安裝

1. 既有 `Code.gs` 裡，把 `function doPost(e)` 改名為 `function handlePwaSync_(e)`
   （只改名稱，內容不動）
2. Apps Script 新增檔案，貼上 `line-router.gs` 全文
3. 專案設定 → 指令碼屬性 → `LINE_CHANNEL_ACCESS_TOKEN` = LINE 長期存取權杖
4. Google Sheet 新增 `logs` 分頁，第一列貼上表頭（見下方 schema）
5. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署
   （**網址不變**，PWA 端不需任何改動）
6. LINE Developers → Messaging API → Webhook URL 填 exec 網址、啟用 Webhook、
   **關閉「自動回覆訊息」與「歡迎訊息」**（否則官方罐頭訊息會蓋掉路由的回覆）

## 訊息格式

```
whoami                      → 回覆你自己的 LINE userId（用來填白名單）

任務/內容[/優先度]
任務/買牛奶                 → 🟡 M（預設）
任務/報表開發/H             → 🔴 H
任務/整理桌面/l             → 🟢 L（大小寫皆可）
任務/寫 A/B 測試報告        → 內容含斜線不會被切壞

記帳/金額/分類[/備註]
記帳/120/餐飲               → 支出 120
記帳/120/餐飲/星巴克        → 加備註
記帳/80/餐飲/買 A/B 兩份    → 備註含斜線不會被切壞

收入/金額/分類[/備註]
收入/50000/其他/九月薪水    → 同格式，只是 type 記成 income
```

**任務**的解析規則：只有最後一段剛好是 H / M / L 才視為優先度，其餘一律算內容。
所以 `任務/交報告/M/H` 的內容是「交報告/M」、優先度 H。

**記帳／收入**不套這條規則——記帳沒有優先度，`記帳/60/交通/H` 的備註就是字面的「H」。
第三段之後的內容全部算備註（含斜線）。

分類必須是這 7 類其中之一，與 `index.html` 的 `EXPENSE_CATEGORIES` 一致：

```
餐飲、交通、日常用品、家庭、醫療、娛樂、其他
```

打錯字時**一律打回並附上可用清單，不會自動歸進「其他」**（ADR-006 §A）。
被靜靜歸錯類比當場被退回難發現得多，而且月結時對不出來。

## logs 分頁

任務／記帳／收入／查詢四種前綴，**每次交易無論成功失敗都寫一列**。
認不得的前綴（打錯字、閒聊、貼到的網址）刻意不寫——logs 是拿來回頭查
「我那筆到底記到哪去了」的，灌進雜訊等於自廢武功。

| 欄位 | 說明 |
|---|---|
| `id` | `Date.now()` |
| `ts` | 建立時間（Date 物件，供時間篩選） |
| `source` | `任務`／`記帳`／`收入`／`查詢` |
| `status` | `成功`／`失敗` |
| `input` | 使用者原始 LINE 訊息文字 |
| `result` | 簡短結果摘要（成功：寫入內容一句話；失敗：失敗原因一句話） |
| `detail` | 詳細資訊，選填（如完整錯誤堆疊、API 狀態碼） |
| `target_row` | 成功寫入時對應 `tasks`／`expenses` 的實際列號；失敗或查詢類留空 |
| `user_id` | LINE userId |

寫 log 整支包在 try/catch 裡，**失敗只記 console、絕不拋出**。
log 是事後回頭查的東西，不是交易本身：`logs` 分頁沒建、表頭被改壞、寫入超時，
任何一種都不該讓一筆已經成功的記帳變成失敗，也不該害使用者收不到回覆。

代價是「log 沒出現」在外面看起來什麼事都沒發生——這正是 `diagnoseLogSheet`
存在的理由（見下方除錯）。

> **已知假設邊界**：`target_row` 取 `sheet.getLastRow()`，多筆並發寫同一張表時
> 理論上有競態風險。以目前單人使用、LINE webhook 序列處理的情況不會發生，暫不加鎖。

列數上限本輪不處理（未來票：超過 500 列自動修剪）。

## 之後要加新分頁

只在 `ROUTE_TABLE` 加一筆，其他邏輯不用動。每筆的欄位：

```javascript
'心情': {
  sheetName: 'moods',
  usage: '心情/1到5[/備註]',
  parse: parseMood_,      // 回 { 欄位... }，不合法時回 { error: '給使用者看的訊息' }
  build: buildMoodRow_,   // 回 { 欄位名: 值 }
  format: formatMoodSuccess_,  // 成功時回給 LINE 的訊息
  summary: summarizeMood_      // 成功時寫進 logs 的 result 摘要（一句話）
}
```

寫入是依 Sheet **實際表頭列**對位，欄序沒有寫死，之後調欄位順序不必回頭改程式。
log 由 `routeLineMessage_` 統一寫，新分頁不必自己處理。

## 白名單

`ALLOWED_USER_IDS` 空陣列 = 不限制。要鎖定只有自己能寫入：

1. 在 LINE 傳 `whoami`，bot 會回你的 userId
2. 填進 `var ALLOWED_USER_IDS = ['U你的ID'];`
3. 重新部署

`whoami` 刻意排在白名單檢查之前——它是取得 ID 的來源，也是填錯時把自己
鎖在門外的救援途徑。它只回傳發話者自己的 ID，問不到別人的。

> ⚠️ 不要填 `/v2/bot/info` 回傳的 userId，那是 bot 自己的，填了等於放行 bot、
> 擋掉自己。

## 除錯

兩支健檢函式都**不需要重新部署**：編輯器上方的函式下拉選單選它 → 按「執行」→
看「執行記錄」。編輯器執行的是「目前存檔的程式碼」，網頁應用程式服務的是
「已部署的版本」，兩者分開，所以可以在不動部署的情況下直接問。

### `diagnoseLineToken` — LINE 有寫進 Sheet 但沒回訊息時

| 記錄顯示 | 意思 |
|---|---|
| 找不到指令碼屬性 | 屬性沒設成功，或名稱拼錯（注意大小寫） |
| HTTP 401 | 權杖無效——多半誤貼了 Channel secret，或複製不完整 |
| HTTP 200 | 權杖沒問題，去檢查官方帳號的「回應設定」（回應模式要是「聊天機器人」、自動回應關閉、Webhook 開啟） |

正常運作時，每次 LINE 訊息的執行記錄都會留下 `LINE 回覆成功`；
失敗則會留下 `LINE 回覆失敗 HTTP <code>` 與 LINE 回傳的原文。

### `diagnoseLogSheet` — 記帳成功了，但 logs 分頁沒東西時

檢查 `logs` 分頁存不存在、表頭有沒有缺欄位、目前幾列。
因為寫 log 的失敗是**刻意被吞掉**的，這支就是把那個安靜的失敗叫出來講話。

> **一律用 `console.log`，不要用 `Logger.log`。**
> 編輯器手動執行時兩者都看得到，但 **webhook 觸發的執行只看得到 `console.log`**——
> `Logger.log` 的輸出不會出現在「執行項目」裡，等於白寫。

## 已知限制

- **無法驗證 LINE 官方簽章**：Apps Script 的 `doPost` 讀不到 HTTP Header。
  exec 網址一旦外流，任何人都能往 Sheet 寫入。
  防線是 `ALLOWED_USER_IDS` 白名單——第一次傳訊息後，到 Apps Script
  「執行項目」找 `LINE userId: Uxxxx`，填進陣列即可鎖定。
- **`logs` 是單向寫入，PWA 不可回推**：前端存檔是整包 `replaceAll`。
  若 LOG 頁面把 logs 讀進 `state` 又跟著推回雲端，Apps Script 寫的記錄會被整包洗掉。
  logs 一律**唯讀、即時抓、不進 `state`、不進 `pushAllToCloud`**。
