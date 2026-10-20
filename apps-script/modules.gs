/**
 * 模組登記表與總開關（ADR-021 D-9 ①、PR-A）
 *
 * 一個模組＝Apps 裡的一個圖示。總開關（enabled）是「這個功能上不上線」，對所有人、1.0／2.0 都一樣；
 * 「誰能用」仍然是 line_users 的 feat_*（D-9 ②），兩件事不重複。
 *
 * 關掉＝連資料都碰不到（Neil 2026-10-19）：
 *  - 有自己一張表的模組（記帳、任務、雜記、股票、郵件、圖書館）：接在 canUse_ 上，
 *    PWA 讀寫、LINE 指令、「查/」、排程總管本來就都過 canUse_，一處擋住全部
 *  - 住在別人表裡的模組，欄位級擋（moduleVisibleRows_ 與各寫入口）：
 *      提醒＝tasks 裡 kind=reminder 的列：讀不到、寫不進、不推播、不翻頁
 *      白板＝tasks／notes／expenses 的 board 欄：讀回來一律不在白板上；寫入保留雲端原值（不會被洗掉）
 *      分期＝_installments＋plan* 動作：不帶計畫、plan* 一律拒絕（各期本身是 expenses 的列，照常是帳）
 *
 * 權限欄（permission）只是登記給人看的：誰能用由程式裡的 MODULE_FEATURE 決定，
 * 不讀 Sheet 上的值——在表上改一格就能放寬權限，那道門就形同虛設。
 * Sheet 上只讀 enabled 與顯示用的欄位（名稱、分類、圖示、排序）。
 */
var MODULE_REGISTRY_HEADERS = ['module_id', 'name', 'category', 'icon', 'enabled', 'permission', 'load_policy', 'sort'];
var MODULE_CACHE_KEY = 'adr021_modules';
var MODULE_CACHE_TTL = 300;

/**
 * 預設列（「初始化」照這份補）。順序＝Apps 的排列：財務、生產力、知識。
 * load_policy：lazy＝點進模組才載（D-1）；首頁 Widget 的摘要另走核心層，不看這一欄
 */
var MODULE_DEFAULTS = [
  { module_id: 'expenses',  name: '記帳',   category: '財務',   icon: '💰', permission: 'feat_expense', sort: 10 },
  { module_id: 'plans',     name: '分期',   category: '財務',   icon: '🧾', permission: 'feat_expense', sort: 20 },
  { module_id: 'stocks',    name: '股票',   category: '財務',   icon: '📈', permission: 'feat_stock',   sort: 30 },
  { module_id: 'tasks',     name: '任務',   category: '生產力', icon: '☑️', permission: 'feat_tasks',   sort: 40 },
  { module_id: 'reminders', name: '提醒',   category: '生產力', icon: '🔔', permission: 'feat_tasks',   sort: 50 },
  { module_id: 'board',     name: '白板',   category: '生產力', icon: '📌', permission: '',             sort: 60 },
  { module_id: 'notes',     name: '雜記',   category: '生產力', icon: '📎', permission: 'feat_notes',   sort: 70 },
  { module_id: 'mail',      name: '郵件',   category: '生產力', icon: '📬', permission: 'feat_gmail',   sort: 80 },
  { module_id: 'library',   name: '圖書館', category: '知識',   icon: '📚', permission: 'feat_clips',   sort: 90 }
];

/** 功能 → 擁有那張表的模組。canUse_ 靠它讓總開關一處擋住所有讀寫路徑 */
var MODULE_OF_FEATURE = {
  feat_expense: 'expenses', feat_tasks: 'tasks', feat_notes: 'notes',
  feat_stock: 'stocks', feat_gmail: 'mail', feat_clips: 'library'
};

/** 同一次執行只讀一次（canUse_ 在收藏工作裡每列都會被叫到） */
var moduleStateMemo_ = null;

function isKnownModule_(id) {
  return MODULE_DEFAULTS.some(function (m) { return m.module_id === id; });
}

/**
 * 被關掉的模組 { id: true }。讀不到表（還沒初始化、讀取失敗）＝全開：
 * 這是「功能上不上線」的開關，預設是開；讀不到就全關，等於一次 Sheet 故障讓整個 App 消失。
 * 讀取失敗只快取在這次執行，不寫進 CacheService（跟名單一樣：失敗不快取）。
 * ss：呼叫端已經開好的試算表（boot 只開一次，ADR-012）；沒給才自己開
 */
