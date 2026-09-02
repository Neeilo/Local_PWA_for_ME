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
4. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署
   （**網址不變**，PWA 端不需任何改動）
5. LINE Developers → Messaging API → Webhook URL 填 exec 網址、啟用 Webhook、
   **關閉「自動回覆訊息」與「歡迎訊息」**（否則官方罐頭訊息會蓋掉路由的回覆）

## 訊息格式

```
前綴/內容[/優先度]

任務/買牛奶           → 🟡 M（預設）
任務/報表開發/H       → 🔴 H
任務/整理桌面/l       → 🟢 L（大小寫皆可）
任務/寫 A/B 測試報告  → 內容含斜線不會被切壞
```

解析規則：**只有最後一段剛好是 H / M / L 才視為優先度**，其餘一律算內容。
所以 `任務/交報告/M/H` 的內容是「交報告/M」、優先度 H。

## 之後要加新分頁

只在 `ROUTE_TABLE` 加一筆 + 寫一個 `buildXxxRow_`，其他邏輯不用動：

```javascript
'記帳': {
  sheetName: 'expenses',
  usage: '記帳/金額/分類',
  build: buildExpenseRow_
}
```

寫入是依 Sheet **實際表頭列**對位，欄序沒有寫死，之後調欄位順序不必回頭改程式。

## 除錯

LINE 有寫進 Sheet 但沒回訊息時，先跑權杖健檢——**不需要重新部署**：

編輯器上方的函式下拉選單選 `diagnoseLineToken` → 按「執行」→ 看「執行記錄」。
編輯器執行的是「目前存檔的程式碼」，網頁應用程式服務的是「已部署的版本」，
兩者分開，所以這支可以在不動部署的情況下直接問 LINE 權杖是否有效。

| 記錄顯示 | 意思 |
|---|---|
| 找不到指令碼屬性 | 屬性沒設成功，或名稱拼錯（注意大小寫） |
| HTTP 401 | 權杖無效——多半誤貼了 Channel secret，或複製不完整 |
| HTTP 200 | 權杖沒問題，去檢查官方帳號的「回應設定」（回應模式要是「聊天機器人」、自動回應關閉、Webhook 開啟） |

正常運作時，每次 LINE 訊息的執行記錄都會留下 `LINE 回覆成功`；
失敗則會留下 `LINE 回覆失敗 HTTP <code>` 與 LINE 回傳的原文。

## 已知限制

- **無法驗證 LINE 官方簽章**：Apps Script 的 `doPost` 讀不到 HTTP Header。
  exec 網址一旦外流，任何人都能往 Sheet 寫入。
  防線是 `ALLOWED_USER_IDS` 白名單——第一次傳訊息後，到 Apps Script
  「執行項目」找 `LINE userId: Uxxxx`，填進陣列即可鎖定。
- **PWA 的 `replaceAll` 可能覆蓋 LINE 寫入的資料**：PWA 存檔是整包覆寫本機 state。
  若 LINE 新增任務時 PWA 仍開著（尚未 pull），下一次存檔會抹掉那一列。
  目前的規避方式是「用 LINE 記完後重開一次 App」。
  根治方式是前端在 `visibilitychange` 回前景時重新 pull——**尚未實作，另開票**。
