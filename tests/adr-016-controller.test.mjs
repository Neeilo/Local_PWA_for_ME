/**
 * ADR-016 PR-A：Gmail 控制員管線（T1～T4）
 *
 * runGmailController() 每天 9 點：依 gmail_rules 掃最近 3 天 → 只貼標籤 → 帳單 PDF 存 Drive → 寫 gmail_log。
 * 這裡守的是：
 *   1. 同一封信跑兩次只寫一列；一封信命中多條規則取 rule_id 最小、其餘寫 logs
 *   2. Gmail 端只准讀與貼標籤：封存、已讀、刪除、垃圾桶一律不碰（假 GmailApp 只放行白名單方法）
 *   3. 去重以 msg_id 為準，不以標籤為準：GmailApp 的標籤是整串的，同主旨的 eTag 會被歸成一串，
 *      靠標籤去重會讓之後進來的新信永遠被跳過
 *   4. 附件白名單：只有 save_attachment 的規則、只有 PDF、電子報一律不存；路徑與檔名照規格；同名不覆蓋
 *   5. 附件存失敗：這封不記、不貼標籤，下次再試（不能記了卻沒存到）
 *   6. 每次執行都寫 logs＋performance（含 0 封）；全程不打外部網址（不呼叫 Gemini）
 *   7. 「初始化」建兩張表、補三個欄、建 Drive 資料夾、裝排程；重跑不重建、不累積
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const RULE_HEADERS = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
                      'label', 'save_attachment', 'notify', 'parser', 'note'];
const LOG_HEADERS = ['msg_id', 'received_at', 'rule_id', 'mail_type', 'source_name', 'subject', 'amount', 'due_date',
                     'status', 'attachment_url', 'gmail_link', 'processed_at'];

/** 2026-10-12 09:00 台北 */
const NOW = new Date(Date.UTC(2026, 9, 12, 1, 0, 0));
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

const rulesSheet = (rows) => new FakeSheet('gmail_rules', [RULE_HEADERS,
  ...rows.map((o) => RULE_HEADERS.map((h) => (o[h] === undefined ? '' : o[h])))]);
const logSheet = (rows = []) => new FakeSheet('gmail_log', [LOG_HEADERS, ...rows]);

const BILL = { rule_id: 1, is_active: 'TRUE', source_name: '國泰世華', mail_type: 'bill', from: 'service@cathaybk.com.tw',
               subject_kw: '電子帳單', label: '帳單/國泰', save_attachment: 'TRUE', notify: 'TRUE' };
const ETAG = { rule_id: 2, is_active: 'TRUE', source_name: 'eTag', mail_type: 'etag', from: 'etc@fetc.net.tw',
               label: 'eTag', save_attachment: 'TRUE', notify: 'TRUE' };
const NEWS = { rule_id: 3, is_active: 'TRUE', source_name: '天下', mail_type: 'newsletter', from: 'news@cw.com.tw',
               label: '電子報', save_attachment: 'TRUE' };

const att = (name) => ({ name });
const msg = (id, from, subject, date, attachments = [], body = '') => ({ id, from, subject, date, attachments, body });

/* ---------------------------------------------------------------------------
 * 假 GmailApp／DriveApp：只放行白名單方法，其他方法一被碰到就記成越權
 * ------------------------------------------------------------------------- */
const GMAIL_OK = new Set(['GmailApp.search', 'GmailApp.getUserLabelByName', 'GmailApp.createLabel',
  'thread.getId', 'thread.getMessages', 'thread.getPermalink', 'thread.addLabel',
  'message.getId', 'message.getFrom', 'message.getSubject', 'message.getDate', 'message.getAttachments',
  'message.getPlainBody',
  'attachment.getName', 'attachment.copyBlob', 'blob.setName', 'label.getName']);

function guarded(kind, impl, touched) {
  return new Proxy({}, {
    get: (_o, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      touched.push(kind + '.' + prop);
      if (prop in impl) return impl[prop];
      return () => { throw new Error('控制員不該呼叫 ' + kind + '.' + prop); };
    }
  });
}

function fakeGmail(threads, { searchImpl = null } = {}) {
  const touched = [];
  const queries = [];
  const labels = {};          // name → label
  const created = [];
  const labelOf = (name) => guarded('label', { getName: () => name }, touched);
  const wrapThread = (t) => guarded('thread', {
    getId: () => t.id,
    getPermalink: () => 'https://mail.google.com/mail/u/0/#all/' + t.id,
    getMessages: () => t.messages.map((m) => guarded('message', {
      getId: () => m.id, getFrom: () => m.from, getSubject: () => m.subject, getDate: () => m.date,
      getPlainBody: () => m.body,
      getAttachments: () => m.attachments.map((a) => guarded('attachment', {
        getName: () => a.name,
        copyBlob: () => { const b = { name: a.name }; return guarded('blob', { setName: (n) => { b.name = n; return b; } }, touched); }
      }, touched))
    }, touched)),
    addLabel: (l) => { t.labels.add(l.getName()); return t; }
  }, touched);
  const GmailApp = guarded('GmailApp', {
    search: (q, start, max) => {
      queries.push(q);
      const found = searchImpl ? searchImpl(q) : threads.filter((t) => t.messages.some((m) => q.includes(m.from)));
      return found.slice(0, max).map(wrapThread);
    },
    getUserLabelByName: (n) => labels[n] || null,
    createLabel: (n) => { created.push(n); labels[n] = labelOf(n); return labels[n]; }
  }, touched);
  return { GmailApp, touched, queries, createdLabels: created };
}

