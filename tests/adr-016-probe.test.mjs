/**
 * ADR-016 PR-0：Gmail 規則探針 probeGmail() 與 gmail_rules 建表
 *
 * 探針是給 Neil 在 GAS 編輯器手動跑的，用來在動信箱之前確認「認信條件有沒有漏抓／誤抓」。
 * 這裡盯的是：
 *   1. 探針只讀不寫：Gmail 端只准 search 與讀主旨／日期，貼標籤、封存、已讀、刪除一律不碰
 *      （假 GmailApp 把每個被碰到的方法都記下來）；Sheet 一格都不改
 *   2. 查詢條件照規則組：from、主旨關鍵字、最近 30 天；停用的規則不查
 *   3. 規則有問題要講出來，不要默默略過：寄件者與主旨都空（會撈到全部信）、信種不認得、
 *      rule_id 缺或重複
 *   4. 同一封信被兩條規則命中要點名（PR-A 會取 rule_id 最小的那條，Neil 要先知道）
 *   5. 一條規則查詢失敗不會中斷其他規則；命中數到上限要標「以上」，不假裝是精確數字
 *   6. 「初始化」建 gmail_rules（只有表頭）；再跑不重建、不動 Neil 填的規則
 *   7. PWA 一般讀寫碰不到 gmail_rules
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const HEADERS = ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw',
                 'label', 'save_attachment', 'notify', 'parser', 'note'];

const rule = (o) => HEADERS.map((h) => (o[h] === undefined ? '' : o[h]));
const rulesSheet = (rows) => new FakeSheet('gmail_rules', [HEADERS, ...rows.map(rule)]);

const RULES = () => [
  { rule_id: 2, is_active: 'TRUE', source_name: '國泰世華', mail_type: 'bill', from: 'service@cathaybk.com.tw', subject_kw: '信用卡電子帳單' },
  { rule_id: 1, is_active: 'TRUE', source_name: 'eTag', mail_type: 'etag', from: 'etc@fetc.net.tw', subject_kw: '' },
  { rule_id: 3, is_active: 'FALSE', source_name: '停用的', mail_type: 'newsletter', from: 'news@example.com' }
];

/** 每封信被記成 { id, subject, date }。search 依寄件者網址的子字串挑信——只要夠驗「查了什麼、回了什麼」 */
const MAILBOX = {
  'service@cathaybk.com.tw': [
    { id: 't-c1', subject: '國泰世華信用卡電子帳單 2026/09', date: new Date(Date.UTC(2026, 8, 25, 1)) },
    { id: 't-c2', subject: '國泰世華信用卡電子帳單 2026/08', date: new Date(Date.UTC(2026, 7, 25, 1)) }
  ],
  'etc@fetc.net.tw': [
    { id: 't-e1', subject: 'eTag 通行費扣款通知', date: new Date(Date.UTC(2026, 9, 10, 1)) },
    { id: 't-e2', subject: 'eTag 通行費扣款通知', date: new Date(Date.UTC(2026, 9, 3, 1)) },
    { id: 't-e3', subject: 'eTag 通行費扣款通知', date: new Date(Date.UTC(2026, 8, 28, 1)) },
    { id: 't-e4', subject: 'eTag 通行費扣款通知', date: new Date(Date.UTC(2026, 8, 20, 1)) }
  ]
};

/**
 * 假 GmailApp：每一次方法存取都記下來（含 thread 上的）。search 以外的 GmailApp 方法、
 * 以及 getId／getFirstMessageSubject／getLastMessageDate 以外的 thread 方法都算「越權」。
 */
function fakeGmail(responder = defaultResponder) {
  const queries = [];
  const touched = [];
  const threadOf = (t) => new Proxy({}, {
    get: (_o, prop) => {
      touched.push('thread.' + String(prop));
      if (prop === 'getId') return () => t.id;
      if (prop === 'getFirstMessageSubject') return () => t.subject;
      if (prop === 'getLastMessageDate') return () => t.date;
      return () => { throw new Error('探針不該呼叫 thread.' + String(prop)); };
    }
  });
  const GmailApp = new Proxy({}, {
    get: (_o, prop) => {
      touched.push('GmailApp.' + String(prop));
      if (prop === 'search') {
        return (q, start, max) => {
          queries.push({ q, start, max });
          return responder(q, max).map(threadOf);
        };
      }
      return () => { throw new Error('探針不該呼叫 GmailApp.' + String(prop)); };
    }
  });
  return { GmailApp, queries, touched };
}

function defaultResponder(q) {
  const hit = Object.keys(MAILBOX).find((addr) => q.includes(addr));
  return hit ? MAILBOX[hit] : [];
}

const ALLOWED = new Set(['GmailApp.search', 'thread.getId', 'thread.getFirstMessageSubject', 'thread.getLastMessageDate']);

