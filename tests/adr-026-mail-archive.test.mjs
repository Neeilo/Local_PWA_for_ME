/**
 * ADR-026 PR-1（後端）：Mail 整理 v2——規則封存 × 處理彙報 × 即時內文
 *
 * 為什麼有這批測試（失效的代價都落在 Neil 的真信箱上）：
 *   1. 預演（沒開正式封存）時**永遠不呼叫 moveToArchive**：開關是 Neil 親手打開的，程式不能先動
 *   2. 正式模式只封「整串都是同一條封存規則、而且是開啟之後處理」的信；任何不確定就留下並記原因（D-13）
 *   3. 封存只移出收件匣：不標已讀、不刪、不動星號（假 GmailApp 只放行白名單方法）
 *   4. 封存出錯 → failed，下一輪重掃；重掃不重寫整列、不重存 PDF
 *   5. legacy（ADR-026 之前寫的、去向空白）永遠不進封存
 *   6. 「初始化」只填空白、重跑結果相同；新規則預設留下＋不存 PDF（D-12）
 *   7. 彙報涵蓋 notify=FALSE、三組計數正確；推播成敗都進 logs（D-7b），不存訊息內容
 *   8. 即時內文：只限管理員＋feat_gmail、msg_id 必須在 gmail_log、超長截斷、不存副本；每次讀取寫 logs 但不含主旨與內文
 *   9. Widget 依 processed_at（台北日）計「今天整理了 N 封」，1.0 的欄位不變
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const RULE_HEADERS = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
                      'label', 'save_attachment', 'notify', 'parser', 'note', 'inbox_action', 'bucket'];
const LOG_HEADERS = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount', 'due_date',
                     'status', 'attachment_url', 'gmail_link', 'processed_at',
                     'bucket', 'requested_inbox_action', 'inbox_action_status', 'inbox_action_at', 'inbox_action_note'];

/** 2026-10-12 09:00 台北 */
const NOW = new Date(Date.UTC(2026, 9, 12, 1, 0, 0));
const daysAgo = (d, base = NOW) => new Date(base.getTime() - d * 86400000);

const rulesSheet = (rows) => new FakeSheet('gmail_rules', [RULE_HEADERS,
  ...rows.map((o) => RULE_HEADERS.map((h) => (o[h] === undefined ? '' : o[h])))]);
const logSheet = (rows = []) => new FakeSheet('gmail_log', [LOG_HEADERS,
  ...rows.map((o) => LOG_HEADERS.map((h) => (o[h] === undefined ? '' : o[h])))]);

const BILL = { rule_id: 10010, is_active: 'TRUE', source_name: '國泰世華', mail_type: 'bill', from: 'service@cathaybk.com.tw',
               save_attachment: 'TRUE', notify: 'TRUE', inbox_action: 'keep', bucket: 'pay' };
const STMT = { rule_id: 10030, is_active: 'TRUE', source_name: '存款對帳單', mail_type: 'etag', from: 'stmt@bank.com.tw',
               notify: 'FALSE', inbox_action: 'archive', bucket: 'fyi' };
const NEWS = { rule_id: 10050, is_active: 'TRUE', source_name: '天下', mail_type: 'newsletter', from: 'news@cw.com.tw',
               notify: 'FALSE', inbox_action: 'archive', bucket: 'news' };

const msg = (id, from, date, body = '', attachments = []) => ({ id, from, subject: '主旨' + id, date, body, attachments });
const thread = (id, messages, { inbox = true } = {}) => ({ id, messages, inbox, labels: new Set() });

/* ---------------------------------------------------------------------------
 * 假 GmailApp：只放行白名單；moveToArchive 另外記下來（要驗「有沒有封」）
 * ------------------------------------------------------------------------- */
const READ_OK = new Set(['GmailApp.search', 'GmailApp.getUserLabelByName', 'GmailApp.createLabel', 'GmailApp.getMessageById',
  'thread.getId', 'thread.getMessages', 'thread.getPermalink', 'thread.addLabel', 'thread.isInInbox', 'thread.moveToArchive',
  'message.getId', 'message.getFrom', 'message.getSubject', 'message.getDate', 'message.getAttachments', 'message.getPlainBody',
  'message.getThread', 'attachment.getName', 'attachment.copyBlob', 'blob.setName', 'label.getName']);

function guarded(kind, impl, touched) {
  return new Proxy({}, {
    get: (_o, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      touched.push(kind + '.' + prop);
      if (prop in impl) return impl[prop];
      return () => { throw new Error('不該呼叫 ' + kind + '.' + prop); };
    }
  });
}