/** Drive：資料夾是樹，檔案存 { name, folderPath }；同名檔案由 getFilesByName 查得到 */
function fakeDrive({ failCreateFile = false } = {}) {
  const files = [];
  const folders = [];
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  const makeFolder = (path) => {
    const node = { path, children: {} };
    node.api = {
      getName: () => path[path.length - 1] || '我的雲端硬碟',
      getFoldersByName: (n) => iter(node.children[n] ? [node.children[n].api] : []),
      createFolder: (n) => { const c = makeFolder(path.concat([n])); node.children[n] = c; folders.push(c.path.join('/')); return c.api; },
      getFilesByName: (n) => iter(files.filter((f) => f.folder === path.join('/') && f.name === n).map((f) => f.api)),
      createFile: (blob) => {
        if (failCreateFile) throw new Error('Drive 空間已滿');
        const f = { name: blob.name, folder: path.join('/') };
        f.api = { getUrl: () => 'https://drive/' + f.folder + '/' + f.name, getName: () => f.name };
        files.push(f);
        return f.api;
      }
    };
    return node;
  };
  const root = makeFolder([]);
  return { DriveApp: { getRootFolder: () => root.api }, files, folders };
}

function env({ rules = [BILL, ETAG, NEWS], threads = [], log = logSheet(), sheets = null, drive = fakeDrive(), searchImpl, extra = {}, extraFiles = ['line-router.gs'] } = {}) {
  const gmail = fakeGmail(threads, { searchImpl });
  const all = sheets || { gmail_rules: rulesSheet(rules), gmail_log: log };
  const e = loadCodeGs({ sheets: all, extraFiles, overrides: Object.assign({ GmailApp: gmail.GmailApp, DriveApp: drive.DriveApp }, extra) });
  return Object.assign(e, { gmail, drive, run: () => e.call('runGmailController_', NOW) });
}

const thread = (id, messages) => ({ id, labels: new Set(), messages });
const logRows = (e) => e.sheets.gmail_log.toRecords();

