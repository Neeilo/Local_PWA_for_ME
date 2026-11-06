/**
 * ADR-026 PR-1（前端）：整理報告、純文字閱讀頁、首頁 Mail Widget、封存開關、規則的分組／收件匣
 *
 * 為什麼有這批測試：
 *  - 信件內文是外部寄來的：**只能用 textContent 放進畫面**，任何標記都不能被當成 HTML（不然一封信就能在 App 裡跑腳本）
 *  - 網址只認 http(s)，才轉成可點連結（rel=noopener）；javascript: 之類的永遠是純文字
 *  - 內文即時讀、不存副本：每點一次就問一次雲端（gmailBody＋trigger），不寫 localStorage
 *  - 封存開關是 Neil 親手開的：沒按確認不送；雲端沒存到要維持原狀並講出來
 *  - 新規則預設不存 PDF、留在收件匣（D-12）
 *  - 1.0 不變：首頁郵件磚照舊、郵件頁沒有整理報告分段
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_stock: 'TRUE', feat_gmail: 'TRUE', feat_ui_v2: 'TRUE' };
const USER = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }, FEATS);
const MODS = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'].map((id, i) =>
  ({ module_id: id, name: id, category: i < 3 ? '財務' : i < 8 ? '生產力' : '知識', icon: '•', enabled: true, sort: (i + 1) * 10 }));

const NOW_ISO = new Date().toISOString();
const REPORT = { success: true, days: 30, live: false, live_since: '', last_run: { at: NOW_ISO, processed: 3 }, rows: [
  { msg_id: 'b1', processed_at: NOW_ISO, source_name: '兆豐', subject: '10 月帳單', mail_type: 'bill', bucket: 'pay', status: '✅ 已解析',
    amount: 12345, due_date: '2026-11-27', requested_inbox_action: 'keep', inbox_action_status: 'kept', gmail_link: 'https://mail.google.com/b1' },
  { msg_id: 's1', processed_at: NOW_ISO, source_name: '存款對帳單', subject: '對帳單', mail_type: 'etag', bucket: 'fyi', status: '🏷️ 僅標籤',
    amount: '', due_date: '', requested_inbox_action: 'archive', inbox_action_status: 'skipped', inbox_action_note: '同串有 NeilOS 沒記錄的信' },
  { msg_id: 'n1', processed_at: NOW_ISO, source_name: '天下', subject: '本週精選', mail_type: 'newsletter', bucket: 'news', status: '🏷️ 僅標籤',
    amount: '', due_date: '', requested_inbox_action: 'archive', inbox_action_status: 'dry_run', inbox_action_note: '本來會封存', gmail_link: 'https://mail.google.com/n1' },
  { msg_id: 'old', processed_at: '2026-10-20T01:00:00.000Z', source_name: '國泰', subject: '舊帳單', mail_type: 'bill', bucket: 'pay', status: '⚠️ 待確認',
    amount: '', due_date: '', requested_inbox_action: '', inbox_action_status: '' }
] };

function withElements(e) {
  e.raw(`__els = {}; __made = [];
    function __el(id){ return { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{}, children:[],
      classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
      appendChild(c){ this.children.push(c); return c; },
      querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} }; }
    document.getElementById = function(id){ return __els[id] || (__els[id] = __el(id)); };
    document.createElement = function(tag){ var x = __el(''); x.tagName = tag; __made.push(x); return x; };`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

function env({ v2 = true, handler = {}, confirmAnswer = true } = {}) {
  const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {}, fetchImpl: ({ body }) => {
    if (!body) return null;
    const h = handler[body.action];
    if (h === undefined) return null;
    return reply(typeof h === 'function' ? h(body) : h);
  } });
  const el = withElements(e);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}"; __view = "${v2 ? 'overview' : 'home'}";
    currentView = function(){ return __view; }; switchView = function(n){ __view = n; }; goView = function(n){ __view = n; };
    confirm = function(){ return ${confirmAnswer}; };`);
  e.raw('roster = ' + JSON.stringify([USER]));
  e.call('applyModules', MODS);
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/* ========================================================================== */
describe('首頁 Mail Widget（D-9）', () => {

  test('今天整理了 N 封＋三組＋封存狀態（預演）＋完成時間；點了開整理報告', () => {
    const { e, el } = env();
    e.call('applyWidgets', { mail: { today: 0, org: { total: 3, pay: 1, fyi: 1, news: 1, kept: 1, archived: 0, dry_run: 2, skipped: 0, failed: 0, check: 0 },
      live: false, last_at: NOW_ISO, warnings: ['今天 1 封封存失敗，下一輪再試'] } }, ['mail']);
    const html = el('wMail').innerHTML;
    assert.match(html, /📬 今天整理了 3 封/);
    assert.match(html, /🧾 1・📄 1・📰 1/);
    assert.match(html, /預演：本來會封存 2/);
    assert.match(html, /完成 今天 \d\d:\d\d/);
    assert.match(html, /onclick="openMailReport\(\)"/);
    assert.match(html, /⚠️ 今天 1 封封存失敗/);
  });

  test('正式封存：顯示已封存數', () => {
    const { e, el } = env();
    e.call('applyWidgets', { mail: { org: { total: 2, pay: 0, fyi: 1, news: 1, archived: 2 }, live: true, last_at: NOW_ISO, warnings: [] } }, ['mail']);
    assert.match(el('wMail').innerHTML, /已封存 2/);
  });

  test('openMailReport：切到整理報告分段', () => {
    const { e } = env();
    e.raw('mailType = "bill"');
    e.call('openMailReport');
    assert.equal(e.read('mailType'), 'report');
    assert.equal(e.read('__view'), 'mail');
  });
});

