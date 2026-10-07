/**
 * _guide 導覽分頁：試算表裡每張分頁是做什麼的（2026-09-23 交棒票，Neil 拍板選項 1）
 *
 * 說明寫在這個檔案的登記表裡，Sheet 上的 _guide 是「產生出來的結果」——
 * refreshGuide() 每次都依登記表整張重寫。理由跟 CI 部署同一條：GitHub 是唯一
 * 真相，說明如果只活在 Sheet 上，改了程式沒人會記得回去改它。
 *
 * 只有「備註」欄會被保留（以分頁名稱對應，不是列號），讓 Neil 還是能在手機上
 * 隨手記。其他欄位在 Sheet 上改了，下次更新就會被蓋回登記表的內容。
 *
 * 分頁命名規則見 apps-script/README.md。新增分頁的 PR 要同時更新下面的登記表；
 * 漏了也不會壞，_guide 會標 ⚠️ 未登記。
 */

/** 類別的排序。未登記的分頁沒有類別，一律排在最後 */
var GUIDE_CATEGORIES = ['資料', '系統', '功能模組'];

/**
 * 登記表。寫成函式而不是頂層陣列：GUIDE_SHEET 定義在 Code.gs，而 Apps Script
 * 各檔案頂層程式碼的執行順序跟檔案順序走——這個檔案若先載入，頂層陣列裡的
 * GUIDE_SHEET 會是 undefined，而且不會報錯。放進函式就是呼叫當下才讀，跟順序無關。
 */
function guideRegistry_() {
  return [
    { sheet: 'tasks', category: '資料', purpose: '任務（含到期日、週期、提醒旗標；origin_chat＝在哪個群組交代的，提醒推回那裡）',
      writers: 'PWA、LINE「任務/」與到期日按鈕、到期檢查（只寫 notified）；origin_chat 只有 LINE 寫', readers: 'PWA、「查/」、到期檢查',
      key: 'id', adr: '004、009、014' },
    { sheet: 'expenses', category: '資料', purpose: '收支記帳（大類＋細項＋對象）',
      writers: 'PWA、LINE「記帳/」「收入/」', readers: 'PWA、「查/」',
      key: 'id', adr: '004、006、013' },
    { sheet: INSTALLMENTS_SHEET, category: '資料', purpose: '分期計畫（各期本身是 expenses 裡帶 plan_id 的列）',
      writers: 'PWA「轉成分期」「結束計畫」「刪除計畫」（只走專用 action，不收一般 upsert）', readers: 'PWA（boot／輪詢帶回）',
      key: 'plan_id', adr: '013' },
    { sheet: 'reviews', category: '資料', purpose: '每日複盤',
      writers: 'PWA', readers: 'PWA、「查/」',
      key: 'review_date＋line_id', adr: '008' },
    { sheet: 'moods', category: '資料', purpose: '心情紀錄',
      writers: 'PWA', readers: 'PWA、「查/」',
      key: 'id', adr: '' },
    { sheet: 'notes', category: '資料', purpose: '雜記（[類別] 內容）',
      writers: 'PWA', readers: 'PWA',
      key: 'id', adr: '' },
    { sheet: 'logs', category: '系統', purpose: 'LINE 與系統的交易記錄，唯讀',
      writers: '只有 GAS', readers: '設定頁 ▸ 管理 ▸ LOG（只限管理員）',
      key: 'id', adr: '006、014' },
    { sheet: 'line_users', category: '系統', purpose: '白名單＋功能權限矩陣＋email（管理者收封存備份信）',
      writers: '註冊指令、管理頁', readers: 'GAS 閘門、PWA',
      key: 'line_id', adr: '008' },
    { sheet: LINE_GROUPS_SHEET, category: '系統', purpose: 'bot 加入過的 LINE 群組：啟用（is_active）、開放哪些指令（cmd_*）、到期提醒推不推群組（notify_due，預設關）',
      writers: 'GAS（join／leave 事件、群組第一次下指令）；管理員在 App 系統設定或 Sheet 上開關', readers: '只有 GAS（PWA 一般讀寫碰不到）',
      key: 'group_id', adr: '013、014' },
    { sheet: LINE_DEVICES_SHEET, category: '系統', purpose: '已配對的裝置（token 只存雜湊）',
      writers: 'PWA 配對、LINE「驗證裝置」、管理頁撤銷（皆由 GAS 寫）', readers: '只有 GAS（PWA 不可讀）',
      key: 'device_id', adr: '010' },
    { sheet: PERFORMANCE_SHEET, category: '系統', purpose: '每次請求的耗時（不存 token、不存資料內容）；含排程（schedule）、切區（zone）、未驗證請求每小時彙總（unauth／hourly）',
      writers: '只有 GAS（PWA 請求回應前寫、LINE 回覆後寫、排程每次執行、每小時彙總）', readers: '設定頁 ▸ 管理 ▸ 效能紀錄（雲端算好摘要，PWA 不可讀原始列）',
      key: 'id', adr: '012、014' },
    { sheet: EXPENSE_CONFIG_SHEET, category: '系統', purpose: '記帳的大類、細項、對象（改名＝新增一列＋停用舊的）',
      writers: 'Neil 在 Sheet 上改（PWA 不可寫）；不存在時 GAS 自動建表寫初版', readers: 'GAS（boot 送前端、LINE 記帳、「查/」）',
      key: 'kind＋name', adr: '013' },
    { sheet: GUIDE_SHEET, category: '系統', purpose: '本導覽表',
      writers: '只有 refreshGuide()', readers: 'Neil',
      key: '分頁名稱', adr: '' }
  ];
}

