/**
 * Neil OS — PWA ↔ Google Sheets 同步（Apps Script 端）
 * ---------------------------------------------------------------------------
 * doGet  : 已關閉（ADR-010 第 3 段，2026-10-01），一律回 { error: 'gone' }
 * doPost : 由 line-router.gs 依 payload 形狀分流後呼叫 handlePwaSync_
 *
 * 讀寫都過 line_users 白名單（ADR-008 Part D → ADR-010 D-1）。身份不再由前端宣告，
 * 而是由 LINE 配對換來的裝置 token 證明（ADR-010 D-2）；token 放在 POST body 裡，
 * 因為 Apps Script 讀不到 HTTP Header。讀取改走 POST 的理由也是這個。
 */

/* ========================================================================== */
/* line_users 白名單（ADR-008 Part D）                                         */
/* ========================================================================== */

var LINE_USERS_SHEET = 'line_users';
var LINE_USERS_CACHE_KEY = 'adr008_line_users_v1';
var LINE_USERS_CACHE_TTL = 300;          // 5 分鐘（ADR-008 D-3）

/** 裝置 token 的雜湊表（ADR-010 D-8）。欄位與規則見下方「ADR-010」那一段 */
var LINE_DEVICES_SHEET = 'line_devices';

/** 效能紀錄（ADR-012 D-6）。欄位與規則見檔尾「效能紀錄」那一段 */
var PERFORMANCE_SHEET = 'performance';

/** 記帳分類設定（ADR-013 D-3）。欄位與規則見檔尾「ADR-013」那一段 */
var EXPENSE_CONFIG_SHEET = '_expense_config';

/** 分期計畫（ADR-013 D-6～D-8）。欄位與規則見檔尾「分期」那一段 */
var INSTALLMENTS_SHEET = 'installments';

/** LINE 群組（ADR-013 D-13～D-15）。欄位與規則見 line-router.gs「群組」那一段 */
var LINE_GROUPS_SHEET = 'line_groups';

/**
 * 不歸前端 state 管的分頁：archivePurge 動不得。
 *
 * logs 是 Apps Script 單向寫入的記錄，line_users 是白名單本身——兩者都不屬於
 * 前端那份 state，被批次刪列等於資料消失（line_users 的話還會順便把所有人
 * 鎖在門外，包含改壞它的那個人）。管理頁一律走 upsert 改單列。
 *
 * 原名 NO_REPLACE_ALL；replaceAll 於 ADR-009 退場後改名，規則不變。
 */
var NOT_FRONTEND_SHEETS = [LINE_USERS_SHEET, 'logs', PERFORMANCE_SHEET, EXPENSE_CONFIG_SHEET, INSTALLMENTS_SHEET,
                           LINE_GROUPS_SHEET];

/**
 * PWA 連一筆都不准寫的分頁（任何 action 都一樣，包括 upsert）。
 *
 * _guide 是 refreshGuide() 依 repo 登記表產生出來的（sheet-guide.gs），沒有任何
 * 前端功能需要寫它；寫進去的東西下次更新也會被蓋掉，放行只會製造「明明存了卻
 * 不見」的假象。它比 NOT_FRONTEND_SHEETS 更嚴，所以擋在所有 action 之前，不另外列進去。
 *
 * _expense_config（ADR-013）同理：分類由 Neil 在 Sheet 上改，前端只拿 boot 解析好的結構。
 * installments（ADR-013 D-6）只走 planCreate／planDelete／planEnd：一般 upsert 改得到計畫列，
 * 卻改不到它底下的各期，兩邊從此對不上。
 */
var GUIDE_SHEET = '_guide';
var NO_PWA_WRITE = [GUIDE_SHEET, LINE_DEVICES_SHEET, PERFORMANCE_SHEET, EXPENSE_CONFIG_SHEET, INSTALLMENTS_SHEET,
                    LINE_GROUPS_SHEET];

/**
 * PWA 連讀都不准讀的分頁（ADR-010 D-8）。
 *
 * line_devices 只存雜湊，拿到也換不回 token；但它同時是「誰有幾台裝置、最後
 * 什麼時候用」的清單，沒有任何前端功能需要整張讀走。管理頁要看裝置走
 * listDevices，那條路會把 token_hash 拿掉。line_devices 同時在 NO_PWA_WRITE 裡
 * （比 NOT_FRONTEND_SHEETS 更嚴，理由同 _guide），任何 action 都寫不進去。
 *
 * performance（ADR-012 T1）同理：讀寫都只能透過管理員的 perfSummary／perfPurge，
 * 原始列只由雲端自己寫。
 *
 * line_groups（ADR-013 D-13）：這一輪沒有前端管理介面，Neil 直接在 Sheet 上打勾。
 */
var NO_PWA_READ = [LINE_DEVICES_SHEET, PERFORMANCE_SHEET, LINE_GROUPS_SHEET];

/**
 * 功能矩陣的欄位清單，與前端 FEATURE_BY_VIEW 的值一一對應。
 * 用在「建表」與「註冊」；權限判斷走下面的 canUse_（ADR-012 D-3）。
 */
var LINE_USERS_FEATURES = ['feat_expense', 'feat_tasks', 'feat_review',
                           'feat_notes', 'feat_mood', 'feat_log'];

/**
 * 分頁 ↔ 功能（ADR-012 D-3）。只寫這一份：PWA 讀寫、LINE 前綴、「查/」都查這張表。
 * 不在表上的分頁（line_users、performance…）不受 feat_* 管，由各自的規則把關。
 */
var FEATURE_BY_SHEET = {
  tasks: 'feat_tasks', expenses: 'feat_expense', reviews: 'feat_review',
  notes: 'feat_notes', moods: 'feat_mood', logs: 'feat_log'
};

/** LINE 回覆與「查/」的提示詞要講人話。名稱與前端導覽列一致 */
var FEATURE_LABEL = {
  feat_tasks: '任務', feat_expense: '記帳', feat_review: '日誌',
  feat_notes: '雜記', feat_mood: '心情', feat_log: 'LOG'
};

/**
 * 這個人能不能用這個功能（ADR-012 D-3：feat_* 從「藏畫面」升級為雲端權限）。
 *
 * 規則與前端 featureAllowed／hasFeatureMatrix 一字不差（有測試把兩邊釘在一起）：
 *  - 這一列完全沒有 feat_ 欄 → 開放。矩陣還沒佈到 Sheet 上，全關只會讓人以為壞了
 *  - 有欄但留空 → 關閉（ADR-008 E-2b）
 * 身份與白名單由 authDevice_／writeGate_ 先把關；走到這裡的 user 已經是 active 成員。
 */
function canUse_(user, feature) {
  if (!feature) return true;
  if (!user || !Object.keys(user).some(function (k) { return k.indexOf('feat_') === 0; })) return true;
  return truthy_(user[feature]);
}

function canUseSheet_(user, sheetName) {
  return canUse_(user, FEATURE_BY_SHEET[sheetName]);
}

/** LINE 這一側拿得到的只有 userId，從（有快取的）名單找回那一列。找不到回 null */
function lineUserById_(rawId) {
  var roster = lineUsersRoster_();
  var id = String(rawId == null ? '' : rawId).trim();
  return (roster.ok && roster.users[id]) || null;
}

/** 建表用的完整表頭（ADR-008 D-1 的欄序） */
var LINE_USERS_HEADERS = ['line_id', 'display_name', 'is_active', 'is_admin']
  .concat(LINE_USERS_FEATURES).concat(['created_at', 'updated_at', 'email']);

/**
 * 確保 line_users 有表可寫。只有「註冊」這條路徑會呼叫。
 *
 * 為什麼讓程式建表：沒有這一步，第一個人得先手動開一張分頁、手打十二個欄名，
 * 而那正是註冊功能要消滅的摩擦。建的只是表頭，不寫任何一列資料——名單仍然是空的，
 * 閘門仍然 fail-closed 擋住所有寫入，所以這個動作本身不會放行任何人。
 *
 * 分頁已存在但整張空白（連表頭都沒有）時，補上表頭即可，不重建分頁——
 * 重建會把使用者可能已經手動輸入的東西一起丟掉。
 */
function ensureLineUsersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LINE_USERS_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(LINE_USERS_SHEET);
    sheet.appendRow(LINE_USERS_HEADERS);
    console.log('已建立分頁「' + LINE_USERS_SHEET + '」並寫入表頭');
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LINE_USERS_HEADERS);
    console.log('分頁「' + LINE_USERS_SHEET + '」原本沒有表頭，已補上');
  }
  return sheet;
}

/**
 * Sheet 的勾選框回傳布林 true，手打的會是字串 'TRUE'。兩種都要認得。
 *
 * 空白＝關閉（ADR-008 E-2b）：新功能加一欄之後，既有使用者在該欄是空的，
 * 就該是關的——不確定時寧可少顯示，也不要讓實驗性功能自己跑出來見人。
 * 判斷規則與前端 truthy() 一字不差，兩邊不一致的話同一張表會被讀成兩種結果。
 */
function truthy_(v) {
  if (v === true) return true;
  var t = String(v == null ? '' : v).trim().toUpperCase();
  return t === 'TRUE' || t === '1' || t === 'YES' || t === 'Y';
}

/**
 * 白名單讀取入口：先問快取，沒有才讀 Sheet。
 *
 * 白名單改動頻率極低（家人增減是偶發事件），被讀取的頻率卻高——每次 LINE 訊息、
 * 每次 PWA 同步都要查一次，而 LINE webhook 有回覆時限（ADR-008 F-2）。
 *
 * **只快取成功的讀取**：把失敗也快取起來，等於一次暫時性的 Sheet 故障要讓所有人
 * 被鎖在門外整整五分鐘。
 */
function lineUsersRoster_() {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (err) { cache = null; }

  if (cache) {
    var hit = null;
    try { hit = cache.get(LINE_USERS_CACHE_KEY); } catch (err) { hit = null; }
    if (hit) {
      try { return JSON.parse(hit); } catch (err) { /* 快取壞了就當沒有，往下讀 Sheet */ }
    }
  }

  var roster = readLineUsers_();
  if (cache && roster.ok) {
    try { cache.put(LINE_USERS_CACHE_KEY, JSON.stringify(roster), LINE_USERS_CACHE_TTL); } catch (err) {}
  }
  return roster;
}

/** 管理頁改完白名單後立刻生效，不必等 TTL 到期 */
function invalidateLineUsersCache_() {
  try { CacheService.getScriptCache().remove(LINE_USERS_CACHE_KEY); } catch (err) {}
}

/**
 * 實際讀 Sheet。回傳形狀刻意讓「讀不到」與「讀到了但沒人」分得出來（ADR-008 H-5）：
 *  - ok:false → Sheet 不見了／沒有 line_id 欄／讀取丟例外
 *  - ok:true 且 activeCount === 0 → 表在、讀得到，但沒有任何一列 is_active
 * 兩者都會 fail-closed 拒絕寫入，但寫進 logs 的 detail 不一樣——出事時要分得出來
 * 是「表被誰刪了」還是「勾選框沒人打勾」，這兩件事的修法完全不同。
 */
function readLineUsers_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_USERS_SHEET);
    if (!sheet) return { ok: false, reason: 'sheet_missing', users: {}, activeCount: 0 };

    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return { ok: true, reason: 'empty', users: {}, activeCount: 0 };

    var headers = values[0].map(function (h) { return String(h).trim(); });
    if (headers.indexOf('line_id') === -1) {
      return { ok: false, reason: 'no_line_id_column', users: {}, activeCount: 0 };
    }

    var users = {}, activeCount = 0;
    for (var i = 1; i < values.length; i++) {
      var obj = {};
      for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[i][c];

      var id = String(obj.line_id == null ? '' : obj.line_id).trim();
      if (!id) continue;                       // 空列（Sheet 底部常有）直接跳過
      users[id] = obj;
      if (truthy_(obj.is_active)) activeCount++;
    }
    return { ok: true, reason: activeCount ? 'ok' : 'no_active', users: users, activeCount: activeCount };
  } catch (err) {
    return { ok: false, reason: 'read_failed', error: String(err), users: {}, activeCount: 0 };
  }
}

/**
 * 寫入閘門。任何寫入路徑都先過這裡，通不過就拒絕並寫一列 logs。
 *
 * 一律 fail-closed（ADR-008 F-1）：這次是「新增」一道門，不是「維護」既有可用性。
 * 一出狀況就自動變回全開的門，跟沒有門是同一件事。寧可同步壞掉讓人當場發現。
 *
 * 功能權限（feat_*）不在這裡驗：這道門只回答「這個人能不能進來」，
 * 「進來之後能用哪些功能」由 canUse_ 依分頁判斷（ADR-012 D-3）。
 */
function writeGate_(rawLineId, what) {
  var id = String(rawLineId == null ? '' : rawLineId).trim();
  var roster = lineUsersRoster_();

  if (!roster.ok) {
    return denyWrite_(id, what, 'whitelist_unavailable',
      '白名單讀不到，一律拒絕寫入',
      '原因：' + roster.reason + (roster.error ? '／' + roster.error : '') +
      '（分頁「' + LINE_USERS_SHEET + '」是否存在、是否有 line_id 欄？）');
  }
  if (!roster.activeCount) {
    return denyWrite_(id, what, 'whitelist_empty',
      '白名單讀得到但沒有任何啟用中的成員，一律拒絕寫入',
      '分頁「' + LINE_USERS_SHEET + '」有表頭但沒有任何一列 is_active 為 TRUE');
  }
  if (!id) {
    return denyWrite_(id, what, 'missing_line_id',
      '這次寫入沒有帶 line_id，拒絕',
      '前端尚未選身份，或跑的是改版前的舊版頁面（快取未更新）');
  }

  var user = roster.users[id];
  if (!user) {
    return denyWrite_(id, what, 'not_on_whitelist',
      '這個 line_id 不在白名單內，拒絕',
      '在 ' + LINE_USERS_SHEET + ' 新增一列並把 is_active 勾起來即可放行');
  }
  if (!truthy_(user.is_active)) {
    return denyWrite_(id, what, 'inactive',
      '這個 line_id 的 is_active 不是 TRUE，拒絕',
      '成員在名單上但被停用；要放行就把 is_active 勾起來');
  }
  return { allowed: true, user: user };
}

/**
 * 被擋下來的寫入一律留一列 logs（ADR-008 F-1「不可靜默失敗」）。
 *
 * 包 try/catch 的理由跟 logCleanup_ 一樣：log 是事後回頭查的東西，寫 log 失敗
 * 不該把「已經判定要拒絕」這件事變成別的結果。但拒絕本身一定要有人看得到，
 * 所以另外補一行 console——logs 分頁壞掉時，那行 console 是最後的線索。
 */
function denyWrite_(lineId, what, code, result, detail) {
  console.log('🚫 寫入被白名單擋下（' + code + '）：' + what + ' / line_id=' + (lineId || '(空)'));
  try {
    logTransaction_('同步', '失敗', what, result, detail + '｜code=' + code, '', lineId);
  } catch (err) {
    console.log('寫 logs 失敗（不影響拒絕的結果）：' + err);
  }
  return { allowed: false, error: code, reason: code };
}

/**
 * 白名單健檢——在編輯器裡直接執行，不需重新部署。
 * 比照 diagnoseLogSheet 的用法：改完表、加完人之後跑一次，確認它真的讀得到。
 */
function diagnoseLineUsers() {
  invalidateLineUsersCache_();
  var roster = readLineUsers_();

  if (!roster.ok) {
    console.log('❌ 白名單讀不到：' + roster.reason + (roster.error ? '／' + roster.error : ''));
    console.log('   目前所有寫入都會被拒絕（fail-closed）。');
    return roster;
  }
  console.log('✅ 分頁「' + LINE_USERS_SHEET + '」讀得到，啟用中 ' + roster.activeCount + ' 人');
  Object.keys(roster.users).forEach(function (id) {
    var u = roster.users[id];
    var feats = Object.keys(u).filter(function (k) { return k.indexOf('feat_') === 0 && truthy_(u[k]); });
    console.log('   ' + (truthy_(u.is_active) ? '●' : '○') + ' ' + (u.display_name || '(無稱呼)') +
      ' ' + id + (truthy_(u.is_admin) ? ' [admin]' : '') +
      ' 功能：' + (feats.length ? feats.join(' ') : '（全關）'));
  });
  if (!roster.activeCount) console.log('⚠️ 沒有任何一列 is_active 為 TRUE，目前所有寫入都會被拒絕。');
  return roster;
}

// ===== 讀取：GET /exec?sheet=… 已關閉（ADR-010 D-9，2026-10-01 關門） =====
/**
 * 匿名讀取的門。exec 網址在公開的 index.html 裡，這扇門開著就等於誰都讀得走全部分頁。
 * 讀取一律改走帶 token 的 POST read。
 *
 * 留一支回 gone 的 doGet 而不是整支刪掉：刪掉的話 Google 會回一頁 HTML 錯誤，
 * 還沒更新的舊版 App 只會看到「讀不到雲端」，猜不出是門關了。只留 console 不寫 logs：
 * 舊版前端每 15 秒輪詢五張表，每一次都寫一列會把 logs 灌爆。
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  console.log('🚫 doGet 已關閉：sheet=' + (params.sheet || '?'));
  return jsonOut({ error: 'gone' });
}

/**
 * 讀一張分頁的回應本體。POST read／readTombstones 共用這一份。
 *
 * 墓碑由**後端**濾掉，不指望前端自己 filter（ADR-009 待其他環境知道的事 #4）。
 *
 * 為什麼是後端的責任：前端有好幾條讀取路徑（輪詢、手動刷新、啟動載入），
 * 每條都記得濾一次才會對，漏掉任何一條，已刪除的項目就會從那條路徑跑回畫面上。
 * 擋在唯一的出口，就不需要任何人記得。
 *
 * only='tombstones' 反過來只回墓碑，那是封存第一段要匯出的東西——它們被預設
 * 過濾掉之後，前端再也看不到，所以得留一扇專門的門。
 */
function readSheetResponse_(sheetName, only, keyFieldParam, perf, user) {
  if (NO_PWA_READ.indexOf(sheetName) !== -1) {
    console.log('🚫 拒絕讀取分頁「' + sheetName + '」：它不對 PWA 開放');
    return { error: 'sheet_not_readable', sheet: sheetName };
  }
  if (!canUseSheet_(user, sheetName)) return { error: 'forbidden', sheet: sheetName };
  perf = perf || {};
  var opened = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  perf.open_ms = Date.now() - opened;
  var read = sheetRecords_(ss, sheetName, perf);
  if (read.error) return read;
  const rows = read.rows;

  if (String(only || '').trim() === 'tombstones') {
    var tombs = rows.filter(isTombstone_);
    // 鍵由**後端**算好一起回傳，前端原樣送回來就好。
    //
    // 為什麼不讓前端自己算：回應走 JSON.stringify，Date 會被轉成 UTC ISO 字串，
    // 前端 slice 出來的日期在 UTC+8 可能差一天（就是 DATA-05 那個根）。鍵一旦
    // 對不上，archivePurge 會安靜地一筆都刪不掉——沒有錯誤訊息，只是沒有效果。
    // 同一套規則只留一份實作，就沒有對不上的可能。
    //
    // GET 的 key_field 只能是逗號字串；POST 送上來的可能是陣列，攤平成同一種再拆
    var rawKeyField = Array.isArray(keyFieldParam) ? keyFieldParam.join(',') : (keyFieldParam || 'id');
    var keyField = String(rawKeyField).split(',')
      .map(function (k) { return k.trim(); }).filter(function (k) { return k; });
    var keys = keyFieldsOf_(keyField.length > 1 ? keyField : (keyField[0] || 'id'));
    return {
      data: tombs,
      keys: tombs.map(function (r) { return recordKey_(r, keys); })
    };
  }
  return { data: withoutTombstones_(rows) };
}

/**
 * 一張分頁讀成物件陣列（含墓碑，過濾交給呼叫端）。read、readMany、boot 共用，
 * 讓「開表 → 讀值 → 對表頭」只有一份。perf 的時間與列數用累加：boot 一次讀好幾張。
 */
