/**
 * ADR-015 PR-A 前端：股票頁（T4）
 *
 * 盯的是：
 *   - 股票格依 feat_stock 開關（跟雲端 canUse_ 同一套規則）
 *   - 報價只在「有 feat_stock 而且在財務區」時跟著輪詢要（stock:true），生產力區不要
 *   - 這次沒要股票資料時保留上一份；雲端說股票那塊讀失敗時也保留並標出來
 *   - 來源標示照票面：富果 · 時間／證交所 · 備援／Google · 延遲約 20 分／收盤 · 10/8
 *   - 持股：黃金另列、不算市值；可依持有者篩
 *   - 交易表單：非管理者的持有者只能是自己；寫入帶 trigger、錯誤講人話、離線講連線錯誤
 *   - 成員與權限可以設定每個人是家人名單裡的哪一位
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs } from './fake-apps-script.mjs';

const NEIL = 'Uneil';
const MOM = 'Umom';

const ROSTER = [
  { line_id: NEIL, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_expense: 'TRUE', feat_stock: 'TRUE', member: '爸爸' },
  { line_id: MOM, display_name: '麗英', is_active: 'TRUE', is_admin: '', feat_expense: 'TRUE', feat_stock: 'TRUE', member: '媽媽' }
];

const STOCK = {
  ready: true,
  watch: [{ symbol: '00631L', name: '元大台灣50正2' }, { symbol: '2330', name: '台積電' },
          { symbol: '0050', name: '元大台灣50' }, { symbol: '6488', name: '環球晶' }, { symbol: '1101', name: '台泥' }],
  quotes: {
    '00631L': { price: 41.28, prevClose: 40, change: 1.28, changePct: 3.2, time: '2026-10-08T02:28:15.000Z', source: 'fugle', name: '元大台灣50正2' },
    2330: { price: 2560, prevClose: 2585, change: -25, changePct: -0.97, time: '', source: 'mis', name: '台積電' },
    '0050': { price: 115, prevClose: 116, change: -1, changePct: -0.86, time: '', source: 'google', name: '' },
    6488: { price: 1130, prevClose: 1215, change: -85, changePct: -7, time: '2026-10-08', date: '2026-10-08', source: 'close', name: '' }
  },
  trades: [
    { id: 't1', trade_date: '2026-10-01', symbol: '00631L', side: 'buy', qty: 1000, price: 40, fee: '', owner: '爸爸', note: '', line_id: NEIL, created_at: '2026-10-01T00:00:00Z' },
    { id: 't2', trade_date: '2026-10-02', symbol: 'GOLD', side: 'buy', qty: 1.5, price: 3500, fee: '', owner: '媽媽', note: '', line_id: MOM, created_at: '2026-10-02T00:00:00Z' }
  ],
  holdings: [
    { owner: '爸爸', symbol: '00631L', qty: 1000, cost: 40000, avg_cost: 40 },
    { owner: '媽媽', symbol: 'GOLD', qty: 1.5, cost: 5250, avg_cost: 3500 }
  ],
  members: ['姐姐', '爸爸', '媽媽'],
  my_member: '爸爸'
};

/** 每個 id 一個固定的假元素，測試才讀得到畫出來的 innerHTML */
function withElements(e) {
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

function env({ me = NEIL, stock = STOCK, fetchImpl = null, zone = 'finance' } = {}) {
  const e = loadFrontend({ fetchImpl });
  const el = withElements(e);
  e.raw('roster = ' + JSON.stringify(ROSTER) + '; myLineId = ' + JSON.stringify(me) + '; cloudDenied = []; localOnly = false');
  e.raw('zone = ' + JSON.stringify(zone) + '; window.scrollTo = function(){}');
  if (stock) e.call('applyStockData', stock);
  return { e, el };
}

const respond = (obj) => ({ json: () => Promise.resolve(obj) });

/* ========================================================================== */
describe('股票格的開關與資料要不要', () => {
  test('featureAllowed／viewAllowed 跟著 feat_stock，與雲端 canUse_ 一致', () => {
    const back = loadCodeGs();
    for (const v of ['TRUE', '', 'FALSE']) {
      const u = Object.assign({}, ROSTER[1], { feat_stock: v });
      const { e } = env({ me: MOM });
      e.raw('roster = ' + JSON.stringify([ROSTER[0], u]));
      assert.equal(e.call('featureAllowed', 'stocks'), back.call('canUse_', u, 'feat_stock'), v);
      assert.equal(e.call('viewAllowed', 'stocks'), back.call('canUse_', u, 'feat_stock'), v);
    }
  });

  test('財務區＋有權限才要股票資料；生產力區、沒權限都不要', () => {
    const { e } = env();
    assert.equal(e.call('wantStock'), true);
    e.raw('zone = "productivity"');
    assert.equal(e.call('wantStock'), false);
    e.raw('zone = "finance"; roster[0].feat_stock = ""');
    assert.equal(e.call('wantStock'), false);
  });

  test('輪詢的 readMany 帶 stock 旗標，並收下回來的股票資料', async () => {
    const fresh = Object.assign({}, STOCK, { my_member: '新的' });
    const { e } = env({ stock: null, fetchImpl: ({ body }) => (body.action === 'readMany'
      ? respond({ data: { tasks: [], reviews: [], moods: [], notes: [], expenses: [] }, denied: [], stock: fresh }) : null) });
    await e.callRaw('syncFromCloud', { trigger: 'poll' });
    const sent = e.calls.find((c) => c.body && c.body.action === 'readMany').body;
    assert.equal(sent.stock, true);
    assert.equal(sent.trigger, 'poll');
    assert.equal(e.read('stockData.my_member'), '新的');
  });

  test('這次沒要（回應沒有 stock）→ 保留上一份；雲端說讀失敗 → 保留並標出來', () => {
    const { e, el } = env();
    e.call('applyStockData', undefined);
    assert.equal(e.read('stockData.my_member'), '爸爸');
    assert.equal(e.read('stockFailed'), false, '沒要不是讀失敗');
    e.call('applyStockData', { error: 'stock_failed' });
    assert.equal(e.read('stockData.my_member'), '爸爸');
    e.call('renderStocksView');
    assert.match(el('stockBody').innerHTML, /這次股票資料讀取失敗，畫面是上一次的/);
  });

  test('分頁還沒建（ready:false）→ 請管理者初始化', () => {
    const { e, el } = env({ stock: Object.assign({}, STOCK, { ready: false }) });
    e.call('renderStocksView');
    assert.match(el('stockBody').innerHTML, /請管理者在 LINE 傳「初始化」/);
  });
});

/* ========================================================================== */
describe('自選與持股的畫面', () => {
  test('來源標示照票面四種；拿不到報價的明講', () => {
    const { e, el } = env();
    e.call('renderStocksView');
    const html = el('stockBody').innerHTML;
    assert.match(html, /富果 · \d\d:\d\d:\d\d/);
    assert.match(html, /證交所 · 備援/);
    assert.match(html, /Google · 延遲約 20 分/);
    assert.match(html, /收盤 · 10\/8/);
    assert.match(html, /1101 台泥<small>暫時拿不到報價/);
    assert.match(html, /stk-up">\+3\.2%/, '紅漲');
    assert.match(html, /stk-down">-0\.97%/, '綠跌');
  });

  test('持股：市值與未實現損益；黃金另列、不算市值；依持有者篩', () => {
    const { e, el } = env();
    e.call('pickStockTab', 'hold');
    let html = el('stockBody').innerHTML;
    assert.match(html, /市值 41,280・未實現損益 <span class="stk-up">\+1,280/);
    assert.match(html, /黃金（只記錄、不抓價）/);
    assert.match(html, /1\.5 公克<small>投入成本 5,250/);
    assert.doesNotMatch(html, /GOLD/, '黃金不出現在股票列（不算市值）');
    assert.doesNotMatch(html, /沒有報價/);
    e.call('pickStockOwner', '媽媽');
    html = el('stockBody').innerHTML;
    assert.doesNotMatch(html, /00631L/);
    assert.match(html, /黃金/);
  });
});

/* ========================================================================== */
describe('交易', () => {
  test('非管理者：別人記的那一筆點不開；持有者只能是自己（選單鎖住）', () => {
    const { e, el } = env({ me: MOM, stock: Object.assign({}, STOCK, { my_member: '媽媽' }) });
    e.call('pickStockTab', 'trades');
    const html = el('stockBody').innerHTML;
    assert.doesNotMatch(html, /openStockForm\('t1'\)/);
    assert.match(html, /openStockForm\('t2'\)/);
    e.call('openStockForm', null);
    assert.equal(el('stkOwner').disabled, true);
    assert.match(el('stkOwner').innerHTML, /^<option value="媽媽" selected>媽媽<\/option>$/);
  });

  test('管理者：可以選任何家人', () => {
    const { e, el } = env();
    e.call('openStockForm', 't2');
    assert.equal(el('stkOwner').disabled, false);
    assert.match(el('stkOwner').innerHTML, /姐姐.*爸爸.*媽媽" selected/);
  });

  test('儲存：送 upsert stock_trades、帶 trigger=write，欄位齊全', async () => {
    const { e, el } = env();
    e.call('openStockForm', null);
    Object.assign(e.read('__els'), {});
    e.raw(`__els.stkSymbol.value='00631l'; __els.stkQty.value='1000'; __els.stkPrice.value='41.28'; __els.stkDate.value='2026-10-08'; __els.stkOwner.value='媽媽'`);
    await e.callRaw('saveStockTrade');
    const sent = e.calls.find((c) => c.body && c.body.action === 'upsert').body;
    assert.equal(sent.sheet, 'stock_trades');
    assert.equal(sent.trigger, 'write');
    assert.equal(sent.record.symbol, '00631L');
    assert.equal(sent.record.side, 'buy');
    assert.equal(sent.record.qty, 1000);
    assert.equal(sent.record.owner, '媽媽');
    assert.equal(sent.record.trade_date, '2026-10-08');
    assert.equal(el('stockFormCard').hidden, true, '存好就收起表單');
  });

  test('賣超：講出持有者與目前持有量，表單不收起', async () => {
    const { e, el } = env({ fetchImpl: ({ body }) => (body.action === 'upsert'
      ? respond({ error: 'oversold', owner: '爸爸', symbol: '00631L', held: 200 }) : null) });
    e.call('openStockForm', null);
    e.raw(`__els.stkSymbol.value='00631L'; __els.stkQty.value='300'; __els.stkPrice.value='41'`);
    e.call('pickStockSide', 'sell');
    await e.callRaw('saveStockTrade');
    assert.equal(e.toasts.pop(), '賣不了：爸爸 目前持有 00631L 200 股');
    assert.equal(el('stockFormCard').hidden, false);
  });

  test('離線（請求失敗）：講連線錯誤，不假裝存好', async () => {
    const { e } = env({ fetchImpl: ({ body }) => (body.action === 'upsert' ? { json: () => Promise.reject(new Error('offline')) } : null) });
    e.call('openStockForm', null);
    e.raw(`__els.stkSymbol.value='00631L'; __els.stkQty.value='1'; __els.stkPrice.value='41'`);
    await e.callRaw('saveStockTrade');
    assert.equal(e.toasts.pop(), '⚠️ 連不上雲端，沒有存');
  });

  test('刪除：送 del=TRUE 的軟刪除', async () => {
    const { e } = env();
    e.call('openStockForm', 't1');
    await e.callRaw('deleteStockTrade');
    const sent = e.calls.find((c) => c.body && c.body.action === 'upsert').body;
    assert.deepEqual(sent.record, { id: 't1', del: 'TRUE' });
  });

  test('非管理者被覆寫持有者：提示「持有者只能是你自己」', async () => {
    const { e } = env({ me: MOM, fetchImpl: ({ body }) => (body.action === 'upsert' ? respond({ success: true, owner_overridden: true }) : null) });
    e.call('openStockForm', null);
    e.raw(`__els.stkSymbol.value='00631L'; __els.stkQty.value='1'; __els.stkPrice.value='41'`);
    await e.callRaw('saveStockTrade');
    assert.ok(e.toasts.includes('已記下（持有者只能是你自己）'));
  });
});

/* ========================================================================== */
describe('設定：自選清單與家人', () => {
  test('只有管理者看得到自選管理；非管理者看到說明', () => {
    const { e, el } = env({ me: MOM });
    e.call('pickStockTab', 'settings');
    assert.match(el('stockBody').innerHTML, /自選清單由管理者維護/);
    assert.equal(el('stockWatchAdd').hidden, true);
    const admin = env();
    admin.e.call('pickStockTab', 'settings');
    assert.match(admin.el('stockBody').innerHTML, /自選清單（5／15）/);
    assert.equal(admin.el('stockWatchAdd').hidden, false);
  });

  test('加入／移除自選：送 stock_watch 的 upsert，鍵是 symbol', async () => {
    const { e } = env();
    e.raw(`document.getElementById('stkWatchInput').value = '2454'`);
    await e.callRaw('addStockWatch');
    await e.callRaw('removeStockWatch', '1101');
    const sent = e.calls.filter((c) => c.body && c.body.action === 'upsert').map((c) => c.body);
    assert.deepEqual(sent.map((b) => [b.sheet, b.key_field, b.record.symbol, b.record.is_active, b.trigger]),
      [['stock_watch', 'symbol', '2454', true, 'write'], ['stock_watch', 'symbol', '1101', false, 'write']]);
  });

  test('自選滿了：講上限', async () => {
    const { e } = env({ fetchImpl: ({ body }) => (body.action === 'upsert' ? respond({ error: 'watch_full', max: 15 }) : null) });
    e.raw(`document.getElementById('stkWatchInput').value = '2454'`);
    await e.callRaw('addStockWatch');
    assert.equal(e.toasts.pop(), '自選最多 15 檔，先移除一檔');
  });

  test('成員與權限：設定 member 寫回 line_users', async () => {
    const { e } = env();
    await e.callRaw('setAdminMember', 1, '姐姐');
    const sent = e.calls.find((c) => c.body && c.body.action === 'upsert').body;
    assert.equal(sent.sheet, 'line_users');
    assert.equal(sent.key_field, 'line_id');
    assert.equal(sent.record.line_id, MOM);
    assert.equal(sent.record.member, '姐姐');
  });

  test('家人名單：沒有股票資料時從記帳分類的「家人」對象拼出來', () => {
    const { e } = env({ stock: null });
    e.raw(`expenseConfig = { categories: [
      { name:'家庭', target_group:'家人', targets:['姐姐','爸爸'] },
      { name:'醫療', target_group:'家人', targets:['爸爸','媽媽'] },
      { name:'交通', target_group:'車輛', targets:['汽車V'] } ] }`);
    assert.deepEqual(e.call('familyNames'), ['姐姐', '爸爸', '媽媽']);
  });
});