function fakeGmail(threads, { archiveFails = 0, bodyOf = null } = {}) {
  const touched = [];
  const archived = [];
  let fails = archiveFails;
  const labels = {};
  const wrapMsg = (t, m) => guarded('message', {
    getId: () => m.id, getFrom: () => m.from, getSubject: () => m.subject, getDate: () => m.date,
    getPlainBody: () => (bodyOf ? bodyOf(m) : m.body),
    getAttachments: () => m.attachments.map((a) => guarded('attachment', {
      getName: () => a, copyBlob: () => { const b = { name: a }; return guarded('blob', { setName: (n) => { b.name = n; return b; } }, touched); }
    }, touched)),
    getThread: () => wrapThread(t)
  }, touched);
  const wrapThread = (t) => guarded('thread', {
    getId: () => t.id,
    getPermalink: () => 'https://mail.google.com/mail/u/0/#all/' + t.id,
    getMessages: () => t.messages.map((m) => wrapMsg(t, m)),
    addLabel: (l) => { t.labels.add(l.getName()); return t; },
    isInInbox: () => t.inbox,
    moveToArchive: () => {
      if (fails > 0) { fails--; throw new Error('Service invoked too many times'); }
      archived.push(t.id); t.inbox = false; return t;
    }
  }, touched);
  const GmailApp = guarded('GmailApp', {
    search: (q, _s, max) => threads.filter((t) => t.messages.some((m) => q.includes(m.from))).slice(0, max).map(wrapThread),
    getUserLabelByName: (n) => labels[n] || null,
    createLabel: (n) => { labels[n] = guarded('label', { getName: () => n }, touched); return labels[n]; },
    getMessageById: (id) => {
      for (const t of threads) { const m = t.messages.find((x) => x.id === id); if (m) return wrapMsg(t, m); }
      return null;
    }
  }, touched);
  return { GmailApp, touched, archived };
}

function fakeDrive() {
  const files = [];
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const folder = (path) => {
    const kids = {};
    return {
      getName: () => path.join('/'),
      getFoldersByName: (n) => iter(kids[n] ? [kids[n]] : []),
      createFolder: (n) => (kids[n] = folder(path.concat([n]))),
      getFilesByName: (n) => iter(files.filter((f) => f.path === path.join('/') + '/' + n).map((f) => f.api)),
      createFile: (b) => { const f = { path: path.join('/') + '/' + b.name }; f.api = { getUrl: () => 'https://drive/' + f.path }; files.push(f); return f.api; }
    };
  };
  const root = folder([]);
  return { DriveApp: { getRootFolder: () => root }, files };
}

const ME = 'Uneil', MOM = 'Umom';
const ADMIN = { line_id: ME, user: { line_id: ME, is_active: 'TRUE', is_admin: 'TRUE', feat_gmail: 'TRUE' } };
const MOM_CALLER = { line_id: MOM, user: { line_id: MOM, is_active: 'TRUE', is_admin: '', feat_gmail: 'TRUE' } };
const GROUP_H = ['group_id', 'name', 'is_active', 'left_at', 'notify_gmail'];
const groups = () => new FakeSheet('line_groups', [GROUP_H, ['C1fabc', 'Mail test', 'TRUE', '', 'TRUE']]);

function env({ rules = [BILL, STMT, NEWS], threads = [], log = logSheet(), live = '', archiveFails = 0, bodyOf, pushImpl, props = {} } = {}) {
  const gmail = fakeGmail(threads, { archiveFails, bodyOf });
  const drive = fakeDrive();
  const properties = Object.assign({}, props);
  if (live) properties.gmail_archive_live = live;
  const e = loadCodeGs({
    extraFiles: ['line-router.gs', 'sheet-guide.gs'], propsWritable: true, properties, pushImpl,
    sheets: { gmail_rules: rulesSheet(rules), gmail_log: log, line_groups: groups() },
    overrides: { GmailApp: gmail.GmailApp, DriveApp: drive.DriveApp }
  });
  return Object.assign(e, { gmail, drive, run: (at = NOW) => e.call('runGmailController_', at) });
}
const logRows = (e) => e.sheets.gmail_log.toRecords();
const byId = (e, id) => logRows(e).find((r) => r.msg_id === id);
const ctlLog = (e) => e.transactions.filter((x) => /^Gmail 控制員/.test(x[2])).pop();

