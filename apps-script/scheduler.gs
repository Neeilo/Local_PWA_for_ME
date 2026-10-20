/* ========================================================================== */
/* 排程總管（ADR-019 D-1／D-2）                                                */
/* ========================================================================== */

/*
 * 為什麼只留一個觸發器：「初始化」原本裝 7 種時間觸發器，10/15 12:00 股票規則（170 秒）、
 * 輪詢（351 秒）、perfFlush（150 秒）撞在一起。GAS「每 N 分鐘」觸發器的起跑時間無法指定，
 * 錯開做不到——所以不錯開，改成只有一個每 5 分鐘的 runScheduler，依登記表**依序**派工，
 * 讓排程之間「不可能重疊」。
 *
 *  - 該不該跑：schedulerDue_ 是純函式（現在時間＋上次執行 → 是否到期），上次執行存在指令碼屬性
 *  - 上一輪還沒跑完：拿不到鎖就直接結束，不堆疊。用 user lock 而不是 script lock——各工作內部
 *    （flushPerfQueue、flushUnauthPerf…）自己會拿 script lock，總管包住整輪不能卡住它們。
 *    觸發器與 Web App 都以部署者身份執行，整個專案只有這裡用 user lock，等於總管專用的鎖
 *  - 時間預算：GAS 單次上限 6 分鐘，整輪用超過 4 分鐘就不再開始新工作，沒跑的下一輪優先
 *  - 一個工作丟例外不影響後面的：各自 try、錯誤寫 logs；超過 30 秒寫 logs；每天第一輪寫一筆心跳
 *  - 行為不變：各工作的寫法、範圍、只推一次、推播失敗不翻頁全部保留，只是「誰叫它」變了
 *
 * ⚠️ 總管是單點：掛了全部停。靠每日心跳＋慢執行 log 發現（ADR-019 後果）。
 * ⚠️ 每日類工作最多晚 5 分鐘（9 點後第一輪）。
 */
var SCHEDULER_FUNCTION = 'runScheduler';
var SCHEDULER_MINUTES = 5;
var SCHEDULER_BUDGET_MS = 240000;          // 4 分鐘：留 2 分鐘給最後一個工作跑完（GAS 上限 6 分鐘）
var SCHEDULER_SLOW_MS = 30000;
var SCHEDULER_SLACK_MS = 60000;            // 觸發器會提早或延後一點；「每 10 分鐘」差 1 分鐘內也算到了
var SCHEDULER_STATE_KEY = 'sched_state';
var SCHEDULER_LOG_SOURCE = '排程';
/**
 * 總管上線前各自裝觸發器的函式。「初始化」看到就刪。
 * 寫成函式不寫成頂層陣列：GAS 依檔案順序執行頂層宣告，這支可能比 sheet-guide.gs 先載入，那時常數還是 undefined
 */
function schedulerOldHandlers_() {
  return [DUE_CHECK_FUNCTION, GUIDE_REFRESH_FUNCTION, UNAUTH_FLUSH_FUNCTION, PERF_QUEUE_FUNCTION,
    STOCK_RULES_FUNCTION, STOCK_DAILY_FUNCTION, GMAIL_CONTROLLER_FUNCTION];
}

/**
 * 工作登記表，**順序就是執行順序**：股票規則（盤中、最在意即時）→ 到期提醒 → Gmail → 其他 → 效能落地最後
 * （它要把前面每個工作排隊的紀錄一起寫進去）。之後的 RD 佇列也掛這裡。
 * done：工作回報「今天做完了」就記 done_day，今天不再跑（盤後收盤價拿到當天的就停）。
 * module：掛在哪個模組底下（ADR-021）。總開關關掉，這個工作就不跑
 */
