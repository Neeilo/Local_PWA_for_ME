# 檢查清單：新增一個 PWA 雲端動作

> 適用：PWA 要呼叫一個新的 `action`（例如 `fooSet`）。規則來源見 [AGENTS.md](../../AGENTS.md)；模組位置見 [MODULES.md](../MODULES.md)。

## 先想清楚

- [ ] 能不能用既有的一般 `upsert`？一般讀寫的分頁（`tasks`、`expenses`、`notes`…）走 `queueUpsert` → `upsert` 就好，不必開新動作。只有「一般 upsert 守不住規則」時才開專用動作（例：分期要同時改計畫與各期 → `planCreate`；收藏只限擁有者 → `clipNote`）。
- [ ] 這個動作要誰能用？從下面挑一個，寫進程式也寫進 API 文件：不需驗證（只有 `pairClaim`／`session`／`renewStart` 這三個，**不要再加**）｜已驗證成員｜擁有者｜管理者｜管理者＋功能權限。
- [ ] 它屬於哪個模組？模組總開關關掉時要拒絕。

## 後端（`apps-script/`）

- [ ] 在 `Code.gs` 的 `routePwaSync_` 加一行 `if (body.action === 'fooSet') return jsonOut(fooSet_(caller, …));`，**放在 `pwaCaller_` 驗證之後**、`NO_PWA_WRITE` 檢查之前（和其他專用動作同一區）。身份一律用 `caller.line_id`，不信任 body 裡的 `line_id`。
- [ ] 處理函式第一件事是守門，依權限選既有的函式，不要自己另寫一套：
  - 管理者：`adminForbidden_(caller, 'fooSet')`（會寫 logs）
  - 功能權限：`canUse_(caller.user, 'feat_xxx')`／分頁權限：`canUseSheet_(caller.user, sheet)`（兩者都先問模組總開關）
  - 模組總開關（沒有 feat 對應的模組）：`moduleOn_('xxx')`，拒絕時回 `moduleOffDenied_(…)`
  - 擁有者：比照 `clipOwnRow_`（比對列上的 `line_id` 與 `caller.line_id`）
- [ ] 回傳格式照慣例：成功 `{ success: true, … }`；失敗 `{ error: '代碼' }`。重送幾次結果都一樣的拒絕加 `permanent: true`，前端會把它移出待送佇列；暫時性失敗（拿不到鎖）回 `{ error: 'busy' }`，前端會重送。
- [ ] 會改狀態或對外送出（寫表、推播、寄信）就寫 logs（ADR-026 D-8）：用 `pwaActionLog_(source, caller, input, out, okText)` 或 `logTransaction_`。**只寫表名、id、動作與短摘要，不複製整筆內容**；郵件內文與金額不進 logs。
- [ ] 寫分頁時拿 `LockService.getScriptLock()`（比照 `selfNoteSet_`、`clipsPatch_`），鎖內重讀再改，避免併發寫壞。
- [ ] 需要外部 HTTP 呼叫：一律 `callApi_(apiId, url, options, meta)`，`apiId` 必須已登記在 `api-cost.gs` 的 `apiCatalog_()`；**不可直接用 `UrlFetchApp`**（`scripts/check-api-exit.mjs` 在 PR 檢查會擋）。
- [ ] 要分段計時的讀取類動作用 `perfJsonOut_(perf, …)` 與 `perfStage_`（比照 `search`、`readMany`）；一般動作用 `jsonOut`。
- [ ] 寫到新的分頁？照 [new-sheet.md](new-sheet.md) 處理；寫到既有分頁？更新 `sheet-guide.gs` 的 `guideRegistry_()` 該分頁的 `writers` 說明。

## 前端（`index.html`）

- [ ] 一律經 `cloudPost({ action:'fooSet', …, trigger:'write' })` 呼叫，**必須帶 `trigger`**（`cold`／`foreground`／`poll`／`manual`／`write`／`zone` 等，見 `Code.gs` 的 `PERF_TRIGGERS`）。`tests/adr-014-perf-push.test.mjs` 會掃每一個 `cloudPost(` 呼叫點，沒帶就紅燈。
- [ ] 失敗要讓人看得懂：連線錯誤顯示連線錯誤，不要假裝存好了；`permanent` 的拒絕要講原因。
- [ ] 不在冷開機路徑上呼叫搜尋、AI 或重的讀取。

## 測試（`tests/`）

- [ ] 後端：用 `fake-apps-script.mjs` 的 `loadCodeGs` 經 `handlePwaSync_` 打真的路由，至少測：成功、權限拒絕（不是管理者／沒有 feat／不是擁有者）、模組關掉、logs 有寫、拒絕時資料沒被改。
- [ ] 前端：用 `fake-browser.mjs` 的 `loadFrontend` 測呼叫參數（含 `trigger`）與失敗時的畫面。
- [ ] 跑 `npm test`、`npm run scan`、`node scripts/check-api-exit.mjs apps-script`。

## 文件

- [ ] `docs/API.md` 加一列（名稱、檔案與函式、參數、回應、權限、是否寫入、logs、效能）。
- [ ] `docs/MODULES.md` 該模組的「相關 API action」加上它。
