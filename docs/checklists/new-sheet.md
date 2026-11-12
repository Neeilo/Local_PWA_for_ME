# 檢查清單：新增一張 Sheet 分頁

> 所有分頁都在同一個試算表。新增分頁的 PR **必須同時更新 `guideRegistry_()`**（漏了不會壞，但 `_guide` 會標「⚠️ 未登記」）。規則來源見 [AGENTS.md](../../AGENTS.md)。

## 命名

- [ ] 照 `apps-script/README.md`「分頁命名規則」：資料表直接用名稱（`tasks`）；系統表加底線前綴（`_guide`）；功能模組用「功能前綴＋底線」（`gmail_log`）。既有的 `logs`、`line_users` 不改名。
- [ ] 名稱寫成 `Code.gs` 頂端的常數（例：`var FOO_SHEET = 'foo';`），程式一律引用常數。

## 登記處（都在 `apps-script/`）

- [ ] `sheet-guide.gs` 的 `guideRegistry_()`：加一筆 `{ sheet, category, purpose, writers, readers, key, adr }`。`purpose` 只寫欄位結構與用途，**不寫任何資料值**（公開 repo）。
- [ ] PWA 能不能用一般動作讀寫它？
  - 只能經專用動作寫 → 加進 `Code.gs` 的 `NO_PWA_WRITE`
  - PWA 連讀都不准（設定、個資、系統用）→ 也加進 `NO_PWA_READ`
  - 兩者都不加 → 任何通過驗證、有權限的成員都能經 `read`／`readMany`／`upsert` 讀寫，確定這是你要的
- [ ] 要受功能權限管？在 `FEATURE_BY_SHEET` 對應一個 `feat_*`；新的 `feat_*` 要加進 `LINE_USERS_FEATURES`、`FEATURE_LABEL`，前端 `FEATURE_ITEMS` 也要對齊。
- [ ] 屬於某個模組？確認 `modules.gs` 的 `MODULE_OF_FEATURE` 讓總開關擋得到它；新模組要加進 `MODULE_DEFAULTS`。
- [ ] 有 `del` 軟刪除、要納入「封存寄信」？加進 `Code.gs` 的 `ARCHIVE_TARGETS`。
- [ ] 要讓 PWA 寫入的資料表：表頭至少有 `id`（或明確的鍵欄）、`line_id`（資料歸屬）、`del`；寫入依**表頭名稱**對位，不寫死欄序。

## 建表與補欄

- [ ] 寫一個可重複執行的安裝函式（比照 `ensureSelfNotesSheet_`、`ensureWidgetConfigSheet_`）：不存在就建表寫表頭；存在就用 `ensureColumnsOnSheet_` **只往右補缺的欄**，既有欄位與資料一概不動。
- [ ] 把它接進「初始化」：`line-router.gs` 的 `initSteps_()` 加一步，回傳 `{ level, changed, text }`。部署後由管理者在 LINE 傳「初始化」執行。
- [ ] 1.0 相容：新欄只能加在最右邊；舊版前端讀到多的欄要照常運作（試營運期間 1.0 與 2.0 共存）。

## 測試與文件

- [ ] 測試：建表可重複執行、補欄不動既有欄、權限（`NO_PWA_*` 擋得住）、`guideRegistry_()` 有登記（`tests/sheet-guide.test.mjs` 的寫法可參考）。
- [ ] `docs/DATA.md` 加一節（用途、鍵欄、主要欄位、寫入者、讀取者、軟刪除旗標、是否在 `NO_PWA_*`、專用寫入路徑）。
- [ ] `docs/MODULES.md` 該模組的「主要分頁」加上它。