/* ========================================================================== */
describe('1.0 不變', () => {

  test('首頁郵件磚照舊（不出現「整理了」）；郵件頁沒有整理報告分段，預設「全部」', () => {
    const { e, el } = env({ v2: false });
    e.raw('mailSummary = {today:2, bill:1, newsletter:1, etag:0, bills_3d:1, org:{total:9}}');
    e.call('renderDashMail');
    assert.match(el('dashMail').innerHTML, /今天 2 封/);
    assert.doesNotMatch(el('dashMail').innerHTML, /整理了/);
    assert.equal(e.read('curMailType()'), 'all');
    assert.ok(!e.read('mailFilters()').some(([k]) => k === 'report'));
  });
});

/* ========================================================================== */
describe('整理報告（D-4）', () => {

  test('2.0 打開郵件頁：預設整理報告、只抓一次（trigger=manual）；分天、三組數量、每封去向與解析結果', async () => {
    const { e, el } = env({ handler: { gmailView: (b) => (b.what === 'report' ? REPORT : { success: true, rows: [], total: 0 }) } });
    await e.callRaw('openMailView');
    await settle();
    const req = sent(e, 'gmailView');
    assert.equal(req.length, 1);
    assert.deepEqual([req[0].body.what, req[0].body.trigger, req[0].body.days], ['report', 'manual', 30]);
    const html = el('mailBody').innerHTML;
    assert.match(html, /封存模式：👀 預演中/);
    assert.match(html, /最後完成：今天/);
    assert.match(html, /今天沒有異常|今天有/);
    assert.match(html, /3 封<\/h3>/);
    assert.match(html, /🧾 要付錢的 1・📄 知道就好 1・📰 電子報 1/);
    assert.match(html, /📥 留在收件匣・NT\$12,345・11\/27 截止/);
    assert.match(html, /↩️ 跳過：同串有 NeilOS 沒記錄的信/);
    assert.match(html, /👀 預演：本來會封存/);
    assert.match(html, /舊資料/);
    assert.match(html, /金額解析不到・截止日解析不到/);
    assert.match(el('mailSeg').innerHTML, /class="sel" onclick="pickMailType\('report'\)"/);
    await e.callRaw('openMailView');
    assert.equal(sent(e, 'gmailView').length, 1, '已經抓過就不重抓');
  });

  test('從整理報告切到「全部」：第一次才抓列表', async () => {
    const { e } = env({ handler: { gmailView: (b) => (b.what === 'report' ? REPORT : { success: true, rows: [], total: 0 }) } });
    await e.callRaw('openMailView'); await settle();
    e.call('pickMailType', 'all'); await settle();
    assert.deepEqual(sent(e, 'gmailView').map((c) => c.body.what), ['report', 'log']);
  });

  test('讀不到：講出原因，不假裝是空的', async () => {
    const { e, el } = env({ handler: { gmailView: { error: 'forbidden' } } });
    await e.callRaw('openMailView'); await settle();
    assert.match(el('mailBody').innerHTML, /只有管理者/);
  });
});

