/**
 * Neil OS — LINE 快速輸入路由（Apps Script 端）
 * ---------------------------------------------------------------------------
 * 這是「加掛」檔，不是完整的 Code.gs。既有的 PWA 同步邏輯完全不動。
 *
 * 【安裝步驟】
 *  1. 在既有 Code.gs 裡，把原本的  function doPost(e)  改名為  function handlePwaSync_(e)
 *     （只改函式名稱，內容一個字都不用動）
 *  2. 新增一個檔案，把本檔全部貼進去
 *  3. 專案設定 → 指令碼屬性 → 新增 LINE_CHANNEL_ACCESS_TOKEN = <LINE 的長期存取權杖>
 *  4. 重新部署（部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署）
 *     ※ 網址不會變，PWA 端不需要改任何東西
 *
 * 【訊息格式】
 *    任務/買牛奶                  → 優先度預設 M
 *    任務/報表開發/H              → 優先度 H
 *    任務/寫 A/B 測試報告         → 內容含「/」也不會被切壞（見 parseMessage_）
 *    記帳/120/餐飲                → 支出 120，分類餐飲
 *    記帳/120/餐飲/星巴克         → 加備註
 *    收入/50000/其他/九月薪水     → 同格式，只是 type 記成 income
 *
 * 【設計約束】
 *  - 純規則式字串切分，不接 AI 判讀（ADR-006：查詢型 AI 為獨立分支，不走 ROUTE_TABLE）
 *  - 與 PWA 同步共用同一部署網址、同一 SECRET，只多一個判斷分支
 *  - id 用 Date.now()，與 index.html 全站慣例一致（不可用 UUID，
 *    否則 taskFromCloud / expenseFromCloud 的 Number(r.id)||Date.now()
 *    會讓 UUID 轉成 NaN，每次啟動都重複塞一筆）
 *  - 欄位順序以 Sheet 實際表頭列為準，不寫死欄序，日後調欄位不用改這裡
 *  - 四種前綴（任務／記帳／收入／查詢）每次交易無論成敗都寫一列 logs（ADR-006 §D）
 */

var LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

/** 交易記錄分頁。表頭：id | ts | source | status | input | result | detail | target_row | user_id */
var LOG_SHEET_NAME = 'logs';

/* ========================================================================== */
/* 查詢 MVP 設定（ADR-006 §B）                                                 */
/* ========================================================================== */

/**
 * 「查」前綴刻意不進 ROUTE_TABLE。
 * 路由表處理的是「解析成固定欄位 → 寫入一列」，查詢是「讀取 → 外部 AI → 回覆」，
 * 兩者的性質不同，混在一起只會讓路由邏輯變得誰都看不懂。
 */
var QUERY_PREFIX = '查';
var QUERY_USAGE = '查/你想問的問題';
/**
 * logs 的 source 欄寫「查詢」，不是前綴「查」。
 * 任務／記帳／收入 的前綴剛好等於來源名，只有這個不是——
 * 寫成「查」的話，前端 LOG 頁那顆「查詢」篩選鈕永遠篩不到東西（ADR-006 §D 的欄位定義）。
 */
var QUERY_LOG_SOURCE = '查詢';

/** 資料窗口與逐筆上限，皆為可調參數（ADR-006 §B） */
var QUERY_WINDOW_DAYS = 30;
var QUERY_MAX_TOTAL_RECORDS = 30;

/**
 * Gemini 模型與端點。
 *
 * 模型 ID 會隨 Google 改版而變動，所以可用指令碼屬性 GEMINI_MODEL 覆寫，
 * 不必回頭改這支程式。不確定目前有哪些可用時，跑 diagnoseGemini —— 
 * 它會直接問 Google「這把 key 能用哪些模型」，比猜可靠。
 */
var GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
var GEMINI_TIMEOUT_REPLY = 'AI 暫時無法回應，請稍後再試';

/**
 * 輸出上限刻意給得寬。
 *
 * Gemini 2.5／3 系列的「thinking tokens」也計入 maxOutputTokens，而思考往往吃掉數百個 ——
 * 上限抓太緊時，模型會在還沒寫完答案就撞到天花板，使用者收到半截話。
 * 我們只要 5 行回覆，2048 綽綽有餘，多出來的額度是留給思考的，不是留給廢話的。
 */
var GEMINI_MAX_OUTPUT_TOKENS = 2048;

/**
 * 允許使用的 LINE userId 白名單。
 * 留空陣列 = 不限制（方便第一次跑通）。
 * 取得自己的 userId 最快的方式：在 LINE 傳一句 whoami，bot 會直接回你。
 * （也會寫進執行記錄，但 webhook 觸發的執行只看得到 console.log，看不到 Logger.log）
 *
 * ⚠️ Apps Script 的 doPost 讀不到 HTTP Header，驗不了 LINE 官方簽章，
 *    所以 exec 網址一旦外流，任何人都能往你的 Sheet 寫東西。白名單是唯一的防線。
 */
var ALLOWED_USER_IDS = [];

/**
 * 記帳分類固定清單，與 index.html 的 EXPENSE_CATEGORIES 一字不差。
 *
 * 不在清單內時一律打回並提示可用清單，不自動 fallback 成「其他」（ADR-006 §A）——
 * 打錯字被靜靜歸進「其他」，比當場被退回難發現得多，而且事後對不出來。
 */