var GUIDE_HEADERS = ['分頁', '類別', '用途', '誰寫入', '誰讀取', '主鍵', '相關 ADR', '欄位', '筆數', '狀態', '備註'];
var GUIDE_NOTE_HEADER = '備註';
var GUIDE_HEADER_ROW = 2;        // 第 1 列是說明，第 2 列才是表頭
var GUIDE_STATUS_OK = '✅ 正常';
var GUIDE_STATUS_UNREGISTERED = '⚠️ 未登記';
var GUIDE_STATUS_MISSING = '⚠️ 找不到分頁';

var GUIDE_REFRESH_FUNCTION = 'refreshGuide';
var GUIDE_REFRESH_HOUR = 6;      // 在九點的到期檢查之前，早上打開就是新的

/**
 * 依登記表重新產生整張 _guide。可重複執行：不存在就建，存在就整張重寫。
 *
 * ⚠️ 不做「各分頁最後更新時間」：SpreadsheetApp 拿不到單一分頁的修改時間，
 * 用 created_at 推測又不準（有些表沒這欄、更新資料不會改它），寫了反而誤導。
 * 也不寫任何資料內容，只寫表頭與筆數。
 */
function refreshGuide() {
  var started = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var guide = ss.getSheetByName(GUIDE_SHEET) || ss.insertSheet(GUIDE_SHEET);
  var rows = guideRows_(ss, guideNotes_(guide));

  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var banner = '本分頁由 refreshGuide() 自動產生（最後更新：' + stamp + '）。' +
    '要改說明請改 repo 的 apps-script/sheet-guide.gs，只有「備註」欄會被保留。';

  guide.clearContents();
  guide.getRange(1, 1, 1, 1).setValues([[banner]]);
  guide.getRange(GUIDE_HEADER_ROW, 1, 1 + rows.length, GUIDE_HEADERS.length)
    .setValues([GUIDE_HEADERS].concat(rows));

  console.log('✅ _guide 已更新：' + rows.length + ' 張分頁');
  // 每次執行都留紀錄（ADR-014 D-16），跟到期檢查同一套：排程有沒有在跑，看 logs 就知道
  logCleanup_('_guide 更新', rows.length + ' 張分頁', '');
  recordSchedulePerf_('guideRefresh', rows.length, Date.now() - started);
  return { sheets: rows.length };
}

/**
 * 導覽表的每一列（依 GUIDE_HEADERS 的欄序）。refreshGuide 寫進 Sheet、首頁「系統設定」的
 * 導覽分頁現算現給，兩邊共用這一份——不然 App 上看到的說明會跟 Sheet 上的漂移。
 */
