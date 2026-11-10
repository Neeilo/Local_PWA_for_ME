/**
 * Gmail 控制員（ADR-016）。
 *
 * 每天 7 點、16 點 runGmailController 依 gmail_rules 掃最近 3 天的信 → Gmail 貼標籤 →
 * 帳單 PDF 原封不動存 Drive → 規則有解析器就抓金額／截止日 → 寫 gmail_log（一封一列）→
 * 「掃一遍」依規則決定留下／封存（ADR-026：預設預演，只記不動；管理員親手開正式封存）→
 * 推一則處理結果彙報到開了 notify_gmail 的群組。不標已讀、不刪除、不動星號、不呼叫 Gemini。
 * 各家銀行的解析器（GMAIL_PARSERS）等 Neil 的樣本信（PR-B3）。
 *
 * 去重以 gmail_log.msg_id 為準，**不靠標籤**：GmailApp 的標籤是貼在整串對話上的，同主旨的
 * eTag 通知會被 Gmail 歸成同一串——查詢若排除「已處理」標籤，第一封之後的新信永遠查不到。
 * 標籤（規則的 label＋NeilOS/已處理）只是讓 Neil 在 Gmail 裡看得出來。
 *
 * 規則表由「初始化」建（Neil 2026-10-12：建表一律走初始化），探針 probeGmail() 在編輯器
 * 手動執行、只讀，用來在規則上線前確認沒有漏抓／誤抓。
 *
 * 用 GmailApp＋DriveApp（Gmail 進階服務已從 manifest 拿掉）。第一次要由部署者在編輯器執行
 * authorizeGmailController 同意權限：GmailApp 沒有只讀可選、DriveApp 會要求整個雲端硬碟。
 */

/** 欄位見 ADR-016 交棒 T1。PWA 一般讀寫碰不到這張表（Code.gs 的 NO_PWA_READ／NO_PWA_WRITE） */
var GMAIL_RULES_HEADERS = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
                           'label', 'save_attachment', 'notify', 'parser', 'note', 'inbox_action', 'bucket'];
/** 信種（D-2）：信用卡帳單、eTag、電子報 */
var GMAIL_MAIL_TYPES = ['bill', 'etag', 'newsletter'];

/**
 * ADR-026：每條規則決定「留在收件匣／封存」與「歸哪一組」。只往右邊加欄（1.0 不讀這兩欄）。
 * inbox_action 空白或不認得＝keep＋警告；bucket 空白＝依信種推（bill→pay、etag→fyi、newsletter→news）
 */
var GMAIL_INBOX_ACTIONS = ['keep', 'archive'];
var GMAIL_BUCKETS = ['pay', 'fyi', 'news'];
var GMAIL_BUCKET_BY_TYPE = { bill: 'pay', etag: 'fyi', newsletter: 'news' };
var GMAIL_BUCKET_LABEL = { pay: '🧾 要付錢的', fyi: '📄 知道就好', news: '📰 電子報' };
/**
 * 「初始化」只填空白格的對照表（ADR-026 交棒 §1）。表外的規則（含 Neil 之後新增的）→ 依信種推＋keep。
 * 區間含頭尾
 */
var GMAIL_RULE_INIT = [
  { ranges: [[10010, 10017], [10040, 10042]], bucket: 'pay', inbox_action: 'keep' },
  { ranges: [[10001, 10001], [10020, 10020], [10030, 10038]], bucket: 'fyi', inbox_action: 'archive' },
  { ranges: [[10050, 10054]], bucket: 'news', inbox_action: 'archive' }
];

/** GmailApp 要的是完整的 Gmail 權限（沒有只讀可選） */
var GMAIL_SCOPE = 'https://mail.google.com/';

var GMAIL_PROBE_DAYS = 30;
/** GmailApp.search 一次最多回 500 個對話串；到頂就標「以上」 */
var GMAIL_PROBE_MAX = 500;
var GMAIL_PROBE_SAMPLES = 3;

/* ========================================================================== */
/* 規則                                                                        */
/* ========================================================================== */

/**
 * 一條規則的 Gmail 查詢條件。寄件者與主旨關鍵字照 Neil 填的原樣放進括號，
 * 所以可以寫 Gmail 的語法（例如 `a@x.com OR b@x.com`、`帳單 -廣告`）。
 * 兩個都空回 ''：那等於撈整個信箱，呼叫端不能查。
 */
function gmailRuleQuery_(rule, days) {
  var from = String(rule.from == null ? '' : rule.from).trim();
  var kw = String(rule.subject_kw == null ? '' : rule.subject_kw).trim();
  if (!from && !kw) return '';
  var parts = [];
  if (from) parts.push('from:(' + from + ')');
  if (kw) parts.push('subject:(' + kw + ')');
  parts.push('newer_than:' + days + 'd');
  return parts.join(' ');
}

/** rule_id 排序：都是數字就比大小（10 排在 9 後面），否則比字串 */
function gmailRuleIdCompare_(a, b) {
  var x = String(a == null ? '' : a).trim(), y = String(b == null ? '' : b).trim();
  var nx = Number(x), ny = Number(y);
  if (x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny)) return nx - ny;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 讀 gmail_rules，整列空白的不算（Sheet 上留白很正常），依 rule_id 排好 */
function gmailRulesRead_() {
  var read = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), GMAIL_RULES_SHEET, {});
  if (read.error) return { error: read.error, rules: [] };
  var rules = read.rows.filter(function (r) {
    return GMAIL_RULES_HEADERS.some(function (h) { return String(r[h] == null ? '' : r[h]).trim() !== ''; });
  });
  rules.sort(function (a, b) { return gmailRuleIdCompare_(a.rule_id, b.rule_id); });
  return { rules: rules };
}

/** 規則本身的問題（照查，但要講出來）。seen 記錄看過的 rule_id，抓重複用 */
function gmailRuleProblems_(rule, seen) {
  var problems = [];
  var id = String(rule.rule_id == null ? '' : rule.rule_id).trim();
  if (!id) problems.push('沒有 rule_id');
  else if (seen[id]) problems.push('rule_id ' + id + ' 重複');
  else seen[id] = true;
  var type = String(rule.mail_type == null ? '' : rule.mail_type).trim();
  if (GMAIL_MAIL_TYPES.indexOf(type) === -1) {
    problems.push('信種「' + type + '」不認得（只收 ' + GMAIL_MAIL_TYPES.join('／') + '）');
  }
  if (!gmailRuleQuery_(rule, GMAIL_PROBE_DAYS)) problems.push('寄件者與主旨關鍵字都是空的，不查（會撈到整個信箱）');
  return problems;
}

function gmailTrim_(v) { return String(v == null ? '' : v).trim(); }

/** 這條規則實際歸哪一組：有填合法值用它，否則依信種推 */
function gmailRuleBucket_(rule) {
  var b = gmailTrim_(rule.bucket);
  if (GMAIL_BUCKETS.indexOf(b) !== -1) return b;
  return GMAIL_BUCKET_BY_TYPE[gmailTrim_(rule.mail_type)] || 'fyi';
}

/** 這條規則實際要留下還是封存：只有明確填 archive 才封，其他（空白、打錯）一律留下（D-13：不確定就留下） */
function gmailRuleInboxAction_(rule) {
  return gmailTrim_(rule.inbox_action) === 'archive' ? 'archive' : 'keep';
}

/** 初始化要填的預設值（只用在空白格） */
function gmailRuleInitDefaults_(rule) {
  var n = Number(gmailTrim_(rule.rule_id));
  for (var i = 0; i < GMAIL_RULE_INIT.length; i++) {
    var hit = GMAIL_RULE_INIT[i].ranges.some(function (r) { return n >= r[0] && n <= r[1]; });
    if (hit) return { bucket: GMAIL_RULE_INIT[i].bucket, inbox_action: GMAIL_RULE_INIT[i].inbox_action };
  }
  return { bucket: GMAIL_BUCKET_BY_TYPE[gmailTrim_(rule.mail_type)] || '', inbox_action: 'keep' };
}

/* ========================================================================== */
/* 「初始化」                                                                   */
/* ========================================================================== */

/**
 * gmail_rules：沒有就建（只有表頭）；已存在只補缺的欄，不動規則。
 */
