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
 *    記帳/120/飲食                → 支出 120，大類飲食（未細分）
 *    記帳/120/外食/午餐           → 只打細項也行，自動推回大類：飲食＞外食，備註午餐
 *    記帳/120/飲食/外食/午餐      → 同上（第 4 段剛好是該大類的細項才算細項）
 *    收入/50000/其他/九月薪水     → 同格式，只是 type 記成 income
 *    分類                         → 回傳整張分類表（大類、細項、對象）
 *
 * 【設計約束】
 *  - 純規則式字串切分，不接 AI 判讀（ADR-006：查詢型 AI 為獨立分支，不走 ROUTE_TABLE）
 *  - 與 PWA 同步共用同一部署網址，只多一個判斷分支
 *  - id 用 Date.now()，與 index.html 全站慣例一致（不可用 UUID，
 *    否則 taskFromCloud / expenseFromCloud 的 Number(r.id)||Date.now()
 *    會讓 UUID 轉成 NaN，每次啟動都重複塞一筆）
 *  - 欄位順序以 Sheet 實際表頭列為準，不寫死欄序，日後調欄位不用改這裡
 *  - 四種前綴（任務／記帳／收入／查詢）每次交易無論成敗都寫一列 logs（ADR-006 §D）
 */

var LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';

/** 主動推播端點（ADR-009 §四 C5）。與 reply 同一把權杖、同一套權限範圍 */
var LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

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

/** 回覆行數上限（寫進提示詞）。ADR-013 D-5：兩層彙總之後先不改，抽成常數方便之後調 */
var QUERY_REPLY_LINES = 5;

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
 * 白名單改查 line_users 分頁（ADR-008 F-2），不再讀指令碼屬性 ALLOWED_USER_IDS。
 *
 * 同一批人、同一個 line_id，沒道理維護兩份名單——PWA 那邊查 Sheet、LINE 這邊查
 * 指令碼屬性，遲早會有一邊忘了改。實作共用 Code.gs 的 writeGate_（同一個 Apps
 * Script 專案共用全域範圍），連 fail-closed 的判斷與 logs 的寫法都是同一份。
 *
 * ⚠️ 語意變了，明講：改版前「屬性沒設＝不限制任何人」，現在「白名單查不到＝拒絕」
 *    （ADR-008 F-1 fail-closed）。line_users 還沒建好之前，LINE 這端會全部擋下來，
 *    這是刻意的——一出狀況就自動變回全開的門，跟沒有門是同一件事。
 *    卡住時：在編輯器直接跑 diagnoseLineUsers() 看它到底讀到什麼。
 *
 * ⚠️ Apps Script 的 doPost 讀不到 HTTP Header，驗不了 LINE 官方簽章，
 *    所以 exec 網址一旦外流，任何人都能往你的 Sheet 寫東西。白名單是唯一的防線。
 *
 * 讀 Sheet 比讀指令碼屬性慢，而 LINE webhook 有回覆時限——所以 D-3 的 CacheService
 * 快取（TTL 5 分鐘）對這一端尤其關鍵，不是可有可無的最佳化。
 *
 * 舊的 ALLOWED_USER_IDS 指令碼屬性自此不再被讀取，確認新路徑正常後可以刪掉。
 */

/**
 * 記帳分類改讀 _expense_config（ADR-013 D-3，Code.gs 的 expenseConfig_），不再寫死一份。
 *
 * 不在清單內時一律打回並提示可用清單，不自動 fallback 成「其他」（ADR-006 §A）——
 * 打錯字被靜靜歸進「其他」，比當場被退回難發現得多，而且事後對不出來。
 */
var CATEGORY_COMMAND = '分類';

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

/**
 * 自行註冊的前綴（ADR-008 Part F 延伸）。
 *
 * 大小寫不拘：這串是要人手打的，`Line_ID` / `line_id` / `LINE_ID` 都該收。
 * 格式 `Line_ID/<自己的 userId>`——userId 從 `whoami` 取得後整串貼回來。
 *
 * 為什麼要人再貼一次自己的 ID：webhook 本來就帶著發話者的 userId，程式其實
 * 不需要這個參數。但它把「註冊」變成一個要先去查、再確認的動作，而不是打錯字
 * 就會誤觸的單字。bot 會比對貼進來的 ID 與發話者本人是否相同，不同一律退回——
 * 沒有這道比對，任何人都能替別人送出註冊。
 */