var EXPENSE_CATEGORIES = ['餐飲', '交通', '日常用品', '家庭', '醫療', '娛樂', '其他'];

/**
 * 路由表。要新增分頁時只加一筆，不需動其他邏輯。
 *  sheetName   : 目標分頁名稱
 *  usage       : 前綴用錯時回覆的提示文字
 *  parse       : 把「前綴/」之後的字串拆成欄位物件；不合法時回 { error: '給使用者看的訊息' }
 *  build       : 把解析結果轉成 { 欄位名: 值 }
 *  format      : 成功時回給 LINE 的訊息
 *  summary     : 成功時寫進 logs 的 result 摘要（一句話）
 *  expenseType : 僅記帳/收入使用，決定 expenses.type 欄的值
 *
 * 記帳與收入共用 buildExpenseRow_ / parseExpense_，差別只在 expenseType。
 */
var ROUTE_TABLE = {
  '任務': {
    sheetName: 'tasks',
    usage: '任務/內容[/H或M或L]',
    parse: parseMessage_,
    build: buildTaskRow_,
    format: formatTaskSuccess_,
    summary: summarizeTask_
  },
  '記帳': {
    sheetName: 'expenses',
    usage: '記帳/金額/分類[/備註]',
    expenseType: 'expense',
    parse: parseExpense_,
    build: buildExpenseRow_,
    format: formatExpenseSuccess_,
    summary: summarizeExpense_
  },
  '收入': {
    sheetName: 'expenses',
    usage: '收入/金額/分類[/備註]',
    expenseType: 'income',
    parse: parseExpense_,
    build: buildExpenseRow_,
    format: formatExpenseSuccess_,
    summary: summarizeExpense_
  }
};

var PRIORITIES = ['H', 'M', 'L'];
var DEFAULT_PRIORITY = 'M';

/* ========================================================================== */
/* 入口                                                                        */
/* ========================================================================== */

/**
 * 統一入口：依 payload 形狀分流。
 *  - 含 events 陣列 → LINE Webhook
 *  - 其餘           → 原本的 PWA 同步（handlePwaSync_）
 */
function doPost(e) {
  var body = null;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    // 解析不了就交給原邏輯處理，維持既有錯誤回應行為
    return handlePwaSync_(e);
  }

  if (body && Object.prototype.toString.call(body.events) === '[object Array]') {
    return handleLineWebhook_(body);
  }
  return handlePwaSync_(e);
}

/**
 * LINE Webhook 處理。
 * 無論內部成敗，一律回 200 —— LINE 收到非 2xx 會重送，重送會造成重複寫入。
 */