function installGmailRules_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(GMAIL_RULES_SHEET);
  if (!sheet || sheet.getLastRow() === 0) {
    sheet = sheet || ss.insertSheet(GMAIL_RULES_SHEET);
    sheet.getRange(1, 1, 1, GMAIL_RULES_HEADERS.length).setValues([GMAIL_RULES_HEADERS]);
    return { level: 'ok', changed: true, text: '新建 ' + GMAIL_RULES_SHEET + '（只有表頭）：把規則盤點表填進去，再到編輯器執行 probeGmail()' };
  }
  var r = ensureColumnsOnSheet_(sheet, GMAIL_RULES_HEADERS);
  if (r.reason) return { level: 'warn', text: GMAIL_RULES_SHEET + ' 沒有表頭，沒有補欄位' };
  var lines = [GMAIL_RULES_SHEET + ' 已存在（' + (sheet.getLastRow() - 1) + ' 列規則）'];
  if (r.added.length) lines.push(GMAIL_RULES_SHEET + ' 補上：' + r.added.join('、'));
  var filled = gmailFillRuleDefaults_(sheet);
  if (filled) lines.push(GMAIL_RULES_SHEET + ' 預設值填了 ' + filled + ' 格（bucket／inbox_action，只填空白）');
  return { level: 'ok', changed: r.added.length > 0 || filled > 0, text: lines.join('\n　') };
}

/**
 * ADR-026：bucket／inbox_action 只填空白格（已有值一律不動），重跑結果相同。
 * 沒有 rule_id 的列（Sheet 上的空白列）不碰。回填了幾格
 */
function gmailFillRuleDefaults_(sheet) {
  if (sheet.getLastRow() < 2) return 0;
  var headers = sheetHeaders_(sheet);
  var col = { id: headers.indexOf('rule_id'), type: headers.indexOf('mail_type'),
              bucket: headers.indexOf('bucket'), action: headers.indexOf('inbox_action') };
  if (col.id === -1 || col.bucket === -1 || col.action === -1) return 0;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  var filled = 0;
  values.forEach(function (row, i) {
    if (!gmailTrim_(row[col.id])) return;
    var d = gmailRuleInitDefaults_({ rule_id: row[col.id], mail_type: col.type === -1 ? '' : row[col.type] });
    if (!gmailTrim_(row[col.bucket]) && d.bucket) { sheet.getRange(i + 2, col.bucket + 1, 1, 1).setValues([[d.bucket]]); filled++; }
    if (!gmailTrim_(row[col.action])) { sheet.getRange(i + 2, col.action + 1, 1, 1).setValues([[d.inbox_action]]); filled++; }
  });
  return filled;
}

/* ========================================================================== */
/* 探針（PR-0）                                                                 */
/* ========================================================================== */

/**
 * 編輯器手動執行的入口。
 *
 * 先要求 Gmail 權限：Google 的「選擇性授權」讓每個權限各有一個勾選框，沒勾到 Gmail 的話
 * 執行照跑、查信才失敗（2026-10-12 實測）。requireScopes 會在缺權限時停下來、重新跳出授權畫面
 */
function probeGmail() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [GMAIL_SCOPE]);
  return probeGmail_();
}

function probeGmail_() {
  console.log('🔎 Gmail 規則探針｜最近 ' + GMAIL_PROBE_DAYS + ' 天｜只讀：不貼標籤、不寫任何分頁');
  var read = gmailRulesRead_();
  if (read.error) {
    console.log('❌ 找不到 ' + GMAIL_RULES_SHEET + ' 分頁：先在 LINE 傳「初始化」建表，填好規則盤點表再跑');
    return { error: read.error, rules: [], inactive: 0, overlaps: [] };
  }

  var report = { rules: [], inactive: 0, overlaps: [] };
  var seen = {};
  var hitsByThread = {};      // thread id → { rule_ids, subject }
  read.rules.forEach(function (rule) {
    if (!truthy_(rule.is_active)) { report.inactive++; return; }
    report.rules.push(probeGmailRule_(rule, seen, hitsByThread));
  });
  report.overlaps = gmailOverlaps_(hitsByThread);

  if (!report.rules.length) {
    console.log('⚠️ 還沒有啟用中的規則：把盤點表填進 ' + GMAIL_RULES_SHEET + '，is_active 打 TRUE 再跑');
  }
  report.overlaps.forEach(function (o) {
    console.log('⚠️ ' + o.count + ' 個對話串同時命中規則 ' + o.rule_ids.join('、') + '（例：' + o.subject +
      '）——之後處理時會取 rule_id 最小的那條，其餘寫 logs');
  });
  console.log('—— 總結：查了 ' + report.rules.length + ' 條規則，停用 ' + report.inactive + ' 條，重複命中 ' +
    report.overlaps.length + ' 組 ——');
  return report;
}

/** 一條規則：查、記命中、印一段。查詢失敗收成結果，不讓一條規則中斷其他規則 */
function probeGmailRule_(rule, seen, hitsByThread) {
  var row = {
    rule_id: rule.rule_id, source_name: rule.source_name, mail_type: rule.mail_type,
    query: gmailRuleQuery_(rule, GMAIL_PROBE_DAYS), problems: gmailRuleProblems_(rule, seen),
    count: 0, capped: false, samples: [], error: ''
  };
  var head = '[' + row.rule_id + '] ' + row.source_name + '（' + row.mail_type + '）';
  var warn = row.problems.length ? '｜⚠️ ' + row.problems.join('；') : '';
  if (!row.query) {
    console.log('⚠️ ' + head + ' → 沒有查' + warn);
    return row;
  }

  var threads;
  try {
    threads = GmailApp.search(row.query, 0, GMAIL_PROBE_MAX);
  } catch (err) {
    row.error = String(err && err.message || err);
    console.log('❌ ' + head + ' → 查詢失敗（' + row.error + '）｜' + row.query + warn);
    return row;
  }

  row.count = threads.length;
  row.capped = threads.length >= GMAIL_PROBE_MAX;
  threads.forEach(function (t, i) {
    var id = t.getId();
    var subject = t.getFirstMessageSubject();
    if (i < GMAIL_PROBE_SAMPLES) {
      row.samples.push({ date: taipeiStamp_(t.getLastMessageDate()).slice(0, 10), subject: subject });
    }
    var hit = hitsByThread[id] || (hitsByThread[id] = { rule_ids: [], subject: subject });
    hit.rule_ids.push(rule.rule_id);
  });

  var countText = row.count + ' 個' + (row.capped ? '以上' : '') + '對話串';
  if (!row.count) warn += '｜⚠️ 沒命中：條件寫錯，或這 ' + GMAIL_PROBE_DAYS + ' 天真的沒信';
  console.log((row.count ? '✅ ' : '⚠️ ') + head + ' → ' + countText + '｜' + row.query + warn);
  row.samples.forEach(function (s) { console.log('　' + s.date + '｜' + s.subject); });
  return row;
}

/** 被兩條以上規則命中的對話串，依「哪幾條規則」分組 */
function gmailOverlaps_(hitsByThread) {
  var groups = {};
  var order = [];
  Object.keys(hitsByThread).forEach(function (id) {
    var hit = hitsByThread[id];
    if (hit.rule_ids.length < 2) return;
    var ids = hit.rule_ids.slice().sort(gmailRuleIdCompare_);
    var key = ids.join('|');
    if (!groups[key]) { groups[key] = { rule_ids: ids, count: 0, subject: hit.subject }; order.push(key); }
    groups[key].count++;
  });
  return order.map(function (k) { return groups[k]; });
}

/* ========================================================================== */
/* PR-A：控制員                                                                 */
/* ========================================================================== */

var GMAIL_LOG_HEADERS = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount',
                         'due_date', 'status', 'attachment_url', 'gmail_link', 'processed_at',
                         'bucket', 'requested_inbox_action', 'inbox_action_status', 'inbox_action_at', 'inbox_action_note'];
/**
 * ADR-026 收件匣去向（status 仍是解析狀態，不動）：
 *   kept 留下｜dry_run 預演（本來會封存）｜archived 已封存（或對帳：已不在收件匣）｜skipped 不封＋原因｜failed 封存出錯（下一輪再掃）
 * 舊列空白＝legacy，永遠不進封存
 */
var GMAIL_INBOX_STATUSES = ['kept', 'dry_run', 'archived', 'skipped', 'failed'];
/** 指令碼屬性：空＝預演；有值＝正式封存的開啟時間（ISO）。只有管理員在 App 打開（gmailArchiveSet） */
var GMAIL_ARCHIVE_PROP = 'gmail_archive_live';
/** 指令碼屬性：最後一次控制員完成的摘要（JSON），整理報告與 Widget 讀，不另讀 Sheet */
var GMAIL_LAST_RUN_PROP = 'gmail_last_run';
/** 「掃一遍」看最近幾天寫的列（依 processed_at） */
var GMAIL_SWEEP_DAYS = 7;
/** 即時內文上限（字）：超過截斷並回 truncated */
var GMAIL_BODY_MAX = 20000;
/** 整理報告預設／最多看幾天 */
var GMAIL_REPORT_DAYS = 30;
var GMAIL_REPORT_MAX_DAYS = 90;
/** logs 的來源：Gmail 讀內文、封存開關以外的郵件動作 */
var GMAIL_LOG_SOURCE = '郵件';
/** 狀態（T1）：有解析器且抓到＝已解析；有解析器卻抓不到＝待確認；沒有解析器＝僅標籤 */
var GMAIL_STATUS_PARSED = '✅ 已解析';
var GMAIL_STATUS_LABEL_ONLY = '🏷️ 僅標籤';
var GMAIL_STATUS_CHECK = '⚠️ 待確認';
var GMAIL_DONE_LABEL = 'NeilOS/已處理';
var GMAIL_SCAN_DAYS = 3;
/** 一條規則一次最多看幾串。三天內不該有這麼多，到頂就寫 logs */
var GMAIL_SCAN_MAX = 100;
var GMAIL_DRIVE_ROOT = ['Neil OS', 'Gmail 附件'];
var GMAIL_CONTROLLER_FUNCTION = 'runGmailController';
/** 每天跑的時段（台北）。2026-11-10 Neil 改成早上 7 點＋下午 4 點（原本 9 點、與到期提醒同時段，D-8）。
 *  一天多跑一次是安全的：去重看 gmail_log 的 msg_id，彙報只列這一輪新處理的、0 封不推 */