/* ========================================================================== */
describe('預演（沒開正式封存）：只記不動', () => {

  test('永遠不呼叫 moveToArchive；封存規則寫 dry_run＋「本來會封存」，留下的寫 kept', () => {
    const e = env({ threads: [
      thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))]),
      thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))]),
      thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1))])
    ] });
    const r = e.run();
    assert.equal(r.processed, 3);
    assert.deepEqual(e.gmail.archived, []);
    assert.ok(!e.gmail.touched.includes('thread.moveToArchive'));
    assert.deepEqual([byId(e, 'b1'), byId(e, 's1'), byId(e, 'n1')].map((x) => [x.bucket, x.requested_inbox_action, x.inbox_action_status]),
      [['pay', 'keep', 'kept'], ['fyi', 'archive', 'dry_run'], ['news', 'archive', 'dry_run']]);
    assert.equal(byId(e, 's1').inbox_action_note, '本來會封存');
    assert.equal(byId(e, 'b1').status, '🏷️ 僅標籤', '原 status 仍是解析狀態');
  });

  test('第二輪：已是 dry_run 的列不重寫（只判定本輪新寫的）', () => {
    const e = env({ threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))])] });
    e.run();
    const at = byId(e, 's1').inbox_action_at;
    e.run(new Date(NOW.getTime() + 86400000));
    assert.equal(byId(e, 's1').inbox_action_at, at);
    assert.ok(!e.gmail.touched.includes('thread.moveToArchive'));
  });

  test('預演也照實判定：同串有 NeilOS 沒記錄的信 → skipped＋原因（預演清單才準）', () => {
    const e = env({ threads: [thread('ts', [msg('mine', 'neil@gmail.com', daysAgo(5)), msg('s1', 'stmt@bank.com.tw', daysAgo(1))])] });
    e.run();
    assert.equal(byId(e, 's1').inbox_action_status, 'skipped');
    assert.match(byId(e, 's1').inbox_action_note, /同串有 NeilOS 沒記錄的信/);
  });
});

