/**
 * Gmail 控制員（ADR-016）。
 *
 * PR-0 只有兩件事：
 *  - 「初始化」建 gmail_rules（只有表頭），Neil 把規則盤點表直接填進這張表——
 *    盤點表只填一次，PR-A 起它就是正式規則（D-10）
 *  - 探針 probeGmail()：在 GAS 編輯器手動執行，每條啟用中的規則列出「最近 30 天命中幾個
 *    對話串、前 3 封主旨」，再看有沒有同一封信被兩條規則命中。**只讀**：不貼標籤、
 *    不寫任何分頁。先確認認信條件沒有漏抓／誤抓，PR-A 才動信箱。之後留著當診斷工具
 *
 * 用 GmailApp（不用 Gmail 進階服務）。第一次執行會要求讀取／管理 Gmail 的權限，
 * GAS 沒有「只讀」的 GmailApp 權限可選。
 */

/** 欄位見 ADR-016 交棒 T1。PWA 一般讀寫碰不到這張表（Code.gs 的 NO_PWA_READ／NO_PWA_WRITE） */
var GMAIL_RULES_HEADERS = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
                           'label', 'save_attachment', 'notify', 'parser', 'note'];
/** 信種（D-2）：信用卡帳單、eTag、電子報 */
var GMAIL_MAIL_TYPES = ['bill', 'etag', 'newsletter'];

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

/* ========================================================================== */
/* 「初始化」                                                                   */
/* ========================================================================== */

/**
 * 「初始化」的 Gmail 那一步：沒有 gmail_rules 就建（只有表頭）；已存在只補缺的欄，不動規則。
 * PR-A 起這一步會一併建 gmail_log、補 feat_gmail 與群組欄位、建 Drive 資料夾、裝排程。
 */
function installGmailRules_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(GMAIL_RULES_SHEET);
  if (!sheet || sheet.getLastRow() === 0) {
    sheet = sheet || ss.insertSheet(GMAIL_RULES_SHEET);
    sheet.getRange(1, 1, 1, GMAIL_RULES_HEADERS.length).setValues([GMAIL_RULES_HEADERS]);
    return { level: 'ok', text: '新建 ' + GMAIL_RULES_SHEET + '（只有表頭）：把規則盤點表填進去，再到編輯器執行 probeGmail()' };
  }
  var r = ensureColumnsOnSheet_(sheet, GMAIL_RULES_HEADERS);
  if (r.reason) return { level: 'warn', text: '⚠️ ' + GMAIL_RULES_SHEET + ' 沒有表頭，沒有補欄位' };
  var lines = [GMAIL_RULES_SHEET + ' 已存在（' + (sheet.getLastRow() - 1) + ' 列規則）'];
  if (r.added.length) lines.push(GMAIL_RULES_SHEET + ' 補上：' + r.added.join('、'));
  return { level: 'ok', text: lines.join('\n　') };
}

/* ========================================================================== */
/* 探針（PR-0）                                                                 */
/* ========================================================================== */

/** 編輯器手動執行的入口 */
function probeGmail() {
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