function sheetRecords_(ss, sheetName, perf) {
  var opened = Date.now();
  var sheet = ss.getSheetByName(sheetName);
  perf.open_ms = (perf.open_ms || 0) + (Date.now() - opened);
  if (!sheet) return { error: 'sheet_not_found', sheet: sheetName };

  var reading = Date.now();
  var values = sheet.getDataRange().getValues();
  perf.read_ms = (perf.read_ms || 0) + (Date.now() - reading);
  perf.rows = (perf.rows || 0) + Math.max(values.length - 1, 0);
  if (values.length < 2) return { rows: [] };

  var headers = values[0];
  return {
    rows: values.slice(1).map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    })
  };
}

/**
 * 一次讀好幾張表（ADR-012 D-1／D-4）。不開放（NO_PWA_READ）或沒有功能權限的表
 * 放進 denied，不報錯——前端把它當成「明確沒權限」，跟「讀取失敗」是兩件事。
 * 分頁還不存在回空陣列，與 read 的 sheet_not_found 同義（前端一直當成「真的空」）。
 */
function readManyFrom_(ss, user, sheets, perf) {
  var data = {};
  var denied = [];
  (Array.isArray(sheets) ? sheets : []).forEach(function (name) {
    if (typeof name !== 'string' || data.hasOwnProperty(name) || denied.indexOf(name) !== -1) return;
    if (NO_PWA_READ.indexOf(name) !== -1 || !canUseSheet_(user, name)) { denied.push(name); return; }
    var read = sheetRecords_(ss, name, perf);
    data[name] = read.error ? [] : withoutTombstones_(read.rows);
  });
  return { data: data, denied: denied };
}

/** 開機時一起帶回的資料表（line_users 另外放，它不是「資料」，是名單） */
var BOOT_SHEETS = ['tasks', 'reviews', 'moods', 'notes', 'expenses'];

/**
 * boot（ADR-012 D-1／D-2）：一個請求帶回 session、名單、有權限的各表。
 * 進到這裡之前 pwaCaller_ 已經驗過 token——驗證沒過，一張資料表都不會讀。
 * 試算表只開一次。
 */
function bootResponse_(caller, perf) {
  var opened = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  perf.open_ms = Date.now() - opened;

  var users = sheetRecords_(ss, LINE_USERS_SHEET, perf);
  var many = readManyFrom_(ss, caller.user, BOOT_SHEETS, perf);
  perf.sheets = [LINE_USERS_SHEET].concat(BOOT_SHEETS).join(',');

  var isAdmin = truthy_((caller.user || {}).is_admin);
  var out = {
    session: {
      status: 'ok',
      line_id: caller.line_id,
      display_name: String((caller.user && caller.user.display_name) || '').trim(),
      device_id: caller.device ? caller.device.device_id : '',
      device_label: caller.device ? caller.device.device_label : '',
      is_admin: isAdmin
    },
    line_users: users.error ? [] : withoutTombstones_(users.rows),
    data: many.data,
    denied: many.denied
  };
  if (isAdmin) out.perf_rows = perfRowCount_();
  return withExpenseConfig_(out, caller.user, ss, BOOT_SHEETS);
}

/**
 * boot 與 readMany 都帶分類設定（ADR-013 D-3）。只給這次真的讀了 expenses、而且有記帳權限的人。
 *
 * 為什麼 readMany 也要帶：只有 boot 帶的話，開機那一趟一失敗（GAS 冷啟動、手機網路差），
 * 接手的 15 秒輪詢走的是 readMany——資料回來了、連線燈也綠了，分類列卻永遠是空的
 * （2026-10-06 實機回報）。設定有 5 分鐘快取，多帶一份幾乎不花成本。
 * 用呼叫端開好的 ss：boot 只開一次試算表。
 */
function withExpenseConfig_(out, user, ss, sheets) {
  if ((sheets || []).indexOf('expenses') !== -1 && canUseSheet_(user, 'expenses')) {
    out.expense_config = expenseConfigPublic_(expenseConfig_(ss));
    // 分期計畫（D-6）跟著同一個條件走：列表上的「剩 M 期共 X 元」要用計畫的總額與狀態
    out.installments = installmentPlans_(ss);
  }
  return out;
}

/** 沒有功能權限的寫入：擋下並留一列 logs（ADR-008 F-1「不可靜默失敗」的同一套做法） */
function featureForbidden_(caller, action, sheetName) {
  var feature = FEATURE_BY_SHEET[sheetName];
  console.log('🚫 沒有功能權限：' + action + ' → ' + sheetName + ' / line_id=' + caller.line_id);
  logTransaction_('同步', '失敗', 'PWA ' + action + ' → ' + sheetName,
    '沒有「' + (FEATURE_LABEL[feature] || feature) + '」功能的權限，拒絕',
    'code=forbidden｜' + feature, '', caller.line_id);
  return { error: 'forbidden', sheet: sheetName };
}

// ===== 所有 PWA 請求：POST body = { token, sheet, action, ... } =====
// 外層只負責量時間與寫效能紀錄（ADR-012 T1）；分流在 routePwaSync_。
function handlePwaSync_(e) {
  var started = Date.now();
  const body = JSON.parse(e.postData.contents);
  var perf = {};
  var out = routePwaSync_(body, perf);
  recordPerf_(body, perf, Date.now() - started);
  return out;
}

/** perf 由各分支填：who（通過驗證才有）、auth_ms、open_ms、read_ms、rows */
function routePwaSync_(body, perf) {
  // 不需要（或還沒有）有效 token 的三扇門：配對、查狀態、過期續期（ADR-010 D-3）
  if (body.action === 'pairClaim') return jsonOut(pairClaim_(body.code, body.device_label));
  if (body.action === 'session') {
    var authStarted = Date.now();
    var s = deviceSession_(body.token);
    perf.auth_ms = Date.now() - authStarted;
    if (s.status === 'ok') perf.who = { line_id: s.line_id, device_id: s.device_id };
    return jsonOut(s);
  }
  if (body.action === 'renewStart') return jsonOut(renewStart_(body.token));

  // 身份一律由後端換出來，不信任 body 裡的 line_id（ADR-010 D-2）
  var callerStarted = Date.now();
  const caller = pwaCaller_(body);
  perf.auth_ms = Date.now() - callerStarted;
  if (!caller.ok) return jsonOut({ error: caller.error, reason: caller.error });
  perf.who = { line_id: caller.line_id, device_id: caller.device ? caller.device.device_id : '' };

  if (body.action === 'boot') return jsonOut(bootResponse_(caller, perf));
  if (body.action === 'readMany') {
    perf.sheets = Array.isArray(body.sheets) ? body.sheets.filter(function (x) { return typeof x === 'string'; }).join(',') : '';
    var openedMany = Date.now();
    var ssMany = SpreadsheetApp.getActiveSpreadsheet();
    perf.open_ms = Date.now() - openedMany;
    var many = readManyFrom_(ssMany, caller.user, body.sheets, perf);
    return jsonOut(withExpenseConfig_(many, caller.user, ssMany, Array.isArray(body.sheets) ? body.sheets : []));
  }
  if (body.action === 'read') return jsonOut(readSheetResponse_(body.sheet, '', '', perf, caller.user));
  if (body.action === 'readTombstones') {
    return jsonOut(readSheetResponse_(body.sheet, 'tombstones', body.key_field, perf, caller.user));
  }
  if (body.action === 'listDevices') return jsonOut(listDevices_(caller, body.line_id));
  if (body.action === 'revokeDevice') return jsonOut(revokeDevices_(caller, body.device_id, body.all_of));
  if (body.action === 'archiveMail') return jsonOut(archiveByMail_(caller));
  if (body.action === 'setMyEmail') return jsonOut(setMyEmail_(caller, body.email));
  if (body.action === 'perfSummary') return jsonOut(perfSummary_(caller));
  if (body.action === 'perfPurge') return jsonOut(perfPurge_(caller, body.days));
  if (body.action === 'adminView') return jsonOut(adminView_(caller, body.what));
  if (body.action === 'groupSet') return jsonOut(groupSet_(caller, body.group_id, body.field, body.value));
  if (body.action === 'configSet') return jsonOut(configSet_(caller, body.key, body.field, body.value));
  if (body.action === 'configAdd') return jsonOut(configAdd_(caller, body.record));
  if (body.action === 'planCreate') return jsonOut(planCreate_(caller, body));
  if (body.action === 'planDelete') return jsonOut(planDelete_(caller, body.plan_id));
  if (body.action === 'planEnd') return jsonOut(planEnd_(caller, body.plan_id, body.today));

  if (NO_PWA_WRITE.indexOf(body.sheet) !== -1) {
    console.log('🚫 拒絕對分頁「' + body.sheet + '」做 ' + body.action + '：它是產生出來的，不收寫入');
    return jsonOut({ error: 'sheet_not_writable', sheet: body.sheet });
  }
  if (!canUseSheet_(caller.user, body.sheet)) return jsonOut(featureForbidden_(caller, body.action, body.sheet));

  var opened = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(body.sheet);
  perf.open_ms = Date.now() - opened;
  if (!sheet) return jsonOut({ error: 'sheet_not_found' });

  if (body.action === 'upsert') {
    const headers = sheetHeaders_(sheet);
    // key_field 可以是字串或陣列：line_users 用 'line_id'，reviews 用
    // ['review_date','line_id']（那張表沒有 id 欄，ADR-009 §一.5）
    const record = body.sheet === TASKS_SHEET ? keepOriginChat_(sheet, headers, body.record || {}) : (body.record || {});
    const out = upsertRow_(sheet, headers, record, body.sheet, body.key_field);
    if (body.sheet === LINE_USERS_SHEET) invalidateLineUsersCache_();
    return jsonOut(out);
  }

  /**
   * 週期任務完成：原列收尾、新增一列接手下一期（ADR-009 §四）。
   *
   * ⚠️ ADR 沒寫到、但不處理就會出事的地方：**重複打勾會不會生出兩列。**
   * 使用者把已完成的週期任務取消打勾再重新打勾，天真的實作會再生一列下一期。
   *
   * 解法不需要新欄位：生出下一期的同時，把**週期設定搬到新的那一列**、從原列
   * 清掉。原列從此不是週期任務，再怎麼打勾都不會再生。週期本來就該跟著「還沒
   * 做的那一期」走，這不是為了防呆而扭曲的設計，是本來就該長的樣子。
   */
  if (body.action === 'completeRecurring') {
    const headers = sheetHeaders_(sheet);
    const rec = keepOriginChat_(sheet, headers, body.record || {});
    const next = nextDueDate_(rec.due_date, rec.recur_interval, rec.recur_unit,
                              keyValue_(body.today) || keyValue_(new Date()));

    // 算不出下一期（沒設週期、單位不認得、日期壞掉）就當一般完成處理，不硬生
    if (!next) {
      const plain = upsertRow_(sheet, headers, rec, body.sheet, body.key_field);
      return jsonOut({ success: true, spawned: false, reason: 'not_recurring', row: plain.row });
    }

    // 下一期：新的 id、接手週期設定、到期日換成下一期，notified 天生為空
    const child = {};
    headers.forEach(function (h) { child[h] = rec[h] == null ? '' : rec[h]; });
    child.id = String(body.next_id || Date.now());
    child.is_completed = '';
    child.due_date = next;
    child.notified = '';
    child.del = '';

    // 原列：標完成，並把週期設定交出去——它不再是週期任務
    const done = {};
    headers.forEach(function (h) { done[h] = rec[h] == null ? '' : rec[h]; });
    done.is_completed = 'TRUE';
    done.recur_interval = '';
    done.recur_unit = '';

    upsertRow_(sheet, headers, done, body.sheet, body.key_field);
    const added = upsertRow_(sheet, headers, child, body.sheet, body.key_field);

    logCleanup_('週期任務 ' + body.sheet + ' id=' + rec.id,
      '完成並接手下一期 ' + next,
      '新列 id=' + child.id + '；週期設定已從原列移交，重複打勾不會再生');
    return jsonOut({ success: true, spawned: true, next_due: next, next_id: child.id, row: added.row });
  }

  /**
   * 封存第二段（ADR-009 §一.4）：前端回報「已成功下載」之後，才真的刪。
   *
   * 送上來的 keys 是第一段（?only=tombstones）匯出的那一批。後端不信任這份清單
   * 本身——purgeTombstoneRows_ 會再確認每一列此刻仍然是墓碑才動手。清單空的
   * 就什麼都不刪。
   */
  if (body.action === 'archivePurge') {
    if (NOT_FRONTEND_SHEETS.indexOf(body.sheet) !== -1) {
      console.log('🚫 拒絕對分頁「' + body.sheet + '」做 archivePurge：它不歸前端管');
      return jsonOut({ error: 'sheet_not_purgeable', sheet: body.sheet });
    }
    const headers = sheetHeaders_(sheet);
    const out = purgeTombstoneRows_(sheet, headers, body.sheet, body.key_field, body.keys || []);
    return jsonOut({
      success: true, deleted: out.deleted, rows: out.rows, skipped: out.skipped
    });
  }

  /**
   * replaceAll 已退場（ADR-009 §一.2）：前端改送單筆 upsert 之後，沒有任何呼叫端。
   *
   * 不只是刪掉它，而是明確拒絕並記一筆 logs：它是整個系統破壞力最大的一個動作
   * （一個請求清空整張表），而 CLOUD_SECRET 公開在部署出去的 index.html 裡、
   * doGet 讀得到 line_users。留著它等於留一個「一次清空」的按鈕給拿到網址的人。
   * 萬一真有舊前端送上來，logs 裡看得到，不會安靜地什麼都沒發生。
   */
  if (body.action === 'replaceAll') {
    console.log('🚫 拒絕 replaceAll → ' + body.sheet + '：已於 ADR-009 退場');
    try {
      logTransaction_('同步', '失敗', 'replaceAll ' + body.sheet,
        '已退場的動作，拒絕執行', 'ADR-009 後前端只送 upsert；若這筆來自舊版 App，請重開 App', '', caller.line_id);
    } catch (err) {
      console.log('寫 logs 失敗（主流程不受影響）：' + err);
    }
    return jsonOut({ error: 'action_retired', action: 'replaceAll' });
  }

  return jsonOut({ error: 'unknown_action' });
}

/* ========================================================================== */
/* 鍵欄：單欄或複合鍵（ADR-009 §一.5）                                         */
/* ========================================================================== */

/**
 * 複合鍵的分隔符，與前端 reviewKey() 同一個字元。
 * 日期是 YYYY-MM-DD、line_id 是英數，兩者都不可能出現它，拆回來不會拆錯。
 */
var KEY_SEPARATOR = '|';

/**
 * key_field 可以是字串（'id'、'line_id'）或陣列（['review_date','line_id']）。
 * 省略、空字串、空陣列一律回到預設的 id——沒有鍵的 upsert 會退化成 append，
 * 那正是 ADR-007 要根治的東西，不能讓它從「參數忘了傳」這條路溜回來。
 */
function keyFieldsOf_(keyField) {
  if (Array.isArray(keyField)) {
    const picked = keyField.filter(k => k != null && k !== '').map(String);
    return picked.length ? picked : ['id'];
  }
  return (keyField == null || keyField === '') ? ['id'] : [String(keyField)];
}

/**
 * 把一格值正規化成可以互相比對的字串。
 *
 * ⚠️ 日期欄是這裡唯一的陷阱，也是 reviews 非用複合鍵不可的連帶代價：Sheet 讀回來的
 * review_date 是 Date 物件，前端送上來的是 'YYYY-MM-DD' 字串。直接 String() 會得到
 * 'Mon Sep 16 2026 00:00:00 GMT+0800'，兩邊永遠對不上，於是每次 upsert 都變成
 * append——正好是這次要根治的重複列，從另一個方向長回來。
 *
 * 取本地年月日而不是 toISOString()：後者是 UTC，在 UTC+8 會把當天算成前一天。
 */
function keyValue_(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    const pad = n => (n < 10 ? '0' : '') + n;
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  return String(v).trim();
}

/**
 * 一筆記錄的鍵。任何一個鍵欄是空的，就當作整筆沒有鍵（回空字串）——
 * 半個鍵比沒有鍵更危險：'2026-09-16|' 會跟另一個沒有 line_id 的人對上。
 */
function recordKey_(record, keys) {
  if (!record) return '';
  const parts = [];
  for (let i = 0; i < keys.length; i++) {
    const v = keyValue_(record[keys[i]]);
    if (!v) return '';
    parts.push(v);
  }
  return parts.join(KEY_SEPARATOR);
}

/**
 * 以鍵欄定位既有列 → 覆蓋；找不到才 append（ADR-007 票 A；ADR-009 §一.5 擴充複合鍵）。
 *
 * 鍵欄預設是 id；line_users 傳 key_field='line_id'（ADR-008 D-4 的管理頁走這條）；
 * reviews 沒有 id 欄，傳 key_field=['review_date','line_id'] 走複合鍵。
 * 遇到多筆同鍵：覆蓋第一筆、刪除其餘，並寫進 logs——讓系統自帶清理能力。
 *
 * 比對方式是「整段資料範圍撈進記憶體再線性搜尋」。不建索引、不維護對照表：
 * 資料量以百為單位，簡單優先。
 *
 * 找不到鍵欄、或這筆記錄的鍵不完整時，退回單純 append 但**留一行 console**。
 * 靜默失敗在這個專案已經貴過三次了。
 */
function upsertRow_(sheet, headers, record, sheetName, keyField) {
  const keys = keyFieldsOf_(keyField);
  const row = headers.map(h => record[h] ?? '');
  const cols = keys.map(k => headers.indexOf(k) + 1);     // 1-based；0 代表找不到
  const missingCols = keys.filter((k, i) => cols[i] === 0);
  const recKey = recordKey_(record, keys);

  if (missingCols.length || !recKey) {
    console.log('upsert 退回 append（' +
      (missingCols.length
        ? '分頁「' + sheetName + '」沒有 ' + missingCols.join('、') + ' 欄'
        : '這筆記錄的鍵不完整：' + keys.join('＋')) + '）');
    sheet.appendRow(row);
    return { success: true, row: sheet.getLastRow(), updated: false, cleaned: 0 };
  }

  const matches = findRowsByKey_(sheet, cols, recKey);
  if (!matches.length) {
    sheet.appendRow(row);
    return { success: true, row: sheet.getLastRow(), updated: false, cleaned: 0 };
  }

  const target = matches[0];
  sheet.getRange(target, 1, 1, headers.length).setValues([row]);

  // 由下往上刪，否則刪掉一列之後下面的列號會整個位移，刪錯人
  const extras = matches.slice(1).sort((a, b) => b - a);
  extras.forEach(r => sheet.deleteRow(r));

  if (extras.length) {
    logCleanup_(
      'upsert ' + sheetName + ' ' + keys.join(KEY_SEPARATOR) + '=' + recKey,
      '覆蓋第 ' + target + ' 列，刪除重複 ' + extras.length + ' 列',
      '刪除的列號：' + extras.slice().sort((a, b) => a - b).join(', ')
    );
  }
  return { success: true, row: target, updated: true, cleaned: extras.length };
}

/**
 * 回傳鍵欄組合等於 wantedKey 的所有列號（1-based，含表頭偏移）。
 * 鍵不完整的列直接跳過，理由同 recordKey_：半個鍵不該跟任何人對上。
 */
function findRowsByKey_(sheet, cols, wantedKey) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const width = Math.max.apply(null, cols);
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const matches = [];
  values.forEach((row, i) => {
    const parts = cols.map(c => keyValue_(row[c - 1]));
    if (parts.every(p => p) && parts.join(KEY_SEPARATOR) === wantedKey) matches.push(i + 2);
  });
  return matches;
}

/** 表頭列。欄序不寫死，日後在 Sheet 調整欄位順序也不必回頭改程式 */
function sheetHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
}