var GMAIL_CONTROLLER_HOURS = [7, 16];
var GMAIL_AUTH_HINT = '在 GAS 編輯器執行一次 authorizeGmailController';

/**
 * 解析器對照表（T5）：名稱 → (內文純文字) → { amount, due_date, period? } | null。純函式，比照 ADR-015 evaluateRule_：
 * 新增一家只加一筆，並在 tests/fixtures/gmail/ 放那家的去識別樣本信。
 * 規則填了這裡沒有的名字 → 當留白（只貼標籤）＋ logs ⚠️
 *
 * ADR-023 D-9、D-10：只讀信件內文（不讀 PDF）；只回金額、西元截止日、帳單月份——
 * 帳號類資訊（中信扣款帳號、兆豐約定帳號）連讀都不讀：每個欄位只看「標籤後面第一個值」。
 * getPlainBody() 的排版各家不同（表格的 |、標籤與值不同行、全形字），一律先 gmailFlat_ 壓平再找
 */
var GMAIL_PARSERS = {
  bill_cathay: function (text) {
    var t = gmailFlat_(text);
    return { amount: gmailAmountAfter_(t, ['本期應繳總金額']), due_date: gmailDateAfter_(t, ['繳款截止日']) };
  },
  bill_ctbc_notice: function (text) {
    var t = gmailFlat_(text);
    return { amount: gmailAmountAfter_(t, ['帳單金額']), due_date: gmailDateAfter_(t, ['繳款截止日']),
             period: gmailMonthAfter_(t, ['帳單月份']) };
  },
  bill_mega: function (text) {
    var t = gmailFlat_(text);
    return { amount: gmailAmountAfter_(t, ['本期應繳金額']), due_date: gmailDateAfter_(t, ['繳款截止日']) };
  },
  // ETC 報帳報表：已扣款，沒有截止日；金額取「實際扣(繳)款金額合計」（不自己加總明細）
  etag_fetc: function (text) {
    var t = gmailFlat_(text);
    return { amount: gmailAmountAfter_(t, ['實際扣(繳)款金額合計']), period: gmailMonthAfter_(t, ['您於']) };
  }
};
/** 各解析器「抓到這些才算 ✅ 已解析」；沒列的＝金額＋截止日 */
var GMAIL_PARSER_NEEDS = { etag_fetc: ['amount'] };
var GMAIL_FIELD_LABEL = { amount: '金額', due_date: '截止日' };

/** 全形 → 半形、拿掉所有空白與表格的 |：標籤和值不管隔了幾行幾格，都變成緊鄰 */
function gmailFlat_(text) {
  return String(text == null ? '' : text)
    .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s\u3000|｜]+/g, '');
}

/** 第一個出現的標籤後面那一段（最多看 40 字：值就在標籤後面，不往下游蕩到別的欄位） */
function gmailAfter_(flat, labels) {
  for (var i = 0; i < labels.length; i++) {
    var at = flat.indexOf(labels[i]);
    if (at !== -1) return flat.slice(at + labels[i].length, at + labels[i].length + 40);
  }
  return '';
}

/** 標籤後第一個金額（可帶 $、NT$、：；千分位、小數）。抓不到回 '' */
function gmailAmountAfter_(flat, labels) {
  var m = /^[^\d]{0,4}?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(gmailAfter_(flat, labels));
  if (!m) return '';
  var n = Number(m[0].replace(/^[^\d]+/, '').replace(/,/g, ''));
  return isFinite(n) && n > 0 ? Math.round(n) : '';
}

/** 民國（2～3 位數年）或西元年 → 西元年 */
function gmailYear_(y) {
  var n = Number(y);
  return y.length <= 3 ? n + 1911 : n;
}

