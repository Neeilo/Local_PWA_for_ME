# 檢查清單：新增排程工作

> 全專案**只有一個時間觸發器** `runScheduler`（每 5 分鐘），由 `apps-script/scheduler.gs` 依登記表**依序**派工，排程之間不可能重疊。**不要自己 `ScriptApp.newTrigger`**：整份原始碼只有 `installScheduler_()` 建觸發器（測試守門）。

## 登記

- [ ] 在 `scheduler.gs` 的 `schedulerJobs_()` 加一項：`{ name, module, label, when, rule, run, done? }`。**順序就是執行順序**；效能紀錄落地 `perfFlush` 必須維持最後一個。
  - `name`：英文識別名，會存進指令碼屬性 `sched_state`
  - `module`：掛在哪個模組（`modules.gs` 的模組 id）；總開關關掉就不跑。系統工作不填
  - `label`／`when`：給人看的名稱與時段（「初始化」的回覆會列出來）
  - `rule.kind`：`always`（每輪）｜`market`（台股盤中）｜`daily`＋`hour`｜`daily_hours`＋`hours`｜`hourly`｜`every`＋`minutes`｜`trading_hours`＋`from`／`to`
  - `done(result)`（選填）：回 true 代表今天做完了，今天不再跑
- [ ] 工作函式簽名 `run(now, ctx)`；會一次做很多件事的工作要看 `ctx.budgetLeft()`，不夠就留給下一輪（整輪預算 4 分鐘，GAS 單次上限 6 分鐘）。

## 寫法

- [ ] 可重複執行、可被中途砍掉：每做完一件就寫回，下一輪不重做已完成的。
- [ ] 丟例外不影響後面的工作（總管會接住並寫 logs），但工作自己的錯誤要寫成看得懂的 logs。失敗也會記成「跑過了」，每日工作壞掉不會每 5 分鐘重試。
- [ ] 會重試的工作要有上限（比照 `clips.gs` 的自動文字辨識：失敗計次，滿 3 次停止）。
- [ ] 改寫使用者也可能同時在改的列：拿鎖、鎖內重讀再決定（比照 `clipsPatch_` 傳函式）。
- [ ] 外部呼叫一律 `callApi_`；結尾用 `recordSchedulePerf_(action, rows, ms)` 記效能。
- [ ] 需要新的指令碼屬性存狀態：鍵名寫成常數，值不寫進 repo。

## 測試與文件

- [ ] 更新 `tests/adr-019-scheduler.test.mjs` 的登記表快照（工作名稱清單），並說明為什麼加。
- [ ] 若掛模組，更新 `tests/adr-021-modules.test.mjs` 的模組對應快照。
- [ ] 為工作本身寫測試：挑選條件、預算不足時不開始、失敗與重試上限、併發時不覆蓋使用者的修改、模組關掉不跑。
- [ ] `docs/MODULES.md`「排程總管」的工作清單與所屬模組更新；新的指令碼屬性寫進 `docs/CONFIG.md`（只寫名稱與用途）。