/* ========================================================================== */
describe('T2 掃信：只貼標籤、去重、多規則', () => {

  test('命中的信寫一列、貼規則標籤＋NeilOS/已處理；查詢是最近 3 天', () => {
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '國泰世華信用卡電子帳單', daysAgo(1))]);
    const e = env({ threads: [t] });
    const r = e.run();
    assert.equal(r.processed, 1);
    assert.ok(e.gmail.queries.includes('from:(service@cathaybk.com.tw) subject:(電子帳單) newer_than:3d'));
    const rows = logRows(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].msg_id, 'm1');
    assert.equal(rows[0].rule_id, 1);
    assert.equal(rows[0].mail_type, 'bill');
    assert.equal(rows[0].source_name, '國泰世華');
    assert.equal(rows[0].status, '🏷️ 僅標籤');
    assert.equal(rows[0].gmail_link, 'https://mail.google.com/mail/u/0/#all/t1');
    assert.equal(rows[0].amount, '');
    assert.deepEqual([...t.labels].sort(), ['NeilOS/已處理', '帳單/國泰']);
  });

  test('同一封信跑兩次只寫一列', () => {
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))]);
    const e = env({ threads: [t] });
    e.run();
    const second = e.run();
    assert.equal(second.processed, 0);
    assert.equal(logRows(e).length, 1);
  });

  test('同一串裡已處理過的舊信跳過、新進來的信照樣處理（去重看 msg_id，不看標籤）', () => {
    const t = thread('t-etag', [msg('e1', 'etc@fetc.net.tw', 'eTag 通行費扣款通知', daysAgo(2))]);
    const e = env({ threads: [t] });
    e.run();
    assert.ok(t.labels.has('NeilOS/已處理'));
    t.messages.push(msg('e2', 'etc@fetc.net.tw', 'eTag 通行費扣款通知', daysAgo(0)));
    const r = e.run();
    assert.equal(r.processed, 1);
    assert.deepEqual(logRows(e).map((x) => x.msg_id), ['e1', 'e2']);
    assert.ok(!e.gmail.queries.some((q) => q.includes('label:')), '查詢不排除已處理標籤');
  });

  test('同一串裡超過 3 天的舊信、不是這個寄件者的信（例如自己的回覆）不處理', () => {
    const t = thread('t1', [
      msg('old', 'service@cathaybk.com.tw', '帳單', daysAgo(5)),
      msg('mine', 'Neil <neil@gmail.com>', 'Re: 帳單', daysAgo(1)),
      msg('new', '國泰世華 <service@cathaybk.com.tw>', '帳單', daysAgo(1))
    ]);
    const e = env({ threads: [t] });
    e.run();
    assert.deepEqual(logRows(e).map((x) => x.msg_id), ['new']);
  });

  test('一封信命中兩條規則：取 rule_id 最小，另一條寫 logs ⚠️', () => {
    const dup = { rule_id: 9, is_active: 'TRUE', source_name: '國泰重複', mail_type: 'bill', from: 'cathaybk.com.tw' };
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))]);
    const e = env({ rules: [dup, BILL], threads: [t], searchImpl: () => [t] });
    e.run();
    const rows = logRows(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rule_id, 1);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /m1 同時命中規則 1、9，取 1/);
  });

  test('停用的、有問題的規則不查；有問題的寫進 logs', () => {
    const bad = { rule_id: 5, is_active: 'TRUE', source_name: '壞的', mail_type: '帳單', from: 'x@y.com' };
    const off = Object.assign({}, NEWS, { is_active: 'FALSE' });
    const e = env({ rules: [BILL, bad, off] });
    e.run();
    assert.equal(e.gmail.queries.length, 1);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /規則 5 略過：信種「帳單」不認得/);
  });

  test('parser 不認得：當留白、照樣處理，logs ⚠️', () => {
    const r = Object.assign({}, BILL, { parser: 'cathay_v1' });
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))]);
    const e = env({ rules: [r], threads: [t] });
    e.run();
    assert.equal(logRows(e)[0].status, '🏷️ 僅標籤');
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /規則 1 的 parser「cathay_v1」不認得，當留白/);
  });

  test('只碰白名單方法：不封存、不標已讀、不刪除、不丟垃圾桶；也不打外部網址', () => {
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [att('帳單.pdf'), att('logo.png')])]);
    const t2 = thread('t2', [msg('n1', 'news@cw.com.tw', '電子報', daysAgo(1), [att('a.pdf')])]);
    const e = env({ threads: [t, t2] });
    e.run();
    const forbidden = e.gmail.touched.filter((m) => !GMAIL_OK.has(m));
    assert.deepEqual(forbidden, []);
    // 假 runtime 的 UrlFetchApp 一被呼叫就丟例外；兩封都有處理到＝沒有打外部
    assert.equal(logRows(e).length, 2);
  });

  test('msg_id 存成文字：全是數字的 id 不會被 Sheet 轉成數字', () => {
    const t = thread('t1', [msg('1234567890123456789', 'service@cathaybk.com.tw', '帳單', daysAgo(1))]);
    const log = logSheet();
    log.autoNumber = true;
    const e = env({ threads: [t], log });
    e.run();
    assert.equal(e.sheets.gmail_log.values[1][0], '1234567890123456789');
    assert.equal(e.run().processed, 0, '讀回來比得到，第二次不會重複處理');
  });

  test('一條規則查詢失敗不中斷其他規則', () => {
    const t = thread('t1', [msg('e1', 'etc@fetc.net.tw', 'eTag', daysAgo(1))]);
    const e = env({ threads: [t], searchImpl: (q) => { if (q.includes('cathaybk')) throw new Error('Invalid query'); return q.includes('fetc') ? [t] : []; } });
    const r = e.run();
    assert.equal(r.processed, 1);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /規則 1 查詢失敗（Invalid query）/);
  });
});

/* ========================================================================== */
describe('T3 附件存 Drive', () => {

  test('帳單 PDF 存到 Neil OS/Gmail 附件/{信種}/{YYYY-MM}/，檔名 {收信日}_{來源}_{原檔名}；連結寫進 gmail_log', () => {
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', new Date(Date.UTC(2026, 9, 10, 17, 0)), [att('202610.pdf'), att('logo.png')])]);
    const e = env({ threads: [t] });
    e.run();
    // 10/10 17:00 UTC＝台北 10/11 凌晨：收信日用台北時間
    assert.deepEqual(e.drive.files.map((f) => f.folder + '/' + f.name),
      ['Neil OS/Gmail 附件/bill/2026-10/2026-10-11_國泰世華_202610.pdf']);
    assert.equal(logRows(e)[0].attachment_url, 'https://drive/Neil OS/Gmail 附件/bill/2026-10/2026-10-11_國泰世華_202610.pdf');
  });

  test('save_attachment=FALSE、非 PDF、電子報：都不存', () => {
    const noSave = Object.assign({}, ETAG, { save_attachment: 'FALSE' });
    const e = env({ rules: [noSave, NEWS, BILL], threads: [
      thread('t1', [msg('e1', 'etc@fetc.net.tw', 'eTag', daysAgo(1), [att('明細.pdf')])]),
      thread('t2', [msg('n1', 'news@cw.com.tw', '電子報', daysAgo(1), [att('特刊.pdf')])]),
      thread('t3', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [att('帳單.PDF.zip'), att('說明.docx')])])
    ] });
    e.run();
    assert.deepEqual(e.drive.files, []);
    assert.equal(logRows(e).length, 3);
    assert.ok(logRows(e).every((r) => r.attachment_url === ''));
  });

  test('副檔名大小寫不拘；同一封兩個 PDF 都存，連結換行分隔', () => {
    const e = env({ threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [att('A.PDF'), att('b.pdf')])])] });
    e.run();
    assert.equal(e.drive.files.length, 2);
    assert.equal(logRows(e)[0].attachment_url.split('\n').length, 2);
  });

  test('同名不覆蓋：已經有同名檔就沿用那一個', () => {
    const drive = fakeDrive();
    const day = '2026-10-11';
    const t = (id) => thread('t-' + id, [msg(id, 'service@cathaybk.com.tw', '帳單', new Date(Date.UTC(2026, 9, 11, 2)), [att('x.pdf')])]);
    const e = env({ threads: [t('m1'), t('m2')], drive });
    e.run();
    assert.equal(drive.files.length, 1, '第二封同名的沒有再建一個');
    assert.equal(drive.files[0].name, day + '_國泰世華_x.pdf');
    assert.equal(logRows(e).length, 2);
  });

  test('資料夾不重複建：跑兩天只有一組 Neil OS/Gmail 附件', () => {
    const drive = fakeDrive();
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [att('x.pdf')])]);
    const e = env({ threads: [t], drive });
    e.run();
    t.messages.push(msg('m2', 'service@cathaybk.com.tw', '帳單', daysAgo(0), [att('y.pdf')]));
    e.run();
    assert.equal(drive.folders.filter((p) => p === 'Neil OS').length, 1);
    assert.equal(drive.folders.filter((p) => p === 'Neil OS/Gmail 附件').length, 1);
  });

  test('存檔失敗：這封不記、不貼標籤，下次再試；logs 寫出原因', () => {
    const t = thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [att('x.pdf')])]);
    const e = env({ threads: [t], drive: fakeDrive({ failCreateFile: true }) });
    const r = e.run();
    assert.equal(r.processed, 0);
    assert.equal(logRows(e).length, 0);
    assert.equal(t.labels.size, 0);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /m1 附件存不進 Drive（Drive 空間已滿），下次再試/);
  });
});