/** 標籤後第一個日期 → 'YYYY-MM-DD'（115/11/13、2026/09/15、2026-09-15、115年11月13日）；不存在的日期回 '' */
function gmailDateAfter_(flat, labels) {
  var m = /^[^\d]{0,4}?(\d{2,4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/.exec(gmailAfter_(flat, labels));
  if (!m) return '';
  var y = gmailYear_(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
}

/** 標籤後第一個年月 → 'YYYY-MM'（2026/08、2026年9月、115/08） */
function gmailMonthAfter_(flat, labels) {
  var m = /^[^\d]{0,4}?(\d{2,4})[\/\-.年](\d{1,2})(?!\d)/.exec(gmailAfter_(flat, labels));
  if (!m) return '';
  var mo = Number(m[2]);
  if (mo < 1 || mo > 12) return '';
  return gmailYear_(m[1]) + '-' + (mo < 10 ? '0' : '') + mo;
}

/** LINE 文字訊息上限 5000 字；留一點給「其餘 N 封」 */
var GMAIL_SUMMARY_MAX = 5000;
/** App 郵件列表一次最多帶幾筆（新的在前） */
var GMAIL_VIEW_LIMIT = 200;

/** 排程入口 */
function runGmailController() {
  return runGmailController_(new Date());
}

function runGmailController_(now) {
  var started = Date.now();
  var day = taipeiDateKey_(now);
  var processed = 0, saved = 0;
  var notes = [];
  try {
    var read = gmailRulesRead_();
    if (read.error) {
      logCleanup_('Gmail 控制員 ' + day, '略過：沒有 ' + GMAIL_RULES_SHEET + ' 分頁', '先在 LINE 傳「初始化」');
      return { processed: 0, reason: 'no_rules_sheet' };
    }
    var log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GMAIL_LOG_SHEET);
    if (!log || !sheetHeaders_(log).length) {
      logCleanup_('Gmail 控制員 ' + day, '略過：沒有 ' + GMAIL_LOG_SHEET + ' 分頁', '先在 LINE 傳「初始化」');
      return { processed: 0, reason: 'no_log_sheet' };
    }

    var rules = gmailActiveRules_(read.rules, notes);
    if (!rules.length) {
      logCleanup_('Gmail 控制員 ' + day, '處理 0 封：沒有啟用中的規則', notes.join('｜'));
      return { processed: 0 };
    }

    var done = gmailLogIds_(log);
    var cutoff = now.getTime() - GMAIL_SCAN_DAYS * 86400000;
    var claimed = {};          // 這一輪已處理的信 → 哪條規則（規則照 rule_id 由小到大跑）
    var labels = {};
    var items = [];            // ADR-026 D-5：彙報涵蓋本輪所有處理的信（notify 只決定逐封列不列）
    rules.forEach(function (rule) {
      var threads;
      try {
        threads = GmailApp.search(gmailRuleQuery_(rule, GMAIL_SCAN_DAYS), 0, GMAIL_SCAN_MAX);
      } catch (err) {
        notes.push('規則 ' + rule.rule_id + ' 查詢失敗（' + String(err && err.message || err) + '）');
        return;
      }
      if (threads.length >= GMAIL_SCAN_MAX) notes.push('規則 ' + rule.rule_id + ' 命中 ' + GMAIL_SCAN_MAX + ' 串以上，只看了前 ' + GMAIL_SCAN_MAX + ' 串');
      threads.forEach(function (thread) {
        thread.getMessages().forEach(function (msg) {
          var id = String(msg.getId());
          if (msg.getDate().getTime() < cutoff) return;
          if (!gmailFromMatches_(rule.from, msg.getFrom())) return;
          // 先看「這一輪是不是別條規則已經拿走」，再看 gmail_log：反過來的話重複命中會被默默略過
          if (claimed[id] !== undefined) {
            notes.push(id + ' 同時命中規則 ' + claimed[id] + '、' + rule.rule_id + '，取 ' + claimed[id]);
            return;
          }
          if (done[id]) return;
          claimed[id] = rule.rule_id;
          var r = gmailProcessMessage_(rule, thread, msg, log, labels, now);
          if (r.error) { notes.push(id + ' ' + r.error); return; }
          if (r.warn) notes.push(id + ' ' + r.warn);
          done[id] = true;
          processed++;
          saved += r.saved;
          r.item.notify = truthy_(rule.notify);
          items.push(r.item);
        });
      });
    });

    // 掃一遍（ADR-026 §3）：新信都記好之後、同一輪。失敗不影響彙報
    var sweep = { byId: {}, archived: 0, dry_run: 0, skipped: 0, failed: 0, live: false };
    try { sweep = gmailArchiveSweep_(log, read.rules, now); }
    catch (err) { notes.push('封存掃描失敗（' + String(err && err.message || err) + '），信都已記錄，下一輪再掃'); }
    sweep.notes && sweep.notes.forEach(function (n) { notes.push(n); });
    items.forEach(function (it) { if (sweep.byId[it.msg_id]) it.inbox_action_status = sweep.byId[it.msg_id]; });

    // 推播出錯不能讓整輪變成「例外中止」：信都已經記好了，只是彙報沒送到。本輪 0 封且沒有封存失敗＝不推
    if (items.length || sweep.failed) {
      try { gmailPushDigest_(gmailDigestText_(items, day, sweep), notes); }
      catch (err) { notes.push('彙總沒有推（' + String(err && err.message || err) + '）'); }
    }
    var fate = [];
    if (sweep.archived) fate.push('封存 ' + sweep.archived);
    if (sweep.dry_run) fate.push('預演 ' + sweep.dry_run);
    if (sweep.skipped) fate.push('跳過 ' + sweep.skipped);
    if (sweep.failed) fate.push('封存失敗 ' + sweep.failed);
    logCleanup_('Gmail 控制員 ' + day, '處理 ' + processed + ' 封（存附件 ' + saved + ' 個）' +
      (items.length ? '，彙總 ' + items.length + ' 封' : '') + (fate.length ? '，' + fate.join('／') : ''), notes.join('｜'));
    gmailSaveLastRun_(now, processed, sweep, notes);
    console.log('Gmail 控制員完成：處理 ' + processed + ' 封，存附件 ' + saved + ' 個' + (notes.length ? '\n' + notes.join('\n') : ''));
    return { processed: processed, saved: saved, notes: notes, sweep: { archived: sweep.archived, dry_run: sweep.dry_run, skipped: sweep.skipped, failed: sweep.failed } };
  } catch (err) {
    console.log('Gmail 控制員失敗：' + (err && err.stack || err));
    try { logTransaction_('同步', '失敗', 'Gmail 控制員 ' + day, '例外中止（已處理 ' + processed + ' 封）', String(err), '', ''); } catch (e) {}
    return { processed: processed, saved: saved, error: String(err) };
  } finally {
    recordSchedulePerf_('gmailController', processed, Date.now() - started);
  }
}

/**
 * Mail Widget 摘要（ADR-021 D-16）：控制員既有產出——今日各標籤筆數＋異常警告。
 * 警告沿用控制員檢查規則的同一套（gmailActiveRules_：規則有問題、掛了不存在的解析器），不另寫一份；最多 5 則
 */
function mailWidget_(ss) {
  var counts = mailSummary_(ss, taipeiDateKey_(new Date())) || { today: 0, bill: 0, newsletter: 0, etag: 0, bills_3d: 0 };
  var warnings = [];
  // ADR-026 D-9：今天 ⚠️ 待確認／封存失敗也算異常（只用 mailSummary_ 已讀的同一張表，不多讀）
  var org = counts.org || {};
  if (org.check) warnings.push('今天 ' + org.check + ' 封待確認（解析不到）');
  if (org.failed) warnings.push('今天 ' + org.failed + ' 封封存失敗，下一輪再試');
  var r = gmailRulesRead_();
  if (r.error) warnings.push('讀不到 ' + GMAIL_RULES_SHEET + '（' + r.error + '）');
  else gmailActiveRules_(r.rules, warnings);
  var since = gmailArchiveLiveSince_();
  var last = gmailLastRun_();
  return Object.assign({}, counts, { warnings: warnings.slice(0, 5), at: new Date().toISOString(),
    live: !!since, last_at: last && last.at ? String(last.at) : '' });
}

/** 啟用中、沒有問題的規則（有問題的寫進 notes 並跳過；parser 不認得只提醒、照樣處理） */
function gmailActiveRules_(rules, notes) {
  var seen = {};
  return rules.filter(function (rule) {
    if (!truthy_(rule.is_active)) return false;
    var problems = gmailRuleProblems_(rule, seen);
    if (problems.length) {
      notes.push('規則 ' + (String(rule.rule_id == null ? '' : rule.rule_id).trim() || '（沒有 id）') + ' 略過：' + problems.join('；'));
      return false;
    }
    var parser = String(rule.parser == null ? '' : rule.parser).trim();
    if (parser && !GMAIL_PARSERS[parser]) notes.push('規則 ' + rule.rule_id + ' 的 parser「' + parser + '」不認得，當留白');
    // ADR-026：空白或打錯一律當留下（不確定就不封），但要講出來
    var action = gmailTrim_(rule.inbox_action);
    if (!action) notes.push('規則 ' + rule.rule_id + ' 沒填 inbox_action，當留下（LINE 傳「初始化」會補預設）');
    else if (GMAIL_INBOX_ACTIONS.indexOf(action) === -1) notes.push('規則 ' + rule.rule_id + ' 的 inbox_action「' + action + '」不認得，當留下');
    var bucket = gmailTrim_(rule.bucket);
    if (bucket && GMAIL_BUCKETS.indexOf(bucket) === -1) notes.push('規則 ' + rule.rule_id + ' 的 bucket「' + bucket + '」不認得，依信種歸組');
    return true;
  });
}

/**
 * 同一串裡可能有別人的信（例如 Neil 自己的回覆）：寄件者欄的每個詞（去掉 OR、括號、引號、
 * 排除用的 -詞）只要有一個出現在這封的 From 裡就算。寄件者欄留白＝只靠主旨，一律算。
 */
function gmailFromMatches_(fromExpr, actual) {
  var tokens = String(fromExpr == null ? '' : fromExpr).split(/[\s,，、()"{}]+/).filter(function (t) {
    return t && t.toUpperCase() !== 'OR' && t.charAt(0) !== '-';
  });
  if (!tokens.length) return true;
  var from = String(actual == null ? '' : actual).toLowerCase();
  return tokens.some(function (t) { return from.indexOf(t.toLowerCase()) !== -1; });
}

/** gmail_log 已有的 msg_id */
function gmailLogIds_(sheet) {
  var headers = sheetHeaders_(sheet);
  var col = headers.indexOf('msg_id') + 1;
  var ids = {};
  if (!col || sheet.getLastRow() < 2) return ids;
  sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
    var id = String(row[0] == null ? '' : row[0]).trim();
    if (id) ids[id] = true;
  });
  return ids;
}

/**
 * 一封信：先存附件 → 再記 gmail_log → 最後貼標籤。
 * 附件存不進去就整封不記、不貼（下次再試），不能出現「記了卻沒存到」。
 * 已經記下來才貼標籤失敗：資料在，只是 Gmail 上看不出來，提醒就好。
 */
function gmailProcessMessage_(rule, thread, msg, log, labels, now) {
  var urls;
  try {
    urls = gmailSaveAttachments_(rule, msg);
  } catch (err) {
    return { error: '附件存不進 Drive（' + String(err && err.message || err) + '），下次再試' };
  }
  var parsed = gmailParse_(rule, msg);
  var item = {
    msg_id: String(msg.getId()), received_at: msg.getDate().toISOString(), rule_id: rule.rule_id,
    mail_type: rule.mail_type, source_name: rule.source_name, subject: msg.getSubject(),
    amount: parsed.amount, due_date: parsed.due_date, status: parsed.status,
    attachment_url: urls.join('\n'), gmail_link: thread.getPermalink(), processed_at: now.toISOString(),
    // ADR-026：寫入當下的規則快照，不依日後規則回算。留下的直接記 kept；要封存的交給同一輪的「掃一遍」
    bucket: gmailRuleBucket_(rule), requested_inbox_action: gmailRuleInboxAction_(rule),
    inbox_action_status: gmailRuleInboxAction_(rule) === 'keep' ? 'kept' : '',
    inbox_action_at: gmailRuleInboxAction_(rule) === 'keep' ? now.toISOString() : '', inbox_action_note: ''
  };
  gmailAppendLog_(log, item);
  var warn = parsed.warn || '';
  try {
    gmailLabel_(thread, rule.label, labels);
  } catch (err) {
    warn = (warn ? warn + '；' : '') + '已記錄，但貼標籤失敗（' + String(err && err.message || err) + '）';
  }
  return { saved: urls.length, warn: warn, item: item };
}