function schedulerJobs_() {
  return [
    { name: 'stockRules', module: 'stocks', label: '股票提醒規則', when: '盤中每輪', rule: { kind: 'market' },
      run: function (now) { return checkStockRules(now); } },
    { name: 'dueCheck', module: 'tasks', label: '到期提醒', when: '每天 ' + DUE_CHECK_HOUR + ' 點後第一輪', rule: { kind: 'daily', hour: DUE_CHECK_HOUR },
      run: function () { return checkDueReminders(); } },
    { name: 'gmail', module: 'mail', label: 'Gmail 控制員', when: '每天 ' + GMAIL_CONTROLLER_HOUR + ' 點後第一輪', rule: { kind: 'daily', hour: GMAIL_CONTROLLER_HOUR },
      run: function (now) { return runGmailController_(now); } },
    { name: 'guide', label: '_guide 導覽', when: '每天 ' + GUIDE_REFRESH_HOUR + ' 點後第一輪', rule: { kind: 'daily', hour: GUIDE_REFRESH_HOUR },
      run: function () { return refreshGuide(); } },
    { name: 'unauthFlush', label: '未驗證彙總', when: '每小時', rule: { kind: 'hourly' },
      run: function (now) { return flushUnauthPerf(now.getTime()); } },
    { name: 'stockDaily', module: 'stocks', label: '盤後收盤價', when: '交易日 ' + STOCK_DAILY_HOUR + '～' + STOCK_DAILY_LAST_HOUR + ' 點每小時，拿到當天收盤就停',
      rule: { kind: 'trading_hours', from: STOCK_DAILY_HOUR, to: STOCK_DAILY_LAST_HOUR },
      run: function (now) { return fetchStockDaily(now); },
      done: function (r) { return !!r && (r.reason === 'done' || (Array.isArray(r.pending) && !r.pending.length && !(r.errors || []).length)); } },
    // ADR-020 C-1：每輪最多 5 篇；預算不夠一篇就不開始（ctx.budgetLeft）
    { name: 'clips', module: 'library', label: '收藏搜集', when: '每輪，最多 ' + CLIPS_PER_ROUND + ' 篇', rule: { kind: 'always' },
      run: function (now, ctx) { return runClipsJob_(now, ctx); } },
    // RD-HF1 HF-C：Apify 本月用量＋近 3 天收藏成功率，給管理員頁看（ADR-020 的備案條件）
    { name: 'apifyUsage', module: 'library', label: 'Apify 用量', when: '每天 ' + CLIPS_USAGE_HOUR + ' 點後第一輪', rule: { kind: 'daily', hour: CLIPS_USAGE_HOUR },
      run: function (now) { return runApifyUsageJob_(now); } },
    { name: 'weather', label: '天氣', when: '每小時', rule: { kind: 'hourly' },
      run: function (now) { return runWeatherJob_(now); } },
    { name: 'perfFlush', label: '效能紀錄落地', when: '每 ' + PERF_QUEUE_MINUTES + ' 分鐘', rule: { kind: 'every', minutes: PERF_QUEUE_MINUTES },
      run: function () { return flushPerfQueue(); } }
  ];
}

/** 量耗時用的時鐘。獨立成函式，測試才能模擬「這個工作跑了 3 分鐘」 */
function schedulerClock_() {
  return Date.now();
}

/**
 * 這個工作現在該不該跑。純函式：只看規則、現在時間、上次執行（st.last）與今天是否已完成（st.done_day）。
 * 時間一律換成台北（taipeiParts_，固定 UTC+8，不靠腳本時區）。
 */
function schedulerDue_(rule, nowMs, st) {
  st = st || {};
  var now = new Date(nowMs);
  var p = taipeiParts_(now);
  var hour = Math.floor(p.minutes / 60);
  var today = taipeiDateKey_(now);
  var last = typeof st.last === 'number' && isFinite(st.last) ? st.last : null;
  var newHour = last === null || Math.floor(last / HOUR_MS) !== Math.floor(nowMs / HOUR_MS);   // UTC+8 整點對齊，UTC 的小時就是台北的小時
  switch (rule && rule.kind) {
    case 'always':
      return true;
    case 'market':
      return isTwTradingTime_(now);
    case 'daily':
      return hour >= rule.hour && (last === null || taipeiDateKey_(new Date(last)) !== today);
    case 'hourly':
      return newHour;
    case 'every':
      return last === null || nowMs - last >= rule.minutes * 60000 - SCHEDULER_SLACK_MS;
    case 'trading_hours':
      if (p.day < 1 || p.day > 5 || hour < rule.from || hour > rule.to) return false;
      return st.done_day !== today && newHour;
  }
  return false;
}

function schedulerState_() {
  var st = null;
  try { st = JSON.parse(PropertiesService.getScriptProperties().getProperty(SCHEDULER_STATE_KEY) || 'null'); } catch (err) { st = null; }
  if (!st || typeof st !== 'object') st = {};
  st.jobs = st.jobs && typeof st.jobs === 'object' ? st.jobs : {};
  st.skipped = Array.isArray(st.skipped) ? st.skipped : [];
  return st;
}

function schedulerSave_(st) {
  try {
    PropertiesService.getScriptProperties().setProperty(SCHEDULER_STATE_KEY, JSON.stringify(st));
  } catch (err) {
    console.log('排程總管存不了狀態（下一輪可能重跑剛跑過的工作）：' + err);
  }
}

function schedulerLog_(status, input, result, detail) {
  try { logTransaction_(SCHEDULER_LOG_SOURCE, status, input, result, detail || '', '', ''); }
  catch (err) { console.log('排程總管寫 logs 失敗：' + status + '｜' + input + '｜' + result + '｜' + err); }
}

