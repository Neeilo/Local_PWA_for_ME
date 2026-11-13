/* ========================================================================== */
/* 圖書館週報（ADR-028）                                                        */
/* ========================================================================== */

/*
 * 每週五 19:00（台北）後，排程總管替每位有 feat_clips 的人產生一期週報：
 *   候選（本人、收齊、未刪、未讀或閱讀中）分成 🆕 本週新收＋📦 舊庫存一批 → 送 AI（照設定頁那一家，失敗不換家）
 *   → 每篇給 ⭐ 推薦／😐 普通／🗑️ 可略過＋一句理由 → 存 clip_reports 一列＋clips 的 report_* 欄 → LINE 短提醒。
 * 另有「📊 立即產生」（手動＝預覽：一樣寫一期、更新各篇判斷，但不推進期間訖、不推 LINE）。
 *
 *  - AI 只建議、不動手：產生週報不改任何 read_status；標已讀只有本人按 clipMarkRead
 *  - 數字總覽由程式算、不送 AI（D-1）
 *  - 整份解析失敗算失敗、不存半份（D-8）；排程失敗 LINE 通知、不自動重試
 *  - 「我的關注」每人一份，存指令碼屬性（只有本人讀寫，內容不進 logs、不進 repo）
 *
 * 候選挑選、提示詞、解析、數字總覽都是純函式（可測）。
 */
var CLIP_REPORTS_HEADERS = ['id', 'line_id', 'type', 'week', 'period_start', 'period_end', 'created_at', 'provider', 'status', 'error',
  'recommended', 'skippable', 'summary', 'used_focus'];
var CLIP_REPORT_FEATURE = 'clip_report';          // ADR-022 記帳的 feature：成本卡分開顯示「圖書館週報」
var CLIP_REPORT_LOG_SOURCE = '收藏';
/** 每週五 19:00（台北）後第一輪 */
var CLIP_REPORT_WEEKDAY = 5;
var CLIP_REPORT_HOUR = 19;
var CLIP_REPORT_JOB_MINUTES = 10;
/** 「上一份排程週報」的指令碼屬性：{ week, done: [line_id] }——每人一週只排一份，成功失敗都算 */
var CLIP_REPORT_STATE_KEY = 'clip_report_state';
var CLIP_REPORT_FIRST_DAYS = 7;
var CLIP_REPORT_OLD_BATCH = 20;
var CLIP_REPORT_MAX_NEW_REC = 3;
var CLIP_REPORT_MAX_OLD_REC = 2;
/** 每篇送 AI 的字數上限（說明文字優先，再來圖片文字、筆記）；整體輸入另設上限，超過的篇這期不判 */
var CLIP_REPORT_ITEM_CHARS = 800;
var CLIP_REPORT_INPUT_MAX = 40000;
var CLIP_REPORT_REASON_MAX = 80;
/** 一個人的 AI 呼叫可能要 30 秒以上：總管剩下的預算不夠就留給下一輪 */
var CLIP_REPORT_MIN_BUDGET_MS = 90000;
var CLIP_REPORT_HISTORY_MAX = 20;
var CLIP_MARK_READ_MAX = 200;
/** 「我的關注」：每人一個指令碼屬性 clip_focus_<line_id>，上限 2,000 字 */
var CLIP_FOCUS_PREFIX = 'clip_focus_';
var CLIP_FOCUS_MAX = 2000;
var CLIP_VERDICTS = ['recommend', 'normal', 'skip'];
var CLIP_VERDICT_ALIASES = { recommend: 'recommend', '推薦': 'recommend', normal: 'normal', '普通': 'normal', skip: 'skip', '可略過': 'skip', '略過': 'skip' };

/* -------------------------------------------------------------------------- */
/* 時間：最近一個週五 19:00（台北）                                                 */
/* -------------------------------------------------------------------------- */

