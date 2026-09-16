/**
 * Neil OS — PWA ↔ Google Sheets 同步（Apps Script 端）
 * ---------------------------------------------------------------------------
 * doGet  : 讀取一張分頁（刻意不驗證，見 ADR-008 D-2）
 * doPost : 由 line-router.gs 依 payload 形狀分流後呼叫 handlePwaSync_
 *
 * 寫入前一律過 line_users 白名單（ADR-008 Part D）。讀取維持現狀——
 * exec 網址一旦外流，讀取本來就擋不住（Apps Script 的 doGet 讀不到 HTTP Header，
 * 沒有東西可以拿來驗身份），那是 ADR-007 已記錄在案的既有限制。本次只把「寫入」
 * 這一層關起來，不重新設計整個安全模型。
 */

/**
 * 同步密鑰改讀指令碼屬性，不寫在原始碼裡。
 *
 * 這份程式碼鏡像進公開的 GitHub repo，寫死等於把鑰匙貼在大門上，而且 git
 * history 洗不掉。比照 LINE_CHANNEL_ACCESS_TOKEN 與 GEMINI_API_KEY 的既有
 * 慣例：伺服器端用得到的密鑰，一律放指令碼屬性。
 *
 * 設定：專案設定 → 指令碼屬性 → CLOUD_SECRET = 與 GitHub Secret 同一個值
 * （從網頁複製常會帶到換行或空白，前後修掉，比照 LINE 權杖的處理）
 */
function cloudSecret_() {
  const raw = PropertiesService.getScriptProperties().getProperty('CLOUD_SECRET');
  return raw ? String(raw).trim() : '';
}

/* ========================================================================== */
/* line_users 白名單（ADR-008 Part D）                                         */
/* ========================================================================== */

var LINE_USERS_SHEET = 'line_users';
var LINE_USERS_CACHE_KEY = 'adr008_line_users_v1';
var LINE_USERS_CACHE_TTL = 300;          // 5 分鐘（ADR-008 D-3）

/**
 * 整包 replaceAll 打不得的分頁。
 *
 * logs 是 Apps Script 單向寫入的記錄，line_users 是白名單本身——兩者都不屬於
 * 前端那份 state，被整包覆蓋等於資料消失（line_users 的話還會順便把所有人
 * 鎖在門外，包含改壞它的那個人）。管理頁一律走 append + upsert 改單列。
 */
var NO_REPLACE_ALL = [LINE_USERS_SHEET, 'logs'];

/**
 * 功能矩陣的欄位清單，與前端 FEATURE_BY_VIEW 的值一一對應。
 * 這裡只在「建表」與「註冊」時用到——閘門不看 feat_*（ADR-008 E-2）。
 */
var LINE_USERS_FEATURES = ['feat_expense', 'feat_tasks', 'feat_review',
                           'feat_notes', 'feat_mood', 'feat_log'];

/** 建表用的完整表頭（ADR-008 D-1 的欄序） */
var LINE_USERS_HEADERS = ['line_id', 'display_name', 'is_active', 'is_admin']
  .concat(LINE_USERS_FEATURES).concat(['created_at', 'updated_at']);

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
 * 功能權限（feat_*）刻意不在這裡驗——那一層只做前端隱藏（ADR-008 E-2）。
 * 被繞過的代價僅止於「多看了一個空白分頁」，跟寫入資格不是同一個量級。
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

// ===== 讀取：GET /exec?sheet=tasks =====
function doGet(e) {
  const sheetName = e.parameter.sheet;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return jsonOut({ error: 'sheet_not_found', sheet: sheetName });

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonOut({ data: [] });

  const headers = values[0];
  const rows = values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i]);
    return obj;
  });
  return jsonOut({ data: rows });
}

// ===== 寫入：POST body = { secret, sheet, action, ... } =====
function handlePwaSync_(e) {
  const body = JSON.parse(e.postData.contents);

  const secret = cloudSecret_();
  if (!secret) {
    // 讀不到就一律拒絕。fail-open 等於把門直接拆掉——寧可同步壞掉讓人發現，
    // 也不能安靜地變成「誰都能寫」。
    console.log('❌ 指令碼屬性 CLOUD_SECRET 不存在或是空字串，所有寫入一律拒絕');
    return jsonOut({ error: 'server_misconfigured' });
  }
  if (body.secret !== secret) return jsonOut({ error: 'unauthorized' });

  // 白名單閘門（ADR-008 D-2）。密鑰只證明「這是我們家的 App」，證明不了「這是誰」；
  // line_id 才回答後者。兩道門串聯，過不了任一道就不寫。
  const gate = writeGate_(body.line_id, 'PWA ' + (body.action || '?') + ' → ' + (body.sheet || '?'));
  if (!gate.allowed) return jsonOut({ error: gate.error, reason: gate.reason });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(body.sheet);
  if (!sheet) return jsonOut({ error: 'sheet_not_found' });

  if (body.action === 'append') {
    const headers = sheetHeaders_(sheet);
    // key_field 讓 line_users 這種以 line_id 為鍵的分頁也能走同一套 upsert
    const out = upsertRow_(sheet, headers, body.record || {}, body.sheet, body.key_field);
    if (body.sheet === LINE_USERS_SHEET) invalidateLineUsersCache_();
    return jsonOut(out);
  }

  if (body.action === 'replaceAll') {
    // 這兩張表不歸前端那份 state 管，整包覆蓋等於把它們清空（ADR-008 Part D）
    if (NO_REPLACE_ALL.indexOf(body.sheet) !== -1) {
      console.log('🚫 拒絕對分頁「' + body.sheet + '」做 replaceAll：它不屬於前端 state');
      return jsonOut({ error: 'sheet_not_replaceable', sheet: body.sheet });
    }

    const records = body.records || [];
    const deduped = dedupeById_(records);

    sheet.clearContents();
    sheet.appendRow(body.headers);
    deduped.kept.forEach(r => sheet.appendRow(body.headers.map(h => r[h] ?? '')));

    if (deduped.dropped.length) {
      logCleanup_(
        'replaceAll ' + body.sheet,
        '去重：' + records.length + ' 筆收斂為 ' + deduped.kept.length + ' 筆',
        '丟棄的重複 id：' + summarizeIds_(deduped.dropped)
      );
    }
    return jsonOut({
      success: true,
      count: deduped.kept.length,
      dropped: deduped.dropped.length
    });
  }

  return jsonOut({ error: 'unknown_action' });
}