/* ========================================================================== */
describe('純文字閱讀頁（D-10）', () => {

  const BODY = '親愛的讀者 <script>alert(1)</script>\n看全文：https://www.cw.com.tw/article/123?a=1。\n別點 javascript:alert(2)';

  async function openFirst(handler) {
    const ctx = env({ handler: Object.assign({ gmailView: REPORT }, handler) });
    await ctx.e.callRaw('openMailView'); await settle();
    await ctx.e.callRaw('openMailBodyAt', 2); await settle();
    return ctx;
  }

  test('點一封：即時問雲端（gmailBody＋msg_id＋trigger）；內文只用 textContent，網址變成 <a rel=noopener>', async () => {
    const { e, el } = await openFirst({ gmailBody: { success: true, text: BODY, truncated: false } });
    const req = sent(e, 'gmailBody');
    assert.equal(req.length, 1);
    assert.deepEqual([req[0].body.msg_id, req[0].body.trigger], ['n1', 'manual']);
    const box = el('mailText');
    assert.equal(box.innerHTML, '', '內文那一格從來不碰 innerHTML');
    const kids = box.children;
    assert.deepEqual(kids.map((k) => k.tagName), ['span', 'a', 'span']);
    assert.match(kids[0].textContent, /<script>alert\(1\)<\/script>/, '標記照字面顯示');
    assert.equal(kids[1].href, 'https://www.cw.com.tw/article/123?a=1', '句尾標點不算進網址');
    assert.match(kids[1].rel, /noopener/);
    assert.equal(kids[1].target, '_blank');
    assert.match(kids[2].textContent, /^。\n別點 javascript:alert\(2\)$/, 'javascript: 不變成連結');
    assert.match(el('mailBody').innerHTML, /← 回整理報告/);
    assert.match(el('mailBody').innerHTML, /在 Gmail 開啟/);
    assert.doesNotMatch(el('mailBody').innerHTML, /<script>/, '框架裡也沒有內文');
  });

  test('不存副本：localStorage 裡沒有內文；再點一次再問一次', async () => {
    const { e } = await openFirst({ gmailBody: { success: true, text: '機密內文', truncated: false } });
    assert.ok(!JSON.stringify(e.localStorage._dump()).includes('機密內文'));
    e.call('closeMailReader');
    await e.callRaw('openMailBodyAt', 2); await settle();
    assert.equal(sent(e, 'gmailBody').length, 2);
  });

  test('超長截斷：附註「只顯示前 20,000 字」；信已刪除：講人話', async () => {
    const a = await openFirst({ gmailBody: { success: true, text: 'x', truncated: true } });
    assert.match(a.el('mailText').children.pop().textContent, /只顯示前 20,000 字/);
    const b = await openFirst({ gmailBody: { error: 'not_found' } });
    assert.match(b.el('mailText').textContent, /Gmail 找不到這封信/);
  });

  test('內文的渲染函式裡沒有 innerHTML（守門：之後改壞會紅燈）', () => {
    const { e } = env();
    assert.doesNotMatch(e.read('fillMailText.toString()'), /innerHTML/);
    assert.doesNotMatch(e.read('mailTextParts.toString()'), /innerHTML/);
  });

  test('mailTextParts：http／https 才算網址；全形括號、句號結尾不吃進去', () => {
    const { e } = env();
    assert.deepEqual(e.call('mailTextParts', '見（https://a.tw/x）與 http://b.tw. ftp://c.tw'),
      [{ text: '見（' }, { url: 'https://a.tw/x' }, { text: '）與 ' }, { url: 'http://b.tw' }, { text: '. ftp://c.tw' }]);
    assert.deepEqual(e.call('mailTextParts', ''), []);
  });
});