/* ========================================================================== */
describe('每次執行都留紀錄', () => {

  test('寫 logs 與 performance（含 0 封）', () => {
    const e = env({ sheets: { gmail_rules: rulesSheet([BILL]), gmail_log: logSheet(),
      performance: new FakeSheet('performance', [['id', 'ts', 'action', 'trigger', 'server_ms', 'rows']]) } });
    e.run();
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[3], /處理 0 封/);
    e.call('flushPerfQueue');   // ADR-019 B-2：排隊的紀錄落地後才在表上
    const perf = e.sheets.performance.toRecords();
    assert.equal(perf.length, 1);
    assert.equal(perf[0].action, 'gmailController');
    assert.equal(perf[0].trigger, 'schedule');
  });

  test('沒有啟用中的規則：不碰 Gmail，logs 寫略過', () => {
    const e = env({ rules: [] });
    e.run();
    assert.equal(e.gmail.queries.length, 0);
    assert.ok(e.transactions.some((x) => /^Gmail 控制員/.test(x[2]) && /沒有啟用中的規則/.test(x[3])));
  });

  test('沒有 gmail_log 分頁：不碰 Gmail，提示先跑初始化', () => {
    const e = env({ sheets: { gmail_rules: rulesSheet([BILL]) } });
    const r = e.run();
    assert.equal(r.reason, 'no_log_sheet');
    assert.equal(e.gmail.queries.length, 0);
    assert.ok(e.transactions.some((x) => /^Gmail 控制員/.test(x[2]) && /初始化/.test(x[4])));
  });
});

