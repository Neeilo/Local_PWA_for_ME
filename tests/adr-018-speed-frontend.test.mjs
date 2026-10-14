/**
 * ADR-018 PR-A（D-1、D-3、D-6）— 開機加速：前端
 *
 * 盯的事（為什麼）：
 *   - 回前景 30 分鐘規則（D-3）：離開 ≤ 30 分 → 不出 Loading、只跑 readMany（頂端細條「更新中」）；
 *     > 30 分 → 完整 boot＋全螢幕 Loading。5 秒內來回切換不重打
 *   - 報價不擋 Loading（D-6）：Loading 在 boot 回來就收，不等 action=stock；
 *     報價還沒回來時，自選股磚／再平衡磚寫「報價更新中…」，**不畫舊價格**（完整開機會清掉上一份）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MIN = 60000;
const json = (v) => ({ json: () => Promise.resolve(v) });
const ALL = () => ({ tasks: [], notes: [], expenses: [] });
const BOOT = () => ({
  session: { status: 'ok', line_id: ME, device_id: 'd1' },
  line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_stock: 'TRUE', feat_expense: 'TRUE', feat_tasks: 'TRUE' }],
  data: ALL(), denied: []
});
const STOCK = { ready: true, watch: [{ symbol: '0050', name: '元大台灣50' }], quotes: { '0050': { price: 190.5, change: 1, changePct: 0.5, source: 'fugle' } },
  trades: [], holdings: [], members: ['爸爸'], my_member: '爸爸', rules: [], hits: {},
  rebalance: { status: 'ok', symbol: '00631L', owner: '爸爸', ratio_pct: 50, low_pct: 45, high_pct: 55, target_pct: 50, cash: 1, alert: false } };

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** stockGate：給一個還沒 resolve 的 promise，就能看「報價還沒回來」那一刻 */
function env({ stockGate = null } = {}) {
  const e = loadFrontend({
    fetchImpl: ({ body }) => {
      if (body.action === 'boot') return json(BOOT());
      if (body.action === 'readMany') return json({ data: ALL(), denied: [] });
      if (body.action === 'stock') return { json: () => (stockGate || Promise.resolve()).then(() => ({ stock: STOCK })) };
      return json({ success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = []; gateMode = null; zone = "finance"');
  e.raw('state = EMPTY_STATE(); applyIdentity = function(){}');
  const els = {};
  const doc = e.context.document;
  const orig = doc.getElementById;
  e.set('document', Object.assign({}, doc, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
  return { e, els };
}
const acts = (e) => e.calls.map((c) => c.body.action + ':' + c.body.trigger);

/* ========================================================================== */
describe('回前景 30 分鐘規則（D-3）', () => {

  test('離開 10 分鐘：不出 Loading、只跑 readMany（foreground）＋報價；頂端細條「更新中…」', async () => {
    const { e, els } = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    e.raw('lastPullAt = 0; hiddenAt = Date.now() - 10 * ' + MIN + '; stockPromise = null');
    e.calls.length = 0;
    els.bootLoading.hidden = true;
    e.set('setTimeout', () => 0);          // 假瀏覽器的 setTimeout 會立刻執行：這裡要看「剛開始」那一刻
    const p = e.callRaw('onForeground', Date.now());
    assert.equal(els.bootLoading.hidden, true, '不出全螢幕 Loading');
    assert.equal(els.bootProgress.hidden, false);
    assert.equal(els.bootProgressMsg.textContent, '更新中…');
    await p;
    await settle();
    assert.deepEqual(acts(e).sort(), ['readMany:foreground', 'stock:foreground']);
  });

  test('離開 31 分鐘：完整 boot＋全螢幕 Loading', async () => {
    const { e, els } = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    e.raw('lastPullAt = 0; hiddenAt = Date.now() - 31 * ' + MIN);
    e.calls.length = 0;
    const p = e.callRaw('onForeground', Date.now());
    assert.equal(els.bootLoading.hidden, false);
    await p;
    assert.equal(els.bootLoading.hidden, true);
    assert.equal(acts(e)[0], 'boot:foreground');
  });

  test('5 秒內來回切換：不重打', async () => {
    const { e } = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    e.raw('hiddenAt = Date.now() - 2000');
    e.calls.length = 0;
    await e.callRaw('onForeground', Date.now());
    assert.equal(e.calls.length, 0);
  });

  test('還沒有身份（開機失敗過）：回前景照完整開機走', async () => {
    const { e } = env();
    e.raw('myLineId = null; lastPullAt = 0; hiddenAt = Date.now() - 60000');
    await e.callRaw('onForeground', Date.now());
    assert.equal(acts(e)[0], 'boot:foreground');
  });
});

/* ========================================================================== */
describe('報價不擋 Loading（D-6）', () => {

  test('boot 回來 Loading 就收；報價還沒回來：自選股與再平衡寫「報價更新中…」；回來才畫價格', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { e, els } = env({ stockGate: gate });
    await e.callRaw('startSession', 'cold');
    assert.equal(els.bootLoading.hidden, true, '不等報價');
    e.call('renderDashStocks');
    assert.match(els.dashStocks.innerHTML, /報價更新中…/);
    assert.match(els.dashRebal.innerHTML, /報價更新中…/);
    assert.equal(els.dashStockCard.hidden, false);
    release();
    await settle();
    assert.match(els.dashStocks.innerHTML, /190\.5/);
    assert.doesNotMatch(els.dashStocks.innerHTML, /報價更新中/);
  });

  test('完整開機清掉上一份報價：Loading 收起後看到的是「報價更新中」，不是舊價格', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { e, els } = env({ stockGate: gate });
    e.raw('stockData = ' + JSON.stringify(Object.assign({}, STOCK, { quotes: { '0050': { price: 111.1, change: 0, changePct: 0, source: 'fugle' } } })));
    await e.callRaw('startSession', 'foreground');
    e.call('renderDashStocks');
    assert.doesNotMatch(els.dashStocks.innerHTML, /111\.1/);
    assert.match(els.dashStocks.innerHTML, /報價更新中…/);
    release();
    await settle();
  });

  test('沒有 feat_stock：不打 action=stock、首頁也不出股票磚', async () => {
    const { e, els } = env();
    e.raw('zone = "productivity"');
    await e.callRaw('startSession', 'cold');
    await settle();
    assert.equal(e.calls.filter((c) => c.body.action === 'stock').length, 0);
  });
});