/* ========================================================================== */
describe('正式封存：只封整串同一條封存規則、開啟之後的信', () => {
  const LIVE = daysAgo(2).toISOString();

  test('同串全同規則 → moveToArchive → archived；留下的規則照樣 kept', () => {
    const e = env({ live: LIVE, threads: [
      thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))]),
      thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1)), msg('s2', 'stmt@bank.com.tw', daysAgo(0))])
    ] });
    const r = e.run();
    assert.deepEqual(e.gmail.archived, ['ts'], '同一串只封一次');
    assert.equal(byId(e, 's1').inbox_action_status, 'archived');
    assert.equal(byId(e, 's2').inbox_action_status, 'archived');
    assert.equal(byId(e, 'b1').inbox_action_status, 'kept');
    assert.equal(r.sweep.archived, 2);
  });

  test('同串有未記錄的信、有別條規則的信 → 不封並記原因', () => {
    const e = env({ live: LIVE, threads: [
      thread('t1', [msg('s1', 'stmt@bank.com.tw', daysAgo(1)), msg('re', 'neil@gmail.com', daysAgo(1))]),
      thread('t2', [msg('n1', 'news@cw.com.tw', daysAgo(1)), msg('s2', 'stmt@bank.com.tw', daysAgo(1))])
    ] });
    e.run();
    assert.deepEqual(e.gmail.archived, []);
    assert.match(byId(e, 's1').inbox_action_note, /同串有 NeilOS 沒記錄的信/);
    assert.match(byId(e, 'n1').inbox_action_note, /同串有別條規則（10030）的信/);
    assert.equal(byId(e, 'n1').inbox_action_status, 'skipped');
  });

  test('寫入後規則改成留下：重掃時不封、記「已改成留下」（快照不依日後規則回算，但封之前要再確認）', () => {
    const e = env({ live: LIVE, archiveFails: 1, threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))])] });
    e.run();
    assert.equal(byId(e, 's1').inbox_action_status, 'failed');
    const row = e.sheets.gmail_rules.values.findIndex((r) => r[0] === 10030);
    e.sheets.gmail_rules.values[row][RULE_HEADERS.indexOf('inbox_action')] = 'keep';
    e.run(new Date(NOW.getTime() + 3600000));
    assert.equal(byId(e, 's1').inbox_action_status, 'skipped');
    assert.match(byId(e, 's1').inbox_action_note, /規則 10030 已改成留下/);
    assert.equal(byId(e, 's1').requested_inbox_action, 'archive', '快照不改');
    assert.deepEqual(e.gmail.archived, []);
  });

  test('開啟前處理的列（含 dry_run）不封：只影響開啟後的信', () => {
    const log = logSheet([{ msg_id: 's0', rule_id: 10030, processed_at: daysAgo(3).toISOString(), requested_inbox_action: 'archive',
      inbox_action_status: 'dry_run', inbox_action_note: '本來會封存' }]);
    const e = env({ live: LIVE, log, threads: [thread('ts', [msg('s0', 'stmt@bank.com.tw', daysAgo(3))])] });
    e.run();
    assert.deepEqual(e.gmail.archived, []);
    assert.equal(byId(e, 's0').inbox_action_status, 'dry_run');
    assert.ok(!e.gmail.touched.includes('GmailApp.getMessageById'), '連查都不查');
  });

  test('封存例外 → failed；下一輪重掃成功；不重寫列、不重存 PDF、不重推', () => {
    const rule = Object.assign({}, STMT, { save_attachment: 'TRUE', mail_type: 'bill', notify: 'TRUE' });
    const e = env({ live: LIVE, rules: [rule], archiveFails: 1,
      threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1), '', ['a.pdf'])])] });
    const r1 = e.run();
    assert.equal(byId(e, 's1').inbox_action_status, 'failed');
    assert.match(byId(e, 's1').inbox_action_note, /too many times/);
    assert.equal(r1.sweep.failed, 1);
    assert.match(ctlLog(e)[4], /s1 封存失敗（Service invoked too many times），下一輪再試/);
    assert.equal(e.drive.files.length, 1);
    const pushes = e.pushes.length;
    const r2 = e.run(new Date(NOW.getTime() + 3600000));
    assert.equal(r2.processed, 0);
    assert.equal(byId(e, 's1').inbox_action_status, 'archived');
    assert.equal(logRows(e).length, 1, '不重寫 log');
    assert.equal(e.drive.files.length, 1, '不重存 PDF');
    assert.equal(e.pushes.length, pushes, '本輪 0 封且沒有失敗：不推');
  });

  test('串已不在收件匣 → archived（對帳），不再呼叫 moveToArchive', () => {
    const e = env({ live: LIVE, threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))], { inbox: false })] });
    e.run();
    assert.equal(byId(e, 's1').inbox_action_status, 'archived');
    assert.match(byId(e, 's1').inbox_action_note, /已不在收件匣/);
    assert.ok(!e.gmail.touched.includes('thread.moveToArchive'));
  });

  test('只碰白名單：不標已讀、不刪、不丟垃圾桶、不動星號／重要性、不搬回收件匣', () => {
    const e = env({ live: LIVE, threads: [
      thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))]),
      thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1))]),
      thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))])
    ] });
    e.run();
    assert.deepEqual(e.gmail.touched.filter((m) => !READ_OK.has(m)), []);
    assert.ok(!e.gmail.touched.some((m) => /markRead|moveToTrash|star|Important|moveToInbox|removeLabel|delete/i.test(m)));
  });

  test('legacy 列（去向空白、沒有 requested_inbox_action）永遠不封，就算規則現在是封存', () => {
    const log = logSheet([{ msg_id: 'old', rule_id: 10030, processed_at: daysAgo(1).toISOString() }]);
    const e = env({ live: daysAgo(5).toISOString(), log, threads: [thread('ts', [msg('old', 'stmt@bank.com.tw', daysAgo(10))])] });
    e.run();
    assert.deepEqual(e.gmail.archived, []);
    assert.equal(byId(e, 'old').inbox_action_status, '');
  });

  test('超過 7 天的 failed 不再重掃', () => {
    const log = logSheet([{ msg_id: 's9', rule_id: 10030, processed_at: daysAgo(8).toISOString(), requested_inbox_action: 'archive', inbox_action_status: 'failed' }]);
    const e = env({ live: daysAgo(30).toISOString(), log, threads: [thread('ts', [msg('s9', 'stmt@bank.com.tw', daysAgo(8))])] });
    e.run();
    assert.deepEqual(e.gmail.archived, []);
  });

  test('gmail_log 還沒補欄（沒跑初始化）：不掃、不封，logs 講要初始化；新信照樣處理', () => {
    const old = new FakeSheet('gmail_log', [LOG_HEADERS.slice(0, 12)]);
    const e = env({ live: LIVE, log: old, threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))])] });
    const r = e.run();
    assert.equal(r.processed, 1);
    assert.deepEqual(e.gmail.archived, []);
    assert.match(ctlLog(e)[4], /還沒有收件匣去向欄，沒有掃/);
  });
});