function modulesOff_(ss) {
  if (moduleStateMemo_) return moduleStateMemo_.off;
  var cache = scriptCache_();
  if (cache) {
    var hit = cacheGetJson_(cache, MODULE_CACHE_KEY);
    if (hit && hit.off) { moduleStateMemo_ = hit; return hit.off; }
  }
  var state = readModuleRegistry_(ss);
  moduleStateMemo_ = state;
  if (cache && state.ok) {
    try { cache.put(MODULE_CACHE_KEY, JSON.stringify(state), MODULE_CACHE_TTL); } catch (err) {}
  }
  return state.off;
}

function moduleOn_(id) {
  return !modulesOff_()[id];
}

/** 改了總開關之後立刻生效 */
function invalidateModuleCache_() {
  moduleStateMemo_ = null;
  var cache = scriptCache_();
  if (cache) { try { cache.remove(MODULE_CACHE_KEY); } catch (err) {} }
}

/** { ok, off: {id:true}, rows: [顯示用的列] }。rows 依 sort 排；表上沒有的模組用預設值補上（＝開） */
function readModuleRegistry_(ss) {
  var byId = {};
  var ok = true;
  try {
    var read = sheetRecords_(ss || SpreadsheetApp.getActiveSpreadsheet(), MODULE_REGISTRY_SHEET, {});
    if (!read.error) {
      read.rows.forEach(function (r) {
        var id = keyValue_(r.module_id);
        if (isKnownModule_(id) && !byId[id]) byId[id] = r;
      });
    }
  } catch (err) {
    console.log('模組登記表讀取失敗（當作全開）：' + err);
    ok = false;
  }
  var off = {};
  var rows = MODULE_DEFAULTS.map(function (d) {
    var r = byId[d.module_id];
    var enabled = r ? truthy_(r.enabled) : true;
    if (!enabled) off[d.module_id] = true;
    var sort = r && r.sort !== '' && isFinite(Number(r.sort)) ? Number(r.sort) : d.sort;
    return {
      module_id: d.module_id,
      name: (r && String(r.name || '').trim()) || d.name,
      category: (r && String(r.category || '').trim()) || d.category,
      icon: (r && String(r.icon || '').trim()) || d.icon,
      enabled: enabled,
      permission: d.permission,
      sort: sort
    };
  }).sort(function (a, b) { return a.sort - b.sort; });
  return { ok: ok, off: off, rows: rows };
}

/** boot 帶給前端：Apps 的圖示與總開關狀態 */
function modulesForPwa_(ss) {
  modulesOff_(ss);
  return moduleStateMemo_.rows;
}

/** 被總開關擋下的寫入：永久拒絕（格式比照白板 not_owner），前端移出佇列、還原畫面 */
function moduleOffDenied_(moduleId, action, what, lineId) {
  console.log('🚫 模組已停用：' + moduleId + ' / ' + action + ' ' + what);
  try {
    logTransaction_('同步', '失敗', 'PWA ' + action + ' → ' + what, '「' + moduleName_(moduleId) + '」模組已停用，拒絕',
      'code=module_off｜' + moduleId, '', lineId || '');
  } catch (err) {}
  return { error: 'forbidden', permanent: true, reason: 'module_off', module: moduleId };
}

function moduleName_(id) {
  var d = MODULE_DEFAULTS.filter(function (m) { return m.module_id === id; })[0];
  return d ? d.name : id;
}

/** LINE 那一側的回覆 */
function moduleOffText_(id) {
  return '「' + moduleName_(id) + '」目前停用中。';
}

/** 寫到這張表會不會撞到被關掉的「擁有者」模組（有自己一張表的那種）。回模組 id 或 '' */
function sheetModuleOff_(sheetName) {
  var id = MODULE_OF_FEATURE[FEATURE_BY_SHEET[sheetName]];
  return id && !moduleOn_(id) ? id : '';
}

/**
 * 讀取出口的欄位級過濾（提醒、白板）。pwaVisibleRows_、「查/」都走這裡。
 * 不改傳進來的列：白板關掉時回的是複本
 */
function moduleVisibleRows_(sheetName, rows) {
  var out = rows;
  if (sheetName === TASKS_SHEET && !moduleOn_('reminders')) {
    out = out.filter(function (r) { return !isReminder_(r); });
  }
  if (BOARD_SHEETS.indexOf(sheetName) !== -1 && !moduleOn_('board')) {
    out = out.map(function (r) { return truthy_(r.board) ? Object.assign({}, r, { board: '' }) : r; });
  }
  return out;
}

/**
 * 白板關掉時的寫入：board 一律用雲端那列現有的值（新列是空白）。
 * 前端讀到的 board 都是空的，送回來也是空的——不保留的話，改一下任務就把白板洗掉了，重新打開時全不見。
 */