var REGISTER_PREFIX = 'line_id';
var REGISTER_USAGE = 'Line_ID/你的userId（先傳 whoami 取得）';

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
  if (!event) return;

  // bot 被邀進群組／多人聊天室：記下 ID 並在群組裡回報。
  // 之後要「依群組開不同功能」或「推播到群組」，第一步都是知道那個群組的 ID——
  // 靠人手動去翻 webhook 記錄不實際，被邀進去的當下就是唯一不費力的時機。
  if (event.type === 'join') {
    handleJoin_(event);
    return;
  }

  if (event.type !== 'message') return;
  if (!event.message || event.message.type !== 'text') return;

  var userId = (event.source && event.source.userId) || '';
  console.log('LINE userId: ' + userId);

  var text = String(event.message.text || '').trim();

  // whoami 刻意排在白名單檢查之前：它就是用來取得要填進 line_users 的值，
  // 也是萬一填錯、把自己擋在門外時唯一的救援途徑。回傳的只有發話者自己的 ID
  // 與「這則訊息所在的聊天室」ID——後者在群組裡本來就人人可問，放在白名單前面
  // 不會擴大攻擊面。
  if (text.toLowerCase() === 'whoami') {
    lineReply_(event.replyToken, whoamiMessage_(event.source));
    return;
  }

  // 註冊跟 whoami 一樣，必須排在白名單檢查**之前**——還沒進名單的人才需要註冊，
  // 排在閘門後面等於「要先有權限才能申請權限」，這個功能就永遠用不到。
  // 它唯一會寫的是 line_users 的一列待審資料（is_active 留白），不放行任何寫入。
  var slash = text.indexOf('/');
  var maybePrefix = (slash === -1 ? text : text.slice(0, slash)).trim().toLowerCase();
  if (maybePrefix === REGISTER_PREFIX) {
    var arg = slash === -1 ? '' : text.slice(slash + 1).trim();
    lineReply_(event.replyToken, handleRegister_(arg, userId, text));
    return;
  }

  // 與 PWA 同步共用同一道閘門、同一張表（ADR-008 F-2）
  var gate = writeGate_(userId, 'LINE ' + firstLine_(text));
  if (!gate.allowed) {
    lineReply_(event.replyToken, lineDeniedMessage_(gate.error));
    return;
  }

  // 裝置配對與續期（ADR-010）。排在閘門**之後**：只有 active 成員拿得到配對碼，
  // 那張碼就是「這個人本人在 LINE 上」的證明，放在閘門前面等於誰都能領鑰匙。
  var deviceReply = handleDeviceCommand_(text, event.source, userId);
  if (deviceReply !== null) {
    lineReply_(event.replyToken, deviceReply);
    return;
  }

  var reply = routeLineMessage_(text, userId);
  lineReply_(event.replyToken, reply);
}

/* ========================================================================== */
/* 裝置配對與續期（ADR-010 流程 A／C 的 LINE 端）                                */
/* ========================================================================== */

var PAIR_COMMAND = '配對';
var RENEW_COMMAND = '驗證裝置';
var RENEW_USAGE = '驗證裝置 123456（碼在 App 畫面上）';

/**
 * 「配對」與「驗證裝置 碼」。不是這兩個指令就回 null，交給一般路由。
 *
 * ⚠️ 只接受一對一聊天（source.type === 'user'）。ADR 沒寫明、但不擋就會出事：
 * 在群組裡傳「配對」，bot 回的碼全群都看得到，誰先輸入誰就拿到這個人的鑰匙。
 * 續期碼也一樣擋——續期的意義是「本人在自己的 LINE 上確認」，群組不是那個地方。
 *
 * 無論成敗都寫 logs（source「配對」），前端 LOG 頁有同名的篩選鈕。
 */
function handleDeviceCommand_(rawText, source, userId) {
  var text = String(rawText || '').trim();
  var isPair = text === PAIR_COMMAND;
  var isRenew = text.indexOf(RENEW_COMMAND) === 0;
  if (!isPair && !isRenew) return null;

  if (!source || source.type !== 'user') {
    logTransaction_(DEVICE_LOG_SOURCE, '失敗', text, '不在一對一聊天室，拒絕',
      '來源：' + ((source && source.type) || '(不明)'), '', userId);
    return '這個指令只能在跟 bot 的一對一聊天室傳。\n在群組裡傳的話，碼會被全群看到。';
  }

  if (isPair) {
    var issued = issuePairCode_(userId);
    if (!issued.ok) {
      logTransaction_(DEVICE_LOG_SOURCE, '失敗', text, '配對碼產生失敗', 'reason=' + issued.reason, '', userId);
      return '暫時沒辦法產生配對碼，請稍後再試。';
    }
    logTransaction_(DEVICE_LOG_SOURCE, '成功', text, '已發配對碼', '', '', userId);
    return '🔑 配對碼：' + issued.code + '\n' +
      (PAIR_CODE_TTL / 60) + ' 分鐘內到 App 輸入，只能用一次。\n' +
      '不要把這個碼給別人——拿到碼的人就能用你的身份登入。';
  }

  var code = text.slice(RENEW_COMMAND.length).trim();
  if (!/^\d{6}$/.test(code)) {
    logTransaction_(DEVICE_LOG_SOURCE, '失敗', text, '續期碼格式不對', '', '', userId);
    return '格式：' + RENEW_USAGE;
  }

  var res = confirmRenewCode_(code, userId);
  if (!res.ok) {
    logTransaction_(DEVICE_LOG_SOURCE, '失敗', text, '續期被拒絕', 'reason=' + res.reason, '', userId);
    return renewDeniedMessage_(res.reason);
  }
  logTransaction_(DEVICE_LOG_SOURCE, '成功', text, '已續期：' + res.device.device_label,
    'device_id=' + res.device.device_id, '', userId);
  return '✅ 已續期：' + res.device.device_label + '\nApp 會在幾秒內自己回到畫面。';
}

function renewDeniedMessage_(reason) {
  if (reason === 'not_owner') return '這個碼不是你的裝置，沒辦法幫你續期。';
  if (reason === 'revoked') return '這台裝置已被撤銷，不能續期。\n請在 App 上重新配對。';
  if (reason === 'invalid_code') {
    return '這個碼不對或已過期（' + (PAIR_CODE_TTL / 60) + ' 分鐘）。\n請在 App 上重新產生一個。';
  }
  return '暫時沒辦法續期，請稍後再試。';
}

