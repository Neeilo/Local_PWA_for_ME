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
 * 【訊息格式】前綴/內容[/優先度]
 *    任務/買牛奶            → 優先度預設 M
 *    任務/報表開發/H        → 優先度 H
 *    任務/寫 A/B 測試報告   → 內容含「/」也不會被切壞（見 parseMessage_）
 *
 * 【設計約束】
 *  - 純規則式字串切分，不接 AI 判讀（ADR：AI 判讀為獨立後續決策）
 *  - 與 PWA 同步共用同一部署網址、同一 SECRET，只多一個判斷分支
 *  - id 用 Date.now()，與 index.html 全站慣例一致（不可用 UUID，
 *    否則 taskFromCloud 的 Number(r.id)||Date.now() 會讓每次啟動都重複塞一筆）
 *  - 欄位順序以 Sheet 實際表頭列為準，不寫死欄序，日後調欄位不用改這裡
 */

var LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

/**
 * 允許使用的 LINE userId 白名單。
 * 留空陣列 = 不限制（方便第一次跑通）。
 * 你的 userId 會寫進「執行記錄」，第一次傳訊息後去 Apps Script 左側「執行項目」找
 * 「LINE userId: Uxxxxxxxx」，填進來即可鎖定只有你能寫入。
 *
 * ⚠️ Apps Script 的 doPost 讀不到 HTTP Header，驗不了 LINE 官方簽章，
 *    所以 exec 網址一旦外流，任何人都能往你的 Sheet 寫東西。白名單是唯一的防線。
 */
var ALLOWED_USER_IDS = [];

/**
 * 路由表。要新增分頁時只加一筆，不需動其他邏輯。
 *  sheetName : 目標分頁名稱
 *  build     : 把解析結果轉成 { 欄位名: 值 } 物件
 *  usage     : 前綴用錯時回覆的提示文字
 */
var ROUTE_TABLE = {
  '任務': {
    sheetName: 'tasks',
    usage: '任務/內容[/H或M或L]',
    build: buildTaskRow_
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
    Logger.log('LINE webhook 例外：' + err);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleLineEvent_(event) {
  if (!event || event.type !== 'message') return;
  if (!event.message || event.message.type !== 'text') return;

  var userId = (event.source && event.source.userId) || '';
  Logger.log('LINE userId: ' + userId);

  if (ALLOWED_USER_IDS.length > 0 && ALLOWED_USER_IDS.indexOf(userId) === -1) {
    lineReply_(event.replyToken, '這個帳號沒有權限寫入喔。');
    return;
  }

  var reply = routeLineMessage_(event.message.text || '');
  lineReply_(event.replyToken, reply);
}

/* ========================================================================== */
/* 路由                                                                        */
/* ========================================================================== */

/**
 * 規則式路由：查表 → 解析 → 寫入 → 回傳給使用者的訊息字串。
 * 找不到前綴時回覆支援清單，絕不靜默失敗。
 */
function routeLineMessage_(rawText) {
  var text = String(rawText || '').trim();
  if (!text) return supportedPrefixesMessage_();

  var slash = text.indexOf('/');
  var prefix = (slash === -1 ? text : text.slice(0, slash)).trim();
  var route = ROUTE_TABLE[prefix];

  if (!route) {
    return '沒有這個前綴喔。\n' + supportedPrefixesMessage_();
  }
  if (slash === -1) {
    return '「' + prefix + '」後面要接內容喔。\n格式：' + route.usage;
  }

  var parsed = parseMessage_(text.slice(slash + 1));
  if (!parsed.content) {
    return '內容是空的喔。\n格式：' + route.usage;
  }

  try {
    var record = route.build(parsed);
    appendToSheet_(route.sheetName, record);
    return formatSuccess_(prefix, parsed);
  } catch (err) {
    Logger.log('寫入失敗：' + err);
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
function parseMessage_(rest) {
  var parts = String(rest).split('/');
  var priority = null;

  if (parts.length > 1) {
    var last = parts[parts.length - 1].trim().toUpperCase();
    if (PRIORITIES.indexOf(last) !== -1) {
      priority = last;
      parts.pop();
    }
  }
  return {
    content: parts.join('/').trim(),
    priority: priority
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

/* ========================================================================== */
/* Sheet 寫入                                                                  */
/* ========================================================================== */

/**
 * 依分頁「實際的表頭列」對位寫入一列。
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
  return lines.join('\n');
}

function formatSuccess_(prefix, parsed) {
  var priority = parsed.priority || DEFAULT_PRIORITY;
  var lamp = { H: '🔴', M: '🟡', L: '🟢' }[priority] || '🟡';
  return '✅ 已新增' + prefix + '\n' + lamp + ' ' + parsed.content;
}

/**
 * 回覆使用者。權杖放指令碼屬性，不寫進原始碼。
 * 回覆失敗只記錄不拋出——寫入已經成功了，不該因為回覆失敗讓 LINE 重送。
 */
function lineReply_(replyToken, text) {
  if (!replyToken) return;

  var token = PropertiesService.getScriptProperties()
    .getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    Logger.log('缺少指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN，略過回覆');
    return;
  }

  try {
    UrlFetchApp.fetch(LINE_REPLY_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('LINE 回覆失敗：' + err);
  }
}