function env({ rows = RULES(), responder, sheets } = {}) {
  const g = fakeGmail(responder);
  const e = loadCodeGs({
    sheets: sheets || { gmail_rules: rulesSheet(rows) },
    overrides: { GmailApp: g.GmailApp }
  });
  return Object.assign(e, { gmail: g });
}

/* ========================================================================== */
describe('probeGmail：只讀不寫', () => {

  test('先要求 Gmail 權限再查（選擇性授權沒勾到 Gmail 時，重新跳出授權畫面）', () => {
    const e = env();
    e.call('probeGmail');
    assert.deepEqual(e.scopeChecks, [{ mode: 'FULL', scopes: ['https://mail.google.com/'] }]);
  });

  test('Gmail 只碰 search 與讀主旨／日期；Sheet 一格都不改', () => {
    const e = env();
    const before = JSON.stringify(e.sheets.gmail_rules.values);
    e.call('probeGmail');
    const forbidden = e.gmail.touched.filter((m) => !ALLOWED.has(m));
    assert.deepEqual(forbidden, [], '探針碰了不該碰的方法');
    assert.equal(JSON.stringify(e.sheets.gmail_rules.values), before);
    assert.deepEqual(Object.keys(e.sheets), ['gmail_rules'], '沒有建任何分頁');
  });
});

/* ========================================================================== */
describe('probeGmail：查詢條件與結果', () => {

  test('依 rule_id 排序；停用的不查；查詢＝寄件者＋主旨關鍵字＋最近 30 天', () => {
    const e = env();
    const r = e.call('probeGmail');
    assert.deepEqual(e.gmail.queries.map((x) => x.q), [
      'from:(etc@fetc.net.tw) newer_than:30d',
      'from:(service@cathaybk.com.tw) subject:(信用卡電子帳單) newer_than:30d'
    ]);
    assert.deepEqual(r.rules.map((x) => x.rule_id), [1, 2]);
    assert.equal(r.inactive, 1);
  });

  test('命中數＋前 3 封主旨；回報裡寫清楚是「對話串」', () => {
    const e = env();
    const r = e.call('probeGmail');
    const etag = r.rules.find((x) => x.rule_id === 1);
    assert.equal(etag.count, 4);
    assert.equal(etag.samples.length, 3);
    assert.equal(etag.samples[0].subject, 'eTag 通行費扣款通知');
    assert.equal(etag.samples[0].date, '2026-10-10');
    const bill = r.rules.find((x) => x.rule_id === 2);
    assert.equal(bill.count, 2);
    assert.ok(e.logs.some((l) => /\[1\] eTag（etag） → 4 個對話串/.test(l)), e.logs.join('\n'));
    assert.ok(e.logs.some((l) => /2026-10-10｜eTag 通行費扣款通知/.test(l)));
  });

  test('沒命中要講出來（可能是條件寫錯）', () => {
    const e = env({ responder: () => [] });
    const r = e.call('probeGmail');
    assert.ok(r.rules.every((x) => x.count === 0));
    assert.ok(e.logs.some((l) => /\[2\] 國泰世華（bill） → 0 個對話串.*⚠️/.test(l)), e.logs.join('\n'));
  });

  test('命中數到上限：標「以上」，不假裝是精確數字', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: 'm' + i, subject: '電子報 ' + i, date: new Date(Date.UTC(2026, 9, 1)) }));
    const e = env({ responder: (_q, max) => many.slice(0, max) });
    const r = e.call('probeGmail');
    assert.equal(e.gmail.queries[0].max, 500);
    assert.equal(r.rules[0].capped, true);
    assert.ok(e.logs.some((l) => /500 個以上/.test(l)), e.logs.join('\n'));
  });

  test('一條規則查詢失敗不中斷其他規則，失敗原因寫出來', () => {
    const e = env({ responder: (q) => { if (q.includes('etc@')) throw new Error('Invalid query'); return defaultResponder(q); } });
    const r = e.call('probeGmail');
    assert.equal(r.rules[0].error, 'Invalid query');
    assert.equal(r.rules[1].count, 2);
    assert.ok(e.logs.some((l) => /❌ \[1\].*Invalid query/.test(l)));
  });

  test('同一封信被兩條規則命中：點名，並說明之後會取 rule_id 最小的', () => {
    const rows = RULES().concat([{ rule_id: 4, is_active: 'TRUE', source_name: 'eTag 重複', mail_type: 'etag', from: 'fetc.net.tw' }]);
    const e = env({ rows, responder: (q) => (q.includes('fetc.net.tw') ? MAILBOX['etc@fetc.net.tw'] : defaultResponder(q)) });
    const r = e.call('probeGmail');
    assert.deepEqual(r.overlaps, [{ rule_ids: [1, 4], count: 4, subject: 'eTag 通行費扣款通知' }]);
    assert.ok(e.logs.some((l) => /4 個對話串同時命中規則 1、4.*rule_id 最小/.test(l)), e.logs.join('\n'));
  });
});