/**
 * 解析（T5）。沒有解析器（或名字不認得）＝僅標籤、不讀內文；有解析器就讀純文字內文交給它。
 * 不合法的值一律當沒抓到（**絕不猜值**）。ADR-023（Neil 2026-11-03）：抓到的欄照存、抓不到的留白，
 * 缺了該解析器的必填欄（GMAIL_PARSER_NEEDS）→ 待確認、warn 寫哪一欄解析不到；解析器丟例外 → 待確認、兩欄留白
 */
function gmailParse_(rule, msg) {
  var name = String(rule.parser == null ? '' : rule.parser).trim();
  var fn = name ? GMAIL_PARSERS[name] : null;
  var none = { amount: '', due_date: '', status: GMAIL_STATUS_LABEL_ONLY };
  if (!fn) return none;
  var out;
  try {
    out = fn(String(msg.getPlainBody() || ''));
  } catch (err) {
    return { amount: '', due_date: '', status: GMAIL_STATUS_CHECK,
             warn: '解析器 ' + name + ' 失敗（' + String(err && err.message || err) + '）' };
  }
  var got = {
    amount: out && typeof out.amount === 'number' && isFinite(out.amount) && out.amount > 0 ? out.amount : '',
    due_date: out && /^\d{4}-\d{2}-\d{2}$/.test(String(out.due_date || '')) ? String(out.due_date) : ''
  };
  var missing = (GMAIL_PARSER_NEEDS[name] || ['amount', 'due_date']).filter(function (k) { return got[k] === ''; });
  if (!missing.length) return { amount: got.amount, due_date: got.due_date, status: GMAIL_STATUS_PARSED };
  return { amount: got.amount, due_date: got.due_date, status: GMAIL_STATUS_CHECK,
           warn: '解析器 ' + name + ' 解析不到：' + missing.map(function (k) { return GMAIL_FIELD_LABEL[k]; }).join('、') };
}

/* ---------- 群組彙總（T6） ---------- */

function gmailMoney_(n) {
  return 'NT$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 'YYYY-MM-DD' → 'M/D' */
function gmailMd_(key) {
  var p = String(key).split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}

/**
 * 一則處理結果彙報（ADR-026 D-5）。涵蓋本輪所有處理的信，依 bucket 分三組，各報數量＋去向；
 * notify=TRUE 的規則逐封列（來源、金額、截止日），FALSE 只計數。只寫來源名稱、金額、截止日、連結
 * （待確認的才寫主旨，沿用現制），不寫寄件者、卡號、內文。
 * 太長就從後面截掉，最後一行「其餘 N 封」——N 是完全沒出現在訊息裡的封數。
 * sweep：這一輪「掃一遍」的計數（跳過／失敗／預演含之前沒封成的列）
 */
var GMAIL_FATE_WORD = { kept: '留下', archived: '已封存', dry_run: '預演', skipped: '跳過', failed: '失敗' };
function gmailDigestText_(items, day, sweep) {
  sweep = sweep || { archived: 0, dry_run: 0, skipped: 0, failed: 0, live: false };
  var entries = [];        // { text, ids }：每一行
  GMAIL_BUCKETS.forEach(function (b) {
    var list = items.filter(function (it) { return (it.bucket || gmailRuleBucket_(it)) === b; });
    if (!list.length) return;
    var head = GMAIL_BUCKET_LABEL[b] + ' ' + list.length + ' 封｜' + gmailFateSummary_(list);
    var rows = list.filter(function (it) { return it.notify; }).map(gmailDigestLine_);
    entries.push({ text: '\n' + head + (rows.length ? '\n' + rows.join('\n') : ''),
                   ids: list.filter(function (it) { return it.notify; }).map(function (it) { return it.msg_id; }) });
    // 只計數的（notify=FALSE）在標題的數字裡就算「出現過」
    list.filter(function (it) { return !it.notify; }).forEach(function (it) { entries[entries.length - 1].ids.push(it.msg_id); });
  });

  var check = items.filter(function (it) { return it.status === GMAIL_STATUS_CHECK; });
  check.forEach(function (it, i) {
    entries.push({ text: (i ? '' : '\n⚠️ 待確認\n') + '・' + it.subject + '\n　' + it.gmail_link, ids: [it.msg_id] });
  });

  var tail = '\n⚠️ 跳過 ' + (sweep.skipped || 0) + '｜失敗 ' + (sweep.failed || 0);
  if (!sweep.live && sweep.dry_run) tail += '\n（預演中：本來會封存 ' + sweep.dry_run + ' 封）';

  var text = '📬 Gmail 整理 ' + gmailMd_(day) + '（共 ' + items.length + ' 封）';
  var shown = {};
  var reserve = 40 + tail.length;
  for (var i = 0; i < entries.length; i++) {
    if (text.length + 1 + entries[i].text.length > GMAIL_SUMMARY_MAX - reserve) break;
    text += '\n' + entries[i].text;
    entries[i].ids.forEach(function (id) { shown[id] = true; });
  }
  if (i < entries.length) {
    var rest = items.filter(function (it) { return !shown[it.msg_id]; }).length;
    text += '\n\n…其餘 ' + rest + ' 封，到 App 看';
  }
  return text + '\n' + tail;
}

/** 一組的去向：全部留下＝「留在收件匣」；否則列各種去向的數量 */
function gmailFateSummary_(list) {
  var count = {};
  list.forEach(function (it) { var k = it.inbox_action_status || 'pending'; count[k] = (count[k] || 0) + 1; });
  if (count.kept === list.length) return '留在收件匣';
  var parts = [];
  ['kept', 'archived', 'dry_run', 'skipped', 'failed'].forEach(function (k) {
    if (count[k]) parts.push(k === 'dry_run' ? '預演：本來會封存 ' + count[k] : GMAIL_FATE_WORD[k] + ' ' + count[k]);
  });
  if (count.pending) parts.push('未處理 ' + count.pending);
  return parts.join('・');
}

/** 逐封列的一行（notify=TRUE）。有解析器卻抓不到寫「解析不到」（ADR-023）；沒有解析器的帳單照舊「金額待確認」 */
function gmailDigestLine_(it) {
  var ran = it.status !== GMAIL_STATUS_LABEL_ONLY;
  var parts = ['・' + it.source_name];
  if (typeof it.amount === 'number') parts.push(gmailMoney_(it.amount));
  else if (ran) parts.push('金額解析不到');
  else if (it.mail_type === 'bill') parts.push('金額待確認');
  if (it.due_date) parts.push(gmailMd_(it.due_date) + ' 截止');
  else if (ran && it.mail_type === 'bill') parts.push('截止日解析不到');
  if (it.attachment_url) parts.push('📎 ' + String(it.attachment_url).split('\n')[0]);
  return parts.join('｜');
}

/**
 * 推給「啟用＋notify_gmail＋bot 沒離開」的群組（ADR-014 notify_* 同一套判斷）。不推個人。
 * ADR-026 D-7b：成功也記——「推播 ✅ 到 C1f…（群組名）」；失敗「推播 ❌ 到 …（群組名）：原因」。不存訊息內容
 */
function gmailPushDigest_(text, notes) {
  var all = readLineGroups_();
  if (!all.ok) { notes.push('讀不到 ' + LINE_GROUPS_SHEET + '，彙總沒有推（' + all.error + '）'); return; }
  var targets = all.rows.map(function (r) { return r.record; }).filter(function (g) {
    return truthy_(g.is_active) && truthy_(g.notify_gmail) && !keyValue_(g.left_at);
  });
  if (!targets.length) { notes.push('沒有開 notify_gmail 的群組，彙總沒有推'); return; }
  targets.forEach(function (g) {
    var id = keyValue_(g.group_id);
    var who = id.slice(0, 3) + '…（' + (gmailTrim_(g.name) || '群組') + '）';
    var r = linePush_(id, text);
    notes.push(r.ok ? '推播 ✅ 到 ' + who : '推播 ❌ 到 ' + who + '：' + r.reason);
  });
}

/* ---------- 掃一遍：留下／封存（ADR-026 §3） ---------- */

/** 正式封存的開啟時間（ISO）；空字串＝預演 */
function gmailArchiveLiveSince_() {
  var v = '';
  try { v = gmailTrim_(PropertiesService.getScriptProperties().getProperty(GMAIL_ARCHIVE_PROP)); } catch (err) { return ''; }
  return v && !isNaN(new Date(v).getTime()) ? v : '';
}

/**
 * 取最近 GMAIL_SWEEP_DAYS 天 requested_inbox_action=archive、去向是 dry_run／failed／空 的列，逐串判定：
 *   - 串已不在 Inbox → archived（對帳，不重做）
 *   - 串內每一封都在 gmail_log、同一 rule_id，而且該規則現在仍是啟用中的 archive → 可封存；否則 skipped＋原因
 *   - 預演：只寫 dry_run（只判定本輪新寫的列，不重寫）
 *   - 正式：processed_at ≥ 開啟時間才 moveToArchive → archived；例外 → failed（下一輪自然再掃到）。開啟前的列不碰
 * 不標已讀、不刪除、不動星號／重要性／既有標籤、不把信搬回收件匣。只寫去向三欄，不重寫整列、不重存 PDF
 */
function gmailArchiveSweep_(log, rules, now) {
  var out = { byId: {}, archived: 0, dry_run: 0, skipped: 0, failed: 0, live: false, notes: [] };
  var since = gmailArchiveLiveSince_();
  out.live = !!since;
  var sinceT = since ? new Date(since).getTime() : 0;
  if (log.getLastRow() < 2) return out;
  var headers = sheetHeaders_(log);
  var col = {};
  ['msg_id', 'rule_id', 'processed_at', 'requested_inbox_action', 'inbox_action_status', 'inbox_action_at', 'inbox_action_note']
    .forEach(function (h) { col[h] = headers.indexOf(h); });
  if (col.requested_inbox_action === -1 || col.inbox_action_status === -1 || col.inbox_action_at === -1 || col.inbox_action_note === -1) {
    out.notes.push(GMAIL_LOG_SHEET + ' 還沒有收件匣去向欄，沒有掃（LINE 傳「初始化」補欄）');
    return out;
  }
  var values = log.getRange(2, 1, log.getLastRow() - 1, headers.length).getValues();
  var ruleOf = {};             // msg_id → rule_id（整張 gmail_log）
  values.forEach(function (row) { var id = gmailTrim_(row[col.msg_id]); if (id) ruleOf[id] = gmailTrim_(row[col.rule_id]); });
  var ruleById = {};
  (rules || []).forEach(function (r) { ruleById[gmailTrim_(r.rule_id)] = r; });
  var from = now.getTime() - GMAIL_SWEEP_DAYS * 86400000;
  var byThread = {};           // 同一串只判定一次（eTag 同主旨會歸成一串）

  values.forEach(function (row, i) {
    if (gmailTrim_(row[col.requested_inbox_action]) !== 'archive') return;
    var status = gmailTrim_(row[col.inbox_action_status]);
    if (['', 'dry_run', 'failed'].indexOf(status) === -1) return;
    var t = toTime_(row[col.processed_at]);
    if (isNaN(t) || t < from) return;
    if (out.live ? t < sinceT : status !== '') return;
    var id = gmailTrim_(row[col.msg_id]);
    var res = gmailArchiveDecide_(id, gmailTrim_(row[col.rule_id]), ruleOf, ruleById, out.live, byThread);
    var at = now.toISOString();
    log.getRange(i + 2, col.inbox_action_status + 1, 1, 1).setValues([[res.status]]);
    log.getRange(i + 2, col.inbox_action_at + 1, 1, 1).setValues([[at]]);
    log.getRange(i + 2, col.inbox_action_note + 1, 1, 1).setValues([[res.note]]);
    out.byId[id] = res.status;
    out[res.status]++;
    if (res.status === 'failed') out.notes.push(id + ' 封存失敗（' + res.note + '），下一輪再試');
  });
  return out;
}

/** 一封要不要封（見 gmailArchiveSweep_）。回 { status, note }；note 只寫原因，不含主旨與內文 */
function gmailArchiveDecide_(msgId, ruleId, ruleOf, ruleById, live, byThread) {
  var thread, tid;
  try {
    var msg = GmailApp.getMessageById(msgId);
    if (!msg) return { status: 'skipped', note: '找不到這封信（可能已刪除）' };
    thread = msg.getThread();
    // 同一串同一條規則只判定一次；不同規則的列答案不同（原因寫的是「另一條」）
    tid = String(thread.getId()) + '|' + ruleId;
    if (byThread[tid]) return byThread[tid];
    var res = gmailArchiveCheck_(thread, ruleId, ruleOf, ruleById);
    if (!res) {
      if (!live) res = { status: 'dry_run', note: '本來會封存' };
      else { thread.moveToArchive(); res = { status: 'archived', note: '已封存' }; }
    }
    byThread[tid] = res;
    return res;
  } catch (err) {
    return { status: 'failed', note: String(err && err.message || err).slice(0, 80) };
  }
}

/** 封存前的檢查；可以封回 null，不能封回 { status, note } */
function gmailArchiveCheck_(thread, ruleId, ruleOf, ruleById) {
  if (!thread.isInInbox()) return { status: 'archived', note: '已不在收件匣（對帳）' };
  var msgs = thread.getMessages();
  for (var i = 0; i < msgs.length; i++) {
    var other = ruleOf[String(msgs[i].getId())];
    if (other === undefined) return { status: 'skipped', note: '同串有 NeilOS 沒記錄的信' };
    if (other !== ruleId) return { status: 'skipped', note: '同串有別條規則（' + other + '）的信' };
  }
  var rule = ruleById[ruleId];
  if (!rule || !truthy_(rule.is_active)) return { status: 'skipped', note: '規則 ' + ruleId + ' 已停用或不存在' };
  if (gmailRuleInboxAction_(rule) !== 'archive') return { status: 'skipped', note: '規則 ' + ruleId + ' 已改成留下' };
  return null;
}

/** 最後一次控制員完成的摘要（Widget 與整理報告讀）。寫不進去不影響主流程 */
function gmailSaveLastRun_(now, processed, sweep, notes) {
  try {
    PropertiesService.getScriptProperties().setProperty(GMAIL_LAST_RUN_PROP, JSON.stringify({
      at: now.toISOString(), processed: processed, archived: sweep.archived || 0, dry_run: sweep.dry_run || 0,
      skipped: sweep.skipped || 0, failed: sweep.failed || 0, notes: notes.length
    }));
  } catch (err) {
    console.log('記不了 ' + GMAIL_LAST_RUN_PROP + '（主流程不受影響）：' + err);
  }
}

function gmailLastRun_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(GMAIL_LAST_RUN_PROP);
    var o = raw ? JSON.parse(raw) : null;
    return o && typeof o === 'object' ? o : null;
  } catch (err) {
    return null;
  }
}

