/**
 * ADR-023 PR-D（前端）— 2.0 首頁股票 widget：兩種損益＋pin 2×2（D-1～D-5）
 *
 * 為什麼：自選股橫向一排在 iOS 滑不動；Neil 打開首頁想一眼看到「賺賠多少」與自己在意的幾檔。
 * 盯的事：
 *   - 版面順序：兩格損益 → pin 2×2 → 再平衡（只管理員有資料）→ 底部「全家持股・不含黃金」＋更新時間
 *   - 沒 pin：提示去股票頁 📌；沒持股（含只有黃金）：兩格不出現
 *   - 未實現損益用跟股票頁同一支 stockUnrealized；黃金不算；沒報價的不算、底部提示
 *   - 價格：整數不帶小數、其餘 2 位（D-5）
 *   - 股票頁 📌：第 5 檔提示「最多 4 檔」、不送雲端；1.0 沒有 📌
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const FEATS = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_stock: 'TRUE', feat_ui_v2: 'TRUE' };
const USER = Object.assign({ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }, FEATS);
const MODS = ['expenses', 'stocks', 'tasks'].map((id, i) => ({ module_id: id, name: id, category: '財務', icon: '•', enabled: true, sort: i }));

function env({ ui = 'v2', handler = {} } = {}) {
  const e = loadFrontend({ storage: { 'personal-os-ui': ui }, fetchImpl: ({ body }) => {
    if (!body) return null;
    const h = handler[body.action];
    return h === undefined ? null : reply(typeof h === 'function' ? h(body) : h);
  } });
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){}, querySelectorAll:()=>[], querySelector:()=>null });
    };
    __toasts = []; toast = function(m){ __toasts.push(m); };`);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}";`);
  e.raw('roster = ' + JSON.stringify([USER]));
  e.call('applyModules', MODS);
  e.html = () => { e.call('renderStocksWidget'); return e.read('__els.wStocks.innerHTML'); };
  e.setStock = (o) => e.raw('stockData = ' + JSON.stringify(o) + '; stockFailed = false; stockAt = new Date(2026, 10, 3, 10, 30).getTime();');
  e.setPins = (pins) => e.raw('widgetConfig = Object.assign({}, widgetCfg(), { stock_pins: ' + JSON.stringify(pins) + ' });');
  return e;
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

const Q = (price, prev) => ({ price, prevClose: prev, change: price - prev, changePct: Math.round((price - prev) / prev * 10000) / 100, source: 'fugle', time: '' });
const WATCH = ['2330', '0050', '2317', '2454', '00631L'].map((symbol) => ({ symbol, name: '' }));
const BASE = {
  ready: true, watch: WATCH,
  quotes: { 2330: Q(1010, 1000), '0050': Q(180.35, 181), 2317: Q(200, 198), 2454: Q(1500, 1490) },
  holdings: [{ owner: 'Neil', symbol: '2330', qty: 100, cost: 90000, avg_cost: 900 },
             { owner: '媽媽', symbol: '0050', qty: 100, cost: 15000, avg_cost: 150 },
             { owner: 'Neil', symbol: 'GOLD', qty: 10, cost: 30000, avg_cost: 3000 }],
  today_pnl: { amount: 935, pct: 0.79, label: '今日', intraday: true, missing: 0 }
};

describe('版面（D-1、D-2、D-4）', () => {

  test('順序：兩格損益 → pin 2×2 → 底部「全家持股・不含黃金」＋更新時間', () => {
    const e = env();
    e.setStock(BASE);
    e.setPins(['2330', '0050', '2317', '2454']);
    const h = e.html();
    const at = (s) => h.indexOf(s);
    assert.ok(at('stk-pnl') !== -1 && at('stk-pins') !== -1 && at('w-foot') !== -1);
    assert.ok(at('stk-pnl') < at('stk-pins') && at('stk-pins') < at('w-foot'));
    assert.match(h, /全家持股・不含黃金・更新 10:30/);
    assert.equal((h.match(/<button class="[^"]*" onclick="goView\('stocks'\)">/g) || []).length, 4, '4 格 pin');
    assert.doesNotMatch(h, /stk-mini/, '不再是橫向捲動的一排');
  });

  test('未實現損益：全家、不含黃金（(1010×100−90000)+(180.35×100−15000)）；今日用後端給的', () => {
    const e = env();
    e.setStock(BASE);
    const h = e.html();
    assert.match(h, /未實現損益<\/span><b class="stk-up">\+14,035<\/b>/);
    assert.match(h, /今日<\/span><b class="stk-up">\+935<\/b><small class="stk-up">\+0\.79%<\/small>/);
  });

  test('盤後／假日：「今日」格的標籤換成後端給的基準（10/31（五）vs 10/30）', () => {
    const e = env();
    e.setStock(Object.assign({}, BASE, { today_pnl: { amount: -120, pct: -0.1, label: '10/31（五）vs 10/30', intraday: false, missing: 0 } }));
    const h = e.html();
    assert.match(h, /10\/31（五）vs 10\/30<\/span><b class="stk-down">-120<\/b>/);
  });

  test('沒 pin：提示「到股票頁 📌 選最多 4 檔」', () => {
    const e = env();
    e.setStock(BASE);
    assert.match(e.html(), /到股票頁 📌 選最多 4 檔/);
  });

  test('pin 了但後來不在自選清單的：不顯示', () => {
    const e = env();
    e.setStock(BASE);
    e.setPins(['2330', '9999']);
    const h = e.html();
    assert.match(h, /2330/);
    assert.doesNotMatch(h, /9999/);
  });

  test('沒持股（只有黃金）：兩格都不出現、也不寫「全家持股」', () => {
    const e = env();
    e.setStock(Object.assign({}, BASE, { holdings: [BASE.holdings[2]], today_pnl: null }));
    const h = e.html();
    assert.doesNotMatch(h, /stk-pnl|未實現損益|全家持股/);
  });

  test('有持股沒報價：不算進去，底部提示「有 1 檔沒有報價」', () => {
    const e = env();
    const quotes = Object.assign({}, BASE.quotes); delete quotes['0050'];
    e.setStock(Object.assign({}, BASE, { quotes }));
    const h = e.html();
    assert.match(h, /未實現損益<\/span><b class="stk-up">\+11,000<\/b>/);
    assert.match(h, /有 1 檔沒有報價，沒算進去/);
  });

  test('再平衡：有資料（管理員）才出現、在 pin 下面；非管理員雲端不給 → 不出現', () => {
    const rebalance = { status: 'ok', symbol: '00631L', owner: 'Neil', ratio_pct: 50, low_pct: 37.5, high_pct: 62.5, target_pct: 50, alert: false, cash: 1, cash_updated_at: '' };
    const e = env();
    e.setStock(Object.assign({}, BASE, { rebalance }));
    e.setPins(['2330']);
    const h = e.html();
    assert.ok(h.indexOf('w-rebal') > h.indexOf('stk-pins'));
    const e2 = env();
    e2.setStock(BASE);
    assert.doesNotMatch(e2.html(), /w-rebal/);
  });

  test('盤中：右上「盤中」', () => {
    const e = env();
    e.setStock(Object.assign({}, BASE, { trading: true }));
    assert.match(e.html(), /w-live">盤中/);
  });
});

describe('價格格式（D-5）', () => {
  test('整數不帶小數、其餘 2 位', () => {
    const e = env();
    assert.equal(e.call('fmtWPrice', 1010), '1,010');
    assert.equal(e.call('fmtWPrice', 180.35), '180.35');
    assert.equal(e.call('fmtWPrice', 25.4), '25.4');
    assert.equal(e.call('fmtWPrice', 12.3456), '12.35');
  });
});

describe('股票頁 📌（D-1）', () => {

  test('按 📌 → 存到雲端 stock_pins（trigger=write）', async () => {
    const e = env({ handler: { widgetConfigSet: (b) => ({ success: true, config: Object.assign({}, b.config) }) } });
    e.setStock(BASE);
    await e.call('toggleStockPin', '2330');
    await settle();
    const s = sent(e, 'widgetConfigSet');
    assert.equal(s.length, 1);
    assert.deepEqual(s[0].body.config.stock_pins, ['2330']);
    assert.equal(s[0].body.trigger, 'write');
  });

  test('第 5 檔：提示「最多 4 檔」、不送雲端；再按一次已 pin 的就取消', async () => {
    const e = env({ handler: { widgetConfigSet: (b) => ({ success: true, config: Object.assign({}, b.config) }) } });
    e.setStock(BASE);
    e.setPins(['2330', '0050', '2317', '2454']);
    await e.call('toggleStockPin', '00631L');
    assert.equal(sent(e, 'widgetConfigSet').length, 0);
    assert.match(e.read('__toasts.join("|")'), /最多 4 檔/);
    await e.call('toggleStockPin', '2330');
    await settle();
    assert.deepEqual(sent(e, 'widgetConfigSet')[0].body.config.stock_pins, ['0050', '2317', '2454']);
  });

  test('存不上去：還原並提示', async () => {
    const e = env({ handler: { widgetConfigSet: { error: 'pins_full', max: 4 } } });
    e.setStock(BASE);
    await e.call('toggleStockPin', '2330');
    await settle();
    assert.deepEqual(e.read('stockPins()'), []);
    assert.match(e.read('__toasts.join("|")'), /最多 4 檔/);
  });

  test('自選列有 📌（2.0）；1.0 沒有', () => {
    const e = env();
    e.setStock(BASE);
    assert.match(e.call('stockWatchHtml'), /stk-pin/);
    const e1 = env({ ui: 'v1' });
    e1.setStock(BASE);
    assert.doesNotMatch(e1.call('stockWatchHtml'), /stk-pin/);
  });
});