/* ========================================================================== */
describe('T1／T4「初始化」', () => {

  const usersSheet = () => new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks'],
    ['Uneil', 'Neil', 'TRUE', 'TRUE', 'TRUE'],
    ['Umom', '媽', 'TRUE', '', 'TRUE']
  ]);
  // line-router.gs 有 line_groups 與「初始化」；sheet-guide.gs 有排程時段對照用到的常數
  const INIT_FILES = ['line-router.gs', 'sheet-guide.gs'];
  const groupsSheet = () => new FakeSheet('line_groups', [['group_id', 'name', 'is_active', 'cmd_expense', 'notify_due']]);

  test('空試算表：建兩張表（表頭正確）、補三個欄、建 Drive 資料夾、裝排程', () => {
    const e = env({ sheets: { line_users: usersSheet(), line_groups: groupsSheet() }, extraFiles: INIT_FILES });
    const r = e.call('installGmail_');
    assert.equal(r.level, 'ok', r.text);
    assert.deepEqual(e.sheets.gmail_rules.values[0], RULE_HEADERS);
    assert.deepEqual(e.sheets.gmail_log.values[0], LOG_HEADERS);
    assert.deepEqual(e.sheets.line_users.values[0].slice(-1), ['feat_gmail']);
    assert.deepEqual(e.sheets.line_users.toRecords().map((u) => u.feat_gmail), ['TRUE', ''], '只替管理員打勾');
    assert.deepEqual(e.sheets.line_groups.values[0].slice(-2), ['cmd_gmail', 'notify_gmail']);
    assert.deepEqual(e.drive.folders, ['Neil OS', 'Neil OS/Gmail 附件']);
    assert.deepEqual(e.triggers.map((t) => [t.handler, t.hour, t.days]), [['runGmailController', 9, 1]]);
    assert.match(r.text, /新建 gmail_rules/);
    assert.match(r.text, /新建 gmail_log/);
    assert.match(r.text, /line_users 補上：feat_gmail（預設只開管理者 1 人）/);
    assert.match(r.text, /line_groups 補上：cmd_gmail、notify_gmail/);
    assert.match(r.text, /Drive 資料夾 Neil OS\/Gmail 附件：新建/);
    assert.match(r.text, /Gmail 授權 ✅/);
  });

  test('重跑三次：不重建、不動資料、資料夾只有一組、排程只有一個', () => {
    const e = env({ sheets: { line_users: usersSheet(), line_groups: groupsSheet() }, extraFiles: INIT_FILES });
    e.call('installGmail_');
    e.sheets.gmail_rules.values.push(RULE_HEADERS.map((h) => (BILL[h] === undefined ? '' : BILL[h])));
    e.sheets.line_users.values[2][5] = 'TRUE';     // 管理者後來替媽媽打勾，不能被蓋回去
    const before = JSON.stringify([e.sheets.gmail_rules.values, e.sheets.line_users.values]);
    e.call('installGmail_');
    const r = e.call('installGmail_');
    assert.equal(JSON.stringify([e.sheets.gmail_rules.values, e.sheets.line_users.values]), before);
    assert.deepEqual(e.drive.folders, ['Neil OS', 'Neil OS/Gmail 附件']);
    assert.equal(e.triggers.filter((t) => t.handler === 'runGmailController').length, 1);
    assert.match(r.text, /gmail_rules 已存在（1 列規則）/);
    assert.match(r.text, /gmail_log 已存在/);
    assert.match(r.text, /Drive 資料夾 Neil OS\/Gmail 附件：已存在/);
  });

  test('到期提醒等其他排程不受影響', () => {
    const e = env({ sheets: { line_users: usersSheet(), line_groups: groupsSheet() }, extraFiles: INIT_FILES });
    e.call('installAdr009Triggers');
    e.call('installGmail_');
    e.call('installGmail_');
    assert.deepEqual(e.triggers.map((t) => t.handler).sort(), ['checkDueReminders', 'runGmailController']);
  });

  test('Drive／Gmail 還沒授權：照樣建表與排程，標 ⚠️ 並說去編輯器跑 authorizeGmailController', () => {
    const e = env({ sheets: { line_users: usersSheet(), line_groups: groupsSheet() }, extraFiles: INIT_FILES, extra: {
      DriveApp: { getRootFolder: () => { throw new Error('You do not have permission to call DriveApp.getRootFolder'); } },
      GmailApp: { getUserLabelByName: () => { throw new Error('You do not have permission to call GmailApp'); } }
    } });
    const r = e.call('installGmail_');
    assert.equal(r.level, 'warn');
    assert.ok(e.sheets.gmail_log);
    assert.equal(e.triggers.length, 1);
    assert.match(r.text, /⚠️ Drive 還沒授權/);
    assert.match(r.text, /⚠️ Gmail 還沒授權/);
    assert.match(r.text, /authorizeGmailController/);
  });

  test('收進「初始化」，排程清單講得出時段', () => {
    const e = loadCodeGs({ extraFiles: INIT_FILES });
    const labels = e.read('initSteps_().map(function (s) { return s.label; })');
    assert.ok(labels.includes('Gmail 控制員（ADR-016）'), labels.join('｜'));
    assert.equal(e.read('scheduleHours_()').runGmailController, '每天約 9 點');
  });

  test('authorizeGmailController 要求全部權限（選擇性授權：任何一個沒勾就重新跳出授權畫面）', () => {
    const e = env();
    e.call('authorizeGmailController');
    assert.deepEqual(e.scopeChecks, [{ mode: 'FULL', scopes: 'all' }]);
    assert.deepEqual(e.drive.folders, [], '只讀：不建任何資料夾');
  });

  test('移除排程有獨立入口，不動其他排程', () => {
    const e = env({ sheets: { line_users: usersSheet(), line_groups: groupsSheet() }, extraFiles: INIT_FILES });
    e.call('installAdr009Triggers');
    e.call('installGmail_');
    e.call('uninstallGmailController');
    assert.deepEqual(e.triggers.map((t) => t.handler), ['checkDueReminders']);
  });
});

/* ========================================================================== */
describe('權限與登記', () => {

  test('gmail_log：PWA 讀寫都碰不到（PR-B 做列表時再開給管理者）', () => {
    const e = env();
    assert.ok(e.read('NO_PWA_READ').includes('gmail_log'));
    assert.ok(e.read('NO_PWA_WRITE').includes('gmail_log'));
  });

  test('_guide 登記 gmail_log，舊 ETC_Data 登記為歷史', () => {
    const e = loadCodeGs({ extraFiles: ['sheet-guide.gs'] });
    const reg = e.read('guideRegistry_()');
    assert.ok(reg.some((x) => x.sheet === 'gmail_log'));
    assert.match(reg.find((x) => x.sheet === 'ETC_Data').purpose, /歷史（凍結）/);
  });
});

/* ==========================================================================
 * PR-B1：解析器骨架（T5）、群組彙總推播（T6）、給 App 的管理員 API
 * ========================================================================== */

/** 測試用的解析器：內文寫「金額 1,234 截止 2026-10-25」就抓得到；其他一律 null */
const FAKE_PARSERS = {
  demo_v1: (text) => {
    const m = /金額\s*([\d,]+)\s*截止\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    return m ? { amount: Number(m[1].replace(/,/g, '')), due_date: m[2] } : null;
  },
  half_v1: () => ({ amount: 500, due_date: '' }),
  boom_v1: () => { throw new Error('格式變了'); }
};

