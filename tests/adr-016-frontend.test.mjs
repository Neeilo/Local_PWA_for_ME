/**
 * ADR-016 PR-B2：App 上的 Gmail 控制員（T7）
 *
 * 盯的事：
 *   - 「📬 郵件」只在生產力區第 5 格、只給「管理者＋feat_gmail」；財務區沒有、不加首頁卡片
 *   - 切區不打雲端（ADR-014 D-8）：郵件列表只在打開那一頁時抓一次
 *   - 郵件列表：依信種篩選、顯示金額／截止日／狀態、附件與 Gmail 連結；不顯示內文
 *   - 設定頁「信件規則」：按了分頁才抓；解析器是下拉選單（選項來自雲端）；停用＝送 is_active false；
 *     新增送 gmailRuleSet；錯誤講人話
 *   - 群組列多一個「📬 郵件彙總」開關（notify_gmail）
 *   - 「成員與權限」多一個 📬 郵件 的開關（feat_gmail）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs } from './fake-apps-script.mjs';

const ME = 'Uneil';
const FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: 'TRUE', feat_mood: 'TRUE' };

const LOG = [
  { msg_id: 'm3', received_at: '2026-10-11T02:00:00.000Z', rule_id: 1, mail_type: 'bill', source_name: '國泰世華', subject: '9 月帳單',
    amount: 12345, due_date: '2026-10-25', status: '✅ 已解析', attachment_url: 'https://drive/a.pdf', gmail_link: 'https://mail.google.com/t3', processed_at: '' },
  { msg_id: 'm2', received_at: '2026-10-10T02:00:00.000Z', rule_id: 2, mail_type: 'etag', source_name: 'eTag', subject: '通行費',
    amount: '', due_date: '', status: '🏷️ 僅標籤', attachment_url: '', gmail_link: 'https://mail.google.com/t2', processed_at: '' },
  { msg_id: 'm1', received_at: '2026-10-09T02:00:00.000Z', rule_id: 3, mail_type: 'newsletter', source_name: '天下', subject: '本週精選',
    amount: '', due_date: '', status: '⚠️ 待確認', attachment_url: '', gmail_link: 'https://mail.google.com/t1', processed_at: '' }
];
const RULES = { success: true, parsers: ['cathay_v1'], mail_types: ['bill', 'etag', 'newsletter'], rules: [
  { rule_id: 1, is_active: 'TRUE', source_name: '國泰世華', mail_type: 'bill', bill_category: '信用卡', from: 'service@cathaybk.com.tw',
    subject_kw: '帳單', label: '帳單/國泰', save_attachment: 'TRUE', notify: 'TRUE', parser: '', note: '' }
] };

function withDom(e) {
  const els = {};
  const mk = (id) => {
    const cls = new Set();
    return { id, value: '', innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)) },
      setAttribute() {}, addEventListener() {} };
  };
  const get = (id) => els[id] || (els[id] = mk(id));
  const views = ['home', 'plans', 'expenses', 'tasks', 'review', 'notes', 'stocks', 'mail'].map((v) => get('view-' + v));
  views[0].classList.add('active');
  const attrs = {};
  e.set('document', Object.assign({}, e.context.document, {
    getElementById: get,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] },
    querySelector: (sel) => (sel === '.view.active' ? views.find((v) => v.classList.contains('active')) || null : get('_q')),
    querySelectorAll: (sel) => (sel === '.view' ? views : [])
  }));
  e.context.scrollY = 0;
  e.context.scrollTo = () => {};
  e.context.requestAnimationFrame = (fn) => fn();
  e.els = new Proxy(els, { get: (_t, id) => get(id) });
  return e;
}

function env({ admin = true, gmail = 'TRUE', respond } = {}) {
  const sent = [];
  const answer = respond || ((b) => (b.action === 'gmailView' ? (b.what === 'log' ? { success: true, rows: LOG, total: 3 } : RULES)
    : b.action === 'gmailRuleSet' ? { success: true, rule: Object.assign({}, RULES.rules[0], b.record) } : { success: true }));
  const e = withDom(loadFrontend({ fetchImpl: ({ body }) => {
    if (!body || !body.action) return null;
    sent.push(body);
    return { json: () => Promise.resolve(answer(body)) };
  } }));
  const u = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: admin ? 'TRUE' : '', feat_gmail: gmail }, FEATS);
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; state = EMPTY_STATE(); firstLoadDone = true; syncFromCloud = function(){}');
  e.raw('roster = ' + JSON.stringify([u]) + '; rosterStatus = "ok"; cloudDenied = []');
  e.sent = sent;
  return e;
}

/* ========================================================================== */
describe('導覽：生產力區第 5 格', () => {

  test('管理者＋feat_gmail：生產力區有 📬 郵件；財務區沒有', () => {
    const e = env();
    e.call('setZone', 'productivity');
    e.call('renderNav');
    assert.match(e.els.nav.innerHTML, /data-view="mail"[^>]*>.*📬.*郵件/s);
    e.call('setZone', 'finance');
    e.call('renderNav');
    assert.doesNotMatch(e.els.nav.innerHTML, /data-view="mail"/);
  });

  test('非管理者就算勾了 feat_gmail、管理者沒勾 feat_gmail：都是空格', () => {
    for (const opt of [{ admin: false, gmail: 'TRUE' }, { admin: true, gmail: '' }]) {
      const e = env(opt);
      e.call('setZone', 'productivity');
      e.call('renderNav');
      assert.doesNotMatch(e.els.nav.innerHTML, /data-view="mail"/, JSON.stringify(opt));
      assert.equal(e.call('viewAllowed', 'mail'), false);
    }
  });

  test('切區不打雲端：還沒打開郵件頁，不抓郵件列表', () => {
    const e = env();
    e.call('setZone', 'productivity');
    e.call('setZone', 'finance');
    e.call('setZone', 'productivity');
    assert.equal(e.sent.filter((b) => b.action === 'gmailView').length, 0);
  });
});

