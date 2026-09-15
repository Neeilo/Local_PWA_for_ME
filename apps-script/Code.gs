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

/**
 * 以鍵欄定位既有列 → 覆蓋；找不到才 append（ADR-007 票 A）。
 * 鍵欄預設是 id；line_users 傳 key_field='line_id'（ADR-008 D-4 的管理頁走這條）。
 * 遇到多筆同 id：覆蓋第一筆、刪除其餘，並寫進 logs——讓系統自帶清理能力。
 *
 * 比對方式是「id 欄整欄一次撈進記憶體再線性搜尋」。不建索引、不維護對照表：
 * 資料量以百為單位，簡單優先。
 *
 * 找不到 id 欄、或這筆記錄沒有 id 時，退回單純 append 但**留一行 console**。
 * 靜默失敗在這個專案已經貴過三次了。
 */
function upsertRow_(sheet, headers, record, sheetName, keyField) {
  const key = keyField || 'id';                          // line_users 以 line_id 為鍵
  const row = headers.map(h => record[h] ?? '');
  const idCol = headers.indexOf(key) + 1;                // 1-based；0 代表找不到
  const recId = (record[key] != null && record[key] !== '') ? String(record[key]) : '';

  if (idCol === 0 || !recId) {
    console.log('upsert 退回 append（' +
      (idCol === 0 ? '分頁「' + sheetName + '」沒有 ' + key + ' 欄' : '這筆記錄沒有 ' + key) + '）');
    sheet.appendRow(row);
    return { success: true, row: sheet.getLastRow(), updated: false, cleaned: 0 };
  }

  const matches = findRowsById_(sheet, idCol, recId);
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
      'upsert ' + sheetName + ' ' + key + '=' + recId,
      '覆蓋第 ' + target + ' 列，刪除重複 ' + extras.length + ' 列',
      '刪除的列號：' + extras.slice().sort((a, b) => a - b).join(', ')
    );
  }
  return { success: true, row: target, updated: true, cleaned: extras.length };
}

/** 回傳 id 欄等於 recId 的所有列號（1-based，含表頭偏移） */
function findRowsById_(sheet, idCol, recId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  const matches = [];
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === recId) matches.push(i + 2);
  }
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