/** now 之前（含）最近一個週五 19:00（台北）→ { key: 'YYYY-MM-DD'（那個週五）, ms } */
function clipReportSlot_(now) {
  var nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  var tpe = new Date(nowMs + 8 * 3600000);                // 台北的「牆上時間」，用 UTC 方法讀
  var back = (tpe.getUTCDay() - CLIP_REPORT_WEEKDAY + 7) % 7;
  var slot = Date.UTC(tpe.getUTCFullYear(), tpe.getUTCMonth(), tpe.getUTCDate() - back, CLIP_REPORT_HOUR) - 8 * 3600000;
  if (slot > nowMs) slot -= 7 * 86400000;                  // 週五 19:00 前 → 上一週的
  return { key: new Date(slot + 8 * 3600000).toISOString().slice(0, 10), ms: slot };
}

function clipReportMs_(v) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(String(v == null ? '' : v));
  return isNaN(t) ? 0 : t;
}

/* -------------------------------------------------------------------------- */
/* 純函式：候選、分組、提示詞、解析、數字總覽                                         */
/* -------------------------------------------------------------------------- */

/** 候選（D-3）：本人、收齊（done／partial，不是只存連結、不是失敗）、未刪、未讀或閱讀中 */
function clipReportCandidates_(rows, lineId) {
  var me = String(lineId || '').trim();
  return (rows || []).filter(function (r) {
    if (!r || String(r.line_id || '').trim() !== me || clipDeleted_(r)) return false;
    var st = String(r.status || '').trim();
    if (st !== 'done' && st !== 'partial') return false;
    return String(r.read_status == null ? '' : r.read_status).trim() !== 'read';
  });
}

/**
 * 分組：🆕 新收＝收藏時間在 (since, untilMs] 之間；📦 舊庫存＝其餘，優先還沒被 AI 判斷過的、再來最久沒判的，
 * 同一層取最舊的，最多 CLIP_REPORT_OLD_BATCH 篇（連續兩期輪到不同一批）。since 是毫秒
 */
function clipReportSplit_(cands, sinceMs, untilMs) {
  var fresh = [];
  var rest = [];
  cands.forEach(function (r) {
    var t = clipReportMs_(r.collected_at);
    if (t > sinceMs && t <= untilMs) fresh.push(r); else rest.push(r);
  });
  var judged = function (r) { return clipReportMs_(r.report_at); };
  rest.sort(function (a, b) {
    var ja = judged(a), jb = judged(b);
    if ((ja > 0) !== (jb > 0)) return ja > 0 ? 1 : -1;      // 沒判過的先
    if (ja !== jb) return ja - jb;                          // 都判過：最久沒判的先
    return clipReportMs_(a.collected_at) - clipReportMs_(b.collected_at);   // 最舊的先
  });
  fresh.sort(function (a, b) { return clipReportMs_(a.collected_at) - clipReportMs_(b.collected_at); });
  return { fresh: fresh, old: rest.slice(0, CLIP_REPORT_OLD_BATCH) };
}