/* ========================================================================== */
describe('📬 郵件列表', () => {

  test('打開才抓一次（帶 trigger），列出來源、主旨、金額、截止日、狀態與連結', async () => {
    const e = env();
    await e.callRaw('openMailView');
    const req = e.sent.filter((b) => b.action === 'gmailView');
    assert.equal(req.length, 1);
    assert.equal(req[0].what, 'log');
    assert.ok(req[0].trigger, '雲端動作要帶 trigger（ADR-014）');
    const html = e.els.mailBody.innerHTML;
    assert.match(html, /國泰世華/);
    assert.match(html, /9 月帳單/);
    assert.match(html, /NT\$12,345/);
    assert.match(html, /10\/25 截止/);
    assert.match(html, /⚠️ 待確認/);
    assert.match(html, /href="https:\/\/drive\/a\.pdf"/);
    assert.match(html, /href="https:\/\/mail\.google\.com\/t3"/);
    e.call('switchView', 'mail');
    assert.equal(e.sent.filter((b) => b.action === 'gmailView').length, 1, '已經抓過就不重抓（要新的按重新整理）');
  });

  test('連結只放行 https（Sheet 被改成 javascript: 也點不了）', async () => {
    const bad = [Object.assign({}, LOG[0], { attachment_url: 'javascript:alert(1)', gmail_link: 'javascript:alert(2)' })];
    const e = env({ respond: () => ({ success: true, rows: bad, total: 1 }) });
    await e.callRaw('openMailView');
    assert.doesNotMatch(e.els.mailBody.innerHTML, /javascript:/);
  });

  test('依信種篩選', async () => {
    const e = env();
    await e.callRaw('openMailView');
    e.call('pickMailType', 'etag');
    assert.match(e.els.mailBody.innerHTML, /通行費/);
    assert.doesNotMatch(e.els.mailBody.innerHTML, /9 月帳單/);
    e.call('pickMailType', 'check');
    assert.match(e.els.mailBody.innerHTML, /本週精選/);
    assert.doesNotMatch(e.els.mailBody.innerHTML, /通行費/);
  });

  test('重新整理會再抓；讀不到講人話', async () => {
    const e = env({ respond: () => ({ error: 'forbidden' }) });
    await e.callRaw('openMailView');
    assert.match(e.els.mailBody.innerHTML, /只有管理者/);
    await e.callRaw('reloadMail');
    assert.equal(e.sent.filter((b) => b.action === 'gmailView').length, 2);
  });
});

