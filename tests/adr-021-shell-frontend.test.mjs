/**
 * ADR-021 PR-A2（前端）— 2.0 殼：ui_v2 權限、切換鈕、5 格 Tab、Apps Grid、總開關畫面
 *
 * 為什麼有這批測試：
 *  - 兩版並存（D-20）：1.0 只多一顆切換鈕，而且只有有 feat_ui_v2 的人看得到；
 *    本機記著 2.0、但權限被關了，一律回 1.0（不能靠本機的一個字串留在沒權限的介面）
 *  - feat_ui_v2 要明確勾了才算：「這一列沒有任何 feat_ 欄＝全開」那條舊規則不套在它身上，
 *    不然矩陣還沒佈到 Sheet 上時，家人全被丟進還沒做完的 2.0
 *  - 切換＝寫本機＋整頁重載，不打雲端
 *  - Apps Grid：總開關關掉的、沒權限的不出現（D-9 ①②）；白板等 PR-B（Neil 2026-10-19：總覽純空骨架）
 *  - 總開關畫面只在 2.0 的管理區，送 moduleSet 要帶 trigger（ADR-014 D-12）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const ALL = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'];
const CAT = { expenses: '財務', plans: '財務', stocks: '財務', tasks: '生產力', reminders: '生產力', board: '生產力', notes: '生產力', mail: '生產力', library: '知識' };
const mods = (off = []) => ALL.map((id, i) => ({ module_id: id, name: id, category: CAT[id], icon: '•', enabled: !off.includes(id), sort: (i + 1) * 10 }));
const FULL = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_stock: 'TRUE', feat_gmail: 'TRUE', feat_clips: 'TRUE' };

function withElements(e) {
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

function env({ me = {}, stored = null, off = [], fetchImpl = null } = {}) {
  const storage = stored ? { 'personal-os-ui': stored } : {};
  const e = loadFrontend({ storage, fetchImpl });
  const el = withElements(e);
  e.raw(`__attrs = {}; document.documentElement = { setAttribute(k, v){ __attrs[k] = v; }, removeAttribute(k){ delete __attrs[k]; } };
    __reloads = 0; location.reload = function(){ __reloads++; };
    currentView = function(){ return 'apps'; };`);
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = [];');
  e.raw('roster = ' + JSON.stringify([Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }, FULL, me)]));
  e.call('applyModules', mods(off));
  return { e, el };
}
const navHtml = (e, el) => { e.call('renderNav'); return el('nav').innerHTML; };

/* ========================================================================== */
describe('誰看得到 2.0', () => {

  test('沒有 feat_ui_v2：1.0 沒有切換鈕；本機記著 2.0 也還是 1.0', () => {
    const { e, el } = env({ stored: 'v2' });
    assert.equal(e.call('isV2'), false);
    e.call('renderAvatar');
    assert.equal(el('uiSwitchBtn').hidden, true);
    assert.match(navHtml(e, el), /data-view="home"/, '1.0 的導覽');
  });

  test('這一列完全沒有 feat_ 欄（矩陣還沒佈上去）：其他功能照舊全開，但 2.0 不開', () => {
    const { e } = env({ me: Object.fromEntries(Object.keys(FULL).map((k) => [k, undefined])), stored: 'v2' });
    e.raw('roster = [{line_id:"' + ME + '", display_name:"Neil", is_active:"TRUE"}]');
    assert.equal(e.call('featureAllowed', 'expenses'), true);
    assert.equal(e.call('uiV2Allowed'), false);
  });

  test('有權限、本機沒選：還是 1.0，但看得到「2.0」鈕', () => {
    const { e, el } = env({ me: { feat_ui_v2: 'TRUE' } });
    assert.equal(e.call('isV2'), false);
    e.call('renderAvatar');
    assert.equal(el('uiSwitchBtn').hidden, false);
  });

  test('有權限＋本機選了 2.0：2.0；2.0 裡不顯示「2.0」鈕', () => {
    const { e, el } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    assert.equal(e.call('isV2'), true);
    e.call('renderAvatar');
    assert.equal(el('uiSwitchBtn').hidden, true);
  });

  test('權限被關掉：下一次判斷就回 1.0（本機記的不算數）', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    assert.equal(e.call('isV2'), true);
    e.raw('roster[0].feat_ui_v2 = ""');
    assert.equal(e.call('isV2'), false);
  });
});

describe('成員與權限、切區提示', () => {
  test('矩陣裡有「2.0 介面」的開關；它不混進分頁對照表', () => {
    const { e } = env();
    assert.ok(e.read('FEATURE_KEYS').includes('feat_ui_v2'));
    assert.match(e.read('FEATURE_LABEL.feat_ui_v2'), /2\.0/);
    assert.ok(!Object.values(e.read('FEATURE_BY_VIEW')).includes('feat_ui_v2'));
  });

  test('2.0 不跳「切換財務／生產力」的提示', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    e.raw('toast = function(m){ __toast = m; }; __toast = null;');
    e.call('maybeZoneHint');
    assert.equal(e.read('__toast'), null);
  });
});

/* ========================================================================== */
describe('切換：寫本機＋整頁重載，不打雲端', () => {

  test('switchUi("v2") → 本機記 v2、重載一次；switchUi("v1") → 清掉、重載', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' } });
    const before = e.calls.length;
    e.call('switchUi', 'v2');
    assert.equal(e.read('localStorage.getItem("personal-os-ui")'), 'v2');
    e.call('switchUi', 'v1');
    assert.equal(e.read('localStorage.getItem("personal-os-ui")'), null);
    assert.equal(e.read('__reloads'), 2);
    assert.equal(e.calls.length, before, '沒有雲端請求');
  });
});