function clipReportPlatform_(r) {
  return r && (r.kind === CLIP_THREADS || /^https?:\/\/(www\.)?threads\.(com|net)\//i.test(String(r.url || ''))) ? 'Threads' : 'IG';
}

function clipReportClean_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 一篇送 AI 的文字：說明文字優先，再來圖片文字、筆記，合計截到 CLIP_REPORT_ITEM_CHARS 字 */
function clipReportItemText_(r) {
  var left = CLIP_REPORT_ITEM_CHARS;
  var parts = [];
  [['說明文字', r.caption], ['圖片文字', r.ocr_output], ['筆記', r.note]].forEach(function (p) {
    var t = clipReportClean_(p[1]);
    if (!t || left <= 0) return;
    if (t.length > left) t = t.slice(0, left) + '…';
    left -= t.length;
    parts.push(p[0] + '：' + t);
  });
  return parts.join('\n');
}

/**
 * 提示詞（D-7）：🔒 固定指令＋✏️「我的關注」（空白用通用標準）＋每篇資料。
 * 整體輸入超過 CLIP_REPORT_INPUT_MAX 的篇這期不送（回 sent 清單，只寫有送的）
 */
function clipReportPrompt_(groups, focus) {
  var f = String(focus || '').trim();
  var head = [
    '你是圖書館整理助理。下面是使用者收藏、還沒讀完的貼文，請用繁體中文判斷每一篇值不值得讀。',
    '規則：',
    '1. 每一篇都要給判斷：recommend（推薦）／normal（普通）／skip（可略過），加一句理由（40 字內）。',
    '2. 推薦上限：「本週新收」最多 ' + CLIP_REPORT_MAX_NEW_REC + ' 篇、「舊庫存」最多 ' + CLIP_REPORT_MAX_OLD_REC + ' 篇。',
    '3. 重複包裝的同一份內容、做法都要「留言領取」的引流文，優先判 skip，理由要說是哪一種。',
    '4. 只依下面提供的內容判斷，不要編造內容沒提到的事。',
    '5. 只輸出 JSON，不要其他文字，格式：{"items":[{"id":"…","verdict":"recommend|normal|skip","reason":"…"}]}',
    '',
    f ? '使用者的關注（判斷標準）：\n' + f : '使用者還沒設定關注：用通用標準判斷——實用、可執行、不重複的優先。',
    ''
  ].join('\n');
  var used = head.length;
  var sent = [];
  var blocks = [];
  [['本週新收', groups.fresh, 'new'], ['舊庫存', groups.old, 'old']].forEach(function (g) {
    var lines = [];
    (g[1] || []).forEach(function (r) {
      var block = '- id: ' + r.id + '｜平台: ' + clipReportPlatform_(r) + '｜作者: ' + clipReportClean_(r.author || '（不明）') + '\n' + clipReportItemText_(r);
      if (used + block.length > CLIP_REPORT_INPUT_MAX) return;
      used += block.length + 1;
      lines.push(block);
      sent.push({ id: String(r.id), group: g[2] });
    });
    if (lines.length) blocks.push('【' + g[0] + '】\n' + lines.join('\n'));
  });
  return { prompt: head + blocks.join('\n\n'), sent: sent };
}

/**
 * 解析 AI 回覆（D-8）：抓第一個 { 到最後一個 }；要有 items 陣列。不認得的 id 忽略、推薦超過上限降為普通、
 * 漏判的篇不寫入；一篇都解析不出來＝失敗（回 null，不存半份）。回 { byId: { id: { verdict, reason, group } } }
 */
function clipReportParse_(text, sent) {
  var s = String(text || '');
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  var json = null;
  try { json = JSON.parse(s.slice(a, b + 1)); } catch (err) { return null; }
  if (!json || !Array.isArray(json.items)) return null;
  var groupOf = {};
  (sent || []).forEach(function (x) { groupOf[x.id] = x.group; });
  var cap = { new: CLIP_REPORT_MAX_NEW_REC, old: CLIP_REPORT_MAX_OLD_REC };
  var used = { new: 0, old: 0 };
  var byId = {};
  var n = 0;
  json.items.forEach(function (it) {
    if (!it || typeof it !== 'object') return;
    var id = String(it.id == null ? '' : it.id).trim();
    var group = groupOf[id];
    if (!group || byId[id]) return;
    var verdict = CLIP_VERDICT_ALIASES[String(it.verdict || '').trim().toLowerCase()] || CLIP_VERDICT_ALIASES[String(it.verdict || '').trim()];
    if (!verdict) return;
    if (verdict === 'recommend') {
      if (used[group] >= cap[group]) verdict = 'normal';
      else used[group]++;
    }
    var reason = clipReportClean_(it.reason);
    if (reason.length > CLIP_REPORT_REASON_MAX) reason = reason.slice(0, CLIP_REPORT_REASON_MAX) + '…';
    byId[id] = { verdict: verdict, reason: reason, group: group };
    n++;
  });
  return n ? { byId: byId } : null;
}

/**
 * 數字總覽（D-1，程式算、不送 AI）。mine：本人未刪的列；fresh：本期新收；judged：本期判斷（可為 null）；
 * prev：上一份排程週報（可為 null）
 */
function clipReportSummary_(mine, fresh, judged, prev) {
  var st = { unread: 0, reading: 0, read: 0 };
  var cats = {};
  mine.forEach(function (r) {
    var s = String(r.status || '').trim();
    if (s !== 'done' && s !== 'partial' && s !== CLIP_LINK) return;
    var rs = String(r.read_status == null ? '' : r.read_status).trim();
    st[rs === 'read' ? 'read' : rs === 'reading' ? 'reading' : 'unread']++;
    var c = String(r.category || '').trim() || '未分類';
    cats[c] = (cats[c] || 0) + 1;
  });
  var newBy = { IG: 0, Threads: 0 };
  fresh.forEach(function (r) { newBy[clipReportPlatform_(r)]++; });
  var verdicts = { recommend: 0, normal: 0, skip: 0 };
  if (judged) Object.keys(judged.byId).forEach(function (id) { verdicts[judged.byId[id].verdict]++; });
  var prevSum = prev ? clipReportJson_(prev.summary, {}) : null;
  var prevRec = prev ? clipReportJson_(prev.recommended, []) : [];
  var readNow = {};
  mine.forEach(function (r) { if (String(r.read_status || '').trim() === 'read') readNow[String(r.id)] = true; });
  return {
    new_total: fresh.length, new_ig: newBy.IG, new_threads: newBy.Threads,
    unread: st.unread, reading: st.reading, read: st.read,
    unread_delta: prevSum && typeof prevSum.unread === 'number' ? st.unread - prevSum.unread : null,
    categories: cats,
    recommend: verdicts.recommend, normal: verdicts.normal, skip: verdicts.skip,
    prev_rec_total: prevRec.length,
    prev_rec_read: prevRec.filter(function (x) { return readNow[String(x.id)]; }).length
  };
}

function clipReportJson_(v, fallback) {
  if (v && typeof v === 'object') return v;
  try { var j = JSON.parse(String(v || '')); return j == null ? fallback : j; } catch (err) { return fallback; }
}

/** 標題：內文第一行（沒有就作者、網址），截 30 字（LINE 短訊與清單共用） */
function clipReportTitle_(r) {
  var first = String(r.caption || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean)[0] || r.author || r.url || '';
  first = String(first);
  return first.length > 30 ? first.slice(0, 30) + '…' : first;
}

/* -------------------------------------------------------------------------- */
/* 存放                                                                         */
/* -------------------------------------------------------------------------- */

function ensureClipReportsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CLIP_REPORTS_SHEET);
  var created = false;
  if (!sheet) { sheet = ss.insertSheet(CLIP_REPORTS_SHEET); created = true; }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, CLIP_REPORTS_HEADERS.length).setValues([CLIP_REPORTS_HEADERS]);
    return { sheet: sheet, created: created, added: [] };
  }
  var r = ensureColumnsOnSheet_(sheet, CLIP_REPORTS_HEADERS);
  return { sheet: sheet, created: created, added: r.added || [] };
}