/* ========================================================================== */
describe('設定頁「信件規則」', () => {

  test('按了分頁才抓；解析器是下拉選單，選項來自雲端', async () => {
    const e = env();
    e.call('renderSysCard');
    assert.equal(e.sent.length, 0);
    assert.ok(e.read('SYS_TABS').some(([k]) => k === 'gmail'));
    await e.callRaw('openSysTab', 'gmail');
    const req = e.sent.find((b) => b.action === 'gmailView');
    assert.equal(req.what, 'rules');
    const html = e.els.sysBody.innerHTML;
    assert.match(html, /國泰世華/);
    assert.match(html, /<option value="cathay_v1"/);
    assert.match(html, /<option value="">（不解析）<\/option>/);
  });

  test('規則上留著雲端不認得的解析器：照實顯示「不認得」並選著，改選「不解析」就清得掉', async () => {
    const odd = Object.assign({}, RULES, { rules: [Object.assign({}, RULES.rules[0], { parser: 'cathay' })] });
    const e = env({ respond: (b) => (b.action === 'gmailView' ? odd : { success: true, rule: Object.assign({}, odd.rules[0], b.record) }) });
    await e.callRaw('openSysTab', 'gmail');
    assert.match(e.els.sysBody.innerHTML, /<option value="cathay" selected>cathay（不認得，當留白）<\/option>/);
    await e.callRaw('setGmailRule', 0, 'parser', '');
    assert.deepEqual(e.sent.filter((b) => b.action === 'gmailRuleSet').pop().record, { rule_id: 1, parser: '' });
    assert.doesNotMatch(e.els.sysBody.innerHTML, /不認得/);
  });

  test('停用送 gmailRuleSet { rule_id, is_active:false }；改欄位只送那一欄', async () => {
    const e = env();
    await e.callRaw('openSysTab', 'gmail');
    await e.callRaw('setGmailRule', 0, 'is_active', false);
    let s = e.sent.filter((b) => b.action === 'gmailRuleSet').pop();
    assert.deepEqual(s.record, { rule_id: 1, is_active: false });
    assert.ok(s.trigger);
    await e.callRaw('setGmailRule', 0, 'subject_kw', '電子帳單');
    s = e.sent.filter((b) => b.action === 'gmailRuleSet').pop();
    assert.deepEqual(s.record, { rule_id: 1, subject_kw: '電子帳單' });
  });

  test('新增規則送整筆；錯誤講人話', async () => {
    const e = env({ respond: (b) => (b.action === 'gmailView' ? RULES : { error: 'empty_query' }) });
    await e.callRaw('openSysTab', 'gmail');
    e.els.gmAddName.value = '玉山';
    e.els.gmAddType.value = 'bill';
    e.els.gmAddFrom.value = '';
    e.els.gmAddKw.value = '';
    e.els.gmAddLabel.value = '帳單/玉山';
    await e.callRaw('addGmailRule');
    const s = e.sent.find((b) => b.action === 'gmailRuleSet');
    assert.equal(s.record.source_name, '玉山');
    assert.equal(s.record.mail_type, 'bill');
    assert.ok(e.toasts.some((t) => /寄件者與主旨關鍵字至少填一個/.test(t)), e.toasts.join('｜'));
  });
});

/* ========================================================================== */
describe('其他開關', () => {

  test('群組列有「📬 郵件彙總」開關', () => {
    const e = env();
    const html = e.call('sysGroupsHtml', { rows: [{ group_id: 'Cg', name: 'Gmail', is_active: 'TRUE', notify_gmail: 'TRUE' }] });
    assert.match(html, /setGroupFlag\(0,'notify_gmail'\)">📬 郵件彙總/);
  });

  test('成員與權限有 📬 郵件（feat_gmail）；前後端對照表對得起來', () => {
    const front = loadFrontend();
    assert.equal(front.read("FEATURE_LABEL['feat_gmail']"), '📬 郵件');
    assert.equal(front.read('FEATURE_BY_VIEW').mail, 'feat_gmail');
    const back = loadCodeGs();
    assert.equal(back.read('FEATURE_LABEL').feat_gmail, '郵件');
    assert.ok(back.read('LINE_USERS_FEATURES').includes('feat_gmail'));
  });
});