function handleLineWebhook_(body) {
  try {
    var events = body.events || [];
    for (var i = 0; i < events.length; i++) {
      handleLineEvent_(events[i]);
    }
  } catch (err) {
    console.log('LINE webhook 例外：' + err);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleLineEvent_(event) {
  if (!event || event.type !== 'message') return;
  if (!event.message || event.message.type !== 'text') return;

  var userId = (event.source && event.source.userId) || '';
  console.log('LINE userId: ' + userId);

  var text = String(event.message.text || '').trim();

  // whoami 刻意排在白名單檢查之前：它就是用來取得要填進 ALLOWED_USER_IDS 的值，
  // 也是萬一填錯、把自己擋在門外時唯一的救援途徑。只回傳發話者自己的 ID，
  // 問不到別人的，所以放在白名單前面不會擴大攻擊面。
  if (text.toLowerCase() === 'whoami') {
    lineReply_(event.replyToken, '你的 userId：\n' + (userId || '(取不到，訊息可能來自群組)'));
    return;
  }

  if (ALLOWED_USER_IDS.length > 0 && ALLOWED_USER_IDS.indexOf(userId) === -1) {
    lineReply_(event.replyToken, '這個帳號沒有權限寫入喔。');
    return;
  }

  var reply = routeLineMessage_(text, userId);
  lineReply_(event.replyToken, reply);
}

/* ========================================================================== */
/* 路由                                                                        */
/* ========================================================================== */

/**
 * 規則式路由：查表 → 解析 → 寫入 → 寫 log → 回傳給使用者的訊息字串。
 * 找不到前綴時回覆支援清單，絕不靜默失敗。
 *
 * 認得的前綴無論成敗都會留下一列 logs；認不得的前綴（打錯字、閒聊、貼到的網址）
 * 刻意不寫——logs 是拿來回頭查「我那筆記到哪去了」的，灌進雜訊等於自廢武功。
 */
function routeLineMessage_(rawText, userId) {
  var text = String(rawText || '').trim();
  if (!text) return supportedPrefixesMessage_();

  var slash = text.indexOf('/');
  var prefix = (slash === -1 ? text : text.slice(0, slash)).trim();

  // 查詢在查表之前攔下：它不寫任何欄位，走不了下面「解析→build→appendRow」那條路
  if (prefix === QUERY_PREFIX) {
    if (slash === -1) {
      logTransaction_(QUERY_LOG_SOURCE, '失敗', text, '缺少問題內容', '', '', userId);
      return '「' + QUERY_PREFIX + '」後面要接問題喔。\n格式：' + QUERY_USAGE;
    }
    return handleQuery_(text.slice(slash + 1).trim(), text, userId);
  }

  var route = ROUTE_TABLE[prefix];

  if (!route) {
    return '沒有這個前綴喔。\n' + supportedPrefixesMessage_();
  }
  if (slash === -1) {
    var missing = '「' + prefix + '」後面要接內容喔。\n格式：' + route.usage;
    logTransaction_(prefix, '失敗', text, '缺少內容', '', '', userId);
    return missing;
  }

  var parsed = route.parse(text.slice(slash + 1), route);
  if (parsed.error) {
    logTransaction_(prefix, '失敗', text, firstLine_(parsed.error), '', '', userId);
    return parsed.error;
  }

  try {
    var record = route.build(parsed, route);
    var rowNumber = appendToSheet_(route.sheetName, record);
    logTransaction_(prefix, '成功', text, route.summary(parsed, route), '', rowNumber, userId);
    return route.format(parsed, route);
  } catch (err) {
    console.log('寫入失敗：' + err);
    logTransaction_(prefix, '失敗', text, '寫入失敗', String(err && err.stack || err), '', userId);
    return '寫入失敗了：' + err.message;
  }
}

/**
 * 把「內容[/優先度]」拆成 { content, priority }。
 *
 * 只有「最後一段剛好是 H / M / L」才視為優先度，其餘一律當成內容的一部分，
 * 所以「寫 A/B 測試報告」不會被切壞，「報表開發/H」則正確取到 H。
 * 沒指定優先度時回 null，由 build 函式套用預設值。
 */
function parseMessage_(rest, route) {
  var parts = String(rest).split('/');
  var priority = null;

  if (parts.length > 1) {
    var last = parts[parts.length - 1].trim().toUpperCase();
    if (PRIORITIES.indexOf(last) !== -1) {
      priority = last;
      parts.pop();
    }
  }

  var content = parts.join('/').trim();
  if (!content) {
    return { error: '內容是空的喔。\n格式：' + route.usage };
  }
  return { content: content, priority: priority };
}

/**
 * 把「金額/分類[/備註]」拆成 { amount, category, note }。
 *
 * 備註吃掉第三段之後的全部內容（含斜線），比照任務內容的處理精神——
 * 「記帳/120/餐飲/買 A/B 兩份」的備註是「買 A/B 兩份」，不會被切壞。
 *
 * 這裡不套用 parseMessage_ 的優先度規則：記帳沒有優先度，
 * 「記帳/120/餐飲/H」的備註就是字面上的「H」。
 */
function parseExpense_(rest, route) {
  var parts = String(rest).split('/');

  var rawAmount = String(parts[0] || '').trim();
  var amount = Number(rawAmount);
  if (!rawAmount || !isFinite(amount) || amount <= 0) {
    return {
      error: '金額要是大於 0 的數字喔' + (rawAmount ? '（你打的是「' + rawAmount + '」）' : '') +
        '。\n格式：' + route.usage
    };
  }

  var category = String(parts[1] || '').trim();
  if (!category) {
    return { error: '要指定分類喔。\n' + categoryListMessage_() + '\n格式：' + route.usage };
  }
  if (EXPENSE_CATEGORIES.indexOf(category) === -1) {
    return { error: '沒有「' + category + '」這個分類喔。\n' + categoryListMessage_() };
  }

  return {
    amount: amount,
    category: category,
    note: parts.slice(2).join('/').trim()
  };
}

/* ========================================================================== */
/* 各分頁的資料組裝                                                             */
/* ========================================================================== */

/** tasks：id | text | is_completed | created_at | priority */
function buildTaskRow_(parsed) {
  return {
    id: Date.now(),
    text: parsed.content,
    is_completed: false,
    created_at: new Date().toISOString(),
    priority: parsed.priority || DEFAULT_PRIORITY
  };
}

/** expenses：id | expense_date | type | category | amount | note | created_at */
function buildExpenseRow_(parsed, route) {
  var now = new Date();
  return {
    id: Date.now(),
    expense_date: dateKey_(now),
    type: route.expenseType,
    category: parsed.category,
    amount: parsed.amount,
    note: parsed.note || '',
    created_at: now.toISOString()
  };
}

/**
 * YYYY-MM-DD，用指令碼時區而非 UTC。
 *
 * 前端的 todayKey() 走的是裝置本地時區，這裡若用 toISOString().slice(0,10)，
 * 台灣時間半夜 0 點到 8 點記的帳會被算成前一天，月結時對不起來。
 */
function dateKey_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ========================================================================== */
/* Sheet 寫入                                                                  */
/* ========================================================================== */

/**
 * 依分頁「實際的表頭列」對位寫入一列，回傳寫入後的列號。
 * 欄序不寫死，日後在 Sheet 調整欄位順序也不必回頭改這支程式。
 */
function appendToSheet_(sheetName, record) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('找不到分頁「' + sheetName + '」');
  }

  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() === 0 || lastCol === 0) {
    throw new Error('分頁「' + sheetName + '」沒有表頭列');
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var row = headers.map(function (h) {
    var key = String(h).trim();
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : '';
  });

  sheet.appendRow(row);
  return sheet.getLastRow();
}

/* ========================================================================== */
/* 交易記錄（logs 分頁）                                                        */
/* ========================================================================== */

