# Neil OS — 個人小系統

安裝在手機主畫面的個人小系統 PWA，資料全部存在本機（localStorage），不依賴後端。

🔗 **Live**: https://neeilo.github.io/Local_PWA_for_ME/

## 功能

1. ☑️ **任務紀錄** — 新增 / 勾選完成 / 刪除
2. 🌙 **每日複盤** — 做得好的 / 卡住的 / 明天最重要的一件事（每日一則）
3. 💚 **心情紀錄** — 五級 + 備註，頂部顯示近 14 天心情脈搏色條
4. 📎 **雜記** — 靈感與雜項

## 技術架構

| 項目 | 選型 |
|---|---|
| 前端 | 純 HTML / CSS / JS，單檔（`index.html`） |
| 本地儲存 | `localStorage`，單一 JSON state key：`personal-os-state-v1` |
| PWA | `manifest.json` + Service Worker（`sw.js`，cache-first 離線快取） |
| 部署 | GitHub Pages |

資料模型：`{ tasks: [], reviews: {date: {...}}, moods: [], notes: [] }`

## 檔案結構

```
index.html      主程式（含樣式與邏輯）
manifest.json   PWA manifest
sw.js           Service Worker（離線快取）
icon-192.png    App icon 192x192
icon-512.png    App icon 512x512
```

## 開發須知

修改任何發布檔案後，需同步更新 `sw.js` 的 CACHE 版號（例如 `neil-os-v1` → `v2`），否則舊快取會擋住新版本。

## 專案狀態

- **Phase 1** — 原型驗證：✅ 已完成（2026-07-02）
- **Phase 2** — 正式發布（manifest + Service Worker + localStorage，部署至 GitHub Pages）：✅ 已完成（2026-07-03）
- **Phase 3** — 功能增強（資料匯出備份、統計圖表等）：⏳ 追蹤中
