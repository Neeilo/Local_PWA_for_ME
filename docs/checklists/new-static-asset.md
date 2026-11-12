# 檢查清單：前端新增靜態資源

> 適用：新增圖示、圖片、字型、另一個 JS／CSS 檔等會被 PWA 載入的檔案。GitHub Pages **只發布白名單裡的檔案**，忘了登記，線上就少一個檔。

- [ ] `scripts/site-files.mjs` 的 `SITE_FILES` 加上檔名。白名單之外的檔案（`docs/`、`AGENTS.md`、各 README、測試）都不會被發布。
- [ ] 要離線可用或在安裝時預先快取 → `sw.js` 的 `ASSETS` 加上 `./檔名`。
- [ ] **改了任何前端資產（含 `index.html`）都要把 `sw.js` 的 `CACHE` 版號往前加一**（例：`neil-os-v66` → `neil-os-v67`），否則已安裝的手機會繼續用舊快取。版號只往前加，回退時也不要退回舊號。目前沒有測試會抓「忘了加版號」。
- [ ] 不要為了改註解而動 `sw.js`：改它任何一個字元都會讓所有裝置更新 Service Worker。
- [ ] 圖示類：`manifest.json` 的 `icons` 是否要一起改。
- [ ] 跑 `npm test`：`tests/build-info.test.mjs` 會交叉比對 `sw.js`、`manifest.json`、`index.html` 實際引用的檔案與 `SITE_FILES`，漏登記就紅燈。
- [ ] 跑 `node scripts/site-files.mjs <暫存目錄>`，確認輸出的檔案清單是你預期的。
- [ ] 檔案裡不能有任何私人資料或真實識別碼（發布出去就是公開的）。