/**
 * 寫一列到 logs 分頁：id | ts | source | status | input | result | detail | target_row | user_id
 *
 * 整支包在 try/catch 裡，失敗只記 console 不拋出（ADR-006 §D）。
 * log 是「事後回頭查」的東西，不是交易本身——logs 分頁沒建、表頭被改壞、
 * 寫入超時，任何一種都不該讓一筆已經成功的記帳變成失敗，也不該害使用者收不到回覆。
 *
 * target_row 取 sheet.getLastRow()，理論上多筆並發寫同一張表會有競態；
 * 以目前單人使用、LINE webhook 序列處理的情況不會發生，暫不加鎖（ADR-006 已記錄此假設邊界）。
 */
function logTransaction_(source, status, input, result, detail, targetRow, userId) {
  try {
    appendToSheet_(LOG_SHEET_NAME, {
      id: Date.now(),
      ts: new Date(),
      source: source || '',
      status: status || '',
      input: input || '',
      result: result || '',
      detail: detail || '',
      target_row: (targetRow || targetRow === 0) ? targetRow : '',
      user_id: userId || ''
    });
  } catch (err) {
    console.log('寫 logs 失敗（主流程不受影響）：' + err);
  }
}

/** 取第一行——錯誤訊息常帶格式提示的第二行，logs 的 result 只要一句話。 */
function firstLine_(text) {
  return String(text || '').split('\n')[0];
}

/* ========================================================================== */
/* 查詢 MVP（ADR-006 §B）                                                      */
/* ========================================================================== */

/**
 * 「查/問題」的完整流程：組上下文 → 呼叫 Gemini → 回覆 → 寫 log。
 * 全程不寫任何資料列，所以 logs 的 target_row 一律留空。
 */
function handleQuery_(question, rawText, userId) {
  if (!question) {
    logTransaction_(QUERY_LOG_SOURCE, '失敗', rawText, '缺少問題內容', '', '', userId);
    return '要問什麼呢？\n格式：' + QUERY_USAGE;
  }

  var key = geminiKey_();
  if (!key) {
    // 這不是「AI 暫時無法回應」——是根本還沒設定，講清楚才知道要去哪裡修
    console.log('查詢略過：指令碼屬性 GEMINI_API_KEY 不存在或是空字串');
    logTransaction_(QUERY_LOG_SOURCE, '失敗', rawText, 'GEMINI_API_KEY 未設定', '', '', userId);
    return 'AI 查詢還沒設定完成（缺 GEMINI_API_KEY）。';
  }

  var context;
  try {
    context = buildQueryContext_();
  } catch (err) {
    console.log('查詢組資料失敗：' + err);
    logTransaction_(QUERY_LOG_SOURCE, '失敗', rawText, '讀取資料失敗',
      String(err && err.stack || err), '', userId);
    return '讀不到資料，請稍後再試。';
  }

  var res = callGemini_(key, buildQueryPrompt_(context, question));
  if (!res.ok) {
    // 對外統一口徑，對內留完整證據——安靜的失敗是最貴的那種
    logTransaction_(QUERY_LOG_SOURCE, '失敗', rawText, res.reason, res.detail, '', userId);
    return GEMINI_TIMEOUT_REPLY;
  }

  logTransaction_(QUERY_LOG_SOURCE, '成功', rawText,
    (res.truncated ? '已回覆（被截斷）：' : '已回覆：') + truncate_(question, 40),
    res.truncated ? 'finishReason=MAX_TOKENS，maxOutputTokens=' + GEMINI_MAX_OUTPUT_TOKENS : '',
    '', userId);
  return res.text;
}

function geminiKey_() {
  var raw = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  // 從網頁複製常會帶到換行或空白，前後修掉（比照 LINE 權杖的處理）
  return raw ? String(raw).trim() : '';
}

function geminiModel_() {
  var raw = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  var model = raw ? String(raw).trim() : '';
  return model || GEMINI_MODEL_DEFAULT;
}

/* -------------------------------------------------------------------------- */
/* 資料組裝                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 把一張分頁讀成物件陣列，欄位名取自實際表頭列。
 * 找不到分頁或只有表頭時回空陣列——查詢少一類資料仍該能回答，不該整個炸掉。
 */
function readSheet_(sheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];

  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });

  return values.slice(1).map(function (row) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
    return obj;
  });
}

/** Sheet 的日期欄可能回 Date 物件也可能回字串，兩種都要吃得下 */
function toDateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}

function windowStartKey_() {
  var d = new Date();
  d.setDate(d.getDate() - QUERY_WINDOW_DAYS);
  return dateKey_(d);
}

/**
 * 組出要送給 AI 的上下文。
 *
 * 記帳走「彙總」而非逐筆，這是刻意的：逐筆一旦被筆數上限截斷，AI 會拿到半個月的
 * 資料卻不知道自己拿的是半個月，然後自信地回答「這個月花了 X 元」——那個數字是錯的。
 * 答錯比答不出來更糟。彙總在 Apps Script 端算完再送，總額永遠精確，也只佔十來行。
 * 代價是問不了「上週四那筆 120 是什麼」這種單筆細節，這是已知且接受的取捨。
 */
function buildQueryContext_() {
  var since = windowStartKey_();
  var today = dateKey_(new Date());
  var expenseRows = readSheet_('expenses');

  return {
    since: since,
    today: today,
    monthStart: monthStartKey_(),
    // 兩組期間都給：使用者最自然的問法是「這個月」，但 ADR 的窗口是「近 30 天」。
    // 只給後者的話，AI 會拿近 30 天的合計去回答「這個月」——數字包含上個月下旬，
    // 而且跟 App 首頁的「本月支出」對不起來。多算一組的成本只有幾行。
    expenses: {
      month: sumExpensesSince_(expenseRows, monthStartKey_()),
      window: sumExpensesSince_(expenseRows, since)
    },
    tasks: collectTasks_(readSheet_('tasks'), since),
    reviews: collectReviews_(readSheet_('reviews'), since),
    moods: summarizeMoods_(readSheet_('moods'), since)
  };
}