function keepStoredBoard_(sheet, headers, record) {
  var boardCol = headers.indexOf('board') + 1;
  var idCol = headers.indexOf('id') + 1;
  var id = keyValue_(record && record.id);
  var stored = '';
  if (boardCol && idCol && id) {
    var rows = findRowsByKey_(sheet, [idCol], id);
    if (rows.length) stored = sheet.getRange(rows[0], boardCol).getValues()[0][0];
  }
  return Object.assign({}, record, { board: stored });
}

/**
 * 總開關（只限管理者）。action=moduleSet { module_id, enabled }。
 * 只改 enabled 一格；表還沒建就先建（跟「初始化」同一份預設）
 */
function moduleSet_(caller, moduleId, enabled) {
  if (!truthy_((caller.user || {}).is_admin)) return { error: 'forbidden' };
  var id = keyValue_(moduleId);
  if (!isKnownModule_(id)) return { error: 'unknown_module' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(UPSERT_LOCK_MS)) return { error: 'busy' };
  try {
    var sheet = ensureModuleRegistry_().sheet;
    var headers = sheetHeaders_(sheet);
    var rows = findRowsByKey_(sheet, [headers.indexOf('module_id') + 1], id);
    var value = enabled ? 'TRUE' : 'FALSE';
    sheet.getRange(rows[0], headers.indexOf('enabled') + 1).setValues([[value]]);
    invalidateModuleCache_();
    logTransaction_('設定', '成功', '模組總開關 ' + id, moduleName_(id) + (enabled ? ' 啟用' : ' 停用'), '', rows[0], caller.line_id);
    return { success: true, modules: modulesForPwa_() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 「初始化」的一步：建表、補表頭、補缺的模組列（已存在的列一格都不動，管理者關掉的不會被打開）。
 * 可重複執行
 */
function ensureModuleRegistry_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MODULE_REGISTRY_SHEET);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(MODULE_REGISTRY_SHEET); created = true; }
  if (sheet.getLastRow() === 0) sheet.appendRow(MODULE_REGISTRY_HEADERS);
  ensureColumnsOnSheet_(sheet, MODULE_REGISTRY_HEADERS);
  var headers = sheetHeaders_(sheet);
  var have = {};
  sheetRecords_(ss, MODULE_REGISTRY_SHEET, {}).rows.forEach(function (r) { have[keyValue_(r.module_id)] = true; });
  var added = [];
  MODULE_DEFAULTS.forEach(function (d) {
    if (have[d.module_id]) return;
    var rec = Object.assign({ enabled: 'TRUE', load_policy: 'lazy' }, d);
    sheet.appendRow(headers.map(function (h) { return rec[h] == null ? '' : rec[h]; }));
    added.push(d.module_id);
  });
  if (added.length) invalidateModuleCache_();
  return { sheet: sheet, created: created, added: added };
}

/**
 * 「初始化」的一步：line_users 補 feat_ui_v2（ADR-021 D-20）。**這一次才新增**時只替管理者打勾，
 * 之後誰的勾都不動（比照 installGmailFeature_）。可重複執行
 */
var UI_V2_FEATURE = 'feat_ui_v2';
function installUiV2Feature_() {
  var users = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_USERS_SHEET);
  if (!users) return { warn: true, text: '⚠️ 找不到 ' + LINE_USERS_SHEET + '，沒有補 ' + UI_V2_FEATURE };
  var u = ensureColumnsOnSheet_(users, [UI_V2_FEATURE]);
  if (u.reason) return { warn: true, text: '⚠️ ' + LINE_USERS_SHEET + ' 沒有表頭，沒有補 ' + UI_V2_FEATURE };
  if (!u.added.length) return { text: LINE_USERS_SHEET + ' 已有 ' + UI_V2_FEATURE };
  var headers = sheetHeaders_(users);
  var admins = 0;
  if (users.getLastRow() >= 2) {
    users.getRange(2, 1, users.getLastRow() - 1, headers.length).getValues().forEach(function (row, i) {
      if (truthy_(row[headers.indexOf('is_admin')])) {
        users.getRange(i + 2, headers.indexOf(UI_V2_FEATURE) + 1, 1, 1).setValues([['TRUE']]);
        admins++;
      }
    });
  }
  invalidateLineUsersCache_();
  return { changed: true, text: LINE_USERS_SHEET + ' 補上：' + UI_V2_FEATURE + '（預設只開管理者 ' + admins + ' 人）' };
}