/* ========================================================================== */
describe('處理結果彙報（D-5、D-7b）', () => {

  test('涵蓋 notify=FALSE、三組計數＋去向；notify=TRUE 才逐封列；預演附「本來會封存」', () => {
    const e = env({ threads: [
      thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))]),
      thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))]),
      thread('tn1', [msg('n1', 'news@cw.com.tw', daysAgo(1))]),
      thread('tn2', [msg('n2', 'news@cw.com.tw', daysAgo(0))])
    ] });
    e.run();
    assert.equal(e.pushes.length, 1);
    const t = e.pushes[0].text;
    assert.match(t, /^📬 Gmail 整理 10\/12（共 4 封）/);
    assert.match(t, /🧾 要付錢的 1 封｜留在收件匣\n・國泰世華｜金額待確認/);
    assert.match(t, /📄 知道就好 1 封｜預演：本來會封存 1/);
    assert.match(t, /📰 電子報 2 封｜預演：本來會封存 2/);
    assert.doesNotMatch(t, /・存款對帳單|・天下/, 'notify=FALSE 只計數');
    assert.match(t, /⚠️ 跳過 0｜失敗 0\n（預演中：本來會封存 3 封）$/);
    assert.doesNotMatch(t, /主旨|@/, '不寫主旨（非待確認）與寄件者');
  });

  test('正式模式：已封存的數字；沒有「預演中」那行', () => {
    const e = env({ live: daysAgo(2).toISOString(), threads: [thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1))])] });
    e.run();
    assert.match(e.pushes[0].text, /📰 電子報 1 封｜已封存 1/);
    assert.doesNotMatch(e.pushes[0].text, /預演中/);
  });

  test('推播成功也寫進 logs 那一行（群組 id 只留前 3 碼＋名稱），不存訊息內容', () => {
    const e = env({ threads: [thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))])] });
    e.run();
    const tx = ctlLog(e);
    assert.match(tx[4], /推播 ✅ 到 C1f…（Mail test）/);
    assert.doesNotMatch(tx[4], /C1fabc|📬 Gmail 整理/);
  });

  test('推播失敗：寫 ❌＋原因', () => {
    const e = env({ pushImpl: () => ({ ok: false, reason: 'HTTP 500' }), threads: [thread('tb', [msg('b1', 'service@cathaybk.com.tw', daysAgo(1))])] });
    e.run();
    assert.match(ctlLog(e)[4], /推播 ❌ 到 C1f…（Mail test）：HTTP 500/);
  });

  test('記下最後一次完成時間與計數（Widget／整理報告讀，不多讀 Sheet）', () => {
    const e = env({ threads: [thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))])] });
    e.run();
    const last = JSON.parse(e.properties.gmail_last_run);
    assert.equal(last.at, NOW.toISOString());
    assert.equal(last.processed, 1);
    assert.equal(last.dry_run, 1);
  });
});

