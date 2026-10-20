/* ========================================================================== */
/* 搜尋（ADR-021 D-5｜PR-F）                                                    */
/* ========================================================================== */

/*
 * action=search { q }：關鍵字在雲端比對。搜尋頁按了才跑，不進開機、不輪詢；不用 AI、不做向量。
 *  - 範圍：任務、提醒、雜記、圖書館（標題／全文／筆記；只存連結的另比網址）、記帳備註。郵件、股票不納入
 *  - 只搜自己的（line_id）；白板例外：釘在白板上的大家都搜得到。白板模組關掉時 moduleVisibleRows_ 已把 board 清掉，自然不算
 *  - 權限照 canUseSheet_（含模組總開關）；提醒關掉時 moduleVisibleRows_ 已濾掉；已刪除不出現
 *  - 多個關鍵字（空白分開）＝全部都要有；不分大小寫。每組新的在前、最多 SEARCH_MAX_PER_GROUP 筆，另回總數
 */
var SEARCH_Q_MAX = 50;
var SEARCH_MAX_PER_GROUP = 20;
/** 摘錄長度（字）：命中處往前留一點上下文 */
var SEARCH_SNIPPET = 40;

function search_(caller, q) {
  var raw = String(q == null ? '' : q).trim();
  if (!raw) return { error: 'empty_query', permanent: true };
  if (raw.length > SEARCH_Q_MAX) return { error: 'too_long', permanent: true, max: SEARCH_Q_MAX };
  var terms = raw.toLowerCase().split(/\s+/);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  modulesOff_(ss);                       // 總開關用這個 ss 讀好，canUse_ 不必再開一次試算表
  var me = String(caller.line_id || '').trim();
  var perf = {};
  var rowsOf = function (name) {
    if (!canUseSheet_(caller.user, name)) return null;
    var read = sheetRecords_(ss, name, perf);
    if (read.error) return [];
    return pwaVisibleRows_(name, withoutTombstones_(read.rows), caller.user).filter(function (r) {
      return String(r.line_id || '').trim() === me || truthy_(r.board);
    });
  };

  var groups = [];
  var tasks = rowsOf(TASKS_SHEET);
  if (tasks) {
    var task = function (r) { return { id: r.id, title: String(r.text || ''), match: String(r.text || ''), date: isReminder_(r) ? r.due_date : r.created_at, at: r.created_at }; };
    groups.push(searchGroup_('todo', '任務', tasks.filter(function (r) { return !isReminder_(r); }), terms, task));
    groups.push(searchGroup_('reminder', '提醒', tasks.filter(isReminder_), terms, task));
  }
  var notes = rowsOf('notes');
  if (notes) {
    groups.push(searchGroup_('notes', '雜記', notes, terms, function (r) {
      return { id: r.id, title: String(r.text || ''), match: String(r.text || ''), date: r.created_at, at: r.created_at };
    }));
  }
  var clips = rowsOf(CLIPS_SHEET);
  if (clips) {
    groups.push(searchGroup_('clips', '圖書館', clips, terms, function (r) {
      var title = String(r.caption || '').split('\n')[0].trim() || String(r.author || '') || clipDomain_(r.url);
      var body = [r.caption, r.note].map(function (x) { return String(x || ''); }).join('\n');
      return { id: r.id, title: title, match: body + '\n' + String(r.author || '') + '\n' + String(r.url || ''), snippetOf: body,
        date: r.collected_at, at: r.collected_at };
    }));
  }
  var expenses = rowsOf('expenses');
  if (expenses) {
    // 只比備註（D-5「記帳備註」）；標題給分類與金額，看得出是哪一筆
    groups.push(searchGroup_('expenses', '記帳', expenses, terms, function (r) {
      var cat = String(r.category || '') + (r.subcategory ? '＞' + r.subcategory : '');
      return { id: r.id, title: cat + ' ' + String(r.amount == null ? '' : r.amount), match: String(r.note || ''), date: r.expense_date, at: r.expense_date };
    }));
  }
  return { success: true, q: raw, groups: groups.filter(function (g) { return g.total > 0; }) };
}

/** 一組：比對 → 新的在前 → 取前幾筆。pick(r) → { id, title, match（拿來比的字）, snippetOf?, date, at（排序用） } */
function searchGroup_(key, label, rows, terms, pick) {
  var hits = rows.map(pick).filter(function (h) {
    var text = h.match.toLowerCase();
    return terms.every(function (t) { return text.indexOf(t) !== -1; });
  });
  hits.sort(function (a, b) { return searchMs_(b.at) - searchMs_(a.at); });
  return {
    key: key, label: label, total: hits.length,
    items: hits.slice(0, SEARCH_MAX_PER_GROUP).map(function (h) {
      return { id: String(h.id), title: h.title.trim(), snippet: searchSnippet_(h.snippetOf != null ? h.snippetOf : h.match, terms),
        date: searchDate_(h.date) };
    })
  };
}

/** 命中那一段（換行壓成空白）。第一個關鍵字不在這段字裡（例如只比到網址）就從頭取 */
function searchSnippet_(text, terms) {
  var flat = String(text || '').replace(/\s+/g, ' ').trim();
  var at = Math.max(flat.toLowerCase().indexOf(terms[0]), 0);
  var start = Math.max(at - 10, 0);
  var end = Math.min(start + SEARCH_SNIPPET, flat.length);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/** 台北日期 YYYY-MM-DD。Sheet 可能回 Date、ISO 字串或已經是日期字串 */
function searchDate_(v) {
  if (v instanceof Date) return taipeiDateKey_(v);
  var s = String(v == null ? '' : v).trim();
  if (s.indexOf('T') !== -1 && !isNaN(Date.parse(s))) return taipeiDateKey_(new Date(Date.parse(s)));
  return s.slice(0, 10);
}

function searchMs_(v) {
  var t = v instanceof Date ? v.getTime() : Date.parse(String(v == null ? '' : v));
  return isNaN(t) ? 0 : t;
}