/** 本人的各期（新的在前） */
function clipReportsOf_(lineId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIP_REPORTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var me = String(lineId || '').trim();
  return clipsTable_(sheet).rows.map(function (x) { return x.rec; })
    .filter(function (r) { return String(r.line_id || '').trim() === me; })
    .sort(function (a, b) { return clipReportMs_(b.created_at) - clipReportMs_(a.created_at); });
}

/** 上一份成功的排程週報 */
function clipReportPrevScheduled_(reports) {
  return reports.filter(function (r) { return r.type === 'scheduled' && r.status === 'ok'; })[0] || null;
}

/** 本期判斷寫回 clips（只寫有判到的篇；最新一次為準）。拿 script lock，一次重讀整張 */
function clipReportWriteVerdicts_(judged, reportId, at) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('clips 忙碌中（拿不到鎖）');
  try {
    var t = clipsTable_(sheet);
    t.rows.forEach(function (x) {
      var j = judged.byId[String(x.rec.id)];
      if (!j) return;
      clipsWriteRow_(sheet, t.headers, x, { report_verdict: j.verdict, report_reason: j.reason, report_id: reportId, report_at: at });
    });
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------------------------------------------------- */
/* 產生一期                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 產生一期週報。type＝'scheduled'｜'manual'。回 { ok, report（寫進 clip_reports 的那一列）, error }。
 * 手動不推進期間訖（新收的起點照「上一份排程週報」算）、不推 LINE；排程寫 week
 */
function clipReportGenerate_(lineId, type, now, week) {
  now = now instanceof Date ? now : new Date();
  var at = now.toISOString();
  var me = String(lineId || '').trim();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  var rows = sheet && sheet.getLastRow() >= 2 ? clipsTable_(sheet).rows.map(function (x) { return x.rec; }) : [];
  var mine = rows.filter(function (r) { return String(r.line_id || '').trim() === me && !clipDeleted_(r); });
  var reports = clipReportsOf_(me);
  var prev = clipReportPrevScheduled_(reports);
  var sinceMs = prev ? clipReportMs_(prev.period_end) : now.getTime() - CLIP_REPORT_FIRST_DAYS * 86400000;
  var groups = clipReportSplit_(clipReportCandidates_(mine, me), sinceMs, now.getTime());
  var focus = clipFocusGet_(me);
  var report = {
    id: 'rep_' + now.getTime() + '_' + Math.floor(Math.random() * 1e6), line_id: me, type: type, week: week || '',
    period_start: new Date(sinceMs).toISOString(), period_end: at, created_at: at, provider: '', status: 'ok', error: '',
    recommended: '[]', skippable: '[]', summary: '', used_focus: focus ? 'TRUE' : ''
  };
  var judged = null;
  if (groups.fresh.length || groups.old.length) {
    var p = clipReportPrompt_(groups, focus);
    var res = callAiLong_(p.prompt, CLIP_REPORT_FEATURE);       // 長輸出：callAi_ 的 2048 tokens 不夠 45 篇
    report.provider = res.label || '';
    judged = res.ok ? clipReportParse_(res.text, p.sent) : null;
    if (!res.ok) { report.status = 'failed'; report.error = res.reason === 'no_key' ? 'AI 還沒設定 API key（' + res.missingKey + '）' : 'AI 呼叫失敗：' + res.reason; }
    else if (!judged) { report.status = 'failed'; report.error = res.truncated ? 'AI 回覆被截斷（輸出太長），這期不存判斷' : 'AI 回覆看不懂（不是約定的 JSON），這期不存判斷'; }
  }
  if (report.status === 'ok' && judged) {
    var rec = [], skip = [];
    p.sent.forEach(function (x) {
      var j = judged.byId[x.id];
      if (!j) return;
      if (j.verdict === 'recommend') rec.push({ id: x.id, group: x.group, reason: j.reason });
      else if (j.verdict === 'skip') skip.push({ id: x.id, group: x.group, reason: j.reason });
    });
    report.recommended = JSON.stringify(rec);
    report.skippable = JSON.stringify(skip);
  }
  report.summary = JSON.stringify(clipReportSummary_(mine, groups.fresh, report.status === 'ok' ? judged : null, prev));
  ensureClipReportsSheet_();
  appendToSheet_(CLIP_REPORTS_SHEET, report);
  if (report.status === 'ok' && judged) clipReportWriteVerdicts_(judged, report.id, at);
  logTransaction_(CLIP_REPORT_LOG_SOURCE, report.status === 'ok' ? '成功' : '失敗', 'clipReport ' + type,
    report.status === 'ok' ? '週報：推薦 ' + JSON.parse(report.recommended).length + '、可略過 ' + JSON.parse(report.skippable).length +
      (judged ? '（判 ' + Object.keys(judged.byId).length + ' 篇）' : '（沒有候選）') : '週報失敗：' + report.error,
    report.id + (report.provider ? '｜' + report.provider : ''), '', me);
  return { ok: report.status === 'ok', report: report, error: report.error };
}

/* -------------------------------------------------------------------------- */
/* 排程與 LINE                                                                   */
/* -------------------------------------------------------------------------- */

function clipReportState_() {
  var v = null;
  try { v = JSON.parse(PropertiesService.getScriptProperties().getProperty(CLIP_REPORT_STATE_KEY) || 'null'); } catch (err) { v = null; }
  return v && typeof v === 'object' && Array.isArray(v.done) ? v : { week: '', done: [] };
}

function clipReportSaveState_(st) {
  try { PropertiesService.getScriptProperties().setProperty(CLIP_REPORT_STATE_KEY, JSON.stringify(st)); }
  catch (err) { console.log('週報排程狀態存不了：' + err); }
}

/**
 * 排程總管每 CLIP_REPORT_JOB_MINUTES 分鐘叫一次：最近一個週五 19:00 已過、這一週還沒排過的人，一人一份。
 * 週五總管停掉的話，之後第一輪補（每人每週一份）。預算不夠一個人就留給下一輪。成功失敗都算排過（失敗不自動重試，LINE 通知）
 */
function runClipReportJob_(now, ctx) {
  var budgetLeft = (ctx && ctx.budgetLeft) || function () { return Infinity; };
  now = now instanceof Date ? now : new Date();
  var slot = clipReportSlot_(now);
  var st = clipReportState_();
  var roster = lineUsersRoster_();
  var weekChanged = st.week !== slot.key;
  if (weekChanged) st = { week: slot.key, done: [] };
  var ids = roster && roster.ok ? Object.keys(roster.users) : [];
  var todo = ids.filter(function (id) {
    var u = roster.users[id];
    return truthy_(u.is_active) && canUse_(u, CLIPS_FEATURE) && st.done.indexOf(String(id)) === -1;
  });
  var processed = 0;
  for (var i = 0; i < todo.length; i++) {
    if (budgetLeft() < CLIP_REPORT_MIN_BUDGET_MS) break;
    var id = String(todo[i]);
    st.done.push(id);
    clipReportSaveState_(st);                          // 先記「排過了」：就算這次跑一半掛掉，也不會一週推兩次
    var out;
    try { out = clipReportGenerate_(id, 'scheduled', now, slot.key); }
    catch (err) { out = { ok: false, error: '處理時出錯：' + String(err && err.message || err), report: null }; }
    clipReportNotify_(id, out);
    processed++;
  }
  if (weekChanged && !processed) clipReportSaveState_(st);
  return { processed: processed, week: slot.key, left: todo.length - processed };
}

/** LINE 一對一短提醒（D-6）；失敗通知（D-8）。推播成敗寫 logs */
function clipReportNotify_(lineId, out) {
  var text;
  if (!out.ok) {
    text = '📊 本週圖書館週報產生失敗（' + (out.error || '原因不明') + '），可到圖書館 📊 週報手動重跑';
  } else {
    var r = out.report;
    var rec = clipReportJson_(r.recommended, []);
    var skip = clipReportJson_(r.skippable, []);
    var byId = {};
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
    if (sheet && sheet.getLastRow() >= 2) clipsTable_(sheet).rows.forEach(function (x) { byId[String(x.rec.id)] = x.rec; });
    var sum = clipReportJson_(r.summary, {});
    if (!rec.length && !skip.length && !sum.new_total && !(sum.unread + sum.reading)) {
      text = '📊 本週圖書館週報：沒有待讀的收藏 🎉';
    } else {
      var lines = ['📊 本週圖書館週報'];
      if (rec.length) {
        lines.push('⭐ 推薦：');
        rec.forEach(function (x) { if (byId[x.id]) lines.push('・' + clipReportTitle_(byId[x.id])); });
      } else {
        lines.push('這週沒有特別推薦的');
      }
      if (skip.length) lines.push('🗑️ 可略過 ' + skip.length + ' 篇');
      lines.push('到圖書館 📊 週報看完整內容');
      text = lines.join('\n');
    }
  }
  var res = { ok: false, reason: 'no_push' };
  try { res = linePush_(lineId, text) || res; } catch (err) { res = { ok: false, reason: String(err && err.message || err) }; }
  try {
    logTransaction_('推播', res.ok ? '成功' : '失敗', 'clipReport', res.ok ? '週報提醒已送出' : '週報提醒沒送出：' + (res.reason || ''), '', '', lineId);
  } catch (err) {}
  return res;
}

/* -------------------------------------------------------------------------- */
/* 「我的關注」                                                                  */
/* -------------------------------------------------------------------------- */

function clipFocusGet_(lineId) {
  var me = String(lineId || '').trim();
  if (!me) return '';
  try { return String(PropertiesService.getScriptProperties().getProperty(CLIP_FOCUS_PREFIX + me) || ''); } catch (err) { return ''; }
}

/* -------------------------------------------------------------------------- */
/* PWA 動作（只限本人＋feat_clips）                                                */
/* -------------------------------------------------------------------------- */

function clipReportForbidden_(caller) {
  if (!canUse_(caller.user, CLIPS_FEATURE)) return { error: 'forbidden', permanent: true, reason: 'feature' };
  if (!String(caller.line_id || '').trim()) return { error: 'forbidden', permanent: true };
  return null;
}

/** 一期送前端：JSON 欄解開 */
function clipReportOut_(r) {
  return {
    id: String(r.id), type: String(r.type || ''), week: String(r.week || ''), period_start: String(r.period_start || ''),
    period_end: String(r.period_end || ''), created_at: String(r.created_at || ''), provider: String(r.provider || ''),
    status: String(r.status || ''), error: String(r.error || ''), used_focus: truthy_(r.used_focus),
    recommended: clipReportJson_(r.recommended, []), skippable: clipReportJson_(r.skippable, []), summary: clipReportJson_(r.summary, {})
  };
}

/** action=clipReport：指定 id 那一期（沒給＝最新一期）＋歷史清單（最多 CLIP_REPORT_HISTORY_MAX 期，只帶摘要欄） */
function clipReportView_(caller, id) {
  var forbidden = clipReportForbidden_(caller);
  if (forbidden) return forbidden;
  var reports = clipReportsOf_(caller.line_id);
  var pick = id ? reports.filter(function (r) { return String(r.id) === String(id); })[0] : reports[0];
  if (id && !pick) return { error: 'not_found', permanent: true };
  return {
    success: true, report: pick ? clipReportOut_(pick) : null, focus_set: !!clipFocusGet_(caller.line_id),
    history: reports.slice(0, CLIP_REPORT_HISTORY_MAX).map(function (r) {
      return { id: String(r.id), type: String(r.type || ''), status: String(r.status || ''), created_at: String(r.created_at || ''), week: String(r.week || '') };
    })
  };
}

/** action=clipReportRun：📊 立即產生（預覽：不推進期間訖、不推 LINE） */
function clipReportRun_(caller) {
  var forbidden = clipReportForbidden_(caller);
  if (forbidden) return forbidden;
  var out;
  try { out = clipReportGenerate_(caller.line_id, 'manual', new Date(), ''); }
  catch (err) {
    logTransaction_(CLIP_REPORT_LOG_SOURCE, '失敗', 'clipReport manual', '週報失敗', String(err && err.stack || err), '', caller.line_id);
    return { error: 'busy' };
  }
  return { success: out.ok, error: out.ok ? undefined : 'report_failed', reason: out.error, report: clipReportOut_(out.report) };
}

/**
 * action=clipMarkRead（D-4）：ids 清單，只改本人、未刪除、還不是已讀的列 → read_status＝read（ADR-025）。
 * 寫 logs（筆數，不複製內容）。回 { success, changed, ids（實際改到的） }
 */
function clipMarkRead_(caller, ids) {
  var forbidden = clipReportForbidden_(caller);
  if (forbidden) return forbidden;
  if (!Array.isArray(ids) || !ids.length || ids.length > CLIP_MARK_READ_MAX) return { error: 'invalid_ids', permanent: true };
  var want = {};
  ids.forEach(function (x) { want[String(x)] = true; });
  var me = String(caller.line_id || '').trim();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLIPS_SHEET);
  if (!sheet) return { error: 'not_ready' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: 'busy' };
  var changed = [];
  try {
    var t = clipsTable_(sheet);
    if (t.headers.indexOf('read_status') === -1) return { error: 'not_ready' };
    t.rows.forEach(function (x) {
      var r = x.rec;
      if (!want[String(r.id)] || String(r.line_id || '').trim() !== me || clipDeleted_(r)) return;
      if (String(r.read_status == null ? '' : r.read_status).trim() === 'read') return;
      clipsWriteRow_(sheet, t.headers, x, { read_status: 'read' });
      changed.push(String(r.id));
    });
  } finally {
    lock.releaseLock();
  }
  logTransaction_(CLIP_REPORT_LOG_SOURCE, '成功', 'clipMarkRead', '一鍵標已讀 ' + changed.length + ' 篇（送來 ' + ids.length + ' 篇）', '', '', me);
  return { success: true, changed: changed.length, ids: changed };
}