/* ========================================================================== */
describe('規則：初始化只填空白、App 新增預設', () => {
  const USERS = () => new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin', 'feat_gmail'], [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE']]);

  test('依對照表填 bucket／inbox_action；已有值不動；既有 save_attachment 不變；重跑結果相同', () => {
    const blank = (id, type, extra = {}) => Object.assign({ rule_id: id, is_active: 'TRUE', source_name: 'r' + id, mail_type: type, from: 'x' + id + '@y.z', save_attachment: 'TRUE' }, extra);
    const rules = [blank(10010, 'bill'), blank(10042, 'bill'), blank(10001, 'etag'), blank(10020, 'etag'), blank(10035, 'etag'),
      blank(10052, 'newsletter'), blank(10099, 'newsletter'), blank(10016, 'bill', { inbox_action: 'archive', bucket: 'fyi' })];
    const e = loadCodeGs({ extraFiles: ['line-router.gs'], sheets: { gmail_rules: rulesSheet(rules) } });
    const r = e.call('installGmailRules_');
    assert.equal(r.changed, true);
    const got = e.sheets.gmail_rules.toRecords().map((x) => [x.rule_id, x.bucket, x.inbox_action, x.save_attachment]);
    assert.deepEqual(got, [
      [10010, 'pay', 'keep', 'TRUE'], [10042, 'pay', 'keep', 'TRUE'], [10001, 'fyi', 'archive', 'TRUE'], [10020, 'fyi', 'archive', 'TRUE'],
      [10035, 'fyi', 'archive', 'TRUE'], [10052, 'news', 'archive', 'TRUE'], [10099, 'news', 'keep', 'TRUE'],
      [10016, 'fyi', 'archive', 'TRUE']   // Neil 填過的不動
    ]);
    const once = JSON.stringify(e.sheets.gmail_rules.values);
    const again = e.call('installGmailRules_');
    assert.equal(JSON.stringify(e.sheets.gmail_rules.values), once);
    assert.equal(again.changed, false);
  });

  test('App 新增：沒送 inbox_action／bucket／save_attachment → keep、依信種、FALSE', () => {
    const e = env();
    e.sheets.line_users = USERS();
    const r = e.call('gmailRuleSet_', ADMIN, { source_name: '欣中天然氣', mail_type: 'bill', from: 'ebill@ms.scgas.com.tw', subject_kw: '繳費通知單' });
    assert.equal(r.success, true);
    assert.deepEqual([r.rule.inbox_action, r.rule.bucket, r.rule.save_attachment], ['keep', 'pay', 'FALSE']);
    const etc = e.call('gmailRuleSet_', ADMIN, { source_name: 'ETC 扣款', mail_type: 'etag', from: 'FETCService@fetc.net.tw', subject_kw: '扣款成功',
      bucket: 'fyi', inbox_action: 'archive', notify: false });
    assert.deepEqual([etc.rule.inbox_action, etc.rule.bucket, etc.rule.notify], ['archive', 'fyi', 'FALSE']);
  });

  test('擋不合法的 inbox_action／bucket；只改送來的欄', () => {
    const e = env();
    assert.equal(e.call('gmailRuleSet_', ADMIN, { rule_id: 10030, inbox_action: 'delete' }).error, 'invalid_inbox_action');
    assert.equal(e.call('gmailRuleSet_', ADMIN, { rule_id: 10030, bucket: 'spam' }).error, 'invalid_bucket');
    assert.equal(e.call('gmailRuleSet_', ADMIN, { rule_id: 10030, inbox_action: 'keep' }).success, true);
    const saved = e.sheets.gmail_rules.toRecords().find((x) => x.rule_id === 10030);
    assert.deepEqual([saved.inbox_action, saved.bucket, saved.from], ['keep', 'fyi', 'stmt@bank.com.tw']);
    assert.equal(e.call('gmailRuleSet_', MOM_CALLER, { rule_id: 10030, inbox_action: 'archive' }).error, 'forbidden');
  });

  test('控制員：inbox_action 空白或打錯 → 當留下＋警告', () => {
    const odd = Object.assign({}, STMT, { inbox_action: 'archvie' });
    const blank = Object.assign({}, NEWS, { inbox_action: '' });
    const e = env({ live: daysAgo(2).toISOString(), rules: [odd, blank], threads: [
      thread('ts', [msg('s1', 'stmt@bank.com.tw', daysAgo(1))]), thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1))])] });
    e.run();
    assert.deepEqual(e.gmail.archived, []);
    assert.equal(byId(e, 's1').inbox_action_status, 'kept');
    assert.match(ctlLog(e)[4], /規則 10030 的 inbox_action「archvie」不認得，當留下/);
    assert.match(ctlLog(e)[4], /規則 10050 沒填 inbox_action，當留下/);
  });
});

/* ========================================================================== */
describe('正式封存開關（gmailArchiveSet）', () => {

  test('打開存開啟時間、再開不改時間；關掉回到預演；每次寫 logs（設定）', () => {
    const e = env();
    const on = e.call('gmailArchiveSet_', ADMIN, true);
    assert.equal(on.success, true);
    assert.equal(on.live, true);
    assert.ok(e.properties.gmail_archive_live);
    const t = e.properties.gmail_archive_live;
    assert.equal(e.call('gmailArchiveSet_', ADMIN, true).live_since, t);
    const off = e.call('gmailArchiveSet_', ADMIN, false);
    assert.equal(off.live, false);
    assert.equal(e.properties.gmail_archive_live, undefined);
    assert.equal(e.transactions.filter((x) => x[0] === '設定' && x[2] === 'gmailArchiveSet').length, 3);
  });

  test('非管理員／沒有 feat_gmail：拒絕且不動屬性；非布林值拒絕', () => {
    const e = env();
    assert.equal(e.call('gmailArchiveSet_', MOM_CALLER, true).error, 'forbidden');
    assert.equal(e.call('gmailArchiveSet_', { line_id: ME, user: { is_admin: 'TRUE', feat_gmail: '' } }, true).error, 'forbidden');
    assert.equal(e.call('gmailArchiveSet_', ADMIN, 'yes').error, 'invalid_value');
    assert.equal(e.properties.gmail_archive_live, undefined);
  });

  test('預設關閉：沒有屬性＝預演', () => {
    const e = env();
    const v = e.call('gmailView_', ADMIN, 'archive');
    assert.deepEqual([v.success, v.live, v.live_since], [true, false, '']);
  });
});