/**
 * 自動清理必須留下記錄，不可靜默刪列（ADR-007 E-3 §3）。
 *
 * 借用 line-router.gs 的 logTransaction_（同一個 Apps Script 專案共用全域範圍）。
 * 整支包在 try/catch 裡：log 是事後回頭查的東西，不是交易本身——寫 log 失敗
 * 不該讓一次已經成功的同步變成失敗。
 *
 * source 寫「同步」：前端 LOG 頁的來源篩選鈕只有任務／記帳／收入／查詢四種，
 * 這一類會出現在「全部」底下而沒有專屬按鈕。這是刻意的——它不是使用者輸入的
 * 交易，不該跟那四種混在同一排篩選鈕裡。
 */
function logCleanup_(input, result, detail) {
  try {
    logTransaction_('同步', '成功', input, result, detail, '', '');
  } catch (err) {
    console.log('寫 logs 失敗（主流程不受影響）：' + err);
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================================================================== */
/* ADR-009 Phase 0 — 軟刪除、兩段式封存、欄位安裝                              */
/*                                                                            */
/* 已接線（2026-09-16 起）：doGet 的墓碑過濾、兩段式封存、前端的即時 upsert    */
/* 都走這一段。Phase 0 時先寫函式與測試、報告經 Neil 確認才接手既有模組的讀寫   */
/* 路徑，是 ADR-009「待其他環境知道的事 #1」要求的施工順序。                    */
/*                                                                            */
/* 例外是 ensureAdr009Columns()：那是給 Neil 在 Apps Script 編輯器手動執行一次 */
/* 的安裝函式（操作方式比照 diagnoseLineUsers）。它不會自己跑，也不在任何同步   */
/* 路徑上。                                                                    */
/* ========================================================================== */

/** 軟刪除旗標欄（ADR-009 §一.3）。空白＝沒刪，判斷規則沿用 truthy_ */
var DEL_FIELD = 'del';

/** 這一列是不是墓碑（已軟刪除） */
function isTombstone_(record) {
  return !!record && truthy_(record[DEL_FIELD]);
}

/**
 * 濾掉墓碑列（ADR-009 §一.3；待其他環境知道的事 #4 要求由後端負責，不指望前端自己 filter）。
 *
 * 「沒有 del 欄」與「del 是空的」都當成沒刪——欄位安裝前全表照常回傳，
 * 不會因為少一個欄位就把所有資料藏起來。這是刻意選的方向：比照 ADR-008 E-2
 * 「欄位不存在＝視為開放」，寧可多顯示，也不要讓一次漏裝欄位看起來像資料全毀。
 */
function withoutTombstones_(rows) {
  if (!rows || !rows.length) return [];
  return rows.filter(r => !isTombstone_(r));
}

/**
 * 封存第一段：把整張分頁的墓碑列撈出來交給前端匯出（ADR-009 §一.4）。
 *
 * 回傳每列的鍵與列號。鍵就是第二段刪除時要比對的憑據——列號會因為任何一次
 * 插入刪除而位移，不能當憑據，所以兩段之間傳的是鍵不是列號。
 */
function tombstoneRows_(sheet, headers, keyField) {
  const keys = keyFieldsOf_(keyField);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !headers.length) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const out = [];
  values.forEach((row, i) => {
    const record = {};
    headers.forEach((h, c) => { record[h] = row[c]; });
    if (!isTombstone_(record)) return;
    out.push({ key: recordKey_(record, keys), row: i + 2, record: record });
  });
  return out;
}

/**
 * 封存第二段：前端回報「已成功下載」之後，才真的把這些列刪掉（ADR-009 §一.4）。
 *
 * 兩道鎖，缺一不可：
 *   1. 鍵必須在 confirmedKeys 裡——沒被匯出過的列一律不動
 *   2. 該列此刻仍然是墓碑——中途被誰改回來（取消 del）就放過它
 *
 * 清單是空的就什麼都不刪，直接回 0。「沒有東西要刪」與「把整張表刪光」之間
 * 不該只差一個空陣列——這正是 ADR 說的「不先斬後奏」，鎖在程式裡而不是在紀律裡。
 */
function purgeTombstoneRows_(sheet, headers, sheetName, keyField, confirmedKeys) {
  const wanted = {};
  (confirmedKeys || []).forEach(k => { const s = keyValue_(k); if (s) wanted[s] = true; });
  const wantedCount = Object.keys(wanted).length;
  if (!wantedCount) return { deleted: 0, rows: [], skipped: 0 };

  const hit = tombstoneRows_(sheet, headers, keyField).filter(c => c.key && wanted[c.key]);
  // 由下往上刪，否則刪掉一列之後下面的列號會整個位移，刪錯人
  const rows = hit.map(c => c.row).sort((a, b) => b - a);
  rows.forEach(r => sheet.deleteRow(r));

  const ordered = rows.slice().sort((a, b) => a - b);
  if (rows.length) {
    logCleanup_(
      'archive ' + sheetName,
      '確認匯出後刪除墓碑 ' + rows.length + ' 列（清單共 ' + wantedCount + ' 筆）',
      '刪除的列號：' + ordered.join(', ')
    );
  }
  return { deleted: rows.length, rows: ordered, skipped: wantedCount - rows.length };
}

/**
 * ADR-009 新增的欄位（待其他環境知道的事 #7）。
 * 只補清單裡缺的，既有欄位與資料一概不動。
 */
var ADR009_COLUMNS = {
  // origin_chat：ADR-014 D-17（群組建立的任務記下群組 ID，到期提醒推回那個群組）
  tasks:    ['del', 'archive', 'board', 'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat'],
  expenses: ['del', 'archive', 'board'],
  notes:    ['del', 'archive', 'board'],
  reviews:  ['del', 'archive'],
  moods:    ['del', 'archive']
};

/**
 * 把 wanted 裡缺的欄名 append 到表頭最右邊，回傳這次補了什麼。
 * 一律往右加、不插入中間：寫入端（upsert、LINE 的 appendToSheet_）都依表頭名稱
 * 對位，欄序不影響正確性；往右加只是讓既有欄位的位置不變，方便人工對照。
 * （原本的理由是 replaceAll 依位置整張重寫，已於 ADR-009 退場。）
 */
function ensureColumnsOnSheet_(sheet, wanted) {
  const headers = sheetHeaders_(sheet);
  if (!headers.length) return { added: [], existing: [], reason: 'no_header' };

  const have = {};
  headers.forEach(h => { if (h) have[h] = true; });
  const missing = wanted.filter(c => !have[c]);
  if (!missing.length) return { added: [], existing: wanted.slice() };

  sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
  return { added: missing, existing: wanted.filter(c => have[c]) };
}

/**
 * 欄位安裝——在 Apps Script 編輯器裡選這個函式按「執行」，跑一次就好。
 *
 * 為什麼不做成每次同步自動檢查（ADR-009 待其他環境知道的事 #7）：那等於每一次
 * 寫入都多讀一次表頭，而這件事一輩子只需要發生一次。比照 diagnoseLineUsers()
 * 的操作方式，手動執行、看執行記錄。
 *
 * 分頁不存在就略過不建：ADR-009 之後 upsert 找不到分頁會回 sheet_not_found，
 * 不會自動建表。缺分頁代表環境有問題，要人去看，不在這裡默默補一張。
 */
function ensureAdr009Columns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summary = {};

  Object.keys(ADR009_COLUMNS).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      console.log('⏭️ 分頁「' + name + '」不存在，略過（upsert 不會自動建表，請先確認試算表是否正確）');
      summary[name] = { added: [], existing: [], reason: 'sheet_missing' };
      return;
    }
    const result = ensureColumnsOnSheet_(sheet, ADR009_COLUMNS[name]);
    if (result.reason === 'no_header') {
      console.log('⚠️ 分頁「' + name + '」連表頭都沒有，略過（先跑一次同步把表頭長出來再回來執行）');
    } else if (result.added.length) {
      console.log('✅ 分頁「' + name + '」補上欄位：' + result.added.join('、'));
    } else {
      console.log('✔ 分頁「' + name + '」欄位已齊備，未變動');
    }
    summary[name] = result;
  });

  console.log('—— ADR-009 欄位安裝完成。此函式可重複執行，已存在的欄位不會被動到。');
  return summary;
}

/**
 * tasks.origin_chat 只有 LINE 寫得進去（ADR-014 D-17）：PWA 送上來的值一律不信，
 * 改用雲端那一列現有的值（新任務＝空白）。
 *
 * 為什麼在後端守、不只靠前端原樣帶回：upsert 是整列覆寫，而 Service Worker 快取住的
 * 舊版 App 不知道有這一欄——它送上來的 record 沒有 origin_chat，一編輯就會把群組
 * 任務洗成個人任務，提醒從此推錯地方，而且是安靜的。
 * 表上還沒有這一欄就原樣回傳（多讀一次也沒東西可保留）。
 */
function keepOriginChat_(sheet, headers, record) {
  var out = Object.assign({}, record);
  var col = headers.indexOf('origin_chat') + 1;
  var idCol = headers.indexOf('id') + 1;
  if (!col) { delete out.origin_chat; return out; }
  out.origin_chat = '';
  var id = keyValue_(record && record.id);
  if (!idCol || !id) return out;
  var rows = findRowsByKey_(sheet, [idCol], id);
  if (rows.length) out.origin_chat = keyValue_(sheet.getRange(rows[0], col, 1, 1).getValues()[0][0]);
  return out;
}

/* ========================================================================== */
/* ADR-009 §四 — 週期提醒的日期算法（Phase 2 純邏輯，仍未接線）                 */
/*                                                                            */
/* 一樣沒有呼叫端。這一段是「不會跟 security 分支對撞」的那一半：全新程式碼、    */
/* 純函式、不碰任何既有讀寫路徑。同步層的重寫等那條分支進來再做。                */
/*                                                                            */
/* 算法歸後端而不是前端，理由同「待其他環境知道的事 #4」：同一套規則有兩份實作， */
/* 遲早漂移，而漂移的那天沒有人會收到通知——它只會安靜地算錯日期。              */
/* ========================================================================== */

/** 週期單位。刻意不開放秒／分鐘／小時（ADR-009 §四），沒有真實需求撐著 */
var RECUR_UNITS = {
  '天': 'day',   'day': 'day',     'days': 'day',
  '週': 'week',  'week': 'week',   'weeks': 'week',
  '月': 'month', 'month': 'month', 'months': 'month',
  '年': 'year',  'year': 'year',   'years': 'year'
};

/** 防呆上限。正常資料跑不到這個數，跑到了代表輸入有問題，寧可回空也不要無窮迴圈 */
var RECUR_MAX_STEPS = 5000;

/**
 * 把 'YYYY-MM-DD' 轉成 Date。
 *
 * 取當地中午而不是午夜：午夜是日界線，任何一點時區或日光節約的偏移都會讓日期
 * 掉到前一天。台北沒有日光節約，但這支函式不該只在台北才是對的。
 */
function parseDateKey_(key) {
  var s = keyValue_(key);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  // new Date(2026, 1, 31) 會自己滾成 3/3。滾掉了就代表原本那個日期不存在。
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 ||
      d.getDate() !== Number(m[3])) return null;
  return d;
}

/** 那個月有幾天。用「下個月的第 0 天」問，比自己記閏年規則可靠 */
function daysInMonth_(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 加一個週期。
 *
 * ⚠️ 月與年要夾住月底，否則 1/31 + 1 個月會變成 3/3——JavaScript 的 Date 會把
 * 不存在的 2/31 自己往後滾，而那是靜默的：使用者只會看到「我的月底提醒跑到
 * 三月初了」，不會有任何錯誤訊息。夾到 2/28（閏年 2/29）才是月結提醒該有的樣子。
 */
function addPeriod_(date, interval, unit) {
  var y = date.getFullYear(), m = date.getMonth(), d = date.getDate();

  if (unit === 'day')  return new Date(y, m, d + interval, 12, 0, 0, 0);
  if (unit === 'week') return new Date(y, m, d + interval * 7, 12, 0, 0, 0);

  var months = (unit === 'year') ? interval * 12 : interval;
  var total = y * 12 + m + months;
  var ny = Math.floor(total / 12), nm = total % 12;
  return new Date(ny, nm, Math.min(d, daysInMonth_(ny, nm)), 12, 0, 0, 0);
}

/**
 * 下一期的到期日（ADR-009 §四）。
 *
 * 規則是「**原訂到期日** + 週期」，不是「完成當下 + 週期」——每月 5 號繳費的人
 * 拖到 20 號才打勾，下一期仍然是下個月 5 號，不會被拖成 20 號。這是刻意的：
 * 週期提醒追的是那件事本身的節奏，不是使用者的手速。
 *
 * 算出來仍在過去就持續累加，直到落在今天或之後（擱置很久的項目一次追回來，
 * 不會生出一串已經過期的新列）。
 *
 * ⚠️ 已知限制：月底的錨點會漂移。1/31 的下一期被夾成 2/28 之後，再下一期是
 * 3/28 而不是 3/31——因為每一期只把「上一期的 due_date」傳下去，ADR 說的那個
 * 「原訂到期日」在第一次夾值之後就遺失了。修法需要一個記住原始錨點的欄位，
 * 而那是 ADR 欄位清單之外的 schema 決策，未經裁決前不自行擴充。
 *
 * 回空字串代表「沒有下一期」：沒設週期、週期不合法、或單位不認得。呼叫端看到
 * 空字串就當一次性項目處理，不要自己補預設值。
 */
function nextDueDate_(baseDue, interval, unit, todayKey) {
  var base = parseDateKey_(baseDue);
  if (!base) return '';

  var n = Number(interval);
  if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) return '';

  var u = RECUR_UNITS[keyValue_(unit)];
  if (!u) return '';

  var today = parseDateKey_(todayKey) || new Date();
  var next = addPeriod_(base, n, u);
  var steps = 0;
  while (next < today && steps < RECUR_MAX_STEPS) {
    next = addPeriod_(next, n, u);
    steps++;
  }
  if (steps >= RECUR_MAX_STEPS) {
    console.log('nextDueDate_ 累加超過上限就停手了：base=' + baseDue +
                ' interval=' + interval + ' unit=' + unit);
    return '';
  }
  return keyValue_(next);
}

/**
 * 到期區塊（ADR-009 §四）。
 *
 * 做區塊分類而不是對逐筆項目疊顏色燈號，是為了不跟既有 priority 的紅黃綠燈
 * 撞語意——同一列同時有兩種顏色，使用者只會困惑哪個才算數。
 *
 * ⚠️ ADR 寫的是「1 天／3 天／5 天／7 天以上四個門檻」，但 1/3/5 之後的第四塊
 * 若是「7 天以上」，第 6 天就沒有歸屬。這裡採唯一能整除這四塊的讀法：
 * ≤1／≤3／≤5／其餘。已過期也沒寫，另外回 'overdue' 讓呼叫端自己決定要獨立
 * 一塊還是併進最急那塊——把它塞進「1 天內」會是假話。兩點都已列進報告請 Neil 裁。
 */
var DUE_THRESHOLDS = [
  { key: 'd1', maxDays: 1 },
  { key: 'd3', maxDays: 3 },
  { key: 'd5', maxDays: 5 }
];
var DUE_BUCKET_LATER = 'later';

/** 兩個日期相差幾天（負數代表已過期）。以當地中午相減，不受時區小數影響 */
function daysUntil_(dueKey, todayKey) {
  var due = parseDateKey_(dueKey), today = parseDateKey_(todayKey);
  if (!due || !today) return null;
  return Math.round((due - today) / 86400000);
}

function dueBucket_(dueKey, todayKey) {
  var days = daysUntil_(dueKey, todayKey);
  if (days === null) return '';          // 沒設到期日的一般任務，不落入任何區塊
  if (days < 0) return 'overdue';
  for (var i = 0; i < DUE_THRESHOLDS.length; i++) {
    if (days <= DUE_THRESHOLDS[i].maxDays) return DUE_THRESHOLDS[i].key;
  }
  return DUE_BUCKET_LATER;
}

/** 會觸發通知的區塊：跨進「3 天內」這條紅燈門檻（含已過期） */
var NOTIFY_BUCKETS = { overdue: true, d1: true, d3: true };

/**
 * 這一列現在該不該推通知（ADR-009 C5）。
 *
 * 只推一次：跨進 3 天門檻的當下發送，之後靠 notified 旗標擋掉重複。新一期是
 * 新增的一列，旗標天生為空，所以不需要任何重置邏輯——這是「完成後新增一列」
 * 而不是「原地改 due_date」換來的好處。
 *
 * 已完成、已軟刪除的一律不推。沒有 line_id 也不推：ADR 說通知送給該筆任務的
 * owner，沒有 owner 就沒有收件人，硬推會推給錯的人。
 */
function shouldNotify_(record, todayKey) {
  if (!record) return false;
  if (truthy_(record.is_completed)) return false;
  if (isTombstone_(record)) return false;
  if (truthy_(record.notified)) return false;
  if (!keyValue_(record.line_id)) return false;
  return !!NOTIFY_BUCKETS[dueBucket_(record.due_date, todayKey)];
}

/* ========================================================================== */
/* ADR-009 §四 C5 — 到期檢查與通知（每天一次的時間驅動觸發器）                  */
/* ========================================================================== */

var TASKS_SHEET = 'tasks';
var DUE_CHECK_FUNCTION = 'checkDueReminders';
var DUE_CHECK_HOUR = 9;          // 早上九點。到期提醒在半夜推沒有意義

/**
 * 安裝時間驅動觸發器（待其他環境知道的事 #5）。
 *
 * 為什麼寫成程式碼而不是在編輯器裡手動加：手動加的觸發器不在 repo 裡，
 * 換人接手時沒有任何線索告訴他「有個東西每天早上九點會自己跑」。這個專案的
 * 紀律是 GitHub 是唯一真相，那就不該有一段只存在於某個網頁設定畫面裡的行為。
 *
 * 先刪同名的舊觸發器再建：重複執行這支函式不會累積出三個觸發器、一天推三次。
 * 部署完成後在編輯器手動執行一次即可，之後不必再管。
 */
function installAdr009Triggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DUE_CHECK_FUNCTION) { ScriptApp.deleteTrigger(t); removed++; }
  });
  if (removed) console.log('移除了 ' + removed + ' 個同名的舊觸發器（避免一天推多次）');

  ScriptApp.newTrigger(DUE_CHECK_FUNCTION).timeBased().atHour(DUE_CHECK_HOUR).everyDays(1).create();
  console.log('✅ 已建立每日觸發器：' + DUE_CHECK_FUNCTION + '，每天約 ' + DUE_CHECK_HOUR + ' 點執行');
  console.log('   這支函式可重複執行，不會累積出多個觸發器。');
  return { removed: removed, created: DUE_CHECK_FUNCTION, hour: DUE_CHECK_HOUR };
}

/** 移除觸發器。決定不用這個功能時，有個乾淨的關法比留著讓它每天空跑好 */
function uninstallAdr009Triggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DUE_CHECK_FUNCTION) { ScriptApp.deleteTrigger(t); removed++; }
  });
  console.log(removed ? ('已移除 ' + removed + ' 個到期檢查觸發器') : '沒有找到到期檢查觸發器');
  return { removed: removed };
}

/**
 * 挑出這一輪該推通知的列。純函式，與 Sheet 和 LINE 都無關——
 * 到期判斷是這個功能最容易出錯的地方，把它跟 I/O 分開才測得動。
 */
function dueRemindersToNotify_(records, todayKey) {
  if (!records || !records.length) return [];
  return records.filter(function (r) { return shouldNotify_(r, todayKey); });
}

/**
 * 通知內容。到期日與還剩幾天都寫進去——只說「快到了」等於要人自己去查。
 * ownerName 有值＝推到群組（ADR-014 T2）：群組裡的人要知道這是誰交代的事。
 */
function dueReminderMessage_(record, todayKey, ownerName) {
  var days = daysUntil_(record.due_date, todayKey);
  var when = days === null ? ''
    : days < 0 ? ('已逾期 ' + Math.abs(days) + ' 天')
    : days === 0 ? '今天到期'
    : ('還剩 ' + days + ' 天');
  var head = ownerName === undefined ? '⏰ 到期提醒'
    : '⏰ ' + (ownerName || '有人') + '的任務快到期了';
  return head + '\n' + (record.text || '(沒有內容)') +
         '\n' + keyValue_(record.due_date) + (when ? '（' + when + '）' : '');
}