/* ========================================================================== */
/* 訊息來源：一對一／群組／多人聊天室                                              */
/* ========================================================================== */

var SOURCE_LABELS = { user: '一對一聊天', group: '群組', room: '多人聊天室' };
var JOIN_LOG_SOURCE = '加入群組';

/** 聊天室本身的 ID：群組回 groupId、多人聊天室回 roomId，一對一沒有這一層 */
function chatIdOf_(source) {
  if (!source) return '';
  if (source.type === 'group') return source.groupId || '';
  if (source.type === 'room') return source.roomId || '';
  return '';
}

/**
 * whoami 的回覆。純函式，方便測。
 *
 * 一對一聊天維持原本的格式一字不改：註冊流程教人「先傳 whoami，再把 ID 整串
 * 貼回來」，格式一變，照舊說明操作的人就會貼錯東西。
 *
 * 群組裡取不到 userId 時要講清楚是「這個裝置沒給」而不是「群組一律沒有」——
 * LINE 只保證手機版會附上發話者的 userId，電腦版可能沒有。測的就是這件事。
 */
function whoamiMessage_(source) {
  var src = source || {};
  var userId = src.userId || '';
  var type = src.type || '';

  if (type !== 'group' && type !== 'room') {
    return '你的 userId：\n' + (userId || '(取不到，訊息可能來自群組)');
  }

  var idLabel = type === 'group' ? 'groupId' : 'roomId';
  return [
    '來源：' + SOURCE_LABELS[type] + '（' + type + '）',
    idLabel + '：\n' + (chatIdOf_(src) || '(取不到)'),
    '你的 userId：\n' + (userId || '(取不到，可能是從電腦版 LINE 發的，請改用手機再試一次)')
  ].join('\n');
}

/**
 * join 事件：寫一列 logs，並在群組裡回報 ID。
 * join 事件沒有發話者，所以 logs 的 user_id 留白。
 */