/* ========================================================================== */
describe('整理報告（gmailView what=report）', () => {

  test('依 processed_at 最近 N 天、新的在前；舊列沒 bucket 依信種推；帶封存模式與最後完成時間', () => {
    const now = Date.now();
    const iso = (d) => new Date(now - d * 86400000).toISOString();
    const log = logSheet([
      { msg_id: 'a', mail_type: 'newsletter', processed_at: iso(1), source_name: '天下' },
      { msg_id: 'b', mail_type: 'bill', bucket: 'pay', processed_at: iso(0.1), inbox_action_status: 'kept' },
      { msg_id: 'c', mail_type: 'bill', processed_at: iso(40) }
    ]);
    const e = env({ log, live: '2026-11-01T00:00:00.000Z', props: { gmail_last_run: JSON.stringify({ at: '2026-11-06T01:00:00.000Z', processed: 2 }) } });
    const r = e.call('gmailView_', ADMIN, 'report', {});
    assert.equal(r.success, true);
    assert.equal(r.days, 30);
    assert.deepEqual(r.rows.map((x) => [x.msg_id, x.bucket]), [['b', 'pay'], ['a', 'news']]);
    assert.equal(r.live, true);
    assert.equal(r.last_run.at, '2026-11-06T01:00:00.000Z');
    assert.equal(e.call('gmailView_', ADMIN, 'report', { days: 999 }).days, 90, '最多 90 天');
    assert.equal(e.call('gmailView_', MOM_CALLER, 'report', {}).error, 'forbidden');
  });
});

/* ========================================================================== */
describe('即時內文（gmailBody，D-10）', () => {
  const LOGGED = () => logSheet([{ msg_id: 'n1', rule_id: 10050, mail_type: 'newsletter', bucket: 'news', source_name: '天下', subject: '本週精選', gmail_link: 'https://mail.google.com/x' }]);

  test('管理員讀得到純文字；每次讀取寫一筆 logs（來源、bucket），不含主旨與內文；不寫 Sheet', () => {
    const e = env({ log: LOGGED(), threads: [thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1), '機密內文 https://cw.com.tw/a')])] });
    const before = JSON.stringify(e.sheets.gmail_log.values);
    const r = e.call('gmailBody_', ADMIN, 'n1');
    assert.equal(r.success, true);
    assert.equal(r.text, '機密內文 https://cw.com.tw/a');
    assert.equal(r.truncated, false);
    e.call('gmailBody_', ADMIN, 'n1');
    const reads = e.transactions.filter((x) => x[0] === '郵件' && x[2] === 'gmailBody n1');
    assert.equal(reads.length, 2, '每次讀取都記');
    assert.equal(reads[0][1], '成功');
    assert.equal(reads[0][3], '天下｜news');
    assert.equal(reads[0][6], ME);
    assert.ok(!JSON.stringify(reads).includes('機密') && !JSON.stringify(reads).includes('本週精選'));
    assert.equal(JSON.stringify(e.sheets.gmail_log.values), before, '不存副本');
    assert.ok(!e.gmail.touched.some((m) => /getBody$|getRawContent/.test(m)), '只讀純文字，不讀 HTML');
  });

  test('非管理員 → forbidden；不在 gmail_log 的 id → 拒絕（不能讀任意信件）並記 logs', () => {
    const e = env({ log: LOGGED(), threads: [thread('tx', [msg('secret', 'boss@x.com', daysAgo(1), '私人信')])] });
    assert.equal(e.call('gmailBody_', MOM_CALLER, 'n1').error, 'forbidden');
    const r = e.call('gmailBody_', ADMIN, 'secret');
    assert.equal(r.error, 'not_in_log');
    assert.ok(!e.gmail.touched.includes('GmailApp.getMessageById'), '連 Gmail 都不問');
    assert.ok(e.transactions.some((x) => x[0] === '郵件' && x[1] === '失敗' && x[2] === 'gmailBody secret'));
  });

  test('超過 20,000 字截斷並回 truncated；信已刪除 → not_found', () => {
    const e = env({ log: LOGGED(), threads: [thread('tn', [msg('n1', 'news@cw.com.tw', daysAgo(1), 'x'.repeat(25000))])] });
    const r = e.call('gmailBody_', ADMIN, 'n1');
    assert.equal(r.text.length, 20000);
    assert.equal(r.truncated, true);
    const gone = env({ log: LOGGED(), threads: [] });
    assert.equal(gone.call('gmailBody_', ADMIN, 'n1').error, 'not_found');
  });

  test('經過 PWA 路由：gmailBody／gmailArchiveSet 要帶 token；動作在 Code.gs 有登記', () => {
    const TOK = 'tok-neil';
    const e = loadCodeGs({ extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK]: ME },
      sheets: { line_users: new FakeSheet('line_users', [['line_id', 'is_active', 'is_admin', 'feat_gmail'], [ME, 'TRUE', 'TRUE', 'TRUE']]),
                gmail_rules: rulesSheet([]), gmail_log: LOGGED() } });
    const post = (b) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK }, b)) } }).body);
    assert.equal(post({ action: 'gmailBody', msg_id: 'zzz', trigger: 'manual' }).error, 'not_in_log');
    assert.equal(post({ action: 'gmailView', what: 'archive', trigger: 'manual' }).live, false);
  });
});