/* ========================================================================== */
describe('2.0 的導覽與畫面', () => {

  test('5 格 Tab：總覽｜Apps｜搜尋｜圖書館｜設定；主色固定金黃（data-zone=finance）', () => {
    const { e, el } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    const html = navHtml(e, el);
    const labels = [...html.matchAll(/<span class="tab-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['總覽', 'Apps', '搜尋', '圖書館', '設定']);
    assert.equal(e.read('__attrs["data-zone"]'), 'finance');
    assert.equal(e.read('__attrs["data-ui"]'), 'v2');
  });

  test('1.0 不帶 data-ui=v2', () => {
    const { e, el } = env();
    navHtml(e, el);
    assert.equal(e.read('__attrs["data-ui"]'), undefined);
  });

  test('2.0 回首頁＝總覽；1.0 進不了 2.0 的頁', () => {
    const v2 = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    assert.equal(v2.e.call('homeView'), 'overview');
    assert.equal(v2.e.call('viewAllowed', 'overview'), true);
    const v1 = env();
    assert.equal(v1.e.call('homeView'), 'home');
    assert.equal(v1.e.call('viewAllowed', 'overview'), false);
    assert.equal(v1.e.call('viewAllowed', 'apps'), false);
    assert.equal(v1.e.call('viewAllowed', 'search'), false);
  });

  test('圖書館沒權限或總開關關掉：那一格藏起（佔位不移位）', () => {
    const { e, el } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2', off: ['library'] });
    const labels = [...navHtml(e, el).matchAll(/<span class="tab-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['總覽', 'Apps', '搜尋', '設定']);
  });
});

/* ========================================================================== */
describe('Apps Grid', () => {

  const apps = (e) => e.read('appsGridItems()').map((g) => [g.category, g.items.map((m) => m.module_id)]);

  test('依分類排：財務｜生產力｜知識；白板 PR-A2 不放（等 PR-B）', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    assert.deepEqual(apps(e), [
      ['財務', ['expenses', 'plans', 'stocks']],
      ['生產力', ['tasks', 'reminders', 'notes', 'mail']],
      ['知識', ['library']]
    ]);
  });

  test('總開關關掉的不出現；整個分類都沒有就不出現標題', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2', off: ['stocks', 'reminders', 'library'] });
    assert.deepEqual(apps(e), [['財務', ['expenses', 'plans']], ['生產力', ['tasks', 'notes', 'mail']]]);
  });

  test('沒權限的不出現：沒有記帳 → 記帳、分期都沒有；非管理者沒有郵件', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE', feat_expense: '', is_admin: '' }, stored: 'v2' });
    const flat = apps(e).flatMap(([, ids]) => ids);
    assert.ok(!flat.includes('expenses'));
    assert.ok(!flat.includes('plans'));
    assert.ok(!flat.includes('mail'));
    assert.ok(flat.includes('tasks'));
  });

  test('依登記表的 sort 排（管理者在表上調順序就跟著變）', () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    e.call('applyModules', mods().map((m) => (m.module_id === 'stocks' ? Object.assign({}, m, { sort: 1 }) : m)));
    assert.deepEqual(apps(e)[0], ['財務', ['stocks', 'expenses', 'plans']]);
  });
});

/* ========================================================================== */
describe('設定：回到 1.0、模組總開關', () => {

  test('「回到 1.0」卡只在 2.0 出現', () => {
    const v1 = env({ me: { feat_ui_v2: 'TRUE' } });
    v1.e.call('renderUiCard');
    assert.equal(v1.el('uiCard').hidden, true);
    const v2 = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    v2.e.call('renderUiCard');
    assert.equal(v2.el('uiCard').hidden, false);
  });

  test('總開關卡：只在 2.0＋管理者；1.0 的設定頁不變', () => {
    const v1 = env({ me: { feat_ui_v2: 'TRUE' } });
    v1.e.call('renderModuleCard');
    assert.equal(v1.el('moduleCard').hidden, true);
    const nonAdmin = env({ me: { feat_ui_v2: 'TRUE', is_admin: '' }, stored: 'v2' });
    nonAdmin.e.call('renderModuleCard');
    assert.equal(nonAdmin.el('moduleCard').hidden, true);
    const admin = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2' });
    admin.e.call('renderModuleCard');
    assert.equal(admin.el('moduleCard').hidden, false);
    const rows = admin.el('moduleRows').innerHTML;
    for (const id of ALL) assert.match(rows, new RegExp("toggleModule\\('" + id + "'\\)"), id);
  });

  test('按下開關：送 moduleSet（帶 trigger），回來的登記表直接套用', async () => {
    const after = mods(['reminders']);
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2', fetchImpl: ({ body }) => body && body.action === 'moduleSet'
      ? { json: () => Promise.resolve({ success: true, modules: after }) } : null });
    await e.call('toggleModule', 'reminders');
    const sent = e.calls.find((c) => c.body && c.body.action === 'moduleSet');
    assert.deepEqual({ id: sent.body.module_id, on: sent.body.enabled, trigger: sent.body.trigger }, { id: 'reminders', on: false, trigger: 'write' });
    assert.equal(e.call('moduleOn', 'reminders'), false);
  });

  test('雲端拒絕：畫面不變、講出來', async () => {
    const { e } = env({ me: { feat_ui_v2: 'TRUE' }, stored: 'v2', fetchImpl: ({ body }) => body && body.action === 'moduleSet'
      ? { json: () => Promise.resolve({ error: 'forbidden' }) } : null });
    e.raw('toast = function(m){ __toast = m; }');
    await e.call('toggleModule', 'reminders');
    assert.equal(e.call('moduleOn', 'reminders'), true);
    assert.match(e.read('__toast'), /沒有改到/);
  });
});