function guideRows_(ss, notes) {
  var actual = {};
  ss.getSheets().forEach(function (s) { actual[s.getName()] = s; });

  var registry = guideRegistry_();
  var rows = [];
  var registered = {};
  GUIDE_CATEGORIES.forEach(function (category) {
    registry.forEach(function (entry) {
      if (entry.category !== category) return;
      registered[entry.sheet] = true;
      rows.push(guideRow_(entry.sheet, entry, actual[entry.sheet], notes));
    });
  });
  Object.keys(actual).forEach(function (name) {
    if (!registered[name]) rows.push(guideRow_(name, null, actual[name], notes));
  });
  return rows;
}

/** 一張分頁在 _guide 裡的那一列 */
function guideRow_(name, entry, sheet, notes) {
  var e = entry || {};
  var fields = '';
  var count = '';
  var status = entry ? GUIDE_STATUS_OK : GUIDE_STATUS_UNREGISTERED;

  if (name === GUIDE_SHEET) {
    // _guide 的第 1 列是說明不是表頭，用 sheetHeaders_ 讀會讀到那句話
    fields = GUIDE_HEADERS.join('、');
  } else if (sheet) {
    fields = sheetHeaders_(sheet).filter(function (h) { return h; }).join('、');
    count = Math.max(sheet.getLastRow() - 1, 0);
    // 分類設定的自檢（ADR-013 交棒票 1-1）：細項重複、大類不存在、顏色重複…寫在狀態欄
    if (name === EXPENSE_CONFIG_SHEET) {
      var warnings = readExpenseConfig_().warnings || [];
      if (warnings.length) status = '⚠️ ' + warnings.join('；');
    }
  } else {
    status = GUIDE_STATUS_MISSING;
  }

  return [name, e.category || '', e.purpose || '', e.writers || '', e.readers || '',
          e.key || '', e.adr || '', fields, count, status, notes[name] || ''];
}

/**
 * 讀出舊的備註：{ 分頁名稱: 備註 }。以名稱對應而不是列號——分頁一多一少，
 * 列號就位移，用列號對會把備註貼到別的分頁身上。
 */
function guideNotes_(guide) {
  var notes = {};
  var lastRow = guide.getLastRow();
  var lastCol = guide.getLastColumn();
  if (lastRow <= GUIDE_HEADER_ROW || lastCol === 0) return notes;

  var values = guide.getRange(GUIDE_HEADER_ROW, 1, lastRow - GUIDE_HEADER_ROW + 1, lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var nameCol = headers.indexOf(GUIDE_HEADERS[0]);
  var noteCol = headers.indexOf(GUIDE_NOTE_HEADER);
  if (nameCol === -1 || noteCol === -1) return notes;

  values.slice(1).forEach(function (row) {
    var name = String(row[nameCol]).trim();
    var note = row[noteCol];
    if (name && note !== '' && note != null) notes[name] = note;
  });
  return notes;
}

/**
 * 每天自動更新 _guide 的觸發器。做法比照 installAdr009Triggers()：先刪同名的
 * 再建，重複執行不會累積；只認自己的 handler，不會動到到期提醒那一個。
 * 安裝時順便立刻跑一次，不用等到明天才看得到。
 *
 * CI 只部署程式碼、不執行函式——merge 後要在編輯器手動執行一次這支。
 */
function installGuideTrigger() {
  var removed = removeGuideTriggers_();
  if (removed) console.log('移除了 ' + removed + ' 個同名的舊觸發器');

  ScriptApp.newTrigger(GUIDE_REFRESH_FUNCTION).timeBased().atHour(GUIDE_REFRESH_HOUR).everyDays(1).create();
  console.log('✅ 已建立每日觸發器：' + GUIDE_REFRESH_FUNCTION + '，每天約 ' + GUIDE_REFRESH_HOUR + ' 點執行');
  refreshGuide();
  return { removed: removed, created: GUIDE_REFRESH_FUNCTION, hour: GUIDE_REFRESH_HOUR };
}

/** 移除 _guide 觸發器。_guide 分頁本身留著，只是不再自動更新 */
function uninstallGuideTrigger() {
  var removed = removeGuideTriggers_();
  console.log(removed ? ('已移除 ' + removed + ' 個 _guide 觸發器') : '沒有找到 _guide 觸發器');
  return { removed: removed };
}

function removeGuideTriggers_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === GUIDE_REFRESH_FUNCTION) { ScriptApp.deleteTrigger(t); removed++; }
  });
  return removed;
}