/** 附件白名單（D-9）：規則要存、不是電子報、副檔名 .pdf。原封不動：不解密、不解析。同名不覆蓋 */
function gmailSaveAttachments_(rule, msg) {
  if (!truthy_(rule.save_attachment) || rule.mail_type === 'newsletter') return [];
  var pdfs = msg.getAttachments().filter(function (a) { return /\.pdf$/i.test(a.getName()); });
  if (!pdfs.length) return [];
  var day = taipeiDateKey_(msg.getDate());
  var folder = gmailFolder_(GMAIL_DRIVE_ROOT.concat([rule.mail_type, day.slice(0, 7)])).folder;
  return pdfs.map(function (a) {
    var name = day + '_' + rule.source_name + '_' + a.getName();
    var same = folder.getFilesByName(name);
    if (same.hasNext()) return same.next().getUrl();
    return folder.createFile(a.copyBlob().setName(name)).getUrl();
  });
}

/** 從「我的雲端硬碟」一層層找，沒有就建。回 { folder, created }（created＝最後一層是這次建的） */
function gmailFolder_(path) {
  var folder = DriveApp.getRootFolder();
  var created = false;
  path.forEach(function (name) {
    var found = folder.getFoldersByName(name);
    created = !found.hasNext();
    folder = created ? folder.createFolder(name) : found.next();
  });
  return { folder: folder, created: created };
}

/** 規則的標籤＋NeilOS/已處理。標籤不存在就建 */
function gmailLabel_(thread, name, cache) {
  var names = [];
  var own = String(name == null ? '' : name).trim();
  if (own) names.push(own);
  names.push(GMAIL_DONE_LABEL);
  names.forEach(function (n) {
    var label = cache[n] || (cache[n] = GmailApp.getUserLabelByName(n) || GmailApp.createLabel(n));
    thread.addLabel(label);
  });
}

/**
 * 寫一列。msg_id 先把那一格設成純文字再 setValues：全是數字的 id 會被 Sheet 轉成數字、
 * 讀回來就對不上（appendRow 不管欄位格式，股票代號踩過，見 stock.gs writeStockRow_）
 */
function gmailAppendLog_(sheet, rec) {
  var headers = sheetHeaders_(sheet);
  var row = headers.map(function (h) { return rec[h] == null ? '' : rec[h]; });
  var target = sheet.getLastRow() + 1;
  if (target > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), target - sheet.getMaxRows());
  var col = headers.indexOf('msg_id') + 1;
  if (col) sheet.getRange(target, col, 1, 1).setNumberFormat('@');
  sheet.getRange(target, 1, 1, headers.length).setValues([row]);
}