/* ========================================================================== */
describe('probeGmail：規則本身有問題要講出來', () => {

  test('寄件者與主旨都空：不查（會撈到整個信箱），標 ⚠️', () => {
    const e = env({ rows: [{ rule_id: 1, is_active: 'TRUE', source_name: '空的', mail_type: 'bill' }] });
    const r = e.call('probeGmail');
    assert.equal(e.gmail.queries.length, 0);
    assert.match(r.rules[0].problems.join('｜'), /寄件者與主旨關鍵字都是空的/);
  });

  test('信種不認得、rule_id 缺或重複：照查，但標 ⚠️', () => {
    const e = env({ rows: [
      { rule_id: 1, is_active: 'TRUE', source_name: 'A', mail_type: '帳單', from: 'a@x.com' },
      { rule_id: 1, is_active: 'TRUE', source_name: 'B', mail_type: 'bill', from: 'b@x.com' },
      { rule_id: '', is_active: 'TRUE', source_name: 'C', mail_type: 'etag', from: 'c@x.com' }
    ] });
    const r = e.call('probeGmail');
    assert.equal(e.gmail.queries.length, 3);
    assert.match(r.rules.find((x) => x.source_name === 'A').problems.join('｜'), /信種「帳單」不認得/);
    assert.match(r.rules.find((x) => x.source_name === 'B').problems.join('｜'), /rule_id 1 重複/);
    assert.match(r.rules.find((x) => x.source_name === 'C').problems.join('｜'), /沒有 rule_id/);
  });

  test('整列空白的不算規則（Sheet 上留白很正常）', () => {
    const e = env({ rows: RULES().concat([{}]) });
    const r = e.call('probeGmail');
    assert.equal(r.rules.length, 2);
    assert.equal(r.inactive, 1);
  });

  test('沒有 gmail_rules 分頁：講清楚要先跑「初始化」，不碰 Gmail', () => {
    const e = env({ sheets: {} });
    const r = e.call('probeGmail');
    assert.equal(r.error, 'sheet_not_found');
    assert.equal(e.gmail.queries.length, 0);
    assert.ok(e.logs.some((l) => /初始化/.test(l)));
  });

  test('有表沒規則：講清楚要先填盤點表', () => {
    const e = env({ rows: [] });
    const r = e.call('probeGmail');
    assert.equal(r.rules.length, 0);
    assert.ok(e.logs.some((l) => /還沒有啟用中的規則/.test(l)), e.logs.join('\n'));
  });
});

/* ========================================================================== */
describe('「初始化」建 gmail_rules', () => {

  test('沒有就建，只有表頭；回覆說「新建」並提示下一步', () => {
    const e = env({ sheets: {} });
    const r = e.call('installGmailRules_');
    assert.equal(r.level, 'ok');
    assert.match(r.text, /新建 gmail_rules/);
    assert.match(r.text, /probeGmail/);
    assert.deepEqual(e.sheets.gmail_rules.values, [HEADERS]);
  });

  test('已存在：不重建、不動 Neil 填的規則，回覆說「已存在」與規則數', () => {
    const e = env();
    const before = JSON.stringify(e.sheets.gmail_rules.values);
    const r = e.call('installGmailRules_');
    assert.match(r.text, /gmail_rules 已存在（3 列規則）/);
    assert.equal(JSON.stringify(e.sheets.gmail_rules.values), before);
  });

  test('已存在但缺欄：往右補上，既有資料不動', () => {
    const e = env({ sheets: { gmail_rules: new FakeSheet('gmail_rules', [HEADERS.slice(0, 7), ['1', 'TRUE', 'eTag', 'etag', '', 'etc@fetc.net.tw', '']]) } });
    const r = e.call('installGmailRules_');
    assert.match(r.text, /補上：label、save_attachment、notify、parser、note/);
    assert.deepEqual(e.sheets.gmail_rules.values[0], HEADERS);
    assert.equal(e.sheets.gmail_rules.toRecords()[0].from, 'etc@fetc.net.tw');
  });

  test('收進初始化步驟清單', () => {
    const e = loadCodeGs({ extraFiles: ['line-router.gs'] });
    const labels = e.read('initSteps_().map(function (s) { return s.label; })');
    assert.ok(labels.includes('Gmail 控制員'), labels.join('｜'));
  });
});

/* ========================================================================== */
describe('PWA 一般讀寫碰不到 gmail_rules', () => {

  test('在 NO_PWA_READ 與 NO_PWA_WRITE 裡', () => {
    const e = env();
    assert.ok(e.read('NO_PWA_READ').includes('gmail_rules'));
    assert.ok(e.read('NO_PWA_WRITE').includes('gmail_rules'));
  });

  test('_guide 有登記', () => {
    const e = loadCodeGs({ extraFiles: ['sheet-guide.gs'] });
    assert.ok(e.read('guideRegistry_()').some((x) => x.sheet === 'gmail_rules'));
  });
});
