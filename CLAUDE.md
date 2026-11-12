# CLAUDE.md — Claude Code 入口

> **共通規則在 [AGENTS.md](AGENTS.md)，先讀那份。** 專案速覽、12 條工作原則、NeilOS 2.0 不可破壞的契約、工作流程、文件導覽與公開資訊分類規則都在那裡；本檔只留 Claude Code 讀檔時需要直接看到的提醒，不另立一套標準。

## 原則編號

**原則編號沿用 `AGENTS.md`。** 程式註解、測試與交棒紀錄裡的「CLAUDE.md 原則 5」「Rule 9」「Rule 7」，指的就是 `AGENTS.md` 的同號原則；12 條原則只搬了位置，編號與內容都沒變。

## 常駐提醒（完整內容見 AGENTS.md）

- **新增任何雲端動作必須帶 trigger**（cold／foreground／poll／manual／write／zone 等），保留效能可觀測性；`tests/adr-014-perf-push.test.mjs` 會檢查 `index.html`，只有 `pairClaim`／`renewStart` 例外。（測試也檢查本檔保留這句話。）
- 雲端是唯一權威來源；PR 檢查（`pr-check.yml`）不部署，合併 `main` 才由 `deploy.yml` 部署。
- 這個 repo 是公開的：寫進 repo 的東西依 `AGENTS.md` 的公開資訊分類規則處理。
- 提交前執行 `npm test`、`npm run scan`。

> 保持此檔短而有效。共通規則的修改請改 `AGENTS.md`，並保留「為什麼要這樣做」。