function handleJoin_(event) {
  var src = event.source || {};
  var type = src.type || '';
  var chatId = chatIdOf_(src);
  console.log('LINE join: ' + type + ' ' + chatId);

  logTransaction_(JOIN_LOG_SOURCE, chatId ? '成功' : '失敗',
    type + '/' + (chatId || '(沒有 ID)'),
    chatId ? ('已加入' + (SOURCE_LABELS[type] || type)) : 'join 事件沒有帶聊天室 ID',
    chatId, '', '');

  if (chatId) {
    lineReply_(event.replyToken,
      '👋 已加入' + (SOURCE_LABELS[type] || '') + '\n' +
      (type === 'group' ? 'groupId' : 'roomId') + '：\n' + chatId);
  }
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

  // 「分類」：唯讀，回傳整張分類表（ADR-013 D-11）。權限照記帳
  if (text === CATEGORY_COMMAND) return handleCategoryCommand_(text, userId);

  var route = ROUTE_TABLE[prefix];

  if (!route) {
    return '沒有這個前綴喔。\n' + supportedPrefixesMessage_() + '\n' + versionLine_();
  }

  // 功能權限（ADR-012 D-3）：跟 PWA 同一張對照表、同一個 canUse_
  var feature = FEATURE_BY_SHEET[route.sheetName];
  if (!canUse_(lineUserById_(userId), feature)) {
    var label = FEATURE_LABEL[feature] || feature;
    logTransaction_(prefix, '失敗', text, '沒有「' + label + '」功能的權限', 'code=forbidden｜' + feature, '', userId);
    return '你沒有「' + label + '」功能的權限。\n需要的話請管理者到 App 的「成員與權限」打開。';
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
    // 資料歸屬（ADR-008 C-1）。蓋在這裡而不是各 build 函式裡：路由表每新增一個
    // 前綴都會自動帶上，不必記得補。分頁還沒加 line_id 欄時，appendToSheet_ 是
    // 依實際表頭對位的，這個鍵會被安靜忽略——不會因此寫壞任何一列。
    record.line_id = userId || '';
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
 * 「分類」關鍵字。跟記帳同一個權限（feat_expense）；不寫任何資料列，logs 記在「查詢」底下——
 * 它是查東西，不是記帳，放進「記帳」篩選鈕只會混淆「我那筆帳記到哪去了」。
 */
function handleCategoryCommand_(text, userId) {
  if (!canUse_(lineUserById_(userId), FEATURE_BY_SHEET.expenses)) {
    var label = FEATURE_LABEL[FEATURE_BY_SHEET.expenses];
    logTransaction_(QUERY_LOG_SOURCE, '失敗', text, '沒有「' + label + '」功能的權限', 'code=forbidden｜feat_expense', '', userId);
    return '你沒有「' + label + '」功能的權限。\n需要的話請管理者到 App 的「成員與權限」打開。';
  }
  var cfg = expenseConfig_();
  logTransaction_(QUERY_LOG_SOURCE, '成功', text, '回傳分類表',
    cfg.source === 'builtin' ? '設定分頁讀不到，回的是內建清單' : '', '', userId);
  return '📒 記帳分類\n' + expenseCategoryTable_(cfg, true) +
    '\n\n格式：記帳/金額/大類或細項[/備註]';
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
  var cfg = expenseConfig_();

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
    return { error: '要指定分類喔。\n' + categoryListMessage_(cfg) + '\n格式：' + route.usage };
  }
  // 第 3 段：大類、大類別名、或細項（細項自動推回大類）——ADR-013 D-10
  var hit = resolveExpenseCategory_(cfg, category);
  if (!hit) {
    return { error: '沒有「' + category + '」這個分類喔。\n' + categoryListMessage_(cfg) };
  }

  // 第 4 段：**完整等於**這個大類的某個細項才算細項，否則整段（含斜線）都是備註。
  // 第 3 段已經是細項時不再看第 4 段——「記帳/120/外食/買菜」的備註就是「買菜」。
  var rest3 = parts.slice(2);
  var sub = hit.sub;
  if (!sub && rest3.length) {
    var cat = (cfg.categories || []).filter(function (c) { return c.name === hit.category; })[0];
    var maybe = String(rest3[0] || '').trim();
    if (cat && maybe && cat.subs.indexOf(maybe) !== -1) {
      sub = maybe;
      rest3 = rest3.slice(1);
    }
  }

  return {
    amount: amount,
    category: hit.category,
    subcategory: sub,
    alias: hit.alias,
    note: rest3.join('/').trim()
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

/** expenses：id | expense_date | type | category | subcategory | targets | amount | note | created_at */
function buildExpenseRow_(parsed, route) {
  var now = new Date();
  return {
    id: Date.now(),
    expense_date: dateKey_(now),
    type: route.expenseType,
    category: parsed.category,
    subcategory: parsed.subcategory || '',
    targets: '',
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
    context = buildQueryContext_(userId);
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
 *
 * 只組發話者有功能權限的模組（ADR-012 D-3）：沒權限的那張表連讀都不讀，
 * 對應欄位是 null，提示詞那一段整段不出現。
 */
var QUERY_SHEETS = ['expenses', 'tasks', 'reviews', 'moods'];

function buildQueryContext_(userId) {
  var since = windowStartKey_();
  var today = dateKey_(new Date());
  var user = lineUserById_(userId);
  var allowed = {};
  QUERY_SHEETS.forEach(function (name) { allowed[name] = canUseSheet_(user, name); });
  var expenseRows = allowed.expenses ? readSheet_('expenses') : [];
  var cfg = allowed.expenses ? expenseConfig_() : null;

  return {
    since: since,
    today: today,
    monthStart: monthStartKey_(),
    allowed: allowed,
    // 兩組期間都給：使用者最自然的問法是「這個月」，但 ADR 的窗口是「近 30 天」。
    // 只給後者的話，AI 會拿近 30 天的合計去回答「這個月」——數字包含上個月下旬，
    // 而且跟 App 首頁的「本月支出」對不起來。多算一組的成本只有幾行。
    expenses: allowed.expenses ? {
      month: sumExpensesSince_(expenseRows, monthStartKey_(), cfg),
      window: sumExpensesSince_(expenseRows, since, cfg)
    } : null,
    tasks: allowed.tasks ? collectTasks_(readSheet_('tasks'), since) : null,
    reviews: allowed.reviews ? collectReviews_(readSheet_('reviews'), since) : null,
    moods: allowed.moods ? summarizeMoods_(readSheet_('moods'), since) : null
  };
}

/** 月初 YYYY-MM-01，與前端 monthKey() 的「本月」定義一致 */
function monthStartKey_() {
  return dateKey_(new Date()).slice(0, 7) + '-01';
}

/**
 * expenses → 大類 → 細項兩層小計 + 對象小計 + 總計 + 筆數（完整不截斷，ADR-013 D-5）。
 *
 * 沒填細項的歸「未細分」。大類名先換回正名（遷移前的「餐飲」併進「飲食」），
 * 跟 App 的甜甜圈同一個口徑。cfg 省略時不換名（舊的呼叫端）。
 *
 * 對象可複選：一筆「姐姐,妹妹」的帳**整筆**同時計入兩個人。拆成各半是在替使用者
 * 決定比例，而那正是這個欄位沒記的事。代價是對象小計相加會大於總額——提示詞會講明。
 */
function sumExpensesSince_(rows, since, cfg) {
  var acc = {
    expense: { total: 0, count: 0, byCat: {}, byTarget: {} },
    income: { total: 0, count: 0, byCat: {}, byTarget: {} }
  };
  var seen = 0;

  rows.forEach(function (r) {
    var date = toDateKey_(r.expense_date);
    if (!date || date < since) return;
    var type = String(r.type || '').trim() === 'income' ? 'income' : 'expense';
    var amount = Number(r.amount) || 0;
    var raw = String(r.category || '其他').trim() || '其他';
    var cat = cfg ? (canonicalExpenseCategory_(cfg, raw) || '其他') : raw;
    var sub = String(r.subcategory || '').trim() || EXPENSE_UNSORTED;

    acc[type].total += amount;
    acc[type].count += 1;
    var c = acc[type].byCat[cat] = (acc[type].byCat[cat] || { sum: 0, n: 0, bySub: {} });
    c.sum += amount;
    c.n += 1;
    c.bySub[sub] = (c.bySub[sub] || { sum: 0, n: 0 });
    c.bySub[sub].sum += amount;
    c.bySub[sub].n += 1;
    String(r.targets || '').split(',').forEach(function (t) {
      t = t.trim();
      if (!t) return;
      var g = acc[type].byTarget[t] = (acc[type].byTarget[t] || { sum: 0, n: 0 });
      g.sum += amount;
      g.n += 1;
    });
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
  // 舊的呼叫端沒有 allowed：當成全開，提示詞與改版前一字不差
  var allowed = ctx.allowed || { expenses: true, tasks: true, reviews: true, moods: true };
  var visible = QUERY_SHEETS.filter(function (name) { return allowed[name]; })
    .map(function (name) { return FEATURE_LABEL[FEATURE_BY_SHEET[name]]; });

  lines.push('你是 Neil 個人系統的查詢助理。以下是他的資料，請用繁體中文回答最後的問題。');
  lines.push('');
  lines.push('規則：');
  lines.push('- 只根據以下資料回答。資料裡沒有的就直說沒有，絕對不要編造或推估。');
  lines.push('- 回答控制在 ' + QUERY_REPLY_LINES + ' 行以內，這則訊息會顯示在 LINE 上。');
  lines.push('- 金額用阿拉伯數字加千分位，不要加貨幣符號以外的修飾。');
  lines.push('- 不要重複問題本身，直接給答案。');
  if (visible.length < QUERY_SHEETS.length) {
    // 沒權限的模組整段不給。不講清楚的話，AI 會把「沒資料」說成「花了 0 元」
    lines.push('- 你只看得到以下模組：' + (visible.length ? visible.join('、') : '（無）') + '。' +
      '其他模組的資料你看不到；被問到時回答「你沒有權限查看這個模組」，不要說成 0 或沒有記錄。');
  }
  if (allowed.expenses) {
    lines.push('- 記帳有「本月」與「近 30 天」兩組統計，期間不同，絕對不可混用或相加：');
    lines.push('  問「這個月」「本月」「九月」→ 用【本月】那組。');
    lines.push('  問「最近」「這 30 天」「這陣子」→ 用【近 30 天】那組。');
    lines.push('  問法沒有指明期間時，用【本月】那組，並在回答中說明是本月。');
    lines.push('- 記帳彙總分兩層：「・大類」底下縮排的「－細項」是那個大類的細分，細項加起來等於大類；' +
      '「' + EXPENSE_UNSORTED + '」是沒填細項的帳。');
    lines.push('- 【對象】是花在誰／哪台車身上。一筆帳可以同時算給好幾個對象，所以對象小計相加會大於總額，不可相加。');
  }
  lines.push('');
  lines.push('今天是 ' + ctx.today + '。');
  lines.push('');

  if (allowed.expenses) {
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
  }

  // 逐筆的部分共用同一個上限：任務吃不完的額度才輪到複盤
  var tasks = allowed.tasks ? ctx.tasks : { open: [], done: [] };
  var allReviews = allowed.reviews ? ctx.reviews : [];
  var budget = QUERY_MAX_TOTAL_RECORDS;
  var openTasks = tasks.open.slice(0, budget);
  budget -= openTasks.length;
  var doneTasks = tasks.done.slice(0, Math.max(0, Math.min(budget, 5)));
  budget -= doneTasks.length;
  var reviews = allReviews.slice(0, Math.max(0, budget));

  if (allowed.tasks) {
    lines.push('【未完成任務】共 ' + tasks.open.length + ' 筆' +
      (tasks.open.length > openTasks.length ? '，以下列出優先度最高的 ' + openTasks.length + ' 筆' : ''));
    lines.push(openTasks.length
      ? openTasks.map(function (t) { return '・[' + t.priority + '] ' + t.text; }).join('\n')
      : '（沒有未完成的任務）');
    lines.push('');
  }

  if (doneTasks.length) {
    lines.push('【近 ' + QUERY_WINDOW_DAYS + ' 天內已完成的任務】');
    lines.push(doneTasks.map(function (t) { return '・' + t.created + ' ' + t.text; }).join('\n'));
    lines.push('');
  }

  if (allowed.reviews) {
    lines.push('【近 ' + QUERY_WINDOW_DAYS + ' 天的複盤】共 ' + allReviews.length + ' 則' +
      (allReviews.length > reviews.length ? '，以下列出最近 ' + reviews.length + ' 則' : ''));
    lines.push(reviews.length
      ? reviews.map(function (r) {
          return '・' + toDateKey_(r.review_date) +
            '｜做得好：' + truncate_(String(r.good || '—'), 60) +
            '｜卡住：' + truncate_(String(r.stuck || '—'), 60) +
            '｜最重要：' + truncate_(String(r.most_important || '—'), 60);
        }).join('\n')
      : '（期間內沒有複盤記錄）');
    lines.push('');
  }

  if (allowed.moods && ctx.moods.count) {
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
  var money = function (x) { return formatAmount_(Math.round(x.sum)) + ' 元（' + x.n + ' 筆）'; };
  var bySum = function (map) {
    return Object.keys(map).sort(function (a, b) { return map[b].sum - map[a].sum; });
  };
  cats.forEach(function (c) {
    lines.push('・' + c + ' ' + money(side.byCat[c]));
    var subs = side.byCat[c].bySub || {};
    var names = bySum(subs);
    // 整個大類都沒細分時不展開：多一行「－未細分」跟上一行一模一樣，只是佔版面
    if (names.length === 1 && names[0] === EXPENSE_UNSORTED) return;
    names.forEach(function (s) { lines.push('　－' + s + ' ' + money(subs[s])); });
  });
  var targets = bySum(side.byTarget || {});
  if (targets.length) {
    lines.push('【對象】' + targets.map(function (t) { return t + ' ' + money(side.byTarget[t]); }).join('；'));
  }
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

/* ========================================================================== */
/* 自行註冊（Line_ID 前綴）                                                    */
/* ========================================================================== */

/**
 * 把自己加進 line_users，但**只建立待審資料**（`is_active` 留白）。
 *
 * 這是刻意的：如果註冊就等於啟用，白名單等於「知道這個 bot 的人都能寫」，
 * ADR-008 Part D 那道門就形同虛設。註冊解決的是「Neil 要手動把 32 字元的 userId
 * 貼進 Sheet」這段摩擦，不是解決「誰可以寫」——後者仍然要由人按一下。
 *
 * 唯一的例外是**名單完全空的時候**：第一個註冊的人直接啟用為管理者，並打開全部
 * 功能。沒有這個例外會是死結——沒有人在名單上，就沒有人能核准第一個人。代價是
 * 部署完到 Neil 註冊之間有一個空窗，誰先傳誰就是管理者；這段窗口以分鐘計，而且
 * 要先是這個 bot 的好友才傳得到。
 *
 * `is_active` 留白（而不是寫 FALSE）是有意義的：前端管理頁用「空白＝待審、
 * FALSE＝被停用過」來分辨這兩種人。對閘門而言兩者一樣是擋，只有標籤不同。
 */
function handleRegister_(claimedId, userId, rawText) {
  if (!userId) {
    // 群組訊息的 source 沒有 userId，註冊的對象會是空的
    return '這裡取不到你的 userId（訊息可能來自群組）。\n請在跟 bot 的一對一聊天室裡再試一次。';
  }
  if (!claimedId) {
    return '格式：' + REGISTER_USAGE + '\n先傳一句 whoami，再把拿到的 ID 整串貼回來。';
  }

  // 只能註冊自己。少了這道比對，任何人都能替別人送出註冊，
  // 管理者看到的待審清單就會混進不是本人申請的資料。
  if (claimedId !== userId) {
    logTransaction_('註冊', '失敗', rawText, '貼上的 userId 與發話者不符', 
      '發話者 ' + userId + '，貼上的是 ' + claimedId, '', userId);
    return '這串 ID 不是你的，沒辦法幫你註冊。\n只能註冊自己——傳 whoami 取得你自己的 ID 再貼過來。';
  }

  // 刻意不走快取：註冊要看到此刻最新的名單，5 分鐘前的快照會讓剛被核准的人
  // 又收到一次「還在待審」，或讓同一個人重複建立兩列。
  var roster = readLineUsers_();
  if (!roster.ok && roster.reason === 'sheet_missing') {
    try {
      ensureLineUsersSheet_();
      roster = readLineUsers_();
    } catch (err) {
      console.log('建立 ' + LINE_USERS_SHEET + ' 失敗：' + err);
    }
  }
  if (!roster.ok) {
    logTransaction_('註冊', '失敗', rawText, '名單讀不到', '原因：' + roster.reason, '', userId);
    return '名單暫時讀不到，沒辦法幫你註冊。\n請稍後再試，或請管理者檢查 line_users 分頁。';
  }

  var existing = roster.users[userId];
  if (existing) {
    if (truthy_(existing.is_active)) {
      return '你已經在名單上了，直接用就可以 👌\n' + supportedPrefixesMessage_();
    }
    // 重複註冊不再寫一列，只把目前狀態講清楚——名單被灌成一堆同 id 的待審資料，
    // 管理者反而看不出誰是誰。
    return '你已經註冊過了，還在等核准。\n請管理者在 App 的「成員與權限」把你打開。';
  }

  var bootstrap = Object.keys(roster.users).length === 0;
  var now = new Date().toISOString();
  var row = {
    line_id: userId,
    display_name: lineDisplayName_(userId),
    // 名單空的時候第一位直接啟用為管理者，否則沒人能核准他（見上方說明）
    is_active: bootstrap ? 'TRUE' : '',
    is_admin: bootstrap ? 'TRUE' : '',
    created_at: now,
    updated_at: now
  };
  // 第一位要把功能全開：矩陣「有欄位但全留白」會被判讀成全部關閉（ADR-008 E-2b），
  // 管理者一進 App 只看得到首頁，連「成員與權限」以外的東西都不見。
  for (var i = 0; i < LINE_USERS_FEATURES.length; i++) {
    row[LINE_USERS_FEATURES[i]] = bootstrap ? 'TRUE' : '';
  }

  var rowNumber;
  try {
    rowNumber = appendToSheet_(LINE_USERS_SHEET, row);
  } catch (err) {
    console.log('註冊寫入失敗：' + err);
    logTransaction_('註冊', '失敗', rawText, '寫入失敗', String(err && err.stack || err), '', userId);
    return '註冊寫入失敗了：' + err.message;
  }

  // 剛寫進去的那一列要立刻算數，不然他還要等最多 5 分鐘才寫得進東西
  invalidateLineUsersCache_();

  if (bootstrap) {
    logTransaction_('註冊', '成功', rawText, '名單原本是空的，第一位成員直接啟用為管理者',
      '已開啟全部功能', rowNumber, userId);
    return '✅ 註冊完成，你是第一位成員\n' +
      '已直接啟用並給了管理權限（名單原本是空的，總得有人能核准後面的人）。\n' +
      '之後在 App 首頁的「成員與權限」可以核准其他人。';
  }
  logTransaction_('註冊', '成功', rawText, '已建立待審資料，等候核准', '', rowNumber, userId);
  return '✅ 收到你的註冊，等管理者核准\n' +
    '核准之前還不能寫入。請管理者到 App 首頁的「成員與權限」把你打開，\n' +
    '順便勾選你可以用哪些功能。';
}

/**
 * 從 LINE 個人資料取顯示名稱，省得使用者自己打一次。
 *
 * 取不到就回空字串，**不讓註冊因此失敗**——稱呼只是給「選身份」畫面看的，
 * 為了一個顯示用的字串把整個註冊擋掉不划算。前端在稱呼空白時會退回顯示 userId。
 */
function lineDisplayName_(userId) {
  var token = lineToken_();
  if (!token || !userId) return '';
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      console.log('取 LINE 個人資料失敗 HTTP ' + res.getResponseCode());
      return '';
    }
    return String(JSON.parse(res.getContentText()).displayName || '').trim();
  } catch (err) {
    console.log('取 LINE 個人資料連線失敗：' + err);
    return '';
  }
}

/**
 * 被擋下來時回給使用者的訊息。
 *
 * 「沒有權限」與「名單根本讀不到」對使用者來說都是「不能用」，但對要修的人來說
 * 是兩件完全不同的事——訊息分開寫，Neil 看一眼就知道要去改 Sheet 還是加人。
 * 細節仍在 logs 裡（denyWrite_ 每次都寫一列），這裡只給一句話。
 */
function lineDeniedMessage_(code) {
  if (code === 'whitelist_unavailable') {
    return '名單暫時讀不到，先擋下來以策安全。\n（請檢查 line_users 分頁是否存在）';
  }
  if (code === 'whitelist_empty') {
    return '名單目前是空的，所有寫入都會被擋。\n（請在 line_users 勾選 is_active）';
  }
  if (code === 'inactive') {
    return '這個帳號目前被停用了。';
  }
  return '這個帳號沒有權限寫入喔。\n輸入 whoami 可以查到自己的 userId。';
}

function supportedPrefixesMessage_() {
  var lines = ['目前支援：'];
  for (var prefix in ROUTE_TABLE) {
    if (Object.prototype.hasOwnProperty.call(ROUTE_TABLE, prefix)) {
      lines.push('・' + ROUTE_TABLE[prefix].usage);
    }
  }
  lines.push('・' + QUERY_USAGE);
  lines.push('・' + CATEGORY_COMMAND + '（看記帳可用的大類、細項、對象）');
  lines.push('・' + REGISTER_USAGE);
  lines.push('・' + PAIR_COMMAND + '（拿 App 的配對碼，限一對一聊天）');
  lines.push('・' + RENEW_USAGE);
  lines.push('（輸入 whoami 可查自己的 userId）');
  return lines.join('\n');
}

/**
 * 線上後端的發行號，附在「沒有這個前綴」回覆的最後一行，用來確認部署的是哪一版。
 *
 * BUILD_INFO 由 CI 在 clasp push 前寫進 build-info.gs（不進 git）。GAS 各檔共用
 * 全域，這裡在「呼叫時」才讀，所以跟檔案載入順序無關。讀不到就明講未知：
 * 代表這份程式不是 CI 部署的（例如在編輯器手改過），那正是要被看見的事。
 *
 * 只加在「沒有這個前綴」：它排在白名單之後，陌生人看不到版本資訊。
 */
function versionLine_() {
  var info = typeof BUILD_INFO === 'undefined' ? null : BUILD_INFO;
  if (!info || !info.sha) return '目前版本：未知（不是由 CI 部署的程式）';
  return '目前版本：#' + info.run + ' · main@' + info.sha + '（' + info.builtAt + '）';
}

/** 分類打錯或沒填時的提示。從設定產生，大類＋細項（ADR-013 T3） */
function categoryListMessage_(cfg) {
  return '目前可用分類（細項也可以直接打）：\n' + expenseCategoryTable_(cfg || expenseConfig_(), false);
}

function formatTaskSuccess_(parsed) {
  var priority = parsed.priority || DEFAULT_PRIORITY;
  var lamp = { H: '🔴', M: '🟡', L: '🟢' }[priority] || '🟡';
  return '✅ 已新增任務\n' + lamp + ' ' + parsed.content;
}

function formatExpenseSuccess_(parsed, route) {
  var isIncome = route.expenseType === 'income';
  var head = '✅ 已記錄' + (isIncome ? '收入' : '支出');
  var line = (isIncome ? '+' : '-') + '$' + formatAmount_(parsed.amount) + '　' + parsed.category +
    (parsed.subcategory ? '＞' + parsed.subcategory : '');
  var out = parsed.note ? head + '\n' + line + '\n📝 ' + parsed.note : head + '\n' + line;
  // 用到別名時講一聲：不然打「餐飲」卻看到「飲食」，會以為記錯
  if (parsed.alias) out += '\n（' + parsed.alias + '已記為 ' + parsed.category + '）';
  return out;
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
  return label + ' ' + parsed.category + (parsed.subcategory ? '＞' + parsed.subcategory : '') + ' ' + parsed.amount +
    (parsed.note ? '（' + parsed.note + '）' : '');
}

/**
 * 回覆使用者。權杖放指令碼屬性，不寫進原始碼。
 *
 * 回覆失敗只記錄不拋出——寫入已經成功了，不該因為回覆失敗讓 LINE 重送。
 * 但一定要把 LINE 的回應碼記進 Log：沒有它，「權杖沒設」「權杖錯了」
 * 「權杖是別的 Channel 的」從外面看起來全都是同一種安靜的失敗。
 */
/** 從網頁複製權杖常會帶到換行或空白，前後修掉，否則 LINE 會回 401 */
function lineToken_() {
  var raw = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  return raw ? String(raw).trim() : '';
}

function lineReply_(replyToken, text) {
  if (!replyToken) return;

  var token = lineToken_();

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
/* LINE 主動推播（ADR-009 §四 C5，動工前置驗證）                                */
/*                                                                            */
/* ⚠️ 目前沒有任何呼叫端。ADR-009 把通知管道列為「條件式決策」：要先用下面的      */
/* testLinePush() 實測 push 端點通不通，通了才接上到期檢查；不通就整塊移入未來票， */
/* 而 C1-C4（到期日欄位、儀表板區塊視覺化）照常上線，不因為 push 卡住被連帶延後。 */
/* ========================================================================== */

/**
 * 主動推一則文字訊息給某個 userId。
 *
 * 與 lineReply_ 的差別只有兩點：端點不同、以及 push 沒有 replyToken 的時效限制，
 * 換來的是配額限制（免費方案每月有則數上限）。權杖共用同一把，所以權杖有沒有效
 * 可以直接沿用 diagnoseLineToken() 的結論，不必另外查。
 *
 * 一樣不拋出：推播失敗不該讓觸發它的那筆流程跟著失敗。但一定要把回應碼記進
 * 執行記錄——沒有它，「權杖沒設」「配額用完」「對方封鎖了官方帳號」從外面看
 * 起來全都是同一種安靜的失敗。
 */
function linePush_(toUserId, text) {
  if (!toUserId) {
    console.log('推播略過：沒有指定對象 userId');
    return { ok: false, code: 0, reason: 'no_target' };
  }

  var token = lineToken_();
  if (!token) {
    console.log('推播略過：指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN 不存在或是空字串');
    return { ok: false, code: 0, reason: 'no_token' };
  }

  try {
    var res = UrlFetchApp.fetch(LINE_PUSH_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        to: toUserId,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code === 200) {
      console.log('LINE 推播成功');
      return { ok: true, code: code, reason: '' };
    }
    console.log('LINE 推播失敗 HTTP ' + code + '：' + body);
    return { ok: false, code: code, reason: firstLine_(body) };
  } catch (err) {
    console.log('LINE 推播連線失敗：' + err);
    return { ok: false, code: 0, reason: String(err) };
  }
}

/**
 * ADR-009 C5 的動工前置驗證——在編輯器裡選這個函式按「執行」，看執行記錄。
 *
 * 對象的挑法：優先讀指令碼屬性 PUSH_TEST_TO；沒設就從 line_users 抓第一位
 * 啟用中的管理者。後者的用意是「不必為了跑一次測試先去設一個屬性」，而管理者
 * 本來就是會被這件事吵到的人。
 *
 * 判讀：
 *   HTTP 200 → push 可行，C5 通知功能照 ADR 實作
 *   HTTP 400 → 多半是對象 userId 不對，或對方沒有加官方帳號為好友
 *   HTTP 401 → 權杖問題，先跑 diagnoseLineToken()
 *   HTTP 429 → 配額用完，這正是 ADR 說「若則數不敷使用再重新評估 Web Push」的訊號
 */
function testLinePush() {
  var target = PropertiesService.getScriptProperties().getProperty('PUSH_TEST_TO');
  target = target ? String(target).trim() : '';

  if (!target) {
    var roster = readLineUsers_();
    if (!roster.ok) {
      console.log('❌ 沒設指令碼屬性 PUSH_TEST_TO，且讀不到 line_users（' + roster.reason + '）');
      return { ok: false, reason: 'no_target' };
    }
    Object.keys(roster.users).some(function (id) {
      var u = roster.users[id];
      if (truthy_(u.is_active) && truthy_(u.is_admin)) { target = id; return true; }
      return false;
    });
  }

  if (!target) {
    console.log('❌ 找不到推播對象：line_users 裡沒有啟用中的管理者，也沒設 PUSH_TEST_TO');
    return { ok: false, reason: 'no_target' };
  }

  console.log('推播對象：' + target.slice(0, 6) + '…（' + target.length + ' 字元）');
  var result = linePush_(target, '【ADR-009 推播測試】看到這則訊息，代表 push 端點可用，週期提醒的通知管道確定走 LINE Push。');

  if (result.ok) {
    console.log('✅ push 可行。ADR-009 C5 條件式決策的條件成立，通知功能照規格實作。');
  } else {
    console.log('❌ push 不可行（' + (result.code || '連線失敗') + '）。依 ADR-009 C5：');
    console.log('   通知這塊移入未來票，C1-C4 到期追蹤與區塊視覺化照常上線，不連帶延後。');
  }
  return result;
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