/**
 * 這一筆要推到哪裡（ADR-014 D-17／D-18）。純函式，groups 是 group_id → line_groups 那一列。
 *  - origin_chat 空白                              → 建立者個人（現狀）
 *  - 群組 is_active、left_at 空白、notify_due 都成立 → 該群組
 *  - 其他                                          → 退回建立者個人，fallback 寫原因
 * 白板（board）與路由無關。
 */
function dueTarget_(record, groups) {
  var owner = keyValue_(record.line_id);
  var chat = keyValue_(record.origin_chat);
  if (!chat) return { to: owner, group: false, fallback: '' };
  var g = groups[chat];
  var why = !g ? '群組不在 ' + LINE_GROUPS_SHEET
    : !truthy_(g.is_active) ? '群組停用'
    : keyValue_(g.left_at) ? 'bot 已離開群組'
    : !truthy_(g.notify_due) ? '群組沒開 notify_due'
    : '';
  if (why) return { to: owner, group: false, fallback: why };
  return { to: chat, group: true, fallback: '' };
}

/**
 * 時間觸發器呼叫時傳的是事件物件（{authMode, triggerUid, …}），不是日期。
 * 以前直接 keyValue_(e) → "[object Object]" 被當成今天，於是**永遠沒有東西到期**——
 * 排程就算裝上了也會每天安靜地空跑。只認 YYYY-MM-DD 字串（測試用），其餘一律今天。
 */
function todayKeyFrom_(arg) {
  var k = typeof arg === 'string' ? keyValue_(arg) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : keyValue_(new Date());
}

/**
 * 每天跑一次的到期檢查。由 installAdr009Triggers() 建立的觸發器呼叫。
 *
 * 推成功才標記 notified：推失敗就標記，等於這筆從此再也不會提醒，而使用者
 * 根本不知道有過這件事。寧可明天再推一次，也不要安靜地漏掉。
 * 推到群組失敗**不**改推個人（ADR-014 T2）：明天會再試，改推的話同一則可能兩邊都收到。
 *
 * 每次執行都留紀錄，含「今天 0 筆」（ADR-014 D-16）：logs 一列＋performance 一列。
 * 9/30 到 10/7 這段排程根本沒裝，就是因為「沒紀錄」跟「今天沒事」看起來一模一樣。
 *
 * 整支包在 try/catch 裡：這是背景工作，丟例外沒有人看得到，只會在執行記錄裡
 * 留一筆紅字。出事要留在 logs，那才是回頭查得到的地方。
 */
function checkDueReminders(todayKey) {
  var started = Date.now();
  var today = todayKeyFrom_(todayKey);
  var due = [];
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TASKS_SHEET);
    if (!sheet) {
      console.log('分頁「' + TASKS_SHEET + '」不存在，略過');
      logCleanup_('到期檢查 ' + today, '略過：沒有 ' + TASKS_SHEET + ' 分頁', '');
      return { notified: 0 };
    }

    var headers = sheetHeaders_(sheet);
    if (headers.indexOf('due_date') === -1) {
      console.log('分頁「' + TASKS_SHEET + '」還沒有 due_date 欄，先執行 ensureAdr009Columns()');
      logCleanup_('到期檢查 ' + today, '略過：tasks 還沒有 due_date 欄', '先在 LINE 傳「初始化」');
      return { notified: 0, reason: 'no_due_date_column' };
    }

    var lastRow = sheet.getLastRow();
    var values = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var records = values.map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      return o;
    });

    due = dueRemindersToNotify_(records, today);

    // 有群組任務才讀 line_groups 與名單（推群組要帶建立者名稱）
    var groups = {}, roster = null;
    if (due.some(function (r) { return keyValue_(r.origin_chat); })) {
      var all = readLineGroups_();
      (all.ok ? all.rows : []).forEach(function (r) { groups[keyValue_(r.record.group_id)] = r.record; });
      roster = lineUsersRoster_();
    }

    var sent = 0, failed = 0, notes = [];
    due.forEach(function (rec) {
      var target = dueTarget_(rec, groups);
      if (target.fallback) notes.push('id=' + rec.id + ' 退回個人：' + target.fallback);
      var owner = target.group ? (((roster && roster.users) || {})[keyValue_(rec.line_id)] || {}) : null;
      var text = target.group ? dueReminderMessage_(rec, today, String(owner.display_name || '').trim())
                              : dueReminderMessage_(rec, today);
      var result = linePush_(target.to, text);
      if (!result.ok) {
        failed++;
        notes.push('id=' + rec.id + ' 推' + (target.group ? '群組' : '個人') + '失敗：' + result.reason);
        console.log('推播失敗，這筆保留未通知狀態，明天會再試：id=' + rec.id + '／' + result.reason);
        return;
      }
      sent++;
      rec.notified = 'TRUE';
      upsertRow_(sheet, headers, rec, TASKS_SHEET, 'id');
    });

    if (failed) notes.unshift('有 ' + failed + ' 筆推播失敗，未標記 notified，明天會再試');
    logCleanup_('到期檢查 ' + today, '通知 ' + sent + ' 筆（符合門檻 ' + due.length + ' 筆）', notes.join('｜'));
    console.log('到期檢查完成：通知 ' + sent + ' / ' + due.length + ' 筆');
    return { notified: sent, matched: due.length };
  } catch (err) {
    console.log('到期檢查失敗：' + err);
    try { logTransaction_('同步', '失敗', '到期檢查 ' + today, '例外中止', String(err), '', ''); } catch (e) {}
    return { notified: 0, error: String(err) };
  } finally {
    recordSchedulePerf_('dueCheck', due.length, Date.now() - started);
  }
}

/* ========================================================================== */
/* ADR-010 — 讀取驗證：LINE 配對 × 裝置 token                                   */
/*                                                                            */
/* 為什麼不是「讀取也過白名單」就好：line_users 本身可以被匿名讀走，而 line_id   */
/* 就在裡面——名單就是鑰匙。所以身份改由 LINE 證明：只有本人在 LINE 上拿得到    */
/* 配對碼，碼換成裝置 token，token 才是代領 line_id 的憑證（D-2）。               */
/*                                                                            */
/* 三條流程（D-3）：                                                           */
/*   A 第一次  LINE「配對」→ issuePairCode_ → PWA pairClaim → 拿到 token         */
/*   B 日常    每個請求帶 token → authDevice_ → 滑動續期                         */
/*   C 過期    PWA renewStart → LINE「驗證裝置 碼」→ confirmRenewCode_ → 同一台續期 */
/* ========================================================================== */

/** 表頭（交棒票 1-1 的欄序）。token 只存雜湊，原文只在配對那一刻交給前端一次 */
var LINE_DEVICES_HEADERS = ['device_id', 'token_hash', 'line_id', 'device_label',
                            'created_at', 'last_used_at', 'revoked_at', 'revoked_by'];

var DEVICE_IDLE_DAYS = 180;               // 滑動效期（D-5）：閒置超過就要走 C
var DEVICE_TOUCH_MS = 86400000;           // last_used_at 一天最多寫一次（D-8）
var DEVICE_CACHE_TTL = 300;               // 裝置查詢快取 5 分鐘（D-8，比照白名單）
var DEVICE_CACHE_PREFIX = 'adr010_dev_';
var DEVICE_LABEL_MAX = 60;

var PAIR_CODE_TTL = 600;                  // 配對碼／續期碼 10 分鐘、用過即刪（D-8）
var PAIR_CODE_PREFIX = 'adr010_pair_';
var RENEW_CODE_PREFIX = 'adr010_renew_';

/**
 * pairClaim 是匿名入口，擋暴力猜碼（交棒票的實作建議）。
 * 六位數只有一百萬種，不擋的話一個腳本幾小時就猜得到某個還活著的碼。
 * 計數器每次失敗都重設 TTL，實際上是「最後一次猜錯後 10 分鐘內累積 30 次」——
 * 比固定視窗更嚴，對正常使用者沒有差別（一個人不會連續打錯 30 次）。
 */
var PAIR_FAIL_KEY = 'adr010_pair_fail';
var PAIR_LOCK_KEY = 'adr010_pair_lock';
var PAIR_FAIL_LIMIT = 30;
var PAIR_LOCK_TTL = 600;

/** logs 的 source。前端 LOG 頁有同名的篩選鈕 */
var DEVICE_LOG_SOURCE = '配對';

/** LINE 官方帳號 ID（例如 @123abcde），給前端組「開啟 LINE 傳送」按鈕。沒設就回空，前端退回複製 */
function lineOaId_() {
  var raw = PropertiesService.getScriptProperties().getProperty('LINE_OA_ID');
  return raw ? String(raw).trim() : '';
}

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (err) { return null; }
}

function cacheGetJson_(cache, key) {
  var raw = null;
  try { raw = cache.get(key); } catch (err) { raw = null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/** SHA-256 → hex。computeDigest 回的是有號位元組（-128～127），要先轉回 0～255 */
function tokenHash_(token) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length < 2 ? '0' + v : v;
  }).join('');
}

/** 兩個 UUIDv4 接起來：244 位元的亂數，來源是 Google 的安全亂數，不是 Math.random */
function newDeviceToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/**
 * 六位數碼。取 UUID 前 12 個 hex（48 位元，第 13 個才是版本號）再取模：
 * 一樣是安全亂數，偏差小到可以忽略。
 */
function newSixDigitCode_() {
  var n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000;
  var s = String(n);
  while (s.length < 6) s = '0' + s;
  return s;
}

/** Sheet 讀回來可能是 Date（自動辨識）也可能是字串；兩種都換成毫秒，換不出來回 NaN */
function toTime_(v) {
  if (v instanceof Date) return v.getTime();
  var s = String(v == null ? '' : v).trim();
  return s ? new Date(s).getTime() : NaN;
}

/** 建表方式比照 ensureLineUsersSheet_：只建表頭，不寫任何一列 */
function ensureLineDevicesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LINE_DEVICES_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LINE_DEVICES_SHEET);
    sheet.appendRow(LINE_DEVICES_HEADERS);
    console.log('已建立分頁「' + LINE_DEVICES_SHEET + '」並寫入表頭');
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LINE_DEVICES_HEADERS);
    console.log('分頁「' + LINE_DEVICES_SHEET + '」原本沒有表頭，已補上');
  }
  return sheet;
}

/**
 * 整張讀進來。分頁不存在＝還沒有人配對過，是「讀到了、沒有裝置」，不是錯誤。
 * 讀取丟例外才是 ok:false——那時一律拒絕，不能把讀不到當成「沒有撤銷紀錄」。
 */
function readDevices_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_DEVICES_SHEET);
    if (!sheet) return { ok: true, sheet: null, headers: [], rows: [] };
    var headers = sheetHeaders_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2 || !headers.length) return { ok: true, sheet: sheet, headers: headers, rows: [] };

    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    var rows = [];
    values.forEach(function (line, i) {
      var rec = {};
      headers.forEach(function (h, c) { rec[h] = line[c]; });
      if (!String(rec.device_id || '').trim()) return;
      rows.push({ row: i + 2, record: rec });
    });
    return { ok: true, sheet: sheet, headers: headers, rows: rows };
  } catch (err) {
    return { ok: false, error: String(err), sheet: null, headers: [], rows: [] };
  }
}

/** 只改指定的欄，其他欄一格都不動（撤銷不該順手改掉 last_used_at） */
function setDeviceFields_(sheet, headers, rowNumber, patch) {
  Object.keys(patch).forEach(function (k) {
    var col = headers.indexOf(k) + 1;
    if (col > 0) sheet.getRange(rowNumber, col, 1, 1).setValues([[patch[k]]]);
  });
}

/** 撤銷／續期之後要立刻生效，不能等 5 分鐘快取過期（交棒票 1-2） */
function invalidateDeviceCache_(hash) {
  var cache = scriptCache_();
  if (!cache || !hash) return;
  try { cache.remove(DEVICE_CACHE_PREFIX + hash); } catch (err) {}
}

/**
 * 以雜湊找裝置：先問快取，沒有才讀 Sheet。
 * **只快取找到的**（比照 lineUsersRoster_）：把「找不到」也快取起來，剛配對好的
 * 那台會在 5 分鐘內被當成陌生人。
 */
function findDeviceByHash_(hash) {
  var cache = scriptCache_();
  if (cache) {
    var hit = cacheGetJson_(cache, DEVICE_CACHE_PREFIX + hash);
    if (hit) return { ok: true, device: hit };
  }
  var all = readDevices_();
  if (!all.ok) return { ok: false, error: all.error, device: null };

  var found = null;
  all.rows.some(function (r) {
    if (String(r.record.token_hash || '').trim() === hash) { found = r.record; return true; }
    return false;
  });
  if (found && cache) {
    try { cache.put(DEVICE_CACHE_PREFIX + hash, JSON.stringify(found), DEVICE_CACHE_TTL); } catch (err) {}
  }
  return { ok: true, device: found };
}

/** 對外的裝置資料：拿掉 token_hash（交棒票 1-4 listDevices） */
function publicDevice_(dev) {
  if (!dev) return null;
  var out = {};
  LINE_DEVICES_HEADERS.forEach(function (h) {
    if (h === 'token_hash') return;
    var v = dev[h];
    out[h] = v instanceof Date ? v.toISOString() : (v == null ? '' : v);
  });
  return out;
}

/**
 * 閒置太久（D-5）。last_used_at 讀不出來就退回 created_at，兩個都讀不出來當作過期——
 * 一列時間欄被改壞的裝置，寧可要本人走一次續期，也不要讓它永遠有效。
 */
function deviceIdle_(dev, nowMs) {
  var last = toTime_(dev.last_used_at);
  if (!isFinite(last)) last = toTime_(dev.created_at);
  if (!isFinite(last)) return true;
  return nowMs - last > DEVICE_IDLE_DAYS * 86400000;
}

/**
 * 滑動續期，一天最多寫一次（D-8）。寫失敗只留 console：這一次的請求已經通過驗證，
 * 不該因為「記一下時間」失敗而變成失敗；明天還會再試。
 */
function touchDevice_(dev, nowMs) {
  var last = toTime_(dev.last_used_at);
  if (isFinite(last) && nowMs - last <= DEVICE_TOUCH_MS) return;
  try {
    var all = readDevices_();
    var hit = null;
    all.rows.some(function (r) {
      if (String(r.record.device_id) === String(dev.device_id)) { hit = r; return true; }
      return false;
    });
    if (!hit) return;
    var stamp = new Date(nowMs).toISOString();
    setDeviceFields_(all.sheet, all.headers, hit.row, { last_used_at: stamp });
    dev.last_used_at = stamp;
    var cache = scriptCache_();
    if (cache) {
      try { cache.put(DEVICE_CACHE_PREFIX + dev.token_hash, JSON.stringify(dev), DEVICE_CACHE_TTL); } catch (err) {}
    }
  } catch (err) {
    console.log('更新 last_used_at 失敗（這次請求照常放行）：' + err);
  }
}

/**
 * 人層被擋的原因。ADR 只寫了 inactive，但 writeGate_ 還會回「白名單讀不到」這類
 * **系統**問題——那些要原樣往上傳：前端看到 inactive 會請人等管理者，看到系統錯誤
 * 只會說連線異常。把一次 Sheet 故障講成「你被停用了」是假話。
 */
function personReason_(gateError) {
  if (gateError === 'not_on_whitelist' || gateError === 'inactive' || gateError === 'missing_line_id') {
    return 'inactive';
  }
  return gateError || 'inactive';
}

var DEVICE_DENY_TEXT = {
  no_token: '請求沒有帶裝置 token，拒絕',
  unknown_token: 'token 對不上任何裝置，拒絕',
  revoked: '這台裝置已被撤銷，拒絕',
  token_expired: '這台裝置閒置超過 ' + DEVICE_IDLE_DAYS + ' 天，要走續期',
  device_store_unavailable: '裝置表讀不到，一律拒絕'
};

/**
 * 裝置層被擋。有 what 才寫 logs（比照 denyWrite_，不可靜默失敗）；session 查狀態
 * 不帶 what——續期畫面每 3 秒問一次「好了沒」，每次都寫一列只會把 logs 灌爆，
 * 而狀態本身就回給了前端，不是安靜的失敗。
 */
function deviceDenied_(reason, dev, what, detail) {
  if (what) {
    console.log('🚫 裝置驗證沒過（' + reason + '）：' + what);
    try {
      logTransaction_('同步', '失敗', what, DEVICE_DENY_TEXT[reason] || reason,
        (detail ? detail + '｜' : '') + 'code=' + reason + (dev ? '｜device_id=' + dev.device_id : ''),
        '', dev ? String(dev.line_id || '') : '');
    } catch (err) {
      console.log('寫 logs 失敗（不影響拒絕的結果）：' + err);
    }
  }
  return { ok: false, reason: reason, device: publicDevice_(dev), line_id: dev ? String(dev.line_id || '').trim() : '' };
}

/**
 * 裝置驗證（交棒票 1-2）→ { ok, line_id, user, device, reason }
 *
 * 雙層、而且是 AND（D-6）：裝置層（認得、沒撤銷、沒過期）＋ 人層（is_active）。
 * 人層直接呼叫 writeGate_，不另寫一份判斷——兩份遲早漂移，漂移的那天會有人被一邊
 * 放行、另一邊擋下。停用＝暫停（D-7）也是這樣來的：裝置列一個字都沒改，人重新
 * 啟用之後自然又過得了。
 *
 * now 只給測試用（比照 checkDueReminders）：綁死系統時鐘的測試會跟著真實日期漂。
 */
function authDevice_(rawToken, what, now) {
  var nowMs = now || Date.now();
  var token = String(rawToken == null ? '' : rawToken).trim();
  if (!token) return deviceDenied_('no_token', null, what);

  var found = findDeviceByHash_(tokenHash_(token));
  if (!found.ok) return deviceDenied_('device_store_unavailable', null, what, found.error);
  var dev = found.device;
  if (!dev) return deviceDenied_('unknown_token', null, what);
  if (String(dev.revoked_at == null ? '' : dev.revoked_at).trim()) return deviceDenied_('revoked', dev, what);
  if (deviceIdle_(dev, nowMs)) return deviceDenied_('token_expired', dev, what);

  var gate = writeGate_(dev.line_id, what || 'PWA session');
  if (!gate.allowed) {
    return { ok: false, reason: personReason_(gate.error), device: publicDevice_(dev),
             line_id: String(dev.line_id || '').trim() };
  }

  touchDevice_(dev, nowMs);
  return { ok: true, reason: '', line_id: String(dev.line_id).trim(), user: gate.user, device: publicDevice_(dev) };
}

/**
 * 這個請求是誰（ADR-010 D-1／D-2）。line_id 一律由後端從 token 換出來。
 *
 * 2026-10-01 關門：舊的「CLOUD_SECRET＋自稱 line_id」整條退場，沒有 token 一律 no_token。
 * 密鑰只證明「這是我們家的 App」，而它就寫在公開的 index.html 裡；line_id 是自稱的，
 * 而名單可以被讀走——兩樣湊起來誰都能冒充誰。
 */
function pwaCaller_(body) {
  var what = 'PWA ' + (body.action || '?') + ' → ' + (body.sheet || '?');
  var auth = authDevice_(body.token, what);
  if (!auth.ok) return { ok: false, error: auth.reason };
  return { ok: true, line_id: auth.line_id, user: auth.user, device: auth.device };
}

/** session：這把 token 現在是什麼狀態（前端開機、回前景、續期輪詢都問這個） */
function deviceSession_(token, now) {
  var auth = authDevice_(token, '', now);
  if (!auth.ok) return { status: auth.reason };
  var out = {
    status: 'ok',
    line_id: auth.line_id,
    display_name: String((auth.user && auth.user.display_name) || '').trim(),
    device_id: auth.device.device_id,
    device_label: auth.device.device_label
  };
  // 門檻提醒要的筆數順便給管理員，不另外發請求（ADR-012 T1 1-4）
  if (truthy_((auth.user || {}).is_admin)) out.perf_rows = perfRowCount_();
  return out;
}