/** 昨天（或上一個有紀錄的日子）的總結：幾輪、哪些工作各跑幾次、最慢的是誰 */
function schedulerHeartbeat_(stats) {
  if (!stats || !stats.day) { schedulerLog_('心跳', '排程總管', '開始記錄（之前沒有紀錄）'); return; }
  var runs = Object.keys(stats.runs || {}).map(function (k) { return k + '×' + stats.runs[k]; }).join('、') || '沒有工作到期';
  var slowest = stats.slowest ? '最慢 ' + stats.slowest.name + ' ' + Math.round(stats.slowest.ms / 1000) + ' 秒' : '';
  schedulerLog_('心跳', '排程總管', stats.day + '：' + stats.rounds + ' 輪', runs + (slowest ? '｜' + slowest : ''));
}

/**
 * 觸發器入口（每 5 分鐘）。觸發器傳的是事件物件，只有測試會傳數字（毫秒）。
 * 回傳 { ran, skipped, failed }；拿不到鎖回 { skipped: 'busy' }。
 */
function runScheduler(arg) {
  var nowMs = typeof arg === 'number' ? arg : Date.now();
  var lock = LockService.getUserLock();
  if (!lock.tryLock(0)) return { skipped: 'busy' };
  try {
    return schedulerRound_(nowMs);
  } finally {
    lock.releaseLock();
  }
}

function schedulerRound_(nowMs) {
  var started = schedulerClock_();
  var st = schedulerState_();
  var now = new Date(nowMs);
  var today = taipeiDateKey_(now);

  if (!st.stats || st.stats.day !== today) {
    schedulerHeartbeat_(st.stats);
    st.stats = { day: today, rounds: 0, runs: {}, slowest: null };
  }
  st.stats.rounds++;

  // 上一輪因預算沒跑的先跑；其餘照登記表順序
  var jobs = schedulerJobs_();
  var first = jobs.filter(function (j) { return st.skipped.indexOf(j.name) !== -1; });
  var rest = jobs.filter(function (j) { return st.skipped.indexOf(j.name) === -1; });
  var ran = [], skipped = [], failed = [];

  first.concat(rest).forEach(function (job) {
    var js = st.jobs[job.name] || {};
    if (job.module && !moduleOn_(job.module)) return;       // 模組總開關關掉（ADR-021）：它的工作不跑
    if (!schedulerDue_(job.rule, nowMs, js)) return;
    if (schedulerClock_() - started >= SCHEDULER_BUDGET_MS) { skipped.push(job.name); return; }

    var t0 = schedulerClock_();
    var result;
    // 這一輪還剩多少時間：會一次做好幾件事的工作（收藏）自己看，不夠就留給下一輪
    var ctx = { budgetLeft: function () { return SCHEDULER_BUDGET_MS - (schedulerClock_() - started); } };
    try {
      result = job.run(now, ctx);
    } catch (err) {
      failed.push(job.name);
      schedulerLog_('失敗', job.name, (job.label || job.name) + ' 丟例外，後面的工作照跑', String(err && err.stack || err));
    }
    var ms = schedulerClock_() - t0;
    // 失敗也記成「跑過了」：每日工作壞掉時不要每 5 分鐘重試一次、每次都寫一列 logs
    js.last = nowMs;
    if (job.done && job.done(result)) js.done_day = today;
    st.jobs[job.name] = js;
    ran.push(job.name);
    st.stats.runs[job.name] = (st.stats.runs[job.name] || 0) + 1;
    if (!st.stats.slowest || ms > st.stats.slowest.ms) st.stats.slowest = { name: job.name, ms: ms };
    if (ms > SCHEDULER_SLOW_MS) schedulerLog_('慢', job.name, (job.label || job.name) + ' 跑了 ' + Math.round(ms / 1000) + ' 秒');
    schedulerSave_(st);          // 每做完一個就存：這一輪中途被砍，已經跑過的不會重跑
  });

  st.skipped = skipped;
  schedulerSave_(st);
  return { ran: ran, skipped: skipped, failed: failed };
}

/** 給「初始化」的回覆：登記了哪些工作、各自什麼時候跑 */
function schedulerJobList_() {
  return schedulerJobs_().map(function (j) { return j.label + '（' + j.when + '）'; });
}

/**
 * 「初始化」用：刪掉所有舊的時間觸發器（含上一次裝的總管），只裝一個每 5 分鐘的 runScheduler。
 * 可重複執行，跑幾次都只有一個。**整份原始碼只有這裡建觸發器**（測試守門）。
 */
function installScheduler_() {
  var removed = 0, oldRemoved = 0;
  var old = schedulerOldHandlers_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === SCHEDULER_FUNCTION || old.indexOf(fn) !== -1) { ScriptApp.deleteTrigger(t); removed++; }
    if (old.indexOf(fn) !== -1) oldRemoved++;
  });
  ScriptApp.newTrigger(SCHEDULER_FUNCTION).timeBased().everyMinutes(SCHEDULER_MINUTES).create();
  // old：其中幾個是舊的各自觸發器（不算總管自己）——「初始化」的回覆用來判斷這次有沒有變
  return { removed: removed, old: oldRemoved, created: SCHEDULER_FUNCTION };
}