/** 月初 YYYY-MM-01，與前端 monthKey() 的「本月」定義一致 */
function monthStartKey_() {
  return dateKey_(new Date()).slice(0, 7) + '-01';
}

/** expenses → 分類小計 + 總計 + 筆數（完整不截斷） */
function sumExpensesSince_(rows, since) {
  var acc = {
    expense: { total: 0, count: 0, byCat: {} },
    income: { total: 0, count: 0, byCat: {} }
  };
  var seen = 0;

  rows.forEach(function (r) {
    var date = toDateKey_(r.expense_date);
    if (!date || date < since) return;
    var type = String(r.type || '').trim() === 'income' ? 'income' : 'expense';
    var amount = Number(r.amount) || 0;
    var cat = String(r.category || '其他').trim() || '其他';

    acc[type].total += amount;
    acc[type].count += 1;
    acc[type].byCat[cat] = (acc[type].byCat[cat] || { sum: 0, n: 0 });
    acc[type].byCat[cat].sum += amount;
    acc[type].byCat[cat].n += 1;
    seen += 1;
  });

  acc.seen = seen;
  return acc;
}

/**
 * tasks → 逐筆。
 *
 * 未完成的任務刻意不受 30 天窗口限制：ADR 特別標了「含未完成」，而未完成是一種
 * 持續狀態，不是時點事件——三個月前沒做完的事，今天問「還有什麼沒做完」時仍然算數。
 * 窗口只套用在已完成的任務上，那些才是「最近做了什麼」的素材。
 */
function collectTasks_(rows, since) {
  var open = [], done = [];

  rows.forEach(function (r) {
    var text = String(r.text || '').trim();
    if (!text) return;
    var isDone = r.is_completed === true || String(r.is_completed).toLowerCase() === 'true';
    var priority = String(r.priority || 'M').trim().toUpperCase();
    var created = toDateKey_(r.created_at);
    var item = { text: text, priority: PRIORITIES.indexOf(priority) === -1 ? 'M' : priority, created: created };

    if (isDone) {
      if (created && created >= since) done.push(item);
    } else {
      open.push(item);
    }
  });

  // 未完成依優先度排序，額度不夠時先被砍的是低優先度的
  var rank = { H: 0, M: 1, L: 2 };
  open.sort(function (a, b) { return rank[a.priority] - rank[b.priority]; });
  done.sort(function (a, b) { return String(b.created).localeCompare(String(a.created)); });

  return { open: open, done: done };
}

function collectReviews_(rows, since) {
  return rows.filter(function (r) {
    var date = toDateKey_(r.review_date);
    return date && date >= since;
  }).sort(function (a, b) {
    return toDateKey_(b.review_date).localeCompare(toDateKey_(a.review_date));
  });
}

