/**
 * 「💸 成本」模組（Neil 2026-10-21：在 App 裡看得到目前的成本概況）
 *
 * 為什麼：ADR-022 PR-C 把用量與成本卡放在「設定 ▸ 管理」（D-7），要找很深。Neil 要一個模組直接點開看。
 * 做法沿用 ADR-021 的模組機制，不另起一套：
 *   - 模組登記表多一列 costs（初始化補列、已存在的列不動）；Apps 出現 💸 成本
 *   - 只給 2.0 管理者（成本與額度是管理資料）；1.0 不動
 *   - 「用量與成本」卡整張搬到模組頁（同 pushCard 搬到任務頁的做法），設定頁就不再有
 *   - 總開關關掉：看不到、查不到（apiCostSummary／查價擋下），但**記帳照常**——callApi_ 是基礎設施，
 *     關掉模組不可以讓帳斷掉（模組關閉不等於刪資料）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const TOK = 'tok-me';
const MOD_H = ['module_id', 'name', 'category', 'icon', 'enabled', 'permission', 'load_policy', 'sort'];

function backend({ costsOff = false } = {}) {
  const rows = [['expenses', '記帳', '財務', '💰', 'TRUE', '', '', 10]];
  if (costsOff) rows.push(['costs', '成本', '系統', '💸', 'FALSE', '', '', 100]);
  return loadCodeGs({
    cache: true,
    propsWritable: true,
    tokens: { [TOK]: ME },
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'], [ME, 'Neil', 'TRUE', 'TRUE']]),
      _module_registry: new FakeSheet('_module_registry', [MOD_H].concat(rows)),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: { UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) } }
  });
}
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK }, body)) } }).body);

describe('雲端：模組登記與總開關', () => {

  test('登記表有 costs（💸 成本），初始化補上、已存在的列不動', () => {
    const e = backend();
    assert.ok(e.read('MODULE_DEFAULTS').some((m) => m.module_id === 'costs' && m.icon === '💸'));
    e.call('ensureModuleRegistry_');
    const ids = e.sheets._module_registry.toRecords().map((r) => r.module_id);
    assert.ok(ids.includes('costs'));
    assert.equal(e.sheets._module_registry.toRecords()[0].name, '記帳', '原本的列沒被改');
  });

  test('總開關關掉：用量摘要與查價都拒絕（module_off），開著就照常', () => {
    const off = backend({ costsOff: true });
    for (const action of ['apiCostSummary', 'apiPriceCheck', 'apiPriceApply']) {
      const r = post(off, { action, trigger: 'manual', prices: [], checked: [] });
      assert.equal(r.error, 'forbidden', action);
      assert.equal(r.reason, 'module_off', action);
    }
    assert.equal(post(backend(), { action: 'apiCostSummary', trigger: 'manual' }).success, true);
  });

  test('總開關關掉：外部呼叫的記帳照常（模組關閉不等於斷帳）', () => {
    const e = backend({ costsOff: true });
    e.call('callApi_', 'cwa', 'https://x/', {});
    const hour = e.read('apiHourKey_(apiNow_())');
    assert.equal(e.cache.get('apic_' + hour + '_cwa'), '1');
  });
});

/* ========================================================================== */
const ALL = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library', 'costs'];
const mods = (off = []) => ALL.map((id, i) => ({ module_id: id, name: id === 'costs' ? '成本' : id, category: id === 'costs' ? '系統' : '生產力',
  icon: id === 'costs' ? '💸' : '•', enabled: !off.includes(id), sort: (i + 1) * 10 }));

function frontend({ v2 = true, admin = true, off = [] } = {}) {
  const calls = [];
  const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {}, fetchImpl: ({ body }) => {
    if (body) calls.push(body);
    if (body && body.action === 'apiCostSummary') return { json: () => Promise.resolve({ success: true, month: '2026-10', total_usd: 0.42,
      by_api: [{ api_id: 'claude', usd: 0.42 }], by_feature: [], quotas: [], unpriced: [], stale: [], actuals: [], labels: { claude: 'Claude' } }) };
    return null;
  } });
  e.raw(`__els = {}; __moved = [];
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        appendChild(n){ __moved.push(id + '<-' + n.id); }, querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    };
    window.scrollTo = function(){}; deviceToken = "tok"; localOnly = false; myLineId = "${ME}";
    roster = ${JSON.stringify([{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: admin ? 'TRUE' : '', feat_ui_v2: 'TRUE' }])};`);
  e.call('applyModules', mods(off));
  e.calls2 = calls;
  return e;
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

describe('前端：Apps 的 💸 成本', () => {

  test('2.0 管理者：Apps 看得到，點開進 view-costs', () => {
    const e = frontend();
    assert.equal(e.read("APP_VIEW.costs"), 'costs');
    assert.equal(e.call('appAllowed', mods().find((m) => m.module_id === 'costs')), true);
    assert.equal(e.call('viewAllowed', 'costs'), true);
  });

  test('非管理者、1.0、總開關關掉：都看不到', () => {
    const m = mods().find((x) => x.module_id === 'costs');
    assert.equal(frontend({ admin: false }).call('appAllowed', m), false);
    assert.equal(frontend({ v2: false }).call('viewAllowed', 'costs'), false);
    const off = frontend({ off: ['costs'] });
    assert.equal(off.call('appAllowed', mods(['costs']).find((x) => x.module_id === 'costs')), false);
    assert.equal(off.call('viewAllowed', 'costs'), false);
  });

  test('用量與成本卡整張搬到模組頁（不再在設定頁）', () => {
    const e = frontend();
    assert.equal(e.read("V2_CARD_HOME.costCard"), 'view-costs');
    e.call('v2PlaceCards');
    assert.ok(e.read('__moved').includes('view-costs<-costCard'));
  });

  test('進模組頁就向雲端要本月摘要，畫出總額', async () => {
    const e = frontend();
    e.call('switchView', 'costs');
    await settle();
    assert.equal(e.calls2.filter((b) => b.action === 'apiCostSummary').length, 1);
    assert.equal(e.calls2.find((b) => b.action === 'apiCostSummary').trigger, 'manual');
    assert.match(e.read('__els.costBody.innerHTML'), /US\$0\.420/);
  });

  test('總覽的額度警示指向 Apps ▸ 成本', () => {
    const e = frontend();
    e.raw(`apiAlerts = [{ api_id: 'line_push', label: 'LINE 推播', pct: 100, date: '2026-10-20', period: 'month' }]`);
    e.call('renderQuotaAlert');
    assert.match(e.read('__els.v2QuotaAlert.innerHTML'), /Apps ▸ 成本/);
  });
});