/**
 * 發配對碼（LINE「配對」）。碼與 line_id 的對應只放快取，TTL 10 分鐘（D-8）。
 * 呼叫端（line-router.gs）已經確認過發話者是 active 成員、而且是一對一聊天。
 */
function issuePairCode_(lineId) {
  return issueCode_(PAIR_CODE_PREFIX, { line_id: String(lineId || '').trim() });
}

/** 配對碼與續期碼共用：產生一個快取裡還沒有的碼。撞到就換，十次都撞到代表快取有問題 */
function issueCode_(prefix, payload) {
  var cache = scriptCache_();
  if (!cache) return { ok: false, reason: 'cache_unavailable' };
  for (var i = 0; i < 10; i++) {
    var code = newSixDigitCode_();
    var busy = null;
    try { busy = cache.get(prefix + code); } catch (err) { return { ok: false, reason: 'cache_unavailable' }; }
    if (busy) continue;
    try { cache.put(prefix + code, JSON.stringify(payload), PAIR_CODE_TTL); } catch (err) {
      return { ok: false, reason: 'cache_unavailable' };
    }
    return { ok: true, code: code };
  }
  return { ok: false, reason: 'cache_unavailable' };
}

/** 猜錯一次記一筆；累積到上限就鎖 10 分鐘，鎖的當下寫一列 logs（只寫這一列，不是每次猜錯都寫） */
function notePairFailure_(cache) {
  var n = 0;
  try { n = Number(cache.get(PAIR_FAIL_KEY)) || 0; } catch (err) { n = 0; }
  n++;
  try {
    if (n >= PAIR_FAIL_LIMIT) {
      cache.put(PAIR_LOCK_KEY, '1', PAIR_LOCK_TTL);
      cache.remove(PAIR_FAIL_KEY);
      console.log('🚫 配對碼連續猜錯 ' + n + ' 次，暫停配對 ' + (PAIR_LOCK_TTL / 60) + ' 分鐘');
      logTransaction_(DEVICE_LOG_SOURCE, '失敗', 'PWA pairClaim',
        '配對碼猜錯太多次，暫停配對 ' + (PAIR_LOCK_TTL / 60) + ' 分鐘',
        '10 分鐘內累積猜錯 ' + n + ' 次，疑似有人在猜碼', '', '');
    } else {
      cache.put(PAIR_FAIL_KEY, String(n), PAIR_LOCK_TTL);
    }
  } catch (err) {
    console.log('記錄配對失敗次數時出錯：' + err);
  }
}

/** 前端帶上來的裝置名稱只是給人看的標籤，去掉換行、截短就好 */
function cleanDeviceLabel_(raw) {
  var s = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  return (s.length > DEVICE_LABEL_MAX ? s.slice(0, DEVICE_LABEL_MAX) : s) || '(未命名裝置)';
}

/**
 * pairClaim（流程 A 的最後一步）→ { success, token, device_id, line_id, display_name } 或 { error }
 *
 * 碼先刪再發 token：同一個碼同時被送兩次，第二次會找不到——一個碼只換得到一把鑰匙。
 * 發之前再過一次人層：碼是 10 分鐘前發的，這段時間裡人可能被停用了。
 */
function pairClaim_(rawCode, rawLabel, now) {
  var cache = scriptCache_();
  if (!cache) {
    console.log('❌ CacheService 取不到，配對碼無從比對');
    return { error: 'cache_unavailable' };
  }
  var locked = null;
  try { locked = cache.get(PAIR_LOCK_KEY); } catch (err) { locked = null; }
  if (locked) return { error: 'too_many_attempts' };

  var code = String(rawCode == null ? '' : rawCode).trim();
  var hit = /^\d{6}$/.test(code) ? cacheGetJson_(cache, PAIR_CODE_PREFIX + code) : null;
  if (!hit || !hit.line_id) {
    notePairFailure_(cache);
    return { error: 'invalid_code' };
  }
  try { cache.remove(PAIR_CODE_PREFIX + code); } catch (err) {}

  var gate = writeGate_(hit.line_id, 'PWA pairClaim');
  if (!gate.allowed) return { error: personReason_(gate.error) };

  var nowIso = new Date(now || Date.now()).toISOString();
  var token = newDeviceToken_();
  var dev = {
    device_id: Utilities.getUuid(),
    token_hash: tokenHash_(token),
    line_id: String(hit.line_id).trim(),
    device_label: cleanDeviceLabel_(rawLabel),
    created_at: nowIso,
    last_used_at: nowIso,
    revoked_at: '',
    revoked_by: ''
  };

  var rowNumber;
  try {
    var sheet = ensureLineDevicesSheet_();
    var headers = sheetHeaders_(sheet);
    sheet.appendRow(headers.map(function (h) { return dev[h] == null ? '' : dev[h]; }));
    rowNumber = sheet.getLastRow();
  } catch (err) {
    console.log('寫入 ' + LINE_DEVICES_SHEET + ' 失敗：' + err);
    try {
      logTransaction_(DEVICE_LOG_SOURCE, '失敗', 'PWA 配對 ' + dev.device_label, '裝置寫入失敗',
        String(err && err.stack || err), '', dev.line_id);
    } catch (e) {}
    return { error: 'device_store_unavailable' };
  }

  try {
    logTransaction_(DEVICE_LOG_SOURCE, '成功', 'PWA 配對 ' + dev.device_label, '已配對新裝置',
      'device_id=' + dev.device_id, rowNumber, dev.line_id);
  } catch (err) {}

  return {
    success: true,
    token: token,
    device_id: dev.device_id,
    line_id: dev.line_id,
    display_name: String((gate.user && gate.user.display_name) || '').trim()
  };
}

/**
 * renewStart（流程 C 的第一步）→ { success, code, oa_id } 或 { error }
 *
 * 只有「真的只是過期」才發碼（D-6）。被撤銷、被停用、認不得的 token 一律拒絕，
 * 只能走 A——撤銷的意義就是「這台不算數了」，讓它自己續回來等於撤銷無效。
 * authDevice_ 在過期那一步就停了、還沒查人，所以人層要在這裡補查一次。
 */
function renewStart_(token, now) {
  var auth = authDevice_(token, '', now);
  if (auth.ok) return { error: 'not_expired' };
  if (auth.reason !== 'token_expired') {
    if (auth.reason === 'revoked' || auth.reason === 'unknown_token' || auth.reason === 'no_token') {
      try {
        logTransaction_(DEVICE_LOG_SOURCE, '失敗', 'PWA renewStart', DEVICE_DENY_TEXT[auth.reason] + '，不發續期碼',
          'code=' + auth.reason + (auth.device ? '｜device_id=' + auth.device.device_id : ''), '', auth.line_id || '');
      } catch (err) {}
    }
    return { error: auth.reason };
  }

  var gate = writeGate_(auth.line_id, 'PWA renewStart');
  if (!gate.allowed) return { error: personReason_(gate.error) };

  var issued = issueCode_(RENEW_CODE_PREFIX, { device_id: auth.device.device_id, line_id: auth.line_id });
  if (!issued.ok) return { error: issued.reason };
  return { success: true, code: issued.code, oa_id: lineOaId_(), expires_in: PAIR_CODE_TTL };
}

/**
 * LINE「驗證裝置 碼」（流程 C 的第二步）→ { ok, reason, device }
 *
 * 發話者必須是裝置原主人。別人傳同一個碼一律拒絕，而且**不刪碼**：刪掉的話，
 * 旁人亂傳一次就能讓原主人的續期失效，等於給了一個干擾別人的按鈕。
 */
function confirmRenewCode_(rawCode, speakerId, now) {
  var cache = scriptCache_();
  if (!cache) return { ok: false, reason: 'cache_unavailable' };
  var code = String(rawCode == null ? '' : rawCode).trim();
  var hit = /^\d{6}$/.test(code) ? cacheGetJson_(cache, RENEW_CODE_PREFIX + code) : null;
  if (!hit) return { ok: false, reason: 'invalid_code' };
  if (String(hit.line_id) !== String(speakerId || '').trim()) return { ok: false, reason: 'not_owner' };

  var all = readDevices_();
  if (!all.ok) return { ok: false, reason: 'device_store_unavailable' };
  var target = null;
  all.rows.some(function (r) {
    if (String(r.record.device_id) === String(hit.device_id)) { target = r; return true; }
    return false;
  });
  if (!target) return { ok: false, reason: 'unknown_device' };
  // 發碼之後才被撤銷的，照樣不續——撤銷的決定比續期新
  if (String(target.record.revoked_at == null ? '' : target.record.revoked_at).trim()) {
    return { ok: false, reason: 'revoked' };
  }

  setDeviceFields_(all.sheet, all.headers, target.row, { last_used_at: new Date(now || Date.now()).toISOString() });
  try { cache.remove(RENEW_CODE_PREFIX + code); } catch (err) {}
  invalidateDeviceCache_(String(target.record.token_hash || ''));
  return { ok: true, reason: '', device: publicDevice_(target.record) };
}

/** 裝置在畫面上的狀態。算法與 authDevice_ 同一套，不另寫 */
function deviceStatus_(dev, nowMs) {
  if (String(dev.revoked_at == null ? '' : dev.revoked_at).trim()) return 'revoked';
  return deviceIdle_(dev, nowMs) ? 'expired' : 'active';
}

/**
 * listDevices：自己的裝置；管理者可以查任何人（交棒票 1-4）。不回 token_hash。
 * current 標出「發這個請求的就是這一台」，管理頁與「解除這台」都靠它認得自己。
 */
function listDevices_(caller, targetLineId) {
  var target = String(targetLineId == null ? '' : targetLineId).trim() || caller.line_id;
  if (target !== caller.line_id && !truthy_((caller.user || {}).is_admin)) {
    return { error: 'forbidden' };
  }
  var all = readDevices_();
  if (!all.ok) return { error: 'device_store_unavailable' };

  var nowMs = Date.now();
  var mine = caller.device ? String(caller.device.device_id) : '';
  var devices = all.rows
    .filter(function (r) { return String(r.record.line_id || '').trim() === target; })
    .map(function (r) {
      var d = publicDevice_(r.record);
      d.status = deviceStatus_(r.record, nowMs);
      d.current = !!mine && String(d.device_id) === mine;
      return d;
    });
  return { success: true, line_id: target, devices: devices };
}

/**
 * revokeDevice：本人可撤銷自己的，管理者可撤銷任何人的（交棒票 1-4）。
 * device_id 撤一台；all_of 撤某人的全部（D-7「停用時要一併撤銷嗎」、管理頁的全部撤銷）。
 *
 * 權限是整批判斷：清單裡只要有一台不是自己的而且自己不是管理者，整個請求拒絕，
 * 不做「撤得掉的先撤」——半套結果比全有全無難解釋得多。已撤銷的不重寫，保留第一次
 * 撤銷的時間與撤銷者。
 */
function revokeDevices_(caller, deviceId, allOf) {
  var id = String(deviceId == null ? '' : deviceId).trim();
  var owner = String(allOf == null ? '' : allOf).trim();
  if (!id && !owner) return { error: 'missing_target' };

  var all = readDevices_();
  if (!all.ok) return { error: 'device_store_unavailable' };
  var targets = all.rows.filter(function (r) {
    return id ? String(r.record.device_id) === id : String(r.record.line_id || '').trim() === owner;
  });
  if (id && !targets.length) return { error: 'device_not_found' };

  var admin = truthy_((caller.user || {}).is_admin);
  var foreign = targets.some(function (r) { return String(r.record.line_id || '').trim() !== caller.line_id; });
  if (foreign && !admin) return { error: 'forbidden' };

  var nowIso = new Date().toISOString();
  var revoked = 0;
  targets.forEach(function (r) {
    if (String(r.record.revoked_at == null ? '' : r.record.revoked_at).trim()) return;
    setDeviceFields_(all.sheet, all.headers, r.row, { revoked_at: nowIso, revoked_by: caller.line_id });
    invalidateDeviceCache_(String(r.record.token_hash || ''));
    revoked++;
  });

  try {
    logTransaction_(DEVICE_LOG_SOURCE, '成功',
      '撤銷裝置 ' + (id ? 'device_id=' + id : '「' + owner + '」的全部裝置'),
      '已撤銷 ' + revoked + ' 台' + (targets.length > revoked ? '（' + (targets.length - revoked) + ' 台原本就已撤銷）' : ''),
      targets.map(function (r) { return r.record.device_label; }).join('、'), '', caller.line_id);
  } catch (err) {}
  return { success: true, revoked: revoked, matched: targets.length };
}

/* ========================================================================== */
/* 封存改寄信（2026-10-01 Neil 裁決，取代 ADR-009 §一.4 的「下載＋人工確認」）   */
/*                                                                            */
/*   管理者按確認 → ① 整理：撈出所有墓碑、打包成 JSON                            */
/*                → ② 寄信：附件寄給所有啟用中的管理者                          */
/*                → ③ 刪除：寄出成功才刪                                        */
/*   任一步失敗就停，回報是哪一步、錯誤訊息是什麼。①② 失敗時雲端一列都沒動；    */
/*   ③ 刪到一半失敗，就把已刪的列補回去（信已經寄出，資料兩邊都在）。             */
/*                                                                            */
/* 為什麼搬到後端一次做完：舊流程是前端逐張分頁各打一次請求，五張表各自成敗，     */
/* 「全部成功或全部不動」在那個形狀裡做不到。瀏覽器也沒有「下載成功」這個事件，   */
/* 只能靠人按確定當訊號；「寄出成功」是程式拿得到的真訊號。                       */
/* ========================================================================== */

/** line_users 上的 email 欄。家人都讀得到這張表，所以 email 在家人之間是公開的（Neil 已知悉） */
var EMAIL_FIELD = 'email';

/** 要封存的分頁與各自的鍵。reviews 沒有 id，用「日期＋寫的人」（ADR-009 §一.5） */
var ARCHIVE_TARGETS = [
  { sheet: 'tasks', key: 'id' },
  { sheet: 'moods', key: 'id' },
  { sheet: 'notes', key: 'id' },
  { sheet: 'expenses', key: 'id' },
  { sheet: 'reviews', key: ['review_date', 'line_id'] }
];

/** 同一時間只准一個封存在跑：兩個封存交錯刪列，列號會互相踩 */
var ARCHIVE_LOCK_MS = 30000;

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
}

/**
 * 收封存信的人：所有啟用中、而且填了 email 的管理者。
 * 不走 5 分鐘快取：管理者剛在 App 填好 email 就按封存，要讀得到那一格。
 */
function adminEmails_() {
  var roster = readLineUsers_();
  if (!roster.ok) return { ok: false, reason: roster.reason, emails: [] };
  var emails = [];
  Object.keys(roster.users).forEach(function (id) {
    var u = roster.users[id];
    var mail = String(u[EMAIL_FIELD] == null ? '' : u[EMAIL_FIELD]).trim();
    if (truthy_(u.is_active) && truthy_(u.is_admin) && isEmail_(mail) && emails.indexOf(mail) === -1) {
      emails.push(mail);
    }
  });
  return { ok: true, emails: emails };
}

/**
 * 本人設定自己的 email。只改自己那一列的 email 欄（＋ updated_at），其他欄一格都不碰——
 * 不走整列 upsert：前端手上的那份名單可能是舊的，整列送回來會把管理者剛改的權限蓋回去。
 * email 欄不存在就補在表頭最右邊（比照 ensureColumnsOnSheet_ 的慣例）。
 */
function setMyEmail_(caller, raw) {
  var email = String(raw == null ? '' : raw).trim();
  if (!isEmail_(email)) return { error: 'invalid_email' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_USERS_SHEET);
  if (!sheet) return { error: 'sheet_not_found' };
  ensureColumnsOnSheet_(sheet, [EMAIL_FIELD]);
  var headers = sheetHeaders_(sheet);
  var rows = findRowsByKey_(sheet, [headers.indexOf('line_id') + 1], caller.line_id);
  if (!rows.length) return { error: 'not_on_whitelist' };

  sheet.getRange(rows[0], headers.indexOf(EMAIL_FIELD) + 1, 1, 1).setValues([[email]]);
  var updated = headers.indexOf('updated_at');
  if (updated !== -1) sheet.getRange(rows[0], updated + 1, 1, 1).setValues([[new Date().toISOString()]]);
  invalidateLineUsersCache_();
  return { success: true, email: email };
}

