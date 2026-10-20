/**
 * ADR-021 PR-D（前端）— 設定拆分（D-14）
 *
 * 為什麼有這批測試：
 *  - 2.0 設定頁只留「個人」與「管理」；非管理者只看得到個人（票面驗收）
 *  - 模組自己的設定搬回模組：信件規則→郵件、分類→記帳、分期（含已結束）→分期、群組推播→任務；
 *    只搬位置不改邏輯——用的是同一組動作（gmailRuleSet／configSet），結果畫在模組頁
 *  - 模組總開關關掉 → 該模組的設定一併消失（票面驗收）
 *  - 1.0 設定頁一個都不動（D-20）：五個分頁、Apify 用量照舊在系統設定
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const ALL_FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_stock: 'TRUE', feat_gmail: 'TRUE', feat_ui_v2: 'TRUE' };
const ADMIN = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }, ALL_FEATS);
const MEMBER = Object.assign({}, ADMIN, { is_admin: '' });
const MOD_IDS = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'];
const mods = (off = []) => MOD_IDS.map((id, i) => ({ module_id: id, name: id, category: '生產力', icon: '•', enabled: !off.includes(id), sort: (i + 1) * 10 }));
const USAGE = { usd: 0.15, at: '2026-10-20T01:00:00.000Z', error: '', done: 3, total: 3, rate: 1 };

function withElements(e) {
  e.raw(`__els = {}; __moved = [];
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        appendChild(n){ __moved.push(id + '<-' + n.id); },
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

function env({ v2 = true, user = ADMIN, off = [], handler = {} } = {}) {
  const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {}, fetchImpl: ({ body }) => {
    if (!body) return null;
    const h = handler[body.action];
    if (h === undefined) return null;
    return reply(typeof h === 'function' ? h(body) : h);
  } });
  const el = withElements(e);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}";`);
  e.raw('roster = ' + JSON.stringify([user]));
  e.call('applyModules', mods(off));
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/* ========================================================================== */
describe('2.0 設定頁：個人／管理（D-14）', () => {
  test('非管理者：只有個人區，連「管理」分段鈕都沒有', () => {
    const { e, el } = env({ user: MEMBER });
    e.raw('settingsTab = "admin"');
    e.call('renderSettings');
    assert.equal(el('setSeg').hidden, true);
    assert.equal(el('setPersonal').hidden, false);
    assert.equal(el('setAdmin').hidden, true);
    assert.equal(el('costCard').hidden, true);
  });

  test('管理者：系統設定只剩跨模組的「群組／導覽」；信件規則、分類、分期不在設定頁', () => {
    const { e, el } = env();
    e.call('renderSettings');
    const tabs = el('sysTabs').innerHTML;
    assert.match(tabs, /群組/);
    assert.match(tabs, /導覽/);
    assert.doesNotMatch(tabs, /信件規則|分類|分期/);
    assert.equal(el('sysCount').textContent, '', '分期筆數不再掛在系統設定的標題');
  });

  test('用量與成本：Apify 用量在 2.0 是管理區自己一張卡，系統設定裡不再重複', () => {
    const { e, el } = env();
    e.raw('clipsUsage = ' + JSON.stringify(USAGE));
    e.call('renderSettings');
    assert.equal(el('costCard').hidden, false);
    assert.match(el('costBody').innerHTML, /Apify 本月 US\$0\.15/);
    assert.equal(el('sysClipsUsage').innerHTML, '');
  });

  test('用量還沒有資料：講沒有資料，不是一片空白', () => {
    const { e, el } = env();
    e.call('renderSettings');
    assert.match(el('costBody').innerHTML, /還沒有/);
  });
});

/* ========================================================================== */
describe('1.0 設定頁不動（D-20）', () => {
  test('五個分頁都在、Apify 用量照舊在系統設定、沒有用量卡', () => {
    const { e, el } = env({ v2: false });
    e.raw('clipsUsage = ' + JSON.stringify(USAGE));
    e.call('renderSettings');
    const tabs = el('sysTabs').innerHTML;
    for (const t of ['群組', '分類', '分期', '信件規則', '導覽']) assert.match(tabs, new RegExp(t));
    assert.match(el('sysClipsUsage').innerHTML, /Apify 本月 US\$0\.15/);
    assert.equal(el('costCard').hidden, true);
  });

  test('模組頁的設定卡在 1.0 一張都不出現；群組推播卡不搬家', () => {
    const { e, el } = env({ v2: false });
    e.call('renderSettings');
    e.call('v2PlaceCards');
    assert.equal(el('mailRulesCard').hidden, true);
    assert.equal(el('expCfgCard').hidden, true);
    assert.equal(el('planAllBtn').hidden, true);
    assert.deepEqual(e.read('__moved'), []);
    assert.equal(el('pushCard').hidden, false, '1.0 管理者照舊在設定頁看得到群組推播');
  });
});

