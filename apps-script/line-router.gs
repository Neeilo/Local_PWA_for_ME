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
/* 回覆                                                                        */
/* ========================================================================== */

function supportedPrefixesMessage_() {
  var lines = ['目前支援：'];
  for (var prefix in ROUTE_TABLE) {
    if (Object.prototype.hasOwnProperty.call(ROUTE_TABLE, prefix)) {
      lines.push('・' + ROUTE_TABLE[prefix].usage);
    }
  }
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