/* ---------- 「初始化」（T1／T4） ---------- */

/**
 * 「初始化」的 Gmail 那一步。每一項都可重複執行：已存在就跳過，不重建、不清資料。
 * Drive／Gmail 還沒授權不算失敗（表與排程照樣建好），標 ⚠️ 說要去編輯器同意權限。
 */
function installGmail_() {
  var lines = [], warn = false;
  var rules = installGmailRules_();
  if (rules.level === 'warn') warn = true;
  var changed = !!rules.changed;
  lines.push(rules.text);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(GMAIL_LOG_SHEET);
  if (!log || log.getLastRow() === 0) {
    log = log || ss.insertSheet(GMAIL_LOG_SHEET);
    log.getRange(1, 1, 1, GMAIL_LOG_HEADERS.length).setValues([GMAIL_LOG_HEADERS]);
    lines.push('新建 ' + GMAIL_LOG_SHEET);
    changed = true;
  } else {
    var l = ensureColumnsOnSheet_(log, GMAIL_LOG_HEADERS);
    if (l.added.length) changed = true;
    lines.push(GMAIL_LOG_SHEET + ' 已存在（' + (log.getLastRow() - 1) + ' 列）' +
      (l.added.length ? '，補上：' + l.added.join('、') : ''));
  }

  var users = installGmailFeature_();
  if (users.warn) warn = true;
  if (users.changed) changed = true;
  lines.push(users.text);

  var g = ensureColumnsOnSheet_(ensureLineGroupsSheet_(), ['cmd_gmail', 'notify_gmail']);
  if (g.reason) { warn = true; lines.push('⚠️ ' + LINE_GROUPS_SHEET + ' 沒有表頭，沒有補 cmd_gmail／notify_gmail'); }
  else {
    if (g.added.length) changed = true;
    lines.push(g.added.length ? LINE_GROUPS_SHEET + ' 補上：' + g.added.join('、') : LINE_GROUPS_SHEET + ' 欄位已齊備');
  }

  try {
    var f = gmailFolder_(GMAIL_DRIVE_ROOT);
    lines.push('Drive 資料夾 ' + GMAIL_DRIVE_ROOT.join('/') + '：' + (f.created ? '新建' : '已存在'));
    if (f.created) changed = true;
  } catch (err) {
    warn = true;
    lines.push('⚠️ Drive 還沒授權，資料夾沒有建：' + GMAIL_AUTH_HINT + '（會要求整個雲端硬碟的權限，GAS 的限制）');
  }

  try {
    GmailApp.getUserLabelByName(GMAIL_DONE_LABEL);
    lines.push('Gmail 授權 ✅');
  } catch (err) {
    warn = true;
    lines.push('⚠️ Gmail 還沒授權：' + GMAIL_AUTH_HINT);
  }

  // 觸發器由排程總管統一管（ADR-019 D-1），這裡不再自己裝
  lines.push('排程：由排程總管每天 ' + GMAIL_CONTROLLER_HOURS.join('、') + ' 點後第一輪執行');
  return { level: warn ? 'warn' : 'ok', changed: changed, text: lines.join('\n　') };
}

/**
 * line_users 補 feat_gmail。**這一次才新增**時只替管理者打勾（D-7）；之後誰的勾都不動。
 * 非管理者就算被勾了也讀不到 gmail_*（目前兩張表都在 NO_PWA_READ）
 */
function installGmailFeature_() {
  var users = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_USERS_SHEET);
  if (!users) return { warn: true, text: '⚠️ 找不到 ' + LINE_USERS_SHEET + '，沒有補 feat_gmail' };
  var u = ensureColumnsOnSheet_(users, ['feat_gmail']);
  if (u.reason) return { warn: true, text: '⚠️ ' + LINE_USERS_SHEET + ' 沒有表頭，沒有補 feat_gmail' };
  if (!u.added.length) return { text: LINE_USERS_SHEET + ' 已有 feat_gmail' };
  var headers = sheetHeaders_(users);
  var admins = 0;
  if (users.getLastRow() >= 2) {
    users.getRange(2, 1, users.getLastRow() - 1, headers.length).getValues().forEach(function (row, i) {
      if (truthy_(row[headers.indexOf('is_admin')])) {
        users.getRange(i + 2, headers.indexOf('feat_gmail') + 1, 1, 1).setValues([['TRUE']]);
        admins++;
      }
    });
  }
  invalidateLineUsersCache_();
  return { changed: true, text: LINE_USERS_SHEET + ' 補上：feat_gmail（預設只開管理者 ' + admins + ' 人）' };
}


/**
 * 授權——部署後在 GAS 編輯器選這支按「執行」一次（比照 authorizeArchiveMail）。
 * 第一次同意權限是 Google 的規定，只能由部署者本人在編輯器按；LINE 進來的「初始化」沒有同意畫面。
 * 只讀：查一個標籤、看雲端硬碟根目錄的名字，不建任何東西。
 */
function authorizeGmailController() {
  // 選擇性授權：任何一個權限沒勾，就停下來重新跳出授權畫面（見 probeGmail）
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  GmailApp.getUserLabelByName(GMAIL_DONE_LABEL);
  console.log('✅ Gmail 權限已授權');
  console.log('✅ Drive 權限已授權（' + DriveApp.getRootFolder().getName() + '）');
  console.log('回 LINE 再傳一次「初始化」，Drive 資料夾就會建好');
  return { ok: true };
}

/* ========================================================================== */
/* PR-B：給 App 的管理員 API（T7 的後端）                                        */
/* PWA 一般 read／upsert 仍然碰不到 gmail_*（NO_PWA_READ／NO_PWA_WRITE 不變），     */
/* 只有這兩個驗過權限與欄位的 action。                                            */
/* ========================================================================== */

var GMAIL_BOOL_FIELDS = ['is_active', 'save_attachment', 'notify'];

/** 管理者＋feat_gmail（D-7）。非管理者就算被勾了 feat_gmail 也不行 */
function gmailForbidden_(caller, action) {
  var forbidden = adminForbidden_(caller, action);
  if (forbidden) return forbidden;
  if (canUse_(caller.user, 'feat_gmail')) return null;
  try { logTransaction_(SETTINGS_LOG_SOURCE, '失敗', action, '沒有「郵件」功能的權限', '', '', caller.line_id); } catch (err) {}
  return { error: 'forbidden' };
}

/**
 * what = rules（設定頁）／log（📬 郵件列表，新的在前，最多 GMAIL_VIEW_LIMIT 筆）／
 *        report（ADR-026 整理報告：依 processed_at 最近 days 天，含去向與封存模式）／archive（封存開關現況）
 */
function gmailView_(caller, what, opts) {
  var forbidden = gmailForbidden_(caller, 'gmailView ' + what);
  if (forbidden) return forbidden;
  opts = opts || {};
  if (what === 'rules') {
    var read = gmailRulesRead_();
    if (read.error) return { error: read.error };
    return { success: true, rules: read.rules.map(function (r) { return plainRecord_(r, GMAIL_RULES_HEADERS); }),
             parsers: Object.keys(GMAIL_PARSERS).sort(), mail_types: GMAIL_MAIL_TYPES.slice(),
             buckets: GMAIL_BUCKETS.slice(), inbox_actions: GMAIL_INBOX_ACTIONS.slice() };
  }
  if (what === 'log') {
    var log = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), GMAIL_LOG_SHEET, {});
    if (log.error) return { error: log.error };
    var rows = log.rows.map(function (r) { return plainRecord_(r, GMAIL_LOG_HEADERS); });
    rows.sort(function (a, b) { return String(b.received_at).localeCompare(String(a.received_at)); });
    return { success: true, rows: rows.slice(0, GMAIL_VIEW_LIMIT), total: rows.length };
  }
  if (what === 'report') return gmailReport_(opts.days);
  if (what === 'archive') {
    var since = gmailArchiveLiveSince_();
    return { success: true, live: !!since, live_since: since, last_run: gmailLastRun_() };
  }
  return { error: 'unknown_view' };
}

var GMAIL_REPORT_FIELDS = ['msg_id', 'received_at', 'processed_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount',
                           'due_date', 'status', 'gmail_link', 'bucket', 'requested_inbox_action', 'inbox_action_status', 'inbox_action_note'];