/** 封存失敗：寫一列 logs（不可靜默失敗），回報階段與原因 */
function archiveFail_(stage, message, extra) {
  console.log('❌ 封存失敗（' + stage + '）：' + message);
  try {
    logTransaction_('同步', '失敗', '封存寄信', '失敗於「' + stage + '」階段', message, '', '');
  } catch (err) {}
  var out = { error: 'archive_failed', stage: stage, message: message };
  Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

/** 刪到一半失敗時把已刪的列補回去。回報補回幾列、有沒有全部補回 */
function rollbackArchive_(deleted) {
  var count = 0;
  var ok = true;
  deleted.forEach(function (d) {
    try { d.sheet.appendRow(d.values); count++; } catch (err) {
      ok = false;
      console.log('補回失敗（' + d.sheet.getName() + '）：' + err);
    }
  });
  return { ok: ok, count: count };
}

function archiveMailBody_(plan, total) {
  var lines = ['Neil OS 封存備份：共 ' + total + ' 筆已刪除的資料，完整內容在附件 JSON。', ''];
  plan.forEach(function (p) { lines.push('・' + p.target.sheet + '：' + p.keys.length + ' 筆'); });
  lines.push('', '寄出成功之後，這些資料已從雲端永久刪除。這封信就是唯一的備份，請保留。');
  return lines.join('\n');
}

/**
 * archiveMail → { success, total, deleted, skipped, recipients } 或 archiveFail_ 的形狀
 *
 * ③ 刪除前會再讀一次：寄信那幾秒裡，某一列若被人取消刪除（del 清掉），它就不再是墓碑，
 * 放過它（計入 skipped）。它的內容仍在信裡，多備份一份不會壞事。
 */
function archiveByMail_(caller) {
  if (!truthy_((caller.user || {}).is_admin)) return archiveFail_('permission', '只有管理者可以封存');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ARCHIVE_LOCK_MS)) return archiveFail_('lock', '另一個封存正在進行，請稍後再試');
  try {
    // ① 整理
    var plan = [];
    var total = 0;
    var json = '';
    var stamp = keyValue_(new Date());
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      ARCHIVE_TARGETS.forEach(function (t) {
        var sheet = ss.getSheetByName(t.sheet);
        if (!sheet) return;
        var headers = sheetHeaders_(sheet);
        var tombs = tombstoneRows_(sheet, headers, t.key).filter(function (c) { return c.key; });
        if (!tombs.length) return;
        plan.push({
          target: t, sheet: sheet, headers: headers,
          keys: tombs.map(function (c) { return c.key; }),
          records: tombs.map(function (c) { return c.record; })
        });
        total += tombs.length;
      });
      if (!total) return { success: true, total: 0, deleted: 0, skipped: 0, recipients: 0 };
      json = JSON.stringify({
        exported_at: new Date().toISOString(),
        total: total,
        sheets: plan.map(function (p) { return { sheet: p.target.sheet, rows: p.records }; })
      }, null, 2);
    } catch (err) {
      return archiveFail_('collect', String(err && err.message || err));
    }

    // ② 寄信
    var to = adminEmails_();
    if (!to.ok) return archiveFail_('mail', '成員名單讀不到（' + to.reason + '）');
    if (!to.emails.length) return archiveFail_('mail', '沒有任何啟用中的管理者填了 email，請先到首頁填寫');
    try {
      MailApp.sendEmail({
        to: to.emails.join(','),
        subject: 'Neil OS 封存備份 ' + stamp + '（' + total + ' 筆）',
        body: archiveMailBody_(plan, total),
        attachments: [Utilities.newBlob(json, 'application/json', 'neil-os-archive-' + stamp + '.json')]
      });
    } catch (err) {
      return archiveFail_('mail', String(err && err.message || err));
    }

    // ③ 刪除：失敗就把已刪的補回去
    var deleted = [];
    var skipped = 0;
    try {
      plan.forEach(function (p) {
        var wanted = {};
        p.keys.forEach(function (k) { wanted[k] = true; });
        var fresh = tombstoneRows_(p.sheet, p.headers, p.target.key).filter(function (c) { return c.key && wanted[c.key]; });
        skipped += p.keys.length - fresh.length;
        // 由下往上刪，否則刪掉一列之後下面的列號會整個位移，刪錯人
        fresh.map(function (c) { return c.row; }).sort(function (a, b) { return b - a; }).forEach(function (r) {
          var values = p.sheet.getRange(r, 1, 1, p.headers.length).getValues()[0];
          p.sheet.deleteRow(r);
          deleted.push({ sheet: p.sheet, values: values });
        });
      });
    } catch (err) {
      var back = rollbackArchive_(deleted);
      return archiveFail_('delete', String(err && err.message || err) +
        (back.ok ? '；已刪的 ' + back.count + ' 列已補回' : '；⚠️ 補回只成功 ' + back.count + '／' + deleted.length + ' 列'),
        { mailed: true, rolled_back: back.ok, restored: back.count });
    }

    logCleanup_('封存寄信 ' + stamp,
      '已寄出備份並刪除 ' + deleted.length + ' 列（寄給 ' + to.emails.length + ' 位管理者）',
      plan.map(function (p) { return p.target.sheet + ' ' + p.keys.length; }).join('、') +
        (skipped ? '；寄信期間被取消刪除而放過 ' + skipped + ' 列' : ''));
    return { success: true, total: total, deleted: deleted.length, skipped: skipped, recipients: to.emails.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 寄信權限授權——部署後在 Apps Script 編輯器選這支按「執行」一次。
 *
 * 封存改用 MailApp 之後，專案多了「代表你寄信」的權限範圍。web app 以部署者身份執行，
 * 這個權限要由部署者本人在編輯器裡同意一次；沒同意之前，寄信會失敗（可能連帶其他請求）。
 * 跑完看執行記錄：印出今天剩餘的寄信額度就代表授權完成。
 */
function authorizeArchiveMail() {
  var left = MailApp.getRemainingDailyQuota();
  console.log('✅ 寄信權限已授權。今天剩餘寄信額度：' + left);
  var to = adminEmails_();
  console.log(to.emails.length
    ? '封存信會寄給：' + to.emails.join('、')
    : '⚠️ 還沒有任何啟用中的管理者填 email，封存會在「寄信」階段停下來');
  return { quota: left, recipients: to.emails };
}


/* ========================================================================== */
/* 效能紀錄（ADR-012 D-6／D-7，交棒票 T1）                                     */
/* ========================================================================== */

/**
 * 每列是一次請求的耗時，**不存 token、不存任何資料內容**：只有動作名、觸發情境、
 * 毫秒數、表名、列數、哪台裝置、哪個人。
 *
 * 兩種列：
 *  - 雲端列：handlePwaSync_ 自己量的 server_ms 與分段（驗證／開表／讀表），client_ms 空白
 *  - 手機列：手機量的 client_ms（含網路與 GAS 冷啟動），夾在**下一個**請求的 body.perf
 *    裡送上來，另寫一列；server 那幾欄空白。不回頭補同一列：要先找到那一列，
 *    找錯就是寫錯人的數字，另寫一列沒有這個風險
 *
 * 寫入時機不在 server_ms 裡：GAS 不能先回應再做事，所以寫紀錄的那一點時間
 * 使用者還是要等，只是量不到自己。用 appendRow 一列一列寫：開機時五張表是
 * 並行的五個請求，appendRow 才不會互相蓋掉。
 */
var PERFORMANCE_HEADERS = ['id', 'ts', 'action', 'trigger', 'client_ms', 'server_ms', 'auth_ms', 'open_ms', 'read_ms',
  'sheets', 'rows', 'device_id', 'line_id', 'reply_ms'];

/** 觸發情境。不在清單裡的一律不記——欄位裡只會出現這幾個字 */
var PERF_TRIGGERS = ['cold', 'foreground', 'poll', 'manual', 'write', 'line', 'schedule'];
var PERF_CLIENT_MAX = 20;              // 一個請求最多收幾筆手機紀錄
var PERF_CLIENT_MS_MAX = 600000;       // 超過 10 分鐘的不是耗時，是手機睡著了
var PERF_SUMMARY_DAYS = 7;
var PERF_PURGE_DEFAULT_DAYS = 30;
var PERF_LOCK_MS = 10000;
var PERF_DAY_MS = 86400000;

/** 建表方式比照 ensureLineUsersSheet_：只建表頭 */
function ensurePerformanceSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PERFORMANCE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PERFORMANCE_SHEET);
    sheet.appendRow(PERFORMANCE_HEADERS);
    return sheet;
  }
  if (sheet.getLastRow() === 0) sheet.appendRow(PERFORMANCE_HEADERS);
  return sheet;
}

/** 手機送上來的紀錄只收形狀對的；動作名只允許英文字母，夾帶任何內容都進不來 */
function clientPerfRows_(list) {
  if (!Array.isArray(list)) return [];
  var out = [];
  list.forEach(function (p) {
    if (out.length >= PERF_CLIENT_MAX || !p || typeof p !== 'object') return;
    var action = String(p.action == null ? '' : p.action);
    var ms = p.client_ms;
    if (!/^[A-Za-z]{1,32}$/.test(action)) return;
    if (PERF_TRIGGERS.indexOf(p.trigger) === -1) return;
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0 || ms > PERF_CLIENT_MS_MAX) return;
    out.push({ action: action, trigger: p.trigger, client_ms: Math.round(ms) });
  });
  return out;
}

/**
 * 回應前寫紀錄。整支包 try/catch：紀錄是事後回頭看的東西，寫不進去不該讓一次
 * 成功的讀寫變成失敗（比照 logTransaction_）。
 *
 * **沒通過驗證的請求一列都不寫**：不然拿到網址的人就能灌爆這張表。
 * poll 只在前端帶 perf_sample:true 時寫（每 20 次 1 次，由前端計數）。
 */
function recordPerf_(body, perf, serverMs) {
  try {
    if (!perf.who) return;
    var rows = [];
    var trigger = body.trigger;
    if (PERF_TRIGGERS.indexOf(trigger) !== -1 && (trigger !== 'poll' || body.perf_sample === true)) {
      rows.push({
        action: String(body.action || ''), trigger: trigger, server_ms: serverMs,
        auth_ms: perf.auth_ms, open_ms: perf.open_ms, read_ms: perf.read_ms,
        sheets: perf.sheets || (typeof body.sheet === 'string' ? body.sheet : ''), rows: perf.rows
      });
    }
    rows = rows.concat(clientPerfRows_(body.perf));
    if (!rows.length) return;

    var sheet = ensurePerformanceSheet_();
    var headers = perfHeaders_(sheet);
    var now = Date.now();
    rows.forEach(function (r, i) {
      r.id = String(now + i);
      r.ts = new Date(now).toISOString();
      r.device_id = perf.who.device_id || '';
      r.line_id = perf.who.line_id || '';
      sheet.appendRow(headers.map(function (h) {
        return (r[h] === undefined || r[h] === null) ? '' : r[h];
      }));
    });
  } catch (err) {
    console.log('寫效能紀錄失敗（主流程不受影響）：' + err);
  }
}

/**
 * 表頭；舊表沒有 reply_ms（2026-10-06 加的，LINE 用）就補在最右邊。
 * 本來每次寫紀錄就要讀一次表頭，這裡沒有多讀，只有缺欄的那一次多寫一格。
 */
function perfHeaders_(sheet) {
  var headers = sheetHeaders_(sheet);
  if (headers.length && headers.indexOf('reply_ms') === -1) {
    sheet.getRange(1, headers.length + 1, 1, 1).setValues([['reply_ms']]);
    headers.push('reply_ms');
  }
  return headers;
}

/**
 * LINE 的一次 webhook（2026-10-06）。本來只有 PWA 的請求有效能紀錄，LINE 完全沒記——
 * 「按鈕很慢」查不到數字。在**回覆之後**才寫，不讓使用者多等。
 *  - server_ms：整個 webhook 跑完（含回覆後才寫的 logs）
 *  - reply_ms ：從收到事件到送出回覆——使用者實際等的時間
 * 只記名單上啟用中的人（比照 PWA：沒通過驗證的請求一列都不寫，免得陌生人灌爆這張表）。
 */
function recordLinePerf_(action, userId, serverMs, replyMs) {
  try {
    var user = lineUserById_(userId);
    if (!user || !truthy_(user.is_active)) return;
    var sheet = ensurePerformanceSheet_();
    var headers = perfHeaders_(sheet);
    var now = Date.now();
    var r = { id: String(now), ts: new Date(now).toISOString(), action: action, trigger: 'line',
              server_ms: serverMs, reply_ms: replyMs == null ? '' : replyMs, line_id: String(userId || '').trim() };
    sheet.appendRow(headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }));
  } catch (err) {
    console.log('寫 LINE 效能紀錄失敗（主流程不受影響）：' + err);
  }
}

/**
 * 排程的一次執行（ADR-014 D-16）。排程沒有人、沒有裝置，line_id／device_id 留白——
 * 只有這條路可以留白寫入；PWA 的 recordPerf_ 照舊「沒通過驗證一列都不寫」。
 */
function recordSchedulePerf_(action, rows, serverMs) {
  try {
    var sheet = ensurePerformanceSheet_();
    var headers = perfHeaders_(sheet);
    var now = Date.now();
    var r = { id: String(now), ts: new Date(now).toISOString(), action: action, trigger: 'schedule',
              server_ms: serverMs, rows: rows };
    sheet.appendRow(headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }));
  } catch (err) {
    console.log('寫排程效能紀錄失敗（主流程不受影響）：' + err);
  }
}

/** 管理員開 App 時的門檻提醒用。讀不到就回 0：提醒不重要到要擋住開機 */
function perfRowCount_() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PERFORMANCE_SHEET);
    return sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0;
  } catch (err) {
    return 0;
  }
}

/** 非管理員碰效能紀錄：擋下並記一筆 */
function perfForbidden_(caller, action) {
  logTransaction_('效能', '失敗', action, '只有管理者可以使用效能紀錄', '', '', caller.line_id);
  return { error: 'forbidden' };
}

/** 空白當沒有；Sheet 讀回來可能是數字也可能是字串 */
function perfNum_(v) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/** nearest-rank：排序後第 ceil(q×n) 個。不內插，回的一定是真的量到過的數字 */
function perfPercentile_(sorted, q) {
  return sorted[Math.max(Math.ceil(q * sorted.length) - 1, 0)];
}

function perfReadRows_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PERFORMANCE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheet, rows: [] };
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  return {
    sheet: sheet,
    rows: values.slice(1).map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      return o;
    })
  };
}

/**
 * perfSummary（管理員）：近 7 天的摘要，雲端算好再送，不傳原始列。
 *  - client：手機感受到的時間，依 trigger 分組（開 App、回前景、輪詢、手動刷新、寫入）
 *  - server：雲端內部時間，依 action 分組，附各分段佔比（%）
 * 依 trigger 分手機那組，是因為改版前後 action 名稱會變（3 輪流程 → boot），
 * 「開 App 要等多久」這個問題本身不變，比較基準才對得起來。
 */
function perfSummary_(caller, now) {
  if (!truthy_((caller.user || {}).is_admin)) return perfForbidden_(caller, 'perfSummary');
  var nowMs = now || Date.now();
  var data = perfReadRows_();
  var since = nowMs - PERF_SUMMARY_DAYS * PERF_DAY_MS;

  var oldest = NaN;
  var client = {};
  var server = {};
  var line = {};
  data.rows.forEach(function (r) {
    var t = toTime_(r.ts);
    if (!isNaN(t) && (isNaN(oldest) || t < oldest)) oldest = t;
    if (isNaN(t) || t < since) return;

    var c = perfNum_(r.client_ms);
    if (c !== null) {
      var ck = String(r.trigger || '');
      (client[ck] = client[ck] || []).push(c);
    }
    var s = perfNum_(r.server_ms);
    // LINE 另外一張表：使用者等的是「多久回覆」，不是整個 webhook 跑多久
    if (String(r.trigger || '') === 'line') {
      var lk = String(r.action || '');
      var lg = line[lk] = line[lk] || { reply: [], total: [] };
      var rp = perfNum_(r.reply_ms);
      if (rp !== null) lg.reply.push(rp);
      if (s !== null) lg.total.push(s);
      return;
    }
    if (s !== null) {
      var sk = String(r.action || '');
      var g = server[sk] = server[sk] || { ms: [], total: 0, auth: 0, open: 0, read: 0 };
      g.ms.push(s);
      g.total += s;
      g.auth += perfNum_(r.auth_ms) || 0;
      g.open += perfNum_(r.open_ms) || 0;
      g.read += perfNum_(r.read_ms) || 0;
    }
  });

  var asc = function (a, b) { return a - b; };
  var pct = function (part, total) { return total > 0 ? Math.round(part / total * 100) : 0; };
  return {
    success: true,
    days: PERF_SUMMARY_DAYS,
    total: data.rows.length,
    oldest: isNaN(oldest) ? '' : new Date(oldest).toISOString(),
    client: Object.keys(client).map(function (k) {
      var ms = client[k].sort(asc);
      return { trigger: k, count: ms.length, p50: perfPercentile_(ms, 0.5), p90: perfPercentile_(ms, 0.9) };
    }),
    server: Object.keys(server).map(function (k) {
      var g = server[k];
      var ms = g.ms.sort(asc);
      return { action: k, count: ms.length, p50: perfPercentile_(ms, 0.5), p90: perfPercentile_(ms, 0.9),
        auth_pct: pct(g.auth, g.total), open_pct: pct(g.open, g.total), read_pct: pct(g.read, g.total) };
    }),
    line: Object.keys(line).map(function (k) {
      var g = line[k];
      var rp = g.reply.sort(asc), tt = g.total.sort(asc);
      return { action: k, count: Math.max(rp.length, tt.length),
        reply_p50: rp.length ? perfPercentile_(rp, 0.5) : null, reply_p90: rp.length ? perfPercentile_(rp, 0.9) : null,
        total_p50: tt.length ? perfPercentile_(tt, 0.5) : null };
    })
  };
}

/**
 * perfPurge（管理員）：刪 ts 早於 N 天（預設 30）的列。手動按，不開排程（D-7）。
 *
 * 天數亂填一律退回預設——0 或負數會變成「全部刪掉」，那不該是打錯字的後果。
 * 認不出日期的列不刪：不知道多舊的東西，不替人決定它夠舊了。
 * 由下往上刪，連續的整段一次刪（deleteRows），列號才不會位移、也不會一列一列刪到逾時。
 */
function perfPurge_(caller, days, now) {
  if (!truthy_((caller.user || {}).is_admin)) return perfForbidden_(caller, 'perfPurge');
  var n = Math.floor(Number(days));
  if (days === null || days === undefined || days === '' || !(n >= 1)) n = PERF_PURGE_DEFAULT_DAYS;
  var cutoff = (now || Date.now()) - n * PERF_DAY_MS;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PERF_LOCK_MS)) return { error: 'busy' };
  try {
    var data = perfReadRows_();
    var doomed = [];                                   // Sheet 列號（表頭是第 1 列）
    data.rows.forEach(function (r, i) {
      var t = toTime_(r.ts);
      if (!isNaN(t) && t < cutoff) doomed.push(i + 2);
    });

    for (var end = doomed.length - 1; end >= 0;) {
      var start = end;
      while (start > 0 && doomed[start - 1] === doomed[start] - 1) start--;
      data.sheet.deleteRows(doomed[start], end - start + 1);
      end = start - 1;
    }

    var remaining = data.rows.length - doomed.length;
    logTransaction_('效能', '成功', 'perfPurge ' + n + ' 天前', '刪除 ' + doomed.length + ' 列',
      '剩 ' + remaining + ' 列', '', caller.line_id);
    return { success: true, days: n, deleted: doomed.length, remaining: remaining };
  } finally {
    lock.releaseLock();
  }
}


/* ========================================================================== */
/* ADR-013 — 記帳分類設定：大類 × 細項 × 對象（交棒票 T1／T2）                   */
/*                                                                            */
/* 取代 index.html 與 line-router.gs 各寫死一份的分類清單（D-3）。Neil 在 Sheet  */
/* 的 _expense_config 上改，PWA 從 boot 拿解析好的結構，LINE 讀同一份。          */
/* 改名的規則是「新增＋停用舊項」，不改字——舊資料存的是名稱，改了字就對不上。    */
/* ========================================================================== */

/**
 * 每一列是一個大類、細項或對象（kind 決定）。
 *  - parent  ：細項 → 所屬大類；對象 → 群組名（家人／車輛）
 *  - targets ：只對大類有效，可選的對象群組（群組名／全部／空白＝不顯示對象）
 *  - aliases ：只對大類有效，逗號分隔
 *  - color   ：只對大類有效，c1～c8（前端 :root 的 --c1～--c8）
 *  - is_active：空白或 TRUE＝啟用；其他（FALSE、取消勾選）＝停用
 */
var EXPENSE_CONFIG_HEADERS = ['kind', 'name', 'parent', 'targets', 'aliases', 'color', 'sort', 'is_active'];
var EXPENSE_CONFIG_CACHE_KEY = 'adr013_expense_config_v1';
var EXPENSE_CONFIG_CACHE_TTL = 300;      // 5 分鐘，比照白名單：Neil 改完 Sheet 最多等這麼久
var EXPENSE_COLOR_SLOTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
var EXPENSE_TARGETS_ALL = '全部';
/** 沒填細項的帳在統計裡的名字（「查/」兩層彙總用） */
var EXPENSE_UNSORTED = '未細分';
/** expenses 這次新增的欄位（交棒票 2-1）。plan_* 給分期（PR-B）用，這次先一起補上 */
var ADR013_EXPENSE_COLUMNS = ['subcategory', 'targets', 'plan_id', 'plan_seq'];
/** 一次性遷移：舊的「餐飲」改名為「飲食」（D-4） */
var EXPENSE_MIGRATE_FROM = '餐飲';
var EXPENSE_MIGRATE_TO = '飲食';

/**
 * 初版設定（D-4）。兩個用途：分頁不存在時寫進去的內容，以及分頁讀不到時的 fail-safe。
 * 刻意只有這一份：「內建清單」與「初版」是同一件事，分開寫遲早一邊忘了改。
 */
function expenseConfigSeed_() {
  var rows = [];
  var cat = function (name, color, targets, aliases) {
    rows.push(['category', name, '', targets || '', aliases || '', color, (rows.length + 1) * 10, '']);
  };
  var subs = function (parent, names) {
    names.forEach(function (n, i) { rows.push(['sub', n, parent, '', '', '', (i + 1) * 10, '']); });
  };
  var targets = function (group, names) {
    names.forEach(function (n, i) { rows.push(['target', n, group, '', '', '', (i + 1) * 10, '']); });
  };
  cat('飲食', 'c1', '', '餐飲');
  cat('交通', 'c2', '車輛');
  cat('日常用品', 'c3');
  cat('家庭', 'c4', '家人');
  cat('醫療', 'c5', '家人');
  cat('娛樂', 'c6', '家人');
  cat('其他', 'c7', EXPENSE_TARGETS_ALL);
  cat('教育', 'c8', '家人');
  subs('飲食', ['外食', '買菜', '冷凍', '常備食材']);
  subs('交通', ['加油', 'ETC', '保養']);
  subs('教育', ['學費', '月費', '才藝']);
  targets('家人', ['姐姐', '妹妹', '爸爸', '媽媽', '共有', '其他人']);
  targets('車輛', ['汽車V', '汽車X', '機車G', '機車A']);
  return rows;
}