/** action=clipFocus：讀本人的「我的關注」 */
function clipFocusView_(caller) {
  var forbidden = clipReportForbidden_(caller);
  if (forbidden) return forbidden;
  return { success: true, focus: clipFocusGet_(caller.line_id), max: CLIP_FOCUS_MAX };
}

/** action=clipFocusSet：存本人的「我的關注」（空白＝清掉）。logs 只記動作與字數，不複製內容 */
function clipFocusSet_(caller, text) {
  var forbidden = clipReportForbidden_(caller);
  if (forbidden) return forbidden;
  if (typeof text !== 'string') return { error: 'invalid_value', permanent: true };
  var v = text.trim();
  if (v.length > CLIP_FOCUS_MAX) return { error: 'too_long', permanent: true, max: CLIP_FOCUS_MAX };
  var key = CLIP_FOCUS_PREFIX + String(caller.line_id).trim();
  try {
    var props = PropertiesService.getScriptProperties();
    if (v) props.setProperty(key, v); else props.deleteProperty(key);
  } catch (err) {
    return { error: 'save_failed' };
  }
  logTransaction_(CLIP_REPORT_LOG_SOURCE, '成功', 'clipFocusSet', v ? '更新「我的關注」（' + v.length + ' 字）' : '清空「我的關注」', '', '', caller.line_id);
  return { success: true, focus: v };
}

/** 「初始化」：建 clip_reports（clips 的 report_* 欄由 installClips_ 補） */
function installClipReports_() {
  var c = ensureClipReportsSheet_();
  return { level: 'ok', changed: c.created || c.added.length > 0,
    text: c.created ? '新建 ' + CLIP_REPORTS_SHEET : CLIP_REPORTS_SHEET + ' 已存在' + (c.added.length ? '（補上欄位：' + c.added.join('、') + '）' : '') };
}
