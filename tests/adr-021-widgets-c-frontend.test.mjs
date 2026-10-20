/**
 * ADR-021 PR-C（前端）— Widget 排序（盤中規則）、Finance／Mail／Stocks／Weather、編輯模式存設定、Apps 常用／隱藏
 *
 * 為什麼有這批測試：
 *  - 排序純函式（票面驗收）：釘選在前；盤中 Stocks 在釘選之後第一個；非交易時段照使用者順序；無權限的不出現
 *  - 財務、股票開機後另外要（不拖慢冷開機）；一趟失敗只換那幾格「連不上・重試」
 *  - 財務 Widget 用雲端給的那幾列算，不是 state.expenses（2.0 開機沒讀記帳）
 *  - 天氣：≥50% 提示帶傘；還沒抓過講「第一次更新中」；找不到鄉鎮講去設定改
 *  - 設定一人一份存雲端：存不上去要還原並講出來（不假裝存好了）
 *  - Apps 常用排最上、隱藏的不出現（編輯模式才列在「已隱藏」）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const ALL_FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_stock: 'TRUE', feat_gmail: 'TRUE', feat_ui_v2: 'TRUE' };
const USER = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }, ALL_FEATS);
const MODS = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'].map((id, i) =>
  ({ module_id: id, name: id, category: i < 3 ? '財務' : i < 8 ? '生產力' : '知識', icon: '•', enabled: true, sort: (i + 1) * 10 }));

function withElements(e) {
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

function env({ user = USER, handler = {} } = {}) {
  const e = loadFrontend({ storage: { 'personal-os-ui': 'v2' }, fetchImpl: ({ body }) => {
    if (!body) return null;
    const key = body.action === 'boot' && body.core ? 'bootCore' : body.action;
    const h = handler[key];
    if (h === undefined) return null;
    return reply(typeof h === 'function' ? h(body) : h);
  } });
  const el = withElements(e);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}"; __view = "overview";
    currentView = function(){ return __view; }; switchView = function(n){ __view = n; };`);
  e.raw('roster = ' + JSON.stringify([user]));
  e.call('applyModules', MODS);
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
const order = (e, cfg, trading, deny = []) =>
  e.read(`widgetOrder(${JSON.stringify(cfg)}, function(id){ return ${JSON.stringify(deny)}.indexOf(id) === -1; }, ${trading})`);

/* ========================================================================== */
describe('排序（純函式，D-7／D-8）', () => {
  const { e } = env();

  test('預設順序：任務→財務→郵件→股票→閱讀→天氣', () => {
    assert.deepEqual(order(e, {}, false), ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather']);
  });

  test('釘選的永遠在最上（照使用者順序）', () => {
    assert.deepEqual(order(e, { order: ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather'], pinned: ['weather', 'reading'] }, false).slice(0, 2),
      ['reading', 'weather']);
  });

  test('盤中：Stocks 排在已釘選之下第一個；非交易時段照使用者順序', () => {
    const cfg = { order: ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather'], pinned: ['weather'] };
    assert.deepEqual(order(e, cfg, true).slice(0, 3), ['weather', 'stocks', 'tasks']);
    assert.deepEqual(order(e, cfg, false).slice(0, 3), ['weather', 'tasks', 'finance']);
  });

  test('盤中但 Stocks 自己被釘選：留在釘選區，不重複', () => {
    const r = order(e, { pinned: ['stocks'] }, true);
    assert.equal(r.filter((x) => x === 'stocks').length, 1);
    assert.equal(r[0], 'stocks');
  });

  test('隱藏的、沒權限的不出現；順序漏掉的照預設接在後面', () => {
    const r = order(e, { order: ['weather'], hidden: ['finance'] }, false, ['mail']);
    assert.deepEqual(r, ['weather', 'tasks', 'stocks', 'reading']);
  });

  test('權限：非管理者沒有郵件 Widget；沒有記帳權限沒有財務', () => {
    const { e: e2 } = env({ user: Object.assign({}, USER, { is_admin: '', feat_expense: '' }) });
    const v = e2.call('visibleWidgets');
    assert.ok(!v.includes('mail'));
    assert.ok(!v.includes('finance'));
    assert.ok(v.includes('weather'));
  });
});

/* ========================================================================== */
describe('財務、股票開機後另外要', () => {

  const core = { core: true, session: { status: 'ok', line_id: ME }, line_users: [USER], modules: MODS, self_note: '',
    widgets: { tasks: { tasks: [], board: { notes: [], expenses: [] } }, reading: { unread: 0, last: null }, weather: { pending: true, county: '臺北市', district: '中正區' } },
    widget_config: { order: ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather'], hidden: [], pinned: [], apps_pinned: [], apps_hidden: [], weather_county: '臺北市', weather_district: '中正區' },
    widgets_meta: { trading: false } };

  test('core 回來後：widgets only:[finance] 一趟、股票報價一趟', async () => {
    const { e } = env({ handler: { bootCore: core, widgets: { widgets: {} }, stock: { stock: { watch: [], quotes: {} } } } });
    await e.callRaw('runBoot', 'cold');
    await settle();
    assert.deepEqual(sent(e, 'widgets').map((c) => c.body.only), [['finance']]);
    assert.equal(sent(e, 'stock').length, 1);
  });

  test('股票被隱藏：不打報價', async () => {
    const hid = Object.assign({}, core, { widget_config: Object.assign({}, core.widget_config, { hidden: ['stocks'] }) });
    const { e } = env({ handler: { bootCore: hid, widgets: { widgets: {} } } });
    await e.callRaw('runBoot', 'cold');
    await settle();
    assert.equal(sent(e, 'stock').length, 0);
  });

  test('財務那一趟失敗：只有財務那一格「連不上・重試」，任務照常', async () => {
    const { e, el } = env({ handler: { bootCore: core, widgets: { error: 'boom' } } });
    await e.callRaw('runBoot', 'cold');
    await settle();
    e.call('renderOverview');
    assert.match(el('wFinance').innerHTML, /連不上・重試/);
    assert.doesNotMatch(el('wTasks').innerHTML, /連不上/);
  });
});

/* ========================================================================== */
describe('各 Widget 的內容', () => {

  test('財務：用雲端給的列算本月支出（不是 state.expenses）', () => {
    const { e, el } = env();
    const p = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`;
    e.raw(`state.expenses = [{id:1, date:"${day}", type:"expense", category:"餐飲", amount:99999, line_id:"${ME}"}]`);
    e.call('applyWidgets', { finance: { rows: [{ id: '1', expense_date: day, type: 'expense', category: '餐飲', amount: 1234, line_id: ME }], installments: [] } }, ['finance']);
    assert.match(el('wFinance').innerHTML, /1,234/);
    assert.doesNotMatch(el('wFinance').innerHTML, /99,999/);
  });

  test('天氣：≥50% 帶傘；顯示地點、高低溫、降雨機率', () => {
    const { e, el } = env();
    e.call('applyWidgets', { weather: { county: '臺北市', district: '中正區', period: '今天', wx: '短暫陣雨', max: 30, min: 24, pop: 60, umbrella: true } }, ['weather']);
    const h = el('wWeather').innerHTML;
    assert.match(h, /臺北市中正區/);
    assert.match(h, /24–30°C/);
    assert.match(h, /降雨機率 60%/);
    assert.match(h, /記得帶傘/);
  });

  test('天氣：還沒抓過 → 第一次更新中；找不到鄉鎮 → 叫人去設定改（不是連不上）', () => {
    const { e, el } = env();
    e.call('applyWidgets', { weather: { pending: true, county: '臺北市', district: '中正區' } }, ['weather']);
    assert.match(el('wWeather').innerHTML, /第一次更新中/);
    e.call('applyWidgets', { weather: { error: 'district_not_found', district: '火星區' } }, ['weather']);
    assert.match(el('wWeather').innerHTML, /找不到「火星區」/);
    assert.doesNotMatch(el('wWeather').innerHTML, /連不上/);
  });

  test('天氣抓失敗：那一格連不上・重試', () => {
    const { e, el } = env();
    e.call('applyWidgets', { weather: { error: 'fetch_failed' } }, ['weather']);
    assert.match(el('wWeather').innerHTML, /連不上・重試/);
  });

  test('郵件：今日筆數＋異常警告', () => {
    const { e, el } = env();
    e.call('applyWidgets', { mail: { today: 3, bill: 1, newsletter: 2, etag: 0, bills_3d: 1, warnings: ['規則 R1 的 parser「x」不認得，當留白'] } }, ['mail']);
    assert.match(el('wMail').innerHTML, /今天 3 封/);
    assert.match(el('wMail').innerHTML, /⚠️ 規則 R1/);
  });
});

/* ========================================================================== */
describe('個人設定存雲端（D-8）', () => {

  test('編輯模式改順序＋釘選，按完成：送 widgetConfigSet（trigger=write）', async () => {
    const { e } = env({ handler: { widgetConfigSet: (b) => ({ success: true, config: Object.assign({}, e.call('widgetCfg'), b.config) }) } });
    e.call('enterWidgetEdit');
    e.raw('widgetEditIds = ["weather","tasks","finance","mail","stocks","reading"]');
    e.call('toggleWidgetPin', 'weather');
    await e.callRaw('exitWidgetEdit', true);
    const b = sent(e, 'widgetConfigSet')[0].body;
    assert.equal(b.trigger, 'write');
    assert.deepEqual(b.config.order.slice(0, 2), ['weather', 'tasks']);
    assert.deepEqual(b.config.pinned, ['weather']);
    assert.equal(e.read('widgetEditing'), false);
  });

  test('存不上去：還原、講出來', async () => {
    const { e } = env({ handler: { widgetConfigSet: { error: 'busy' } } });
    await e.callRaw('saveWidgetConfig', { hidden: ['weather'] });
    assert.deepEqual(e.call('widgetCfg').hidden, []);
    assert.ok(e.toasts.some((t) => /沒有存到/.test(t)));
  });

  test('天氣地點看不懂（invalid_location）：講清楚要填什麼', async () => {
    const { e } = env({ handler: { widgetConfigSet: { error: 'invalid_location' } } });
    await e.callRaw('saveWidgetConfig', { weather_county: '火星', weather_district: '一區' });
    assert.ok(e.toasts.some((t) => /地點看不懂/.test(t)));
  });
});

/* ========================================================================== */
describe('Apps 常用／隱藏（D-9 ③）', () => {

  const groups = (e) => e.read('appsGridItems()').map((g) => [g.category, g.items.map((m) => m.module_id)]);

  test('常用排最上、不在分類裡重複；隱藏的不出現', () => {
    const { e } = env();
    e.raw(`widgetConfig = Object.assign(widgetCfg(), { apps_pinned:["notes","expenses"], apps_hidden:["plans"] })`);
    const g = groups(e);
    assert.deepEqual(g[0], ['常用', ['notes', 'expenses']]);
    assert.ok(!g.slice(1).flatMap(([, ids]) => ids).includes('notes'));
    assert.ok(!g.flatMap(([, ids]) => ids).includes('plans'));
  });

  test('編輯模式：隱藏的列在最後「已隱藏」（才按得到顯示）', () => {
    const { e } = env();
    e.raw(`widgetConfig = Object.assign(widgetCfg(), { apps_hidden:["plans"] }); appsEditing = true`);
    const g = groups(e);
    assert.deepEqual(g[g.length - 1], ['已隱藏', ['plans']]);
  });

  test('完成：只送 apps 兩個欄位', async () => {
    const { e } = env({ handler: { widgetConfigSet: (b) => ({ success: true, config: Object.assign({}, e.call('widgetCfg'), b.config) }) } });
    e.raw('appsEditing = true');
    e.call('toggleAppPin', 'stocks');
    await e.callRaw('exitAppsEdit', true);
    assert.deepEqual(Object.keys(sent(e, 'widgetConfigSet')[0].body.config).sort(), ['apps_hidden', 'apps_pinned']);
    assert.deepEqual(sent(e, 'widgetConfigSet')[0].body.config.apps_pinned, ['stocks']);
  });
});