function expenseConfigSeedRecords_() {
  return expenseConfigSeed_().map(function (row) {
    var o = {};
    EXPENSE_CONFIG_HEADERS.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

/** 空白＝啟用（Neil 新增一列不必記得打勾）；其餘只有 truthy_ 認得的才算啟用 */
function configActive_(v) {
  if (v === true) return true;
  var t = String(v == null ? '' : v).trim();
  return t === '' || truthy_(t);
}

function configSort_(v) {
  var n = Number(v);
  return (v === '' || v == null || !isFinite(n)) ? Infinity : n;
}

/**
 * 原始列 → 前後端都用的結構。純函式，Sheet 與快取都不碰。
 *
 * 有問題的列**跳過並記進 warnings**，不讓整張設定失效：一個打錯字的細項不該讓
 * 全家都不能記帳。warnings 會出現在 _guide 的「狀態」欄與 diagnoseExpenseConfig()。
 * 沒有任何一個啟用中的大類才算整份不能用（ok:false），交給呼叫端退回內建清單。
 */
function parseExpenseConfig_(records) {
  var warnings = [];
  var cats = [], catByName = {}, subOwner = {}, groups = {}, aliasOwner = {}, colorOwner = {};
  var subRows = [], aliasRows = [];

  (records || []).forEach(function (r, i) {
    var at = '第 ' + (i + 2) + ' 列';
    var kind = String(r.kind == null ? '' : r.kind).trim().toLowerCase();
    var name = String(r.name == null ? '' : r.name).trim();
    if (!kind && !name) return;                         // 空列（Sheet 底部常有）
    if (!name) { warnings.push(at + '沒有名稱'); return; }
    var row = { name: name, parent: String(r.parent == null ? '' : r.parent).trim(),
                sort: configSort_(r.sort), seq: i, active: configActive_(r.is_active), raw: r, at: at };

    if (kind === 'category') {
      if (catByName[name]) { warnings.push('大類「' + name + '」重複（' + at + '），只認第一個'); return; }
      var color = String(r.color == null ? '' : r.color).trim().toLowerCase();
      if (EXPENSE_COLOR_SLOTS.indexOf(color) === -1) {
        warnings.push('大類「' + name + '」的 color「' + (color || '空白') + '」不是 c1～c8');
        color = '';
      } else if (colorOwner[color]) {
        warnings.push('大類「' + name + '」與「' + colorOwner[color] + '」的顏色都是 ' + color);
      } else {
        colorOwner[color] = name;
      }
      row.color = color;
      row.targetGroup = String(r.targets == null ? '' : r.targets).trim();
      row.aliases = [];
      catByName[name] = row;
      cats.push(row);
      String(r.aliases == null ? '' : r.aliases).split(/[,，、]/).forEach(function (a) {
        a = a.trim();
        if (a) aliasRows.push({ alias: a, cat: row });
      });
    } else if (kind === 'sub') {
      subRows.push(row);
    } else if (kind === 'target') {
      if (!row.parent) { warnings.push('對象「' + name + '」沒有填群組（parent）'); return; }
      (groups[row.parent] = groups[row.parent] || []).push(row);
    } else {
      warnings.push(at + '的 kind「' + kind + '」不認得（只能是 category／sub／target）');
    }
  });

  // 細項名稱全表唯一（D-10）：LINE 只打細項就要推得回唯一一個大類
  subRows.forEach(function (s) {
    var owner = catByName[s.parent];
    if (!owner) { warnings.push('細項「' + s.name + '」的大類「' + (s.parent || '空白') + '」不存在'); return; }
    if (catByName[s.name]) { warnings.push('細項「' + s.name + '」跟大類同名，略過'); return; }
    if (subOwner[s.name]) {
      warnings.push('細項「' + s.name + '」重複（「' + subOwner[s.name] + '」與「' + s.parent + '」底下都有），只認第一個');
      return;
    }
    subOwner[s.name] = s.parent;
    (owner.subs = owner.subs || []).push(s);
  });

  aliasRows.forEach(function (a) {
    if (catByName[a.alias] || subOwner[a.alias] || aliasOwner[a.alias]) {
      warnings.push('別名「' + a.alias + '」跟其他大類、細項或別名撞名，略過');
      return;
    }
    aliasOwner[a.alias] = a.cat.name;
    a.cat.aliases.push(a.alias);
  });

  var bySort = function (a, b) { return a.sort === b.sort ? a.seq - b.seq : (a.sort < b.sort ? -1 : 1); };
  var activeNames = function (list) {
    return (list || []).filter(function (x) { return x.active; }).sort(bySort).map(function (x) { return x.name; });
  };
  var groupNames = Object.keys(groups);

  var categories = cats.slice().sort(bySort).map(function (c) {
    var targets = [];
    if (c.targetGroup === EXPENSE_TARGETS_ALL) {
      groupNames.forEach(function (g) { targets = targets.concat(activeNames(groups[g])); });
    } else if (c.targetGroup) {
      if (!groups[c.targetGroup]) warnings.push('大類「' + c.name + '」的對象群組「' + c.targetGroup + '」不存在');
      targets = activeNames(groups[c.targetGroup]);
    }
    return { name: c.name, color: c.color, active: c.active, aliases: c.aliases,
             subs: activeNames(c.subs), target_group: c.targetGroup, targets: targets };
  });

  var activeCount = categories.filter(function (c) { return c.active; }).length;
  if (!activeCount) warnings.push('沒有任何啟用中的大類');
  return { ok: activeCount > 0, categories: categories, warnings: warnings };
}

/**
 * 分頁不存在就建表並寫入初版；已存在就**不覆蓋**（比照 ensureLineUsersSheet_）。
 * 存在但整張空白（連表頭都沒有）視同不存在，補上表頭與初版。
 */
function ensureExpenseConfigSheet_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EXPENSE_CONFIG_SHEET);
  if (sheet && sheet.getLastRow() > 0) return sheet;
  if (!sheet) sheet = ss.insertSheet(EXPENSE_CONFIG_SHEET);
  var rows = [EXPENSE_CONFIG_HEADERS].concat(expenseConfigSeed_());
  sheet.getRange(1, 1, rows.length, EXPENSE_CONFIG_HEADERS.length).setValues(rows);
  console.log('已建立分頁「' + EXPENSE_CONFIG_SHEET + '」並寫入初版分類設定');
  logCleanup_('建立 ' + EXPENSE_CONFIG_SHEET, '已寫入初版分類設定（' + (rows.length - 1) + ' 列）',
    '之後請直接在 Sheet 上改；改名＝新增一列＋把舊的 is_active 取消');
  return sheet;
}

/** 讀分頁 → { ok, categories, warnings } 或 { ok:false, reason }。分頁不存在會先建 */
function readExpenseConfig_(ss) {
  try {
    ss = ss || SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EXPENSE_CONFIG_SHEET) || ensureExpenseConfigSheet_(ss);
    var values = sheet.getDataRange().getValues();
    var headers = (values[0] || []).map(function (h) { return String(h).trim(); });
    if (headers.indexOf('kind') === -1 || headers.indexOf('name') === -1) {
      return { ok: false, reason: 'no_kind_or_name_column', warnings: [] };
    }
    var records = values.slice(1).map(function (row) {
      var o = {};
      headers.forEach(function (h, i) { o[h] = row[i]; });
      return o;
    });
    var parsed = parseExpenseConfig_(records);
    if (!parsed.ok) parsed.reason = 'no_active_category';
    return parsed;
  } catch (err) {
    return { ok: false, reason: 'read_failed', error: String(err), warnings: [] };
  }
}

/**
 * 分類設定讀取入口：先問快取，沒有才讀 Sheet。
 *
 * ⚠️ 讀不到時 **fail-safe 退回內建的初版清單**並寫 logs（交棒票 1-2）——跟白名單的
 * fail-closed 刻意相反：分類是「選項」不是「權限」，記帳不能因為設定壞掉就全停。
 * 只快取成功的讀取（比照 lineUsersRoster_）：把退回的內建清單也快取起來，
 * Neil 修好 Sheet 之後還要再等五分鐘才看得到。
 */
function expenseConfig_(ss) {
  var cache = scriptCache_();
  if (cache) {
    var hit = cacheGetJson_(cache, EXPENSE_CONFIG_CACHE_KEY);
    if (hit) return hit;
  }
  var read = readExpenseConfig_(ss);
  if (read.ok) {
    var cfg = { source: 'sheet', categories: read.categories, warnings: read.warnings };
    if (cache) {
      try { cache.put(EXPENSE_CONFIG_CACHE_KEY, JSON.stringify(cfg), EXPENSE_CONFIG_CACHE_TTL); } catch (err) {}
    }
    return cfg;
  }

  console.log('⚠️ 記帳分類設定讀不到（' + read.reason + '），暫用內建清單');
  try {
    logTransaction_('同步', '失敗', '讀取 ' + EXPENSE_CONFIG_SHEET, '分類設定讀不到，暫用內建清單（記帳照常）',
      '原因：' + read.reason + (read.error ? '／' + read.error : '') +
      ((read.warnings || []).length ? '｜' + read.warnings.join('；') : ''), '', '');
  } catch (err) {}
  var builtin = parseExpenseConfig_(expenseConfigSeedRecords_());
  return { source: 'builtin', categories: builtin.categories, warnings: builtin.warnings };
}

/** 改完設定要立刻生效時用（diagnoseExpenseConfig、installAdr013） */
function invalidateExpenseConfigCache_() {
  var cache = scriptCache_();
  if (cache) { try { cache.remove(EXPENSE_CONFIG_CACHE_KEY); } catch (err) {} }
}

/** 送給前端的形狀：warnings 不送（那是給 Neil 在 _guide 看的） */
function expenseConfigPublic_(cfg) {
  return { source: cfg.source, categories: cfg.categories };
}

/**
 * LINE 輸入的分類欄 → { category, sub, alias }，認不得回 null（D-10）。
 * 只認啟用中的：停用的大類／細項不出現在選單，打字也不該打得進去。
 * 比對順序：大類名 → 大類別名 → 細項名（細項自動推回大類）。
 */
function resolveExpenseCategory_(cfg, raw) {
  var t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  var cats = (cfg.categories || []).filter(function (c) { return c.active; });
  var i;
  for (i = 0; i < cats.length; i++) if (cats[i].name === t) return { category: t, sub: '', alias: '' };
  for (i = 0; i < cats.length; i++) if (cats[i].aliases.indexOf(t) !== -1) return { category: cats[i].name, sub: '', alias: t };
  for (i = 0; i < cats.length; i++) if (cats[i].subs.indexOf(t) !== -1) return { category: cats[i].name, sub: t, alias: '' };
  return null;
}

/**
 * 統計用：已存的分類名 → 現在的大類名。別名換回正名（遷移前的「餐飲」併進「飲食」），
 * 停用的大類照樣認得（舊資料照常統計），認不得的原樣保留——不替使用者把錢搬到「其他」。
 */
function canonicalExpenseCategory_(cfg, raw) {
  var t = String(raw == null ? '' : raw).trim();
  var cats = (cfg && cfg.categories) || [];
  for (var i = 0; i < cats.length; i++) {
    if (cats[i].name === t || cats[i].aliases.indexOf(t) !== -1) return cats[i].name;
  }
  return t;
}

/**
 * 分類表的文字版（LINE「分類」關鍵字、分類打錯時的提示）。
 * withTargets=false 是錯誤提示用的短版：只列大類與細項。
 */
function expenseCategoryTable_(cfg, withTargets) {
  var lines = [];
  (cfg.categories || []).filter(function (c) { return c.active; }).forEach(function (c) {
    lines.push('・' + c.name + (c.aliases.length ? '（別名：' + c.aliases.join('、') + '）' : ''));
    if (c.subs.length) lines.push('　細項：' + c.subs.join('、'));
    if (withTargets && c.targets.length) lines.push('　對象：' + c.targets.join('、'));
  });
  return lines.join('\n');
}

/**
 * 分類設定健檢——在編輯器裡選這支按「執行」（比照 diagnoseLineUsers）。
 * 會先清快取，看到的就是 Sheet 此刻的內容。
 */
function diagnoseExpenseConfig() {
  invalidateExpenseConfigCache_();
  var read = readExpenseConfig_();
  if (!read.ok) {
    console.log('❌ 分類設定不能用（' + read.reason + (read.error ? '／' + read.error : '') + '），目前記帳走內建清單');
  } else {
    console.log('✅ 分頁「' + EXPENSE_CONFIG_SHEET + '」讀得到');
  }
  (read.categories || []).forEach(function (c) {
    console.log('   ' + (c.active ? '●' : '○') + ' ' + c.name + ' [' + (c.color || '無色') + ']' +
      (c.subs.length ? ' 細項：' + c.subs.join('、') : '') +
      (c.targets.length ? ' 對象：' + c.targets.join('、') : ''));
  });
  (read.warnings || []).forEach(function (w) { console.log('⚠️ ' + w); });
  return read;
}

/**
 * 一次性遷移：expenses 的 category「餐飲」→「飲食」（D-4）。可重複執行：
 * 第二次跑找不到「餐飲」，就什麼都不改。只改 category 那一格，其他欄一格都不碰。
 */
function migrateExpenseDiningToFood() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('expenses');
  if (!sheet) { console.log('⏭️ 分頁「expenses」不存在，略過'); return { changed: 0, reason: 'sheet_missing' }; }
  var headers = sheetHeaders_(sheet);
  var col = headers.indexOf('category') + 1;
  var lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) return { changed: 0 };

  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  var rows = [];
  values.forEach(function (v, i) {
    if (String(v[0] == null ? '' : v[0]).trim() !== EXPENSE_MIGRATE_FROM) return;
    sheet.getRange(i + 2, col, 1, 1).setValues([[EXPENSE_MIGRATE_TO]]);
    rows.push(i + 2);
  });
  logCleanup_('遷移 expenses 分類', EXPENSE_MIGRATE_FROM + '→' + EXPENSE_MIGRATE_TO + '：' + rows.length + ' 列',
    rows.length ? '列號：' + rows.join(', ') : '沒有要改的列（已遷移過）');
  console.log((rows.length ? '✅ ' : '✔ ') + EXPENSE_MIGRATE_FROM + '→' + EXPENSE_MIGRATE_TO + '：改了 ' + rows.length + ' 列');
  return { changed: rows.length, rows: rows };
}

/**
 * ADR-013 安裝——merge 後在 Apps Script 編輯器選這支按「執行」一次（比照 ensureAdr009Columns），
 * 或由管理者在 LINE 傳「初始化」（line-router.gs 的 handleInitCommand_）。
 * 三件事，全部可重複執行：
 *   1. expenses 往右補 subcategory／targets／plan_id／plan_seq
 *   2. _expense_config 不存在就建表寫初版（存在不覆蓋）；installments 不存在就建表頭
 *   3. 「餐飲」→「飲食」遷移
 *
 * ⚠️ 第 1 步沒跑之前，細項與對象寫不進 Sheet（寫入都依表頭對位，沒有那一欄就安靜地略過）。
 */
function installAdr013() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var expenses = ss.getSheetByName('expenses');
  var columns = { added: [], reason: 'sheet_missing' };
  if (!expenses) {
    console.log('⏭️ 分頁「expenses」不存在，略過補欄位');
  } else {
    columns = ensureColumnsOnSheet_(expenses, ADR013_EXPENSE_COLUMNS);
    console.log(columns.added.length ? '✅ expenses 補上欄位：' + columns.added.join('、') : '✔ expenses 欄位已齊備');
  }
  ensureExpenseConfigSheet_(ss);
  ensureInstallmentsSheet_(ss);
  var migrated = migrateExpenseDiningToFood();
  var config = diagnoseExpenseConfig();
  console.log('—— ADR-013 安裝完成。此函式可重複執行。');
  return { columns: columns, migrated: migrated.changed, config_ok: config.ok,
           categories: (config.categories || []).length, warnings: config.warnings || [] };
}


/* ========================================================================== */
/* ADR-013 — 分期（D-6～D-8，交棒票 T4）                                         */
/*                                                                            */
/* 先記一筆 → PWA「轉成分期」→ planCreate 一次做完：寫計畫列、原本那筆軟刪除、   */
/* 預先產生各期。不用排程：各期一產生就是普通的記帳列，月小計、「查/」、甜甜圈     */
/* 全部照舊算，不必認得「分期」這回事。                                          */
/*                                                                            */
/* 第一版只做「刪得掉、停得了、單筆改得動」（D-8）：                              */
/*   planDelete：整個計畫刪除，各期全軟刪除、原本那筆恢復                         */
/*   planEnd   ：結束計畫，今天之後的期數軟刪除，已到期的保留                     */
/*   改某一期  ：一般 upsert，不回寫計畫                                          */
/* 保留方向（不做）：① 改計畫同步到各期 ② 分期↔信用卡連動                        */
/* ========================================================================== */

var INSTALLMENTS_HEADERS = ['plan_id', 'source_expense_id', 'total', 'down_payment', 'periods', 'first_date',
  'category', 'subcategory', 'targets', 'note', 'card', 'line_id', 'status', 'created_at', 'ended_at'];
var PLAN_PERIODS_MAX = 120;              // 十年。超過的不是分期，是打錯字
var PLAN_LOCK_MS = 10000;
var PLAN_CARD_MAX = 40;
/** 頭期那一列的 plan_seq */
var PLAN_SEQ_DOWN = '頭期';
/**
 * 各期 plan_seq 的分隔字元是**全形**斜線：「3／12」。半形的「3/12」寫進 Sheet 會被自動
 * 轉成 3 月 12 日——那就不是第幾期了，而且是安靜的。前端顯示時換回「第 3/12 期」。
 */
var PLAN_SEQ_SEP = '／';

/** 建表方式比照 ensurePerformanceSheet_：只建表頭 */
function ensureInstallmentsSheet_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INSTALLMENTS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(INSTALLMENTS_SHEET);
    sheet.appendRow(INSTALLMENTS_HEADERS);
    return sheet;
  }
  if (sheet.getLastRow() === 0) sheet.appendRow(INSTALLMENTS_HEADERS);
  return sheet;
}

/** 送前端的計畫列（刪除的不送）。分頁還沒建＝還沒有任何計畫 */
function installmentPlans_(ss) {
  var sheet = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName(INSTALLMENTS_SHEET);
  if (!sheet) return [];
  var read = sheetRecords_(ss || SpreadsheetApp.getActiveSpreadsheet(), INSTALLMENTS_SHEET, {});
  if (read.error) return [];
  return read.rows.filter(function (p) {
    return String(p.plan_id || '').trim() && String(p.status || '').trim() !== 'deleted';
  }).map(function (p) {
    var o = {};
    INSTALLMENTS_HEADERS.forEach(function (h) { o[h] = p[h] instanceof Date ? keyValue_(p[h]) : (p[h] == null ? '' : p[h]); });
    return o;
  });
}

/** 'YYYY-MM-DD' 的下 n 個月 1 號。純函式 */
function monthFirstAfter_(dateKey, n) {
  var d = parseDateKey_(dateKey);
  if (!d) return '';
  return keyValue_(new Date(d.getFullYear(), d.getMonth() + n, 1, 12, 0, 0, 0));
}

/**
 * 各期的日期與金額（D-6）。純函式，PWA 的預覽也走這一份（planCreate 的 dry_run）——
 * 前後端各算一份，遲早有一天預覽說 1,983、存進去的是 1,984。
 *  - 有頭期款：頭期一筆，日期＝原日期
 *  - 剩餘金額 ÷ 期數，無條件捨去成整數，零頭全放最後一期
 *  - 第 1 期＝原日期的下個月 1 號，之後每月 1 號
 */
function planSchedule_(total, downPayment, periods, dateKey) {
  var rows = [];
  if (downPayment > 0) rows.push({ seq: PLAN_SEQ_DOWN, date: dateKey, amount: downPayment });
  var rest = total - downPayment;
  var each = Math.floor(rest / periods);
  for (var i = 1; i <= periods; i++) {
    var amount = i < periods ? each : Math.round((rest - each * (periods - 1)) * 100) / 100;
    rows.push({ seq: i + PLAN_SEQ_SEP + periods, date: monthFirstAfter_(dateKey, i), amount: amount });
  }
  return rows;
}

/** 分期的動作一律要有記帳權限（跟寫 expenses 同一條規則） */
function planForbidden_(caller, action) {
  return canUseSheet_(caller.user, 'expenses') ? null : featureForbidden_(caller, action, 'expenses');
}