const ME = 'Uneil', MOM = 'Umom';
const ADMIN = { line_id: ME, user: { line_id: ME, is_active: 'TRUE', is_admin: 'TRUE', feat_gmail: 'TRUE' } };

const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
                 'created_at', 'updated_at', 'notify_due', 'cmd_gmail', 'notify_gmail'];
const groupRow = (o) => GROUP_H.map((h) => (o[h] === undefined ? '' : o[h]));
const GROUPS = () => new FakeSheet('line_groups', [GROUP_H,
  groupRow({ group_id: 'Cgmail', name: 'Gmail 控制員', is_active: 'TRUE', notify_gmail: 'TRUE' }),
  groupRow({ group_id: 'Cfamily', name: '家人', is_active: 'TRUE', notify_due: 'TRUE' }),
  groupRow({ group_id: 'Coff', name: '停用', is_active: '', notify_gmail: 'TRUE' }),
  groupRow({ group_id: 'Cleft', name: '已離開', is_active: 'TRUE', notify_gmail: 'TRUE', left_at: '2026-10-01' })
]);

function envB({ rules = [BILL, ETAG, NEWS], threads = [], groups = GROUPS(), pushImpl, parsers = FAKE_PARSERS, extraSheets = {} } = {}) {
  const gmail = fakeGmail(threads);
  const drive = fakeDrive();
  const e = loadCodeGs({
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    pushImpl,
    sheets: Object.assign({ gmail_rules: rulesSheet(rules), gmail_log: logSheet(), line_groups: groups }, extraSheets),
    overrides: { GmailApp: gmail.GmailApp, DriveApp: drive.DriveApp, GMAIL_PARSERS: parsers }
  });
  return Object.assign(e, { gmail, drive, run: () => e.call('runGmailController_', NOW) });
}

describe('T5 解析器骨架', () => {

  test('規則有解析器、抓得到：✅ 已解析，金額與截止日寫進 gmail_log', () => {
    const r = Object.assign({}, BILL, { parser: 'demo_v1' });
    const e = envB({ rules: [r], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [], '本期應繳金額 1,234 截止 2026-10-25')])] });
    e.run();
    const row = logRows(e)[0];
    assert.equal(row.status, '✅ 已解析');
    assert.equal(row.amount, 1234);
    assert.equal(row.due_date, '2026-10-25');
  });

  test('抓不到、只抓到一半、解析器丟例外：⚠️ 待確認，金額與截止日都留白（絕不猜值）', () => {
    const rules = [Object.assign({}, BILL, { parser: 'demo_v1' }), Object.assign({}, ETAG, { parser: 'half_v1' }),
                   Object.assign({}, NEWS, { mail_type: 'bill', parser: 'boom_v1' })];
    const e = envB({ rules, threads: [
      thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [], '版面改了，找不到金額')]),
      thread('t2', [msg('m2', 'etc@fetc.net.tw', 'eTag', daysAgo(1), [], 'x')]),
      thread('t3', [msg('m3', 'news@cw.com.tw', '帳單', daysAgo(1), [], 'y')])
    ] });
    e.run();
    const rows = logRows(e);
    assert.deepEqual(rows.map((r) => r.status), ['⚠️ 待確認', '⚠️ 待確認', '⚠️ 待確認']);
    assert.ok(rows.every((r) => r.amount === '' && r.due_date === ''));
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /m3 解析器 boom_v1 失敗（格式變了）/);
  });

  test('沒有解析器的規則不讀內文', () => {
    const e = envB({ threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1), [], '機密內文')])] });
    e.run();
    assert.ok(!e.gmail.touched.includes('message.getPlainBody'));
    assert.equal(logRows(e)[0].status, '🏷️ 僅標籤');
  });

  test('解析器只收合法值：金額要是正數、截止日要是 YYYY-MM-DD', () => {
    const e = envB({ rules: [Object.assign({}, BILL, { parser: 'bad_v1' })], parsers: { bad_v1: () => ({ amount: 'NT$1,234', due_date: '10/25' }) },
      threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])] });
    e.run();
    assert.equal(logRows(e)[0].status, '⚠️ 待確認');
  });
});

