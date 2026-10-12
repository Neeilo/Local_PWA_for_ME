/**
 * Gmail 控制員（ADR-016）。
 *
 * 每天 9 點 runGmailController 依 gmail_rules 掃最近 3 天的信 → Gmail 只貼標籤 →
 * 帳單 PDF 原封不動存 Drive → 寫 gmail_log（一封一列）。不封存、不標已讀、不刪除、不呼叫 Gemini。
 * 解析金額／截止日與群組彙總推播在 PR-B。
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
 * gmail_rules：沒有就建（只有表頭）；已存在只補缺的欄，不動規則。
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
  if (r.reason) return { level: 'warn', text: GMAIL_RULES_SHEET + ' 沒有表頭，沒有補欄位' };
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

/* ========================================================================== */
/* PR-A：控制員                                                                 */
/* ========================================================================== */

var GMAIL_LOG_HEADERS = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount',
                         'due_date', 'status', 'attachment_url', 'gmail_link', 'processed_at'];
/** 狀態（T1）：PR-B 加上「✅ 已解析」「⚠️ 待確認」；沒有解析器的一律是這個 */
var GMAIL_STATUS_LABEL_ONLY = '🏷️ 僅標籤';
var GMAIL_DONE_LABEL = 'NeilOS/已處理';
var GMAIL_SCAN_DAYS = 3;
/** 一條規則一次最多看幾串。三天內不該有這麼多，到頂就寫 logs */
var GMAIL_SCAN_MAX = 100;
var GMAIL_DRIVE_ROOT = ['Neil OS', 'Gmail 附件'];
var GMAIL_CONTROLLER_FUNCTION = 'runGmailController';
var GMAIL_CONTROLLER_HOUR = 9;       // 與到期提醒同時段（D-8）
var GMAIL_AUTH_HINT = '在 GAS 編輯器執行一次 authorizeGmailController';

/**
 * 解析器對照表：名稱 → (內文純文字) → { amount, due_date } | null。PR-B 才加入第一批；
 * 規則填了這裡沒有的名字 → 當留白（只貼標籤）＋ logs ⚠️
 */
var GMAIL_PARSERS = {};

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
        });
      });
    });

    logCleanup_('Gmail 控制員 ' + day, '處理 ' + processed + ' 封（存附件 ' + saved + ' 個）', notes.join('｜'));
    console.log('Gmail 控制員完成：處理 ' + processed + ' 封，存附件 ' + saved + ' 個' + (notes.length ? '\n' + notes.join('\n') : ''));
    return { processed: processed, saved: saved, notes: notes };
  } catch (err) {
    console.log('Gmail 控制員失敗：' + (err && err.stack || err));
    try { logTransaction_('同步', '失敗', 'Gmail 控制員 ' + day, '例外中止（已處理 ' + processed + ' 封）', String(err), '', ''); } catch (e) {}
    return { processed: processed, saved: saved, error: String(err) };
  } finally {
    recordSchedulePerf_('gmailController', processed, Date.now() - started);
  }
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
  gmailAppendLog_(log, {
    msg_id: String(msg.getId()), received_at: msg.getDate().toISOString(), rule_id: rule.rule_id,
    mail_type: rule.mail_type, source_name: rule.source_name, subject: msg.getSubject(),
    amount: '', due_date: '', status: GMAIL_STATUS_LABEL_ONLY,
    attachment_url: urls.join('\n'), gmail_link: thread.getPermalink(), processed_at: now.toISOString()
  });
  try {
    gmailLabel_(thread, rule.label, labels);
  } catch (err) {
    return { saved: urls.length, warn: '已記錄，但貼標籤失敗（' + String(err && err.message || err) + '）' };
  }
  return { saved: urls.length };
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
  lines.push(rules.text);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(GMAIL_LOG_SHEET);
  if (!log || log.getLastRow() === 0) {
    log = log || ss.insertSheet(GMAIL_LOG_SHEET);
    log.getRange(1, 1, 1, GMAIL_LOG_HEADERS.length).setValues([GMAIL_LOG_HEADERS]);
    lines.push('新建 ' + GMAIL_LOG_SHEET);
  } else {
    var l = ensureColumnsOnSheet_(log, GMAIL_LOG_HEADERS);
    lines.push(GMAIL_LOG_SHEET + ' 已存在（' + (log.getLastRow() - 1) + ' 列）' +
      (l.added.length ? '，補上：' + l.added.join('、') : ''));
  }

  var users = installGmailFeature_();
  if (users.warn) warn = true;
  lines.push(users.text);

  var g = ensureColumnsOnSheet_(ensureLineGroupsSheet_(), ['cmd_gmail', 'notify_gmail']);
  if (g.reason) { warn = true; lines.push('⚠️ ' + LINE_GROUPS_SHEET + ' 沒有表頭，沒有補 cmd_gmail／notify_gmail'); }
  else lines.push(g.added.length ? LINE_GROUPS_SHEET + ' 補上：' + g.added.join('、') : LINE_GROUPS_SHEET + ' 欄位已齊備');

  try {
    var f = gmailFolder_(GMAIL_DRIVE_ROOT);
    lines.push('Drive 資料夾 ' + GMAIL_DRIVE_ROOT.join('/') + '：' + (f.created ? '新建' : '已存在'));
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

  installGmailTrigger_();
  lines.push('排程 ' + GMAIL_CONTROLLER_FUNCTION + '：已安裝（每天約 ' + GMAIL_CONTROLLER_HOUR + ' 點）');
  return { level: warn ? 'warn' : 'ok', text: lines.join('\n　') };
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
  return { text: LINE_USERS_SHEET + ' 補上：feat_gmail（預設只開管理者 ' + admins + ' 人）' };
}

/** 獨立安裝／移除，不跟到期提醒綁在一起（T4）。先刪同名的再建，重跑不累積 */
function installGmailTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === GMAIL_CONTROLLER_FUNCTION) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(GMAIL_CONTROLLER_FUNCTION).timeBased().atHour(GMAIL_CONTROLLER_HOUR).everyDays(1).create();
}

/** 編輯器手動執行：停掉控制員（表與資料都留著） */
function uninstallGmailController() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === GMAIL_CONTROLLER_FUNCTION) { ScriptApp.deleteTrigger(t); removed++; }
  });
  console.log(removed ? '已移除 ' + removed + ' 個 ' + GMAIL_CONTROLLER_FUNCTION + ' 觸發器' : '沒有找到 ' + GMAIL_CONTROLLER_FUNCTION + ' 觸發器');
  return { removed: removed };
}

/**
 * 授權——部署後在 GAS 編輯器選這支按「執行」一次（比照 authorizeArchiveMail）。
 * 第一次同意權限是 Google 的規定，只能由部署者本人在編輯器按；LINE 進來的「初始化」沒有同意畫面。
 * 只讀：查一個標籤、看雲端硬碟根目錄的名字，不建任何東西。
 */
function authorizeGmailController() {
  GmailApp.getUserLabelByName(GMAIL_DONE_LABEL);
  console.log('✅ Gmail 權限已授權');
  console.log('✅ Drive 權限已授權（' + DriveApp.getRootFolder().getName() + '）');
  console.log('回 LINE 再傳一次「初始化」，Drive 資料夾就會建好');
  return { ok: true };
}