/* ========================================================================== */
describe('搬回模組：同一套畫面與動作，畫在模組頁', () => {
  const RULE = { rule_id: 1, source_name: '玉山', mail_type: 'bill', from: 'a@b', subject_kw: '帳單', label: '帳單/玉山', parser: '', is_active: 'TRUE' };

  test('信件規則在郵件頁：點開才抓；改一欄送 gmailRuleSet，結果重畫在郵件頁', async () => {
    const { e, el } = env({ handler: {
      gmailView: { success: true, rules: [RULE], parsers: [], mail_types: ['bill', 'etag', 'newsletter'] },
      gmailRuleSet: (b) => ({ success: true, rule: Object.assign({}, RULE, b.record, { is_active: 'FALSE' }) })
    } });
    e.call('renderSettings');
    assert.equal(el('mailRulesCard').hidden, false);
    assert.equal(sent(e, 'gmailView').length, 0, '點開才抓');
    e.call('toggleFold', 'gmailRules');
    await settle();
    assert.equal(sent(e, 'gmailView')[0].body.what, 'rules');
    assert.match(el('mailRulesBody').innerHTML, /玉山/);
    await e.callRaw('setGmailRule', 0, 'is_active', false);
    const s = sent(e, 'gmailRuleSet')[0].body;
    assert.deepEqual(s.record, { rule_id: 1, is_active: false });
    assert.equal(s.trigger, 'write');
    assert.match(el('mailRulesBody').innerHTML, /已停用/);
  });

  test('信件規則讀不到：講原因、可以重試', async () => {
    const { e, el } = env({ handler: { gmailView: { error: 'forbidden' } } });
    e.call('toggleFold', 'gmailRules');
    await settle();
    assert.match(el('mailRulesBody').innerHTML, /讀不到（forbidden）/);
    assert.match(el('mailRulesBody').innerHTML, /重試/);
  });

  test('記帳分類在記帳頁：點開才抓 adminView config；新增照舊送 configAdd', async () => {
    const { e, el } = env({ handler: {
      adminView: { success: true, rows: [{ kind: 'category', name: '飲食', parent: '', color: 'c1', targets: '', aliases: '', sort: 10, is_active: '' }], warnings: [] },
      configAdd: { error: 'duplicate_name' }
    } });
    e.call('renderSettings');
    assert.equal(el('expCfgCard').hidden, false);
    e.call('toggleFold', 'expCfg');
    await settle();
    assert.equal(sent(e, 'adminView')[0].body.what, 'config');
    assert.match(el('expCfgBody').innerHTML, /飲食/);
    e.raw('[["sysAddKind","sub"],["sysAddName","外食"],["sysAddParent","飲食"],["sysAddColor",""]].forEach(function(p){ document.getElementById(p[0]).value = p[1]; });');
    await e.callRaw('addConfigItem');
    assert.deepEqual(sent(e, 'configAdd')[0].body.record, { kind: 'sub', name: '外食', parent: '飲食', color: '' });
    assert.ok(e.toasts.some((t) => /名稱重複了/.test(t)));
  });

  test('分期頁：管理者可切「含已結束」（原本在設定▸分期）；用手上的計畫，不另外發請求', () => {
    const { e, el } = env();
    e.raw('installmentPlans = [{plan_id:"P1", status:"active", total:23800, periods:12, category:"其他"},' +
      '{plan_id:"P2", status:"ended", total:6000, periods:3, category:"教育"}]');
    e.call('renderPlansView');
    assert.equal(el('planAllBtn').hidden, false);
    assert.doesNotMatch(el('planList').innerHTML, /已結束/);
    e.call('togglePlanEnded');
    assert.match(el('planList').innerHTML, /已結束/);
    assert.match(el('planList').innerHTML, /P1/);
    assert.equal(el('planListTitle').textContent, '所有分期');
    e.call('togglePlanEnded');
    assert.doesNotMatch(el('planList').innerHTML, /已結束/);
    assert.equal(e.calls.length, 0);
  });

  test('分期頁：非管理者沒有「含已結束」，就算狀態被切過也只列進行中', () => {
    const { e, el } = env({ user: MEMBER });
    e.raw('installmentPlans = [{plan_id:"P2", status:"ended", total:6000, periods:3, category:"教育"}]; planShowEnded = true;');
    e.call('renderPlansView');
    assert.equal(el('planAllBtn').hidden, true);
    assert.doesNotMatch(el('planList').innerHTML, /已結束/);
  });

  test('群組推播在 2.0 搬到任務頁（同一張卡，動作不變）', () => {
    const { e, el } = env();
    e.call('v2PlaceCards');
    assert.deepEqual(e.read('__moved'), ['view-tasks<-pushCard']);
    e.call('renderPushCard');
    assert.equal(el('pushCard').hidden, false);
  });
});

/* ========================================================================== */
describe('模組總開關關掉 → 該模組的設定一併消失', () => {
  test('郵件、記帳、分期、任務關掉：各自的設定卡都不出現', () => {
    const { e, el } = env({ off: ['mail', 'expenses', 'plans', 'tasks'] });
    e.call('renderSettings');
    e.call('renderPlansView');
    assert.equal(el('mailRulesCard').hidden, true);
    assert.equal(el('expCfgCard').hidden, true);
    assert.equal(el('planAllBtn').hidden, true);
    assert.equal(el('pushCard').hidden, true);
  });

  test('只關郵件：其他模組的設定照常', () => {
    const { e, el } = env({ off: ['mail'] });
    e.call('renderSettings');
    assert.equal(el('mailRulesCard').hidden, true);
    assert.equal(el('expCfgCard').hidden, false);
    assert.equal(el('pushCard').hidden, false);
  });

  test('沒有 feat_gmail 的管理者：信件規則也不出現（郵件頁本來就進不去）', () => {
    const { e, el } = env({ user: Object.assign({}, ADMIN, { feat_gmail: '' }) });
    e.call('renderSettings');
    assert.equal(el('mailRulesCard').hidden, true);
  });
});