/** moods → 平均與筆數。逐筆送沒有意義，趨勢才有 */
function summarizeMoods_(rows, since) {
  var sum = 0, n = 0;
  rows.forEach(function (r) {
    var date = toDateKey_(r.mood_date);
    if (!date || date < since) return;
    var level = Number(r.level);
    if (!isFinite(level)) return;
    sum += level; n += 1;
  });
  return { count: n, avg: n ? Math.round((sum / n) * 10) / 10 : 0 };
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                      */
/* -------------------------------------------------------------------------- */

function buildQueryPrompt_(ctx, question) {
  var lines = [];

  lines.push('你是 Neil 個人系統的查詢助理。以下是他的資料，請用繁體中文回答最後的問題。');
  lines.push('');
  lines.push('規則：');
  lines.push('- 只根據以下資料回答。資料裡沒有的就直說沒有，絕對不要編造或推估。');
  lines.push('- 回答控制在 5 行以內，這則訊息會顯示在 LINE 上。');
  lines.push('- 金額用阿拉伯數字加千分位，不要加貨幣符號以外的修飾。');
  lines.push('- 不要重複問題本身，直接給答案。');
  lines.push('- 記帳有「本月」與「近 30 天」兩組統計，期間不同，絕對不可混用或相加：');
  lines.push('  問「這個月」「本月」「九月」→ 用【本月】那組。');
  lines.push('  問「最近」「這 30 天」「這陣子」→ 用【近 30 天】那組。');
  lines.push('  問法沒有指明期間時，用【本月】那組，並在回答中說明是本月。');
  lines.push('');
  lines.push('今天是 ' + ctx.today + '。');
  lines.push('');

  lines.push('【記帳彙總】以下兩組都是完整統計，未經截斷，可直接引用');
  lines.push('');
  lines.push('▍本月（' + ctx.monthStart + ' ~ ' + ctx.today + '）');
  lines.push(expenseBlock_(ctx.expenses.month.expense, '支出'));
  lines.push(expenseBlock_(ctx.expenses.month.income, '收入'));
  lines.push('');
  lines.push('▍近 ' + QUERY_WINDOW_DAYS + ' 天（' + ctx.since + ' ~ ' + ctx.today + '）');
  lines.push(expenseBlock_(ctx.expenses.window.expense, '支出'));
  lines.push(expenseBlock_(ctx.expenses.window.income, '收入'));
  lines.push('');

  // 逐筆的部分共用同一個上限：任務吃不完的額度才輪到複盤
  var budget = QUERY_MAX_TOTAL_RECORDS;
  var openTasks = ctx.tasks.open.slice(0, budget);
  budget -= openTasks.length;
  var doneTasks = ctx.tasks.done.slice(0, Math.max(0, Math.min(budget, 5)));
  budget -= doneTasks.length;
  var reviews = ctx.reviews.slice(0, Math.max(0, budget));

  lines.push('【未完成任務】共 ' + ctx.tasks.open.length + ' 筆' +
    (ctx.tasks.open.length > openTasks.length ? '，以下列出優先度最高的 ' + openTasks.length + ' 筆' : ''));
  lines.push(openTasks.length
    ? openTasks.map(function (t) { return '・[' + t.priority + '] ' + t.text; }).join('\n')
    : '（沒有未完成的任務）');
  lines.push('');

  if (doneTasks.length) {
    lines.push('【近 ' + QUERY_WINDOW_DAYS + ' 天內已完成的任務】');
    lines.push(doneTasks.map(function (t) { return '・' + t.created + ' ' + t.text; }).join('\n'));
    lines.push('');
  }

  lines.push('【近 ' + QUERY_WINDOW_DAYS + ' 天的複盤】共 ' + ctx.reviews.length + ' 則' +
    (ctx.reviews.length > reviews.length ? '，以下列出最近 ' + reviews.length + ' 則' : ''));
  lines.push(reviews.length
    ? reviews.map(function (r) {
        return '・' + toDateKey_(r.review_date) +
          '｜做得好：' + truncate_(String(r.good || '—'), 60) +
          '｜卡住：' + truncate_(String(r.stuck || '—'), 60) +
          '｜最重要：' + truncate_(String(r.most_important || '—'), 60);
      }).join('\n')
    : '（期間內沒有複盤記錄）');
  lines.push('');

  if (ctx.moods.count) {
    lines.push('【心情】近 ' + QUERY_WINDOW_DAYS + ' 天記錄 ' + ctx.moods.count + ' 次，平均 ' + ctx.moods.avg + ' 分（1 最低、5 最高）');
    lines.push('');
  }

  lines.push('問題：' + question);
  return lines.join('\n');
}

function expenseBlock_(side, label) {
  if (!side.count) return label + '合計 0 元（期間內沒有記錄）';

  var cats = Object.keys(side.byCat).sort(function (a, b) {
    return side.byCat[b].sum - side.byCat[a].sum;
  });
  var lines = [label + '合計 ' + formatAmount_(Math.round(side.total)) + ' 元（' + side.count + ' 筆）'];
  cats.forEach(function (c) {
    lines.push('・' + c + ' ' + formatAmount_(Math.round(side.byCat[c].sum)) + ' 元（' + side.byCat[c].n + ' 筆）');
  });
  return lines.join('\n');
}

function truncate_(text, max) {
  var s = String(text || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* -------------------------------------------------------------------------- */
/* Gemini 呼叫                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 回 { ok:true, text } 或 { ok:false, reason, detail }。
 *
 * 每一種失敗都留 console.log，不靜默吞掉（ADR-006 §B）——
 * 「額度用完」「模型名稱過期」「key 是別的專案的」從外面看全都是同一種安靜的失敗。
 */
function callGemini_(key, prompt) {
  var model = geminiModel_();
  var url = GEMINI_API_BASE + '/' + encodeURIComponent(model) + ':generateContent';

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS }
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.log('Gemini 連線失敗（model=' + model + '）：' + err);
    return { ok: false, reason: '連線失敗', detail: String(err && err.stack || err) };
  }

  var code = res.getResponseCode();
  var body = res.getContentText();

  if (code !== 200) {
    console.log('Gemini HTTP ' + code + '（model=' + model + '）：' + body);
    // 404 幾乎都是模型名稱過期，指路比只回一句「失敗」有用
    var hint = code === 404 ? '（模型「' + model + '」可能不存在，跑 diagnoseGemini 看可用清單）' : '';
    return { ok: false, reason: 'HTTP ' + code + hint, detail: truncate_(body, 800) };
  }

  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    console.log('Gemini 回應不是 JSON：' + truncate_(body, 500));
    return { ok: false, reason: '回應格式錯誤', detail: truncate_(body, 800) };
  }

  var got = extractGeminiText_(parsed);
  var hitCap = got.finishReason === 'MAX_TOKENS';

  if (!got.text) {
    // 三種情況會落在這裡：被安全機制擋掉、思考吃光了額度、回應結構不如預期。
    // 分辨得出來才修得掉，所以 finishReason 要一起記。
    console.log('Gemini 回應沒有可用文字（finishReason=' + (got.finishReason || '未提供') +
      (hitCap ? '，thinking tokens 可能吃光了 maxOutputTokens' : '') + '）：' + truncate_(body, 800));
    return {
      ok: false,
      reason: hitCap ? '回應被 token 上限截斷且無內容' : '回應沒有內容',
      detail: truncate_(body, 800)
    };
  }

  if (hitCap) {
    // 有話但沒說完。半截答案仍比沒答案有用，但使用者必須知道它不完整 ——
    // 悄悄把截斷的內容當成完整答案送出去，是這裡最不該犯的錯。
    console.log('Gemini 回應被 token 上限截斷（maxOutputTokens=' + GEMINI_MAX_OUTPUT_TOKENS +
      '，thinking tokens 也計入）：' + truncate_(body, 500));
    return {
      ok: true,
      text: got.text + '\n\n⚠️ 回應太長被截斷了，問得更具體一點會比較完整。',
      truncated: true
    };
  }
  return { ok: true, text: got.text };
}