/** 整理報告：只回 gmail_log 有的東西（沒有內文）。舊列沒有 bucket 就依信種推，去向空白＝legacy */
function gmailReport_(days) {
  var n = Math.floor(Number(days));
  n = isFinite(n) && n >= 1 ? Math.min(n, GMAIL_REPORT_MAX_DAYS) : GMAIL_REPORT_DAYS;
  var log = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), GMAIL_LOG_SHEET, {});
  if (log.error) return { error: log.error };
  var from = Date.now() - n * 86400000;
  var rows = [];
  log.rows.forEach(function (r) {
    var t = toTime_(r.processed_at);
    if (isNaN(t) || t < from) return;
    var o = plainRecord_(r, GMAIL_REPORT_FIELDS);
    if (GMAIL_BUCKETS.indexOf(gmailTrim_(o.bucket)) === -1) o.bucket = GMAIL_BUCKET_BY_TYPE[gmailTrim_(o.mail_type)] || 'fyi';
    rows.push(o);
  });
  rows.sort(function (a, b) { return String(b.processed_at).localeCompare(String(a.processed_at)); });
  var since = gmailArchiveLiveSince_();
  return { success: true, days: n, rows: rows, live: !!since, live_since: since, last_run: gmailLastRun_() };
}

/**
 * 正式封存開關（ADR-026 D-3）。只有管理員＋feat_gmail；打開存「開啟時間」（只影響之後處理的信），
 * 已經開著再開不改時間；關掉＝回到預演。每次切換都寫 logs（來源「設定」）
 */
function gmailArchiveSet_(caller, live) {
  var forbidden = gmailForbidden_(caller, 'gmailArchiveSet');
  if (forbidden) return forbidden;
  if (typeof live !== 'boolean') return { error: 'invalid_value' };
  var since = gmailArchiveLiveSince_();
  try {
    var props = PropertiesService.getScriptProperties();
    if (live && !since) { since = new Date().toISOString(); props.setProperty(GMAIL_ARCHIVE_PROP, since); }
    if (!live && since) { props.deleteProperty(GMAIL_ARCHIVE_PROP); since = ''; }
  } catch (err) {
    try { logTransaction_(SETTINGS_LOG_SOURCE, '失敗', 'gmailArchiveSet', '存不進指令碼屬性', String(err), '', caller.line_id); } catch (e) {}
    return { error: 'save_failed' };
  }
  settingsLog_(caller, 'gmailArchiveSet', live ? '正式封存：開' : '正式封存：關（回到預演）', since ? '開啟時間 ' + since : '');
  return { success: true, live: !!since, live_since: since };
}

/**
 * 即時內文（ADR-026 D-10）：從 Gmail 讀純文字，不存副本（不寫 Sheet／Drive／快取）、不回 HTML。
 * msg_id 必須在 gmail_log 裡——不能拿來讀任意信件。每次讀取寫一筆 logs（來源「郵件」）：
 * 只有 msg_id、來源名稱與 bucket，不含主旨與內文（月底覆盤「電子報在 NeilOS 被讀幾封」靠它，D-11）
 */
function gmailBody_(caller, msgId) {
  var forbidden = gmailForbidden_(caller, 'gmailBody');
  if (forbidden) return forbidden;
  var id = gmailTrim_(msgId);
  if (!id) return { error: 'missing_msg_id' };
  var log = sheetRecords_(SpreadsheetApp.getActiveSpreadsheet(), GMAIL_LOG_SHEET, {});
  if (log.error) return { error: log.error };
  var row = log.rows.filter(function (r) { return gmailTrim_(r.msg_id) === id; })[0];
  var fail = function (why, code) {
    try { logTransaction_(GMAIL_LOG_SOURCE, '失敗', 'gmailBody ' + id, why, '', '', caller.line_id); } catch (e) {}
    return { error: code };
  };
  if (!row) return fail('不在 gmail_log，拒絕讀取', 'not_in_log');
  var bucket = GMAIL_BUCKETS.indexOf(gmailTrim_(row.bucket)) !== -1 ? gmailTrim_(row.bucket) : (GMAIL_BUCKET_BY_TYPE[gmailTrim_(row.mail_type)] || 'fyi');
  var msg = null;
  try { msg = GmailApp.getMessageById(id); } catch (err) { msg = null; }
  if (!msg) return fail('Gmail 找不到這封信（可能已刪除）', 'not_found');
  var text;
  try { text = String(msg.getPlainBody() || ''); }
  catch (err) { return fail('讀不到內文（' + String(err && err.message || err).slice(0, 80) + '）', 'read_failed'); }
  var truncated = text.length > GMAIL_BODY_MAX;
  if (truncated) text = text.slice(0, GMAIL_BODY_MAX);
  try {
    logTransaction_(GMAIL_LOG_SOURCE, '成功', 'gmailBody ' + id, gmailTrim_(row.source_name) + '｜' + bucket,
      truncated ? '超過 ' + GMAIL_BODY_MAX + ' 字已截斷' : '', '', caller.line_id);
  } catch (e) {}
  return { success: true, msg_id: id, text: text, truncated: truncated, source_name: gmailTrim_(row.source_name),
           subject: gmailTrim_(row.subject), bucket: bucket, gmail_link: gmailTrim_(row.gmail_link) };
}

/**
 * 新增或編輯一條規則。rule_id 留白＝新增（取最大的數字＋1）；有 rule_id＝只改送來的欄位。
 * 停用＝is_active FALSE，不刪列：gmail_log 裡的舊信還指著這個 rule_id。
 */
function gmailRuleSet_(caller, input) {
  var forbidden = gmailForbidden_(caller, 'gmailRuleSet');
  if (forbidden) return forbidden;
  input = input || {};
  var read = gmailRulesRead_();
  if (read.error) return { error: read.error };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GMAIL_RULES_SHEET);

  var id = String(input.rule_id == null ? '' : input.rule_id).trim();
  var rule;
  if (id) {
    var found = read.rules.filter(function (r) { return String(r.rule_id).trim() === id; })[0];
    if (!found) return { error: 'rule_not_found', rule_id: id };
    rule = plainRecord_(found, GMAIL_RULES_HEADERS);
  } else {
    var max = 0;
    read.rules.forEach(function (r) { var n = Number(r.rule_id); if (isFinite(n) && n > max) max = n; });
    rule = plainRecord_({ is_active: true }, GMAIL_RULES_HEADERS);
    rule.rule_id = max + 1;
  }
  GMAIL_RULES_HEADERS.forEach(function (h) {
    if (h !== 'rule_id' && Object.prototype.hasOwnProperty.call(input, h)) rule[h] = input[h];
  });
  // ADR-026：新規則預設留下、bucket 依信種（D-12：save_attachment 沒送就是 FALSE，不再依帳單自動勾）
  if (!id) {
    if (!gmailTrim_(rule.inbox_action)) rule.inbox_action = 'keep';
    if (!gmailTrim_(rule.bucket)) rule.bucket = GMAIL_BUCKET_BY_TYPE[gmailTrim_(rule.mail_type)] || '';
  }
  var action = gmailTrim_(rule.inbox_action), bucket = gmailTrim_(rule.bucket);
  if (Object.prototype.hasOwnProperty.call(input, 'inbox_action') && action && GMAIL_INBOX_ACTIONS.indexOf(action) === -1) return { error: 'invalid_inbox_action' };
  if (Object.prototype.hasOwnProperty.call(input, 'bucket') && bucket && GMAIL_BUCKETS.indexOf(bucket) === -1) return { error: 'invalid_bucket' };
  GMAIL_RULES_HEADERS.forEach(function (h) {
    if (GMAIL_BOOL_FIELDS.indexOf(h) !== -1) rule[h] = truthy_(rule[h]) ? 'TRUE' : 'FALSE';
    else if (h !== 'rule_id') rule[h] = String(rule[h] == null ? '' : rule[h]).trim();
  });

  if (!rule.source_name) return { error: 'missing_source_name' };
  // 停用中的規則控制員不會用：不擋，否則一條填錯的舊規則連「先停用」都做不到
  if (rule.is_active === 'TRUE') {
    if (GMAIL_MAIL_TYPES.indexOf(rule.mail_type) === -1) return { error: 'invalid_mail_type' };
    if (!gmailRuleQuery_(rule, GMAIL_SCAN_DAYS)) return { error: 'empty_query' };
    // 只擋「這次選了」不認得的解析器。規則上留著的舊值控制員本來就當留白（gmailActiveRules_ 警告），
    // 不能因為它就連「取消存 PDF」都存不進去（Neil 2026-10-20）
    var parserSent = Object.prototype.hasOwnProperty.call(input, 'parser');
    if (parserSent && rule.parser && !GMAIL_PARSERS[rule.parser]) return { error: 'unknown_parser', parser: rule.parser };
  }

  upsertRow_(sheet, sheetHeaders_(sheet), rule, GMAIL_RULES_SHEET, 'rule_id');
  settingsLog_(caller, 'gmailRuleSet ' + rule.source_name, (id ? '修改' : '新增') + ' rule_id=' + rule.rule_id,
    'is_active=' + rule.is_active + '｜mail_type=' + rule.mail_type + '｜bucket=' + rule.bucket + '｜inbox_action=' + rule.inbox_action);
  return { success: true, rule: rule };
}
