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
const msg = (id, from, subject, date, attachments = []) => ({ id, from, subject, date, attachments });

/* ---------------------------------------------------------------------------
 * 假 GmailApp／DriveApp：只放行白名單方法，其他方法一被碰到就記成越權
 * ------------------------------------------------------------------------- */
const GMAIL_OK = new Set(['GmailApp.search', 'GmailApp.getUserLabelByName', 'GmailApp.createLabel',
  'thread.getId', 'thread.getMessages', 'thread.getPermalink', 'thread.addLabel',
  'message.getId', 'message.getFrom', 'message.getSubject', 'message.getDate', 'message.getAttachments',
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

function env({ rules = [BILL, ETAG, NEWS], threads = [], log = logSheet(), sheets = null, drive = fakeDrive(), searchImpl, extra = {}, extraFiles = [] } = {}) {
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