/** 回 { text, finishReason }——finishReason 是判斷「有沒有說完」的唯一依據 */
function extractGeminiText_(parsed) {
  var candidates = (parsed && parsed.candidates) || [];
  for (var i = 0; i < candidates.length; i++) {
    var parts = (candidates[i].content && candidates[i].content.parts) || [];
    var chunks = [];
    for (var j = 0; j < parts.length; j++) {
      if (parts[j] && typeof parts[j].text === 'string') chunks.push(parts[j].text);
    }
    var joined = chunks.join('').trim();
    if (joined) return { text: joined, finishReason: candidates[i].finishReason || '' };
  }
  var first = candidates[0] || {};
  return { text: '', finishReason: first.finishReason || '' };
}

/* ========================================================================== */
/* 回覆                                                                        */
/* ========================================================================== */

function supportedPrefixesMessage_() {
  var lines = ['目前支援：'];
  for (var prefix in ROUTE_TABLE) {
    if (Object.prototype.hasOwnProperty.call(ROUTE_TABLE, prefix)) {
      lines.push('・' + ROUTE_TABLE[prefix].usage);
    }
  }
  lines.push('・' + QUERY_USAGE);
  lines.push('（輸入 whoami 可查自己的 userId）');
  return lines.join('\n');
}

function categoryListMessage_() {
  return '目前可用分類：' + EXPENSE_CATEGORIES.join('、');
}

function formatTaskSuccess_(parsed) {
  var priority = parsed.priority || DEFAULT_PRIORITY;
  var lamp = { H: '🔴', M: '🟡', L: '🟢' }[priority] || '🟡';
  return '✅ 已新增任務\n' + lamp + ' ' + parsed.content;
}

function formatExpenseSuccess_(parsed, route) {
  var isIncome = route.expenseType === 'income';
  var head = '✅ 已記錄' + (isIncome ? '收入' : '支出');
  var line = (isIncome ? '+' : '-') + '$' + formatAmount_(parsed.amount) + '　' + parsed.category;
  return parsed.note ? head + '\n' + line + '\n📝 ' + parsed.note : head + '\n' + line;
}