describe('T6 群組彙總推播', () => {

  const BILL_P = Object.assign({}, BILL, { parser: 'demo_v1' });
  const ETAG_P = Object.assign({}, ETAG, { parser: 'demo_v1' });
  const NEWS2 = { rule_id: 4, is_active: 'TRUE', source_name: '商周', mail_type: 'newsletter', from: 'news@bw.com.tw', notify: 'TRUE' };
  const NEWS_N = Object.assign({}, NEWS, { notify: 'TRUE' });
  const allThreads = () => [
    thread('t1', [msg('m1', 'service@cathaybk.com.tw', '國泰帳單', daysAgo(1), [att('b.pdf')], '金額 12,345 截止 2026-10-25')]),
    thread('t2', [msg('e1', 'etc@fetc.net.tw', 'eTag', daysAgo(1), [], '金額 120 截止 2026-10-20'),
                  msg('e2', 'etc@fetc.net.tw', 'eTag', daysAgo(0), [], '金額 80 截止 2026-10-21')]),
    thread('t3', [msg('n1', 'news@cw.com.tw', '天下', daysAgo(1))]),
    thread('t4', [msg('n2', 'news@bw.com.tw', '商周', daysAgo(1))])
  ];

  test('一則彙總只推給「啟用＋notify_gmail＋沒離開」的群組；不推個人', () => {
    const e = envB({ rules: [BILL_P, ETAG_P, NEWS_N, NEWS2], threads: allThreads() });
    e.run();
    assert.deepEqual(e.pushes.map((p) => p.to), ['Cgmail']);
    const text = e.pushes[0].text;
    assert.match(text, /^📬 Gmail 彙總 10\/12（5 封）/);
    assert.match(text, /🧾 帳單\n・國泰世華｜NT\$12,345｜10\/25 截止｜📎 https:\/\/drive\//);
    assert.match(text, /🚗 eTag 2 筆，合計 NT\$200/);
    assert.match(text, /📰 電子報 2 封：天下、商周/);
    assert.doesNotMatch(text, /cathaybk|fetc|@/, '不寫寄件者地址');
  });

  test('⚠️ 待確認：列主旨＋Gmail 連結', () => {
    const e = envB({ rules: [BILL_P], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '國泰世華 9 月帳單', daysAgo(1), [], '改版了')])] });
    e.run();
    assert.match(e.pushes[0].text, /⚠️ 待確認\n・國泰世華 9 月帳單\n　https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/t1/);
    assert.match(e.pushes[0].text, /🧾 帳單\n・國泰世華｜金額待確認/);
  });

  test('0 封不推；notify 沒開的不列；全部都沒開也不推', () => {
    const e0 = envB();
    e0.run();
    assert.equal(e0.pushes.length, 0);
    const quiet = Object.assign({}, BILL, { notify: 'FALSE' });
    const e1 = envB({ rules: [quiet], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])] });
    e1.run();
    assert.equal(logRows(e1).length, 1, '照樣處理');
    assert.equal(e1.pushes.length, 0);
  });

  test('同一封只推一次：第二次跑沒有新信就不推', () => {
    const e = envB({ rules: [BILL_P], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])] });
    e.run();
    e.run();
    assert.equal(e.pushes.length, 1);
  });

  test('太長就截斷，最後寫「其餘 N 封」，不超過 LINE 上限', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      thread('t' + i, [msg('m' + i, 'service@cathaybk.com.tw', '很長的主旨'.repeat(5) + i, daysAgo(1))]));
    const e = envB({ rules: [Object.assign({}, BILL_P)], threads: many });
    e.run();
    const text = e.pushes[0].text;
    assert.ok(text.length <= 5000, String(text.length));
    assert.match(text, /…其餘 \d+ 封，到 App 看/);
  });

  test('沒有開 notify_gmail 的群組：不推，logs 講清楚', () => {
    const e = envB({ rules: [BILL], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])],
      groups: new FakeSheet('line_groups', [GROUP_H]) });
    e.run();
    assert.equal(e.pushes.length, 0);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /沒有開 notify_gmail 的群組，彙總沒有推/);
  });

  test('推播那一步丟例外：信照樣記錄，logs 照樣寫（不是整輪例外中止）', () => {
    const e = envB({ rules: [BILL], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])] });
    e.read('readLineGroups_ = function () { throw new Error("Sheet 暫時無法存取"); }');
    e.run();
    assert.equal(logRows(e).length, 1);
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.equal(tx[1], '成功');
    assert.match(tx[4], /彙總沒有推（Sheet 暫時無法存取）/);
  });

  test('推播失敗寫進 logs（信已經記錄，不重推）', () => {
    const e = envB({ rules: [BILL], threads: [thread('t1', [msg('m1', 'service@cathaybk.com.tw', '帳單', daysAgo(1))])],
      pushImpl: () => ({ ok: false, code: 429, reason: 'HTTP 429' }) });
    e.run();
    const tx = e.transactions.find((x) => /^Gmail 控制員/.test(x[2]));
    assert.match(tx[4], /彙總推到 Cgmail 失敗（HTTP 429）/);
  });
});