/* ========================================================================== */
describe('封存開關（設定▸管理▸📬 郵件封存，D-3）', () => {

  test('只有 2.0 管理者＋郵件模組看得到；點開才抓（trigger=manual）', async () => {
    const { e, el } = env({ handler: { gmailView: { success: true, live: false, live_since: '' } } });
    e.call('renderMailArchiveCard');
    assert.equal(el('mailArchiveCard').hidden, false);
    await e.callRaw('loadMailArchive'); await settle();
    assert.deepEqual(sent(e, 'gmailView').map((c) => [c.body.what, c.body.trigger]), [['archive', 'manual']]);
    assert.match(el('mailArchiveBody').innerHTML, /預演/);
    assert.match(el('mailArchiveBody').innerHTML, /打開正式封存/);
    const v1 = env({ v2: false });
    v1.e.call('renderMailArchiveCard');
    assert.equal(v1.el('mailArchiveCard').hidden, true);
  });

  test('打開要先確認；確認後送 gmailArchiveSet（live=true、trigger=write）', async () => {
    const { e, el } = env({ handler: { gmailView: { success: true, live: false, live_since: '' },
      gmailArchiveSet: { success: true, live: true, live_since: NOW_ISO } } });
    await e.callRaw('loadMailArchive'); await settle();
    await e.callRaw('setMailArchive', true); await settle();
    const req = sent(e, 'gmailArchiveSet');
    assert.deepEqual([req[0].body.live, req[0].body.trigger], [true, 'write']);
    assert.match(el('mailArchiveBody').innerHTML, /正式封存/);
    assert.match(el('mailArchiveBody').innerHTML, /關回預演/);
  });

  test('沒按確認：什麼都不送', async () => {
    const { e } = env({ confirmAnswer: false, handler: { gmailView: { success: true, live: false } } });
    await e.callRaw('loadMailArchive'); await settle();
    await e.callRaw('setMailArchive', true); await settle();
    assert.equal(sent(e, 'gmailArchiveSet').length, 0);
  });

  test('雲端沒存到：維持預演並講出來', async () => {
    const { e, el } = env({ handler: { gmailView: { success: true, live: false, live_since: '' }, gmailArchiveSet: { error: 'save_failed' } } });
    await e.callRaw('loadMailArchive'); await settle();
    await e.callRaw('setMailArchive', true); await settle();
    assert.match(el('mailArchiveBody').innerHTML, /打開正式封存/);
    assert.ok(e.toasts.some((t) => /沒有存到雲端，維持原狀/.test(t)));
  });
});

/* ========================================================================== */
describe('信件規則：分組與收件匣（D-12）', () => {

  test('每條規則多兩個下拉：分組（空白＝依信種）、收件匣（沒填＝留下）', () => {
    const { e } = env();
    const html = e.call('sysGmailHtml', { rules: [{ rule_id: 1, is_active: 'TRUE', source_name: 'A', mail_type: 'bill', bucket: '', inbox_action: '' },
      { rule_id: 2, is_active: 'TRUE', source_name: 'B', mail_type: 'etag', bucket: 'fyi', inbox_action: 'archive' }], parsers: [] });
    assert.match(html, /setGmailRule\(0,'bucket',this.value\)/);
    assert.match(html, /setGmailRule\(1,'inbox_action',this.value\)/);
    assert.match(html, /<option value="" selected>（依信種分組）<\/option>/);
    assert.match(html, /（沒填＝留下）/);
    assert.match(html, /<option value="archive" selected>🗄️ 封存<\/option>/);
  });

  test('新增規則：不再依帳單自動勾存 PDF；收件匣預設留下', async () => {
    const { e } = env({ handler: { gmailRuleSet: (b) => ({ success: true, rule: Object.assign({ rule_id: 9 }, b.record) }) } });
    e.raw(`__els.gmAddName = Object.assign(document.getElementById('gmAddName'), { value: '欣中天然氣' });
      __els.gmAddType = Object.assign(document.getElementById('gmAddType'), { value: 'bill' });
      __els.gmAddFrom = Object.assign(document.getElementById('gmAddFrom'), { value: 'ebill@ms.scgas.com.tw' });
      __els.gmAddInbox = Object.assign(document.getElementById('gmAddInbox'), { value: '' });`);
    await e.callRaw('addGmailRule'); await settle();
    const rec = sent(e, 'gmailRuleSet')[0].body.record;
    assert.equal(rec.save_attachment, false);
    assert.equal(rec.inbox_action, 'keep');
    assert.equal(rec.bucket, '');
    assert.equal(sent(e, 'gmailRuleSet')[0].body.trigger, 'write');
  });
});