/** 千分位。小數點後不分節（邊界在「.」是 \b 而非 \B，不會被誤插）。 */
function formatAmount_(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function summarizeTask_(parsed) {
  return '任務「' + parsed.content + '」／優先度 ' + (parsed.priority || DEFAULT_PRIORITY);
}

function summarizeExpense_(parsed, route) {
  var label = route.expenseType === 'income' ? '收入' : '支出';
  return label + ' ' + parsed.category + ' ' + parsed.amount +
    (parsed.note ? '（' + parsed.note + '）' : '');
}

/**
 * 回覆使用者。權杖放指令碼屬性，不寫進原始碼。
 *
 * 回覆失敗只記錄不拋出——寫入已經成功了，不該因為回覆失敗讓 LINE 重送。
 * 但一定要把 LINE 的回應碼記進 Log：沒有它，「權杖沒設」「權杖錯了」
 * 「權杖是別的 Channel 的」從外面看起來全都是同一種安靜的失敗。
 */
function lineReply_(replyToken, text) {
  if (!replyToken) return;

  var raw = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  // 從網頁複製權杖常會帶到換行或空白，前後修掉，否則 LINE 會回 401
  var token = raw ? String(raw).trim() : '';

  if (!token) {
    console.log('回覆略過：指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN 不存在或是空字串');
    return;
  }
  console.log('權杖長度 ' + token.length + ' 字元');

  try {
    var res = UrlFetchApp.fetch(LINE_REPLY_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    if (code === 200) {
      console.log('LINE 回覆成功');
    } else {
      console.log('LINE 回覆失敗 HTTP ' + code + '：' + res.getContentText());
    }
  } catch (err) {
    console.log('LINE 回覆連線失敗：' + err);
  }
}

/* ========================================================================== */
/* 診斷工具                                                                    */
/* ========================================================================== */

/**
 * 權杖健檢——直接在編輯器裡選這個函式按「執行」，不需要重新部署。
 *
 * 編輯器執行的是「目前存檔的程式碼」，而網頁應用程式服務的是「已部署的版本」，
 * 兩者是分開的。所以這支可以在不動部署的情況下，直接問 LINE：這把權杖有效嗎？
 *
 * 結果看「執行記錄」：
 *   HTTP 200 → 權杖有效，問題不在權杖（多半是官方帳號的回應模式設定）
 *   HTTP 401 → 權杖無效：可能誤貼了 Channel secret、複製不完整，或已被重新發行
 *   找不到屬性 → 指令碼屬性沒設成功，或名稱拼錯
 */
function diagnoseLineToken() {
  var raw = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  if (raw === null) {
    console.log('❌ 找不到指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN（注意大小寫與前後空白）');
    return;
  }

  var token = String(raw).trim();
  console.log('原始長度 ' + String(raw).length + '，去除前後空白後 ' + token.length);
  if (String(raw).length !== token.length) {
    console.log('⚠️ 權杖前後有多餘空白或換行，已在程式裡自動修掉，但建議回頭重存一次');
  }
  if (!token) {
    console.log('❌ 權杖是空字串');
    return;
  }

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  console.log('LINE /v2/bot/info 回應 HTTP ' + code);
  console.log(res.getContentText());

  if (code === 200) {
    console.log('✅ 權杖有效。若 LINE 仍不回訊息，請檢查官方帳號的「回應設定」：');
    console.log('   回應模式要是「聊天機器人」，且「自動回應訊息」關閉、「Webhook」開啟。');
  } else if (code === 401) {
    console.log('❌ 權杖無效。確認貼的是 Messaging API 分頁最下方的');
    console.log('   Channel access token (long-lived)，不是 Channel secret。');
  }
}

/**
 * logs 分頁健檢——同樣在編輯器裡直接執行，不需重新部署。
 *
 * 寫 log 的失敗是刻意被吞掉的（不能拖累主流程），所以「log 沒出現」在外面看起來
 * 什麼事都沒發生。這支就是把那個安靜的失敗叫出來講話。
 */
function diagnoseLogSheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    console.log('❌ 找不到分頁「' + LOG_SHEET_NAME + '」，請先建立並貼上表頭列');
    return;
  }

  var lastCol = sheet.getLastColumn();
  if (sheet.getLastRow() === 0 || lastCol === 0) {
    console.log('❌ 分頁「' + LOG_SHEET_NAME + '」是空的，缺表頭列');
    return;
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  console.log('目前表頭：' + headers.join(' | '));

  var expected = ['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id'];
  var missing = expected.filter(function (k) { return headers.indexOf(k) === -1; });

  if (missing.length) {
    // 欄序不影響寫入（依表頭對位），但欄位缺了就是真的漏記，值得挑明
    console.log('❌ 缺少欄位：' + missing.join('、'));
  } else {
    console.log('✅ 欄位齊全（欄序不影響寫入，依表頭對位）');
  }
  console.log('目前資料列數（不含表頭）：' + (sheet.getLastRow() - 1));
}

/**
 * Gemini 健檢——編輯器裡直接選這支執行，不需要重新部署。
 *
 * 存在的理由：模型 ID 會隨 Google 改版而變動，而查詢失敗時使用者只會看到
 * 「AI 暫時無法回應」這一句統一口徑。這支直接問 Google 兩件事：
 *   1. 這把 key 有效嗎
 *   2. 這把 key 現在能用哪些模型（別猜，看清單）
 *
 * 記錄裡若出現 ✅ 但 LINE 仍回「AI 暫時無法回應」，看「執行項目」的
 * Gemini HTTP 行，那裡有 Google 回傳的完整原文。
 */
function diagnoseGemini() {
  var raw = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  if (raw === null) {
    console.log('❌ 找不到指令碼屬性 GEMINI_API_KEY（注意大小寫與前後空白）');
    console.log('   到 專案設定 → 指令碼屬性 新增，值取自 Google AI Studio。');
    return;
  }

  var key = String(raw).trim();
  console.log('原始長度 ' + String(raw).length + '，去除前後空白後 ' + key.length);
  if (String(raw).length !== key.length) {
    console.log('⚠️ 權杖前後有多餘空白或換行，已在程式裡自動修掉，但建議回頭重存一次');
  }
  if (!key) {
    console.log('❌ GEMINI_API_KEY 是空字串');
    return;
  }

  var model = geminiModel_();
  console.log('目前設定的模型：' + model +
    (model === GEMINI_MODEL_DEFAULT ? '（程式預設值）' : '（來自指令碼屬性 GEMINI_MODEL）'));

  var res = UrlFetchApp.fetch(GEMINI_API_BASE, {
    method: 'get',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  console.log('ListModels 回應 HTTP ' + code);

  if (code !== 200) {
    console.log(res.getContentText());
    if (code === 400 || code === 403) {
      console.log('❌ key 無效或未啟用 Generative Language API。');
      console.log('   確認貼的是 Google AI Studio 的 API key，且該專案已啟用此 API。');
    }
    return;
  }

  var models = [];
  try {
    var parsed = JSON.parse(res.getContentText());
    models = (parsed.models || []).filter(function (m) {
      // 只列真的能拿來生成內容的，避免 embedding 之類的混進來誤導
      return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
    }).map(function (m) {
      return String(m.name || '').replace(/^models\//, '');
    });
  } catch (err) {
    console.log('⚠️ 回應解析失敗：' + err);
    return;
  }

  console.log('✅ key 有效。可用於 generateContent 的模型共 ' + models.length + ' 個：');
  models.forEach(function (m) { console.log('   ・' + m); });

  if (models.indexOf(model) === -1) {
    console.log('');
    console.log('❌ 目前設定的「' + model + '」不在上面的清單裡，查詢一定會失敗。');
    console.log('   從清單挑一個（建議選 flash 類，免費額度較寬），');
    console.log('   到 專案設定 → 指令碼屬性 新增 GEMINI_MODEL = 該模型 ID。');
    console.log('   不需要改程式碼，也不需要重新部署後才生效。');
  } else {
    console.log('');
    console.log('✅ 目前設定的模型在可用清單內，查詢應該可以正常運作。');
  }
}