describe('給 App 的管理員 API（gmailView／gmailRuleSet）', () => {

  const USERS = () => new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks', 'feat_gmail'],
    [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
    [MOM, '媽', 'TRUE', '', 'TRUE', 'TRUE']
  ]);
  const apiEnv = (over = {}) => {
    const e = envB(Object.assign({ extraSheets: { line_users: USERS() } }, over));
    return e;
  };
  const momCaller = { line_id: MOM, user: { line_id: MOM, is_active: 'TRUE', is_admin: '', feat_gmail: 'TRUE' } };
  const adminNoFeat = { line_id: ME, user: { line_id: ME, is_active: 'TRUE', is_admin: 'TRUE', feat_gmail: '' } };

  test('規則：回全部規則（含停用）＋解析器名單（下拉選單用）', () => {
    const e = apiEnv({ rules: [BILL, Object.assign({}, NEWS, { is_active: 'FALSE' })] });
    const r = e.call('gmailView_', ADMIN, 'rules');
    assert.equal(r.success, true);
    assert.deepEqual(r.rules.map((x) => x.rule_id), [1, 3]);
    assert.deepEqual(r.parsers, ['boom_v1', 'demo_v1', 'half_v1']);
    assert.deepEqual(r.mail_types, ['bill', 'etag', 'newsletter']);
  });

  test('郵件列表：新的在前，最多 200 筆', () => {
    const e = apiEnv();
    const rows = Array.from({ length: 205 }, (_, i) => LOG_HEADERS.map((h) => (h === 'msg_id' ? 'm' + i : h === 'received_at' ? new Date(Date.UTC(2026, 8, 1) + i * 3600000).toISOString() : '')));
    e.sheets.gmail_log.values.push(...rows);
    const r = e.call('gmailView_', ADMIN, 'log');
    assert.equal(r.rows.length, 200);
    assert.equal(r.rows[0].msg_id, 'm204');
    assert.equal(r.total, 205);
  });

  test('非管理者就算勾了 feat_gmail 也拒絕；管理者沒勾 feat_gmail 也拒絕', () => {
    const e = apiEnv();
    assert.equal(e.call('gmailView_', momCaller, 'log').error, 'forbidden');
    assert.equal(e.call('gmailView_', adminNoFeat, 'rules').error, 'forbidden');
    assert.equal(e.call('gmailRuleSet_', momCaller, { source_name: 'x', mail_type: 'bill', from: 'a@b.c' }).error, 'forbidden');
  });

  test('新增規則：rule_id 自動取最大＋1，真假值寫成 TRUE／FALSE，寫 logs', () => {
    const e = apiEnv({ rules: [Object.assign({}, BILL, { rule_id: 10001 })] });
    const r = e.call('gmailRuleSet_', ADMIN, { source_name: '玉山', mail_type: 'bill', from: 'ebill@esun.com.tw',
      subject_kw: '帳單', save_attachment: true, notify: false, is_active: true });
    assert.equal(r.success, true);
    assert.equal(r.rule.rule_id, 10002);
    const saved = e.sheets.gmail_rules.toRecords()[1];
    assert.equal(saved.source_name, '玉山');
    assert.equal(saved.save_attachment, 'TRUE');
    assert.equal(saved.notify, 'FALSE');
    assert.ok(e.transactions.some((t) => t[0] === '設定' && /gmailRuleSet/.test(t[2])));
  });

  test('編輯：只改送來的欄位，其他照舊；停用＝is_active FALSE（不刪列）', () => {
    const e = apiEnv({ rules: [BILL] });
    e.call('gmailRuleSet_', ADMIN, { rule_id: 1, is_active: false });
    const rows = e.sheets.gmail_rules.toRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_active, 'FALSE');
    assert.equal(rows[0].from, 'service@cathaybk.com.tw');
  });

  test('擋不合法的規則：信種、寄件者主旨都空、不認得的解析器、沒有名稱、改不存在的 id', () => {
    const e = apiEnv({ rules: [BILL] });
    const set = (rec) => e.call('gmailRuleSet_', ADMIN, rec).error;
    assert.equal(set({ source_name: 'x', mail_type: '帳單', from: 'a@b.c' }), 'invalid_mail_type');
    assert.equal(set({ source_name: 'x', mail_type: 'bill' }), 'empty_query');
    assert.equal(set({ source_name: 'x', mail_type: 'bill', from: 'a@b.c', parser: 'nope' }), 'unknown_parser');
    assert.equal(set({ source_name: ' ', mail_type: 'bill', from: 'a@b.c' }), 'missing_source_name');
    assert.equal(set({ rule_id: 99, is_active: false }), 'rule_not_found');
    assert.equal(e.sheets.gmail_rules.toRecords().length, 1, '一列都沒動');
  });

  test('填錯的舊規則可以先停用（停用中的不擋驗證），要重新啟用時才擋', () => {
    const bad = { rule_id: 7, is_active: 'TRUE', source_name: '舊的', mail_type: '帳單', from: 'x@y.com' };
    const e = apiEnv({ rules: [bad] });
    assert.equal(e.call('gmailRuleSet_', ADMIN, { rule_id: 7, is_active: false }).success, true);
    assert.equal(e.sheets.gmail_rules.toRecords()[0].is_active, 'FALSE');
    assert.equal(e.call('gmailRuleSet_', ADMIN, { rule_id: 7, is_active: true }).error, 'invalid_mail_type');
  });

  test('經過 PWA 路由：要帶 token，管理員拿得到', () => {
    const TOK = 'tok-neil';
    const e = loadCodeGs({ extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK]: ME },
      sheets: { line_users: USERS(), gmail_rules: rulesSheet([BILL]), gmail_log: logSheet() } });
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify({ action: 'gmailView', what: 'rules', token: TOK, trigger: 'manual' }) } }).body);
    assert.equal(out.success, true);
    assert.equal(out.rules.length, 1);
  });

  test('群組的 notify_gmail 可以在 App 開關（groupSet）', () => {
    const e = apiEnv();
    const r = e.call('groupSet_', ADMIN, 'Cfamily', 'notify_gmail', true);
    assert.equal(r.success, true);
    assert.equal(e.sheets.line_groups.toRecords()[1].notify_gmail, 'TRUE');
    assert.ok(e.read('LINE_GROUPS_HEADERS').includes('notify_gmail'));
  });
});