/* ========================================================================== */
describe('首頁 Widget（D-9）', () => {

  test('依 processed_at（台北日）計今天整理了幾封，分三組＋去向；1.0 欄位照舊依 received_at', () => {
    const log = logSheet([
      { msg_id: 'a', mail_type: 'bill', bucket: 'pay', received_at: '2026-10-10T02:00:00.000Z', processed_at: '2026-10-12T01:00:00.000Z', inbox_action_status: 'kept', status: '⚠️ 待確認' },
      { msg_id: 'b', mail_type: 'newsletter', received_at: '2026-10-11T23:30:00.000Z', processed_at: '2026-10-11T23:30:00.000Z', inbox_action_status: 'dry_run' },
      { msg_id: 'c', mail_type: 'etag', bucket: 'fyi', received_at: '2026-10-12T00:00:00.000Z', processed_at: '2026-10-12T01:00:00.000Z', inbox_action_status: 'failed' },
      { msg_id: 'd', mail_type: 'bill', received_at: '2026-10-11T01:00:00.000Z', processed_at: '2026-10-11T01:00:00.000Z', inbox_action_status: 'kept' }
    ]);
    const e = env({ log });
    const m = e.call('mailSummary_', e.ss, '2026-10-12');
    assert.deepEqual(m.org, { total: 3, pay: 1, fyi: 1, news: 1, kept: 1, archived: 0, dry_run: 1, skipped: 0, failed: 1, check: 1 });
    assert.deepEqual([m.today, m.bill, m.newsletter, m.etag], [2, 0, 1, 1], '1.0 依 received_at，照舊');
  });

  test('mailWidget_：待確認／封存失敗進 ⚠️；帶封存模式與最後完成時間；不碰 Gmail', () => {
    const today = new Date().toISOString();
    const log = logSheet([{ msg_id: 'a', mail_type: 'etag', processed_at: today, inbox_action_status: 'failed', status: '⚠️ 待確認' }]);
    const e = env({ log, live: '2026-11-01T00:00:00.000Z', props: { gmail_last_run: JSON.stringify({ at: today }) } });
    const w = e.call('mailWidget_', e.ss);
    assert.equal(w.org.total, 1);
    assert.equal(w.live, true);
    assert.equal(w.last_at, today);
    assert.ok(w.warnings.some((x) => /1 封待確認/.test(x)));
    assert.ok(w.warnings.some((x) => /1 封封存失敗/.test(x)));
    assert.deepEqual(e.gmail.touched, []);
  });
});

/* ========================================================================== */
describe('登記', () => {
  test('_guide 說明 gmail_rules／gmail_log 的新欄', () => {
    const e = loadCodeGs({ extraFiles: ['sheet-guide.gs'] });
    const reg = e.read('guideRegistry_()');
    const text = JSON.stringify(reg.filter((x) => /^gmail_/.test(x.sheet)));
    for (const f of ['inbox_action', 'bucket', 'requested_inbox_action', 'inbox_action_status']) assert.ok(text.includes(f), f);
  });
});