/** expenses 整張讀進來，附列號。分期要用的欄位缺了就回 missing（請先跑「初始化」） */
function planExpenses_(ss) {
  var sheet = ss.getSheetByName('expenses');
  if (!sheet) return { error: 'sheet_not_found' };
  var headers = sheetHeaders_(sheet);
  var missing = ['id', DEL_FIELD, 'plan_id', 'plan_seq'].filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) return { error: 'columns_missing', missing: missing };
  var lastRow = sheet.getLastRow();
  var values = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return {
    sheet: sheet, headers: headers,
    rows: values.map(function (line, i) {
      var rec = {};
      headers.forEach(function (h, c) { rec[h] = line[c]; });
      return { row: i + 2, record: rec };
    })
  };
}

function planLog_(status, input, result, detail, lineId) {
  try { logTransaction_('記帳', status, input, result, detail || '', '', lineId); } catch (err) {}
}

/**
 * planCreate → { success, plan_id, schedule } ／ dry_run → { success, dry_run, schedule }（什麼都不寫）
 *
 * 防連按兩次：整段包在鎖裡，而且原本那筆一旦轉過（已軟刪除、或帶著 plan_id）就拒絕——
 * 第二次請求排到鎖之後，看到的已經是轉過的那筆，不會再產生第二套。
 */
function planCreate_(caller, body) {
  var forbidden = planForbidden_(caller, 'planCreate');
  if (forbidden) return forbidden;

  var periods = Number(body.periods);
  if (!(periods >= 2 && periods <= PLAN_PERIODS_MAX && Math.floor(periods) === periods)) {
    return { error: 'invalid_periods', max: PLAN_PERIODS_MAX };
  }
  var down = body.down_payment === '' || body.down_payment == null ? 0 : Number(body.down_payment);
  var card = String(body.card == null ? '' : body.card).replace(/[\r\n\t]+/g, ' ').trim().slice(0, PLAN_CARD_MAX);
  var id = keyValue_(body.expense_id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PLAN_LOCK_MS)) return { error: 'busy' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ex = planExpenses_(ss);
    if (ex.error) return ex;
    var hit = null;
    ex.rows.some(function (r) { if (keyValue_(r.record.id) === id) { hit = r; return true; } return false; });
    if (!id || !hit || isTombstone_(hit.record)) return { error: 'expense_not_found' };
    var src = hit.record;
    if (String(src.type || '').trim() === 'income') return { error: 'not_an_expense' };
    if (keyValue_(src.plan_id) || keyValue_(src.plan_seq)) return { error: 'already_planned' };

    var total = Number(src.amount);
    if (!(total > 0)) return { error: 'invalid_amount' };
    if (!(isFinite(down) && down >= 0 && down < total)) return { error: 'invalid_down_payment' };
    var dateKey = keyValue_(src.expense_date);
    if (!parseDateKey_(dateKey)) return { error: 'invalid_date' };
    if (total - down < periods) return { error: 'amount_too_small' };   // 每期至少 1 元

    var schedule = planSchedule_(total, down, periods, dateKey);
    if (body.dry_run === true) return { success: true, dry_run: true, schedule: schedule };

    var now = new Date().toISOString();
    var planId = 'P' + Date.now();
    var base = Date.now();
    var rows = schedule.map(function (s, i) {
      var rec = {};
      ex.headers.forEach(function (h) { rec[h] = src[h] == null ? '' : src[h]; });
      rec.id = String(base + i);
      rec.expense_date = s.date;
      rec.amount = s.amount;
      rec.plan_id = planId;
      rec.plan_seq = s.seq;
      rec.created_at = now;
      rec[DEL_FIELD] = '';
      if ('board' in rec) rec.board = '';
      return ex.headers.map(function (h) { return rec[h]; });
    });

    ensureInstallmentsSheet_(ss).appendRow(INSTALLMENTS_HEADERS.map(function (h) {
      return ({ plan_id: planId, source_expense_id: id, total: total, down_payment: down || '', periods: periods,
        first_date: monthFirstAfter_(dateKey, 1), category: src.category, subcategory: src.subcategory,
        targets: src.targets, note: src.note, card: card, line_id: caller.line_id, status: 'active',
        created_at: now, ended_at: '' })[h] ?? '';
    }));
    ex.sheet.getRange(ex.sheet.getLastRow() + 1, 1, rows.length, ex.headers.length).setValues(rows);
    // 原本那筆：軟刪除並記下 plan_id——planDelete 靠它找回來恢復
    setDeviceFields_(ex.sheet, ex.headers, hit.row, { del: 'TRUE', plan_id: planId });

    planLog_('成功', '轉成分期 ' + src.category + ' ' + total,
      '已建立 ' + planId + '：' + (down ? '頭期 ' + down + '＋' : '') + periods + ' 期',
      '原本那筆 id=' + id + ' 已軟刪除', caller.line_id);
    return { success: true, plan_id: planId, schedule: schedule };
  } finally {
    lock.releaseLock();
  }
}

/** 找計畫列。回 { sheet, headers, row, record } 或 { error } */
function findPlan_(ss, planId) {
  var sheet = ss.getSheetByName(INSTALLMENTS_SHEET);
  var id = keyValue_(planId);
  if (!sheet || !id) return { error: 'plan_not_found' };
  var headers = sheetHeaders_(sheet);
  var rows = findRowsByKey_(sheet, [headers.indexOf('plan_id') + 1], id);
  if (!rows.length) return { error: 'plan_not_found' };
  var values = sheet.getRange(rows[0], 1, 1, headers.length).getValues()[0];
  var record = {};
  headers.forEach(function (h, i) { record[h] = values[i]; });
  return { sheet: sheet, headers: headers, row: rows[0], record: record };
}

/** 計畫底下的各期（含頭期；不含原本那筆——它沒有 plan_seq） */
function planPeriods_(ex, planId) {
  return ex.rows.filter(function (r) {
    return keyValue_(r.record.plan_id) === planId && keyValue_(r.record.plan_seq);
  });
}

/**
 * planDelete（建錯了）：計畫 status=deleted；**所有期**軟刪除；原本那筆恢復（取消軟刪除、清掉 plan_id）。
 * 恢復之後它就是一筆普通的帳，可以重新轉一次。
 */
function planDelete_(caller, planId) {
  var forbidden = planForbidden_(caller, 'planDelete');
  if (forbidden) return forbidden;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PLAN_LOCK_MS)) return { error: 'busy' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var plan = findPlan_(ss, planId);
    if (plan.error) return plan;
    if (String(plan.record.status || '').trim() === 'deleted') return { error: 'plan_already_deleted' };
    var ex = planExpenses_(ss);
    if (ex.error) return ex;
    var id = keyValue_(planId);

    var periods = planPeriods_(ex, id);
    periods.forEach(function (r) { setDeviceFields_(ex.sheet, ex.headers, r.row, { del: 'TRUE' }); });
    var restored = 0;
    var srcId = keyValue_(plan.record.source_expense_id);
    ex.rows.forEach(function (r) {
      if (keyValue_(r.record.id) !== srcId || keyValue_(r.record.plan_seq)) return;
      setDeviceFields_(ex.sheet, ex.headers, r.row, { del: '', plan_id: '' });
      restored++;
    });
    setDeviceFields_(plan.sheet, plan.headers, plan.row, { status: 'deleted', ended_at: new Date().toISOString() });

    planLog_(restored ? '成功' : '失敗', '刪除分期 ' + id,
      '已刪除 ' + periods.length + ' 期' + (restored ? '，原本那筆已恢復' : '，⚠️ 找不到原本那筆，沒有恢復'),
      'source_expense_id=' + srcId, caller.line_id);
    return { success: true, deleted: periods.length, restored: restored };
  } finally {
    lock.releaseLock();
  }
}

/**
 * planEnd（不付了／提前還清）：計畫 status=ended；**日期在今天之後**的期數軟刪除，已到期的保留。
 * today 只給測試用（比照 completeRecurring）；平常走伺服器的今天。
 */
function planEnd_(caller, planId, today) {
  var forbidden = planForbidden_(caller, 'planEnd');
  if (forbidden) return forbidden;
  var todayKey = keyValue_(today) || keyValue_(new Date());
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(PLAN_LOCK_MS)) return { error: 'busy' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var plan = findPlan_(ss, planId);
    if (plan.error) return plan;
    if (String(plan.record.status || '').trim() !== 'active') return { error: 'plan_not_active' };
    var ex = planExpenses_(ss);
    if (ex.error) return ex;
    var id = keyValue_(planId);

    var removed = 0, kept = 0;
    planPeriods_(ex, id).forEach(function (r) {
      if (isTombstone_(r.record)) return;
      if (keyValue_(r.record.expense_date) > todayKey) {
        setDeviceFields_(ex.sheet, ex.headers, r.row, { del: 'TRUE' });
        removed++;
      } else {
        kept++;
      }
    });
    setDeviceFields_(plan.sheet, plan.headers, plan.row, { status: 'ended', ended_at: new Date().toISOString() });
    planLog_('成功', '結束分期 ' + id, '刪除 ' + removed + ' 期未到期，保留 ' + kept + ' 期', '今天=' + todayKey, caller.line_id);
    return { success: true, removed: removed, kept: kept };
  } finally {
    lock.releaseLock();
  }
}


/* ========================================================================== */
/* 首頁「系統設定」卡片（管理員，2026-10-06 Neil 要求）                          */
/*                                                                            */
/* line_groups、_expense_config、installments、_guide 原本只能在 Sheet 上看、改。 */
/* 這一段讓管理員在 App 首頁就能看、能改（比照「成員與權限」：改動即時寫回）。     */
/* ADR-013 D-16 把「管理員分頁」排在第 2 輪：這是提前做的功能面，版面之後重設計。  */
/*                                                                            */
/* 一律只有管理者能用；每一筆改動都寫 logs（source「設定」）。                    */
/* PWA 的一般 read／upsert 仍然碰不到這幾張表（NO_PWA_READ／NO_PWA_WRITE 不變）： */
/* 只有這幾個驗過欄位與值的 action 改得動，改名、刪列這類會讓舊資料對不上的動作沒有開。 */
/* ========================================================================== */

var SETTINGS_LOG_SOURCE = '設定';
var GROUP_SET_FIELDS = ['is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'notify_due'];
var CONFIG_SET_FIELDS = ['is_active', 'color', 'targets', 'aliases', 'sort'];
var CONFIG_KINDS = ['category', 'sub', 'target'];
var CONFIG_NAME_MAX = 20;

function adminForbidden_(caller, action) {
  if (truthy_((caller.user || {}).is_admin)) return null;
  try { logTransaction_(SETTINGS_LOG_SOURCE, '失敗', action, '只有管理者可以改系統設定', '', '', caller.line_id); } catch (err) {}
  return { error: 'forbidden' };
}

function settingsLog_(caller, input, result, detail) {
  try { logTransaction_(SETTINGS_LOG_SOURCE, '成功', input, result, detail || '', '', caller.line_id); } catch (err) {}
}

/** Sheet 的值送前端：日期換成字串，null 換成空字串 */
function plainRecord_(rec, headers) {
  var o = {};
  headers.forEach(function (h) {
    var v = rec[h];
    o[h] = v instanceof Date ? v.toISOString() : (v == null ? '' : v);
  });
  return o;
}

/**
 * adminView：what = groups／config／guide。（分期計畫前端早就有了——boot 帶回來的 installments）
 * config 回原始列（含停用的，才能重新啟用）＋自檢 warnings。
 */
function adminView_(caller, what) {
  var forbidden = adminForbidden_(caller, 'adminView ' + what);
  if (forbidden) return forbidden;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (what === 'groups') {
    var all = readLineGroups_();
    if (!all.ok) return { error: 'read_failed', message: all.error };
    return { success: true, rows: all.rows.map(function (r) { return plainRecord_(r.record, LINE_GROUPS_HEADERS); }) };
  }
  if (what === 'config') {
    var cfg = configRows_(ss);
    var parsed = readExpenseConfig_(ss);
    return { success: true, rows: cfg.rows.map(function (r) { return plainRecord_(r.record, EXPENSE_CONFIG_HEADERS); }),
             warnings: parsed.warnings || [], ok: !!parsed.ok };
  }
  if (what === 'guide') {
    return { success: true, headers: GUIDE_HEADERS, rows: guideRows_(ss, {}) };
  }
  return { error: 'unknown_view' };
}

/** 群組的啟用與指令開關。只收 GROUP_SET_FIELDS、只收真假值 */
function groupSet_(caller, groupId, field, value) {
  var forbidden = adminForbidden_(caller, 'groupSet');
  if (forbidden) return forbidden;
  if (GROUP_SET_FIELDS.indexOf(field) === -1) return { error: 'invalid_field' };
  var id = String(groupId == null ? '' : groupId).trim();
  var all = readLineGroups_();
  if (!all.ok) return { error: 'read_failed', message: all.error };
  var hit = findGroup_(all, id);
  if (!id || !hit) return { error: 'group_not_found' };
  var v = value === true ? 'TRUE' : '';
  setDeviceFields_(all.sheet, all.headers, hit.row, (function () {
    var p = { updated_at: new Date().toISOString() }; p[field] = v; return p;
  })());
  invalidateLineGroupsCache_();          // LINE 的三道門立刻看到新設定，不等快取過期
  settingsLog_(caller, 'groupSet ' + (hit.record.name || id), field + ' → ' + (v ? '開' : '關'), 'group_id=' + id);
  return { success: true, group_id: id, field: field, value: v };
}

/** _expense_config 整張讀進來（附列號）；分頁不存在就建表寫初版，跟 expenseConfig_ 同一條規則 */
function configRows_(ss) {
  var sheet = ss.getSheetByName(EXPENSE_CONFIG_SHEET) || ensureExpenseConfigSheet_(ss);
  var headers = sheetHeaders_(sheet);
  var lastRow = sheet.getLastRow();
  var values = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];
  values.forEach(function (line, i) {
    var rec = {};
    headers.forEach(function (h, c) { rec[h] = line[c]; });
    if (String(rec.name == null ? '' : rec.name).trim()) rows.push({ row: i + 2, record: rec });
  });
  return { sheet: sheet, headers: headers, rows: rows };
}

/** 一列的身分：kind＋name，對象（target）還要加群組——不同群組可以有同名的對象 */
function configKeyOf_(rec) {
  var kind = String(rec.kind == null ? '' : rec.kind).trim().toLowerCase();
  return kind + '|' + String(rec.name == null ? '' : rec.name).trim() + '|' +
    (kind === 'target' ? String(rec.parent == null ? '' : rec.parent).trim() : '');
}

/**
 * 改完設定：用手上（已套用改動）的列直接算出新設定，**放進快取**並回傳最新的列與自檢——
 * 不再整張重讀一次，App 也不必再發一個請求抓清單（2026-10-06 效能調整）。
 * 新設定不能用（沒有任何啟用中的大類）時改成清快取，讓下一次讀取走 fail-safe 那條路。
 */
function configCommit_(cfg) {
  var records = cfg.rows.map(function (r) { return r.record; });
  var parsed = parseExpenseConfig_(records);
  var cache = scriptCache_();
  if (parsed.ok && cache) {
    try {
      cache.put(EXPENSE_CONFIG_CACHE_KEY, JSON.stringify({ source: 'sheet', categories: parsed.categories, warnings: parsed.warnings }),
        EXPENSE_CONFIG_CACHE_TTL);
    } catch (err) { invalidateExpenseConfigCache_(); }
  } else {
    invalidateExpenseConfigCache_();
  }
  return { success: true, warnings: parsed.warnings || [], ok: !!parsed.ok,
           rows: cfg.rows.map(function (r) { return plainRecord_(r.record, EXPENSE_CONFIG_HEADERS); }) };
}

/**
 * configSet：改一格。key = { kind, name, parent }。
 * 沒有開放改 name／kind／parent：改名要「新增＋停用舊的」，不然舊帳存的名字就對不上了（D-3）。
 */
function configSet_(caller, key, field, value) {
  var forbidden = adminForbidden_(caller, 'configSet');
  if (forbidden) return forbidden;
  if (CONFIG_SET_FIELDS.indexOf(field) === -1) return { error: 'invalid_field' };
  var v;
  if (field === 'is_active') {
    v = value === true ? 'TRUE' : 'FALSE';              // 明寫 FALSE：空白在這張表是「啟用」
  } else if (field === 'color') {
    v = String(value == null ? '' : value).trim().toLowerCase();
    if (v && EXPENSE_COLOR_SLOTS.indexOf(v) === -1) return { error: 'invalid_color' };
  } else if (field === 'sort') {
    v = value === '' || value == null ? '' : Number(value);
    if (v !== '' && !isFinite(v)) return { error: 'invalid_sort' };
  } else {
    v = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = configRows_(ss);
  var want = configKeyOf_(key || {});
  var hit = null;
  cfg.rows.some(function (r) { if (configKeyOf_(r.record) === want) { hit = r; return true; } return false; });
  if (!hit) return { error: 'config_not_found' };
  if (field !== 'is_active' && field !== 'sort' && String(hit.record.kind).trim() !== 'category') {
    return { error: 'invalid_field' };                   // 顏色、對象群組、別名只對大類有意義
  }
  var patch = {};
  patch[field] = v;
  setDeviceFields_(cfg.sheet, cfg.headers, hit.row, patch);
  hit.record[field] = v;
  settingsLog_(caller, 'configSet ' + hit.record.kind + ' ' + hit.record.name, field + ' → ' + (v === '' ? '（空白）' : v));
  return configCommit_(cfg);
}

/**
 * configAdd：新增一個大類／細項／對象（改名也是走這條：新增新的，再把舊的停用）。
 * 擋重複（細項名稱全表唯一、大類唯一、對象在同一個群組裡唯一）與掛錯地方的細項。
 */
function configAdd_(caller, record) {
  var forbidden = adminForbidden_(caller, 'configAdd');
  if (forbidden) return forbidden;
  var r = record || {};
  var kind = String(r.kind == null ? '' : r.kind).trim().toLowerCase();
  var name = String(r.name == null ? '' : r.name).replace(/[\r\n\t,，、]+/g, ' ').trim();
  var parent = String(r.parent == null ? '' : r.parent).trim();
  if (CONFIG_KINDS.indexOf(kind) === -1) return { error: 'invalid_kind' };
  if (!name || name.length > CONFIG_NAME_MAX || name.indexOf('/') !== -1) return { error: 'invalid_name' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = configRows_(ss);
  var recs = cfg.rows.map(function (x) { return x.record; });
  var named = function (k, n) {
    return recs.filter(function (x) { return String(x.kind).trim().toLowerCase() === k && String(x.name).trim() === n; });
  };
  if (kind === 'category' && named('category', name).length) return { error: 'duplicate_name' };
  if (kind === 'sub') {
    if (!named('category', parent).length) return { error: 'parent_not_found' };
    if (named('sub', name).length || named('category', name).length) return { error: 'duplicate_name' };
  }
  if (kind === 'target') {
    if (!parent) return { error: 'parent_required' };
    if (named('target', name).some(function (x) { return String(x.parent).trim() === parent; })) return { error: 'duplicate_name' };
  }
  var color = String(r.color == null ? '' : r.color).trim().toLowerCase();
  if (kind === 'category' && color && EXPENSE_COLOR_SLOTS.indexOf(color) === -1) return { error: 'invalid_color' };

  var sort = 0;
  recs.forEach(function (x) {
    var n = Number(x.sort);
    if (String(x.kind).trim().toLowerCase() === kind && isFinite(n) && n > sort) sort = n;
  });
  var row = { kind: kind, name: name, parent: kind === 'category' ? '' : parent,
              targets: kind === 'category' ? String(r.targets == null ? '' : r.targets).trim() : '',
              aliases: '', color: kind === 'category' ? color : '', sort: sort + 10, is_active: '' };
  cfg.sheet.appendRow(cfg.headers.map(function (h) { return row[h] == null ? '' : row[h]; }));
  cfg.rows.push({ row: cfg.sheet.getLastRow(), record: row });
  settingsLog_(caller, 'configAdd ' + kind + ' ' + name, '已新增' + (row.parent ? '（' + row.parent + '）' : ''));
  return configCommit_(cfg);
}