/* ========================================================================== */
/* 同 id 去重閘門（ADR-007 票 A，位置依 Part G-2 修正）                        */
/* ========================================================================== */

/**
 * ADR 原本把閘門設計在「更新流程的無條件 append」上，但實讀程式碼後發現前端
 * 從未使用 append —— 它只送 replaceAll，而 replaceAll 是整張表砍掉重寫。
 * 所以後端並沒有製造重複，它只是忠實地把 state 裡的重複寫出來。閘門因此改放
 * 在 replaceAll：寫入前收斂，髒資料在下次同步時自動消失。
 *
 * ⚠️ 這仍然不是根治。「本機為何先生出兩筆同 id」未解（ADR-007 Part F 未來票），
 * 前端的 dedupeState() 與這裡都是在攔截症狀，只是攔在不同層。
 *
 * 規則與前端 dedupeById() 一字不差：同 id 留「後者」（視為較新的編輯）、位置
 * 維持、沒有 id 的資料原樣保留——把它們當成同一筆併掉會是真正的資料遺失。
 * 兩邊規則若不一致，同一批資料在前後端會收斂成不同結果，那種 bug 最難查。
 */
function dedupeById_(records) {
  const lastIndexById = {};
  const idOf = r => (r && r.id != null && r.id !== '') ? String(r.id) : '';

  records.forEach((r, i) => {
    const id = idOf(r);
    if (id) lastIndexById[id] = i;
  });

  const kept = [], dropped = [];
  records.forEach((r, i) => {
    const id = idOf(r);
    if (!id || lastIndexById[id] === i) kept.push(r);
    else dropped.push(id);
  });
  return { kept: kept, dropped: dropped };
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

/** id 太多時只列前幾個，避免 logs 的 detail 欄爆掉 */
function summarizeIds_(ids) {
  const MAX = 10;
  return ids.length <= MAX
    ? ids.join(', ')
    : ids.slice(0, MAX).join(', ') + ' …（共 ' + ids.length + ' 筆）';
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================================================================== */
/* ADR-009 Phase 0 — 軟刪除、兩段式封存、欄位安裝                              */
/*                                                                            */
/* ⚠️ 這一段目前沒有任何呼叫端，是刻意的。ADR-009「待其他環境知道的事 #1」寫明： */
/* 三個新函式的最小自動化測試要先跑過、報告經 Neil 確認，才准接手既有模組的      */
/* 讀寫路徑。所以這裡先把函式與測試做完，doGet 的過濾與前端的即時 upsert 改寫    */
/* 留到下一階段——不可以先動工、測試事後補。                                     */
/*                                                                            */
/* 唯一會真的執行的是 ensureAdr009Columns()，那是給 Neil 在 Apps Script 編輯器 */
/* 手動執行一次的安裝函式（操作方式比照 diagnoseLineUsers）。它不會自己跑，也    */
/* 不在任何同步路徑上。                                                        */
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
  tasks:    ['del', 'archive', 'board', 'due_date', 'recur_interval', 'recur_unit', 'notified'],
  expenses: ['del', 'archive', 'board'],
  notes:    ['del', 'archive', 'board'],
  reviews:  ['del', 'archive'],
  moods:    ['del', 'archive']
};

/**
 * 把 wanted 裡缺的欄名 append 到表頭最右邊，回傳這次補了什麼。
 * 一律往右加、不插入中間：欄序一變，正在跑的 replaceAll 就會把資料寫進錯誤的欄。
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
 * 分頁不存在就略過不建——這五張表會在第一次同步時自己長出來，這裡先建一張
 * 只有表頭的空表，反而會讓下一次 replaceAll 的表頭對不上。
 */
function ensureAdr009Columns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summary = {};

  Object.keys(ADR009_COLUMNS).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      console.log('⏭️ 分頁「' + name + '」不存在，略過（它會在第一次同步時自己長出來）');
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
