/**
 * ADR-015 PR-A 後端：報價層（T1）、資料表與權限（T2）、LINE 三指令（T3）
 *
 * 盯的是票面「PR-A 測試」那一段的業務規則，不是「有沒有跑」：
 *   - 報價：富果失敗轉 MIS、再失敗轉 Google；source 正確；60 秒內同代號不重打；
 *     非交易時段讀收盤價不打外部；MIS z='-' 時讀 trade.z
 *   - 自選第 16 檔被後端拒絕；非管理者不能改自選
 *   - LINE：一般／黃金／全形千分位正確；代號無效、缺價格、賣超都不寫入
 *   - owner：管理者第五段生效；非管理者被覆寫並提示；沒設 member 拒絕；PWA upsert 同樣由後端強制
 *   - 群組裡的股票指令被拒絕；feat_stock 關閉者讀不到、寫不進
 *   - 移動平均成本：買 1000@40、買 1000@42 → 41；賣 500 後仍 41；手續費計入；GOLD 小數公克
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const NEIL = 'Uneil';      // 管理者，member＝爸爸
const MOM = 'Umom';        // 一般成員，member＝媽媽
const KID = 'Ukid';        // 一般成員，有 feat_stock 但沒設 member
const AUNT = 'Uaunt';      // 一般成員，沒有 feat_stock
const TOK = { NEIL: 'tok-neil', MOM: 'tok-mom', KID: 'tok-kid', AUNT: 'tok-aunt' };
const KEY = 'fugle-test-key';

/** 2026-10-08（週四）10:28 台北＝盤中；10/10（週六）＝非交易時段 */
const OPEN = new Date(Date.UTC(2026, 9, 8, 2, 28, 0));
const SATURDAY = new Date(Date.UTC(2026, 9, 10, 2, 0, 0));

const MARKET = {
  2330: { name: '台積電', last: 2560, prev: 2585 },
  '0056': { name: '元大高股息', last: 36.5, prev: 36.2 },
  '00878': { name: '國泰永續高股息', last: 21.9, prev: 21.8 },
  '0050': { name: '元大台灣50', last: 115.05, prev: 116.05 },
  '00631L': { name: '元大台灣50正2', last: 41.28, prev: 40 },
  6488: { name: '環球晶', last: 1130, prev: 1215, otc: true }
};

function users() {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_stock', 'member'],
    [NEIL, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '爸爸'],
    [MOM, '麗英', 'TRUE', '', 'TRUE', 'TRUE', '媽媽'],
    [KID, '小孩', 'TRUE', '', 'TRUE', 'TRUE', ''],
    [AUNT, '阿姨', 'TRUE', '', 'TRUE', '', '']
  ]);
}

function expenseConfig() {
  return new FakeSheet('_expense_config', [
    ['kind', 'name', 'parent', 'targets', 'aliases', 'color', 'sort', 'is_active'],
    ['category', '家庭', '', '家人', '', 'c4', 10, ''],
    ['target', '姐姐', '家人', '', '', '', 10, ''],
    ['target', '爸爸', '家人', '', '', '', 20, ''],
    ['target', '媽媽', '家人', '', '', '', 30, ''],
    ['target', '前室友', '家人', '', '', '', 40, 'FALSE'],
    ['target', '汽車V', '車輛', '', '', '', 10, '']
  ]);
}

const TRADE_HEADERS = ['id', 'trade_date', 'symbol', 'side', 'qty', 'price', 'fee', 'owner', 'note',
  'line_id', 'created_at', 'del', 'archive'];

function trade(id, date, symbol, side, qty, price, owner, lineId, fee = '') {
  return [String(id), date, symbol, side, qty, price, fee, owner, '', lineId, '2026-10-01T00:00:00.000Z', '', ''];
}

/**
 * 假網路。富果依網址最後一段回報價、MIS 依 ex_ch 回 msgArray（含不存在代號的空殼，2026-10-08 實測如此）。
 * fail：{ fugle: true, mis: true } 讓那一層整個失敗；fugleStatus 指定富果的 HTTP 狀態。
 */
function network({ fail = {}, fugleStatus = 200, misZ = null } = {}) {
  const calls = { fugle: 0, mis: 0, all: [] };
  const fugleResponse = (url) => {
    calls.fugle++;
    calls.all.push(url);
    const code = decodeURIComponent(url.split('/').pop());
    const m = MARKET[code];
    if (fail.fugle) return { status: 500, body: 'boom' };
    if (fugleStatus !== 200) return { status: fugleStatus, body: 'Too Many Requests' };
    if (!m) return { status: 404, body: { statusCode: 404, message: 'Resource Not Found' } };
    return { status: 200, body: { name: m.name, lastPrice: m.last, previousClose: m.prev, closePrice: m.last, lastUpdated: 1791437082297857 } };
  };
  const res = (r) => ({ getResponseCode: () => r.status, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) });
  const UrlFetchApp = {
    fetchAll: (reqs) => reqs.map((q) => res(fugleResponse(q.url))),
    fetch: (url) => {
      calls.all.push(url);
      if (url.startsWith('https://api.fugle.tw/')) return res(fugleResponse(url));
      if (url.startsWith('https://mis.twse.com.tw/')) {
        calls.mis++;
        if (fail.mis) throw new Error('Address unavailable');
        const exCh = decodeURIComponent(new URL(url).searchParams.get('ex_ch')).split('|');
        const msgArray = exCh.map((x) => {
          const [ex, rest] = x.split('_');
          const code = rest.replace('.tw', '');
          const m = MARKET[code];
          if (!m || (ex === 'otc') !== !!m.otc) return { tv: '-', s: '-', c: '', z: '-' };
          return { c: code, n: m.name, ex, z: misZ === null ? String(m.last) : misZ, y: String(m.prev),
                   b: '1.00_', a: '9999.00_', d: '20261008', t: '10:28:15', trade: { t: '10:28:10', z: String(m.last) } };
        });
        return res({ status: 200, body: { msgArray } });
      }
      throw new Error('沒預期的網址 ' + url);
    }
  };
  return { calls, UrlFetchApp };
}

function env({ net = network(), properties = { FUGLE_API_KEY: KEY }, sheets = {}, overrides = {}, pushImpl = null, autoNumber = false } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    pushImpl,
    autoNumber,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    properties,
    tokens: { [TOK.NEIL]: NEIL, [TOK.MOM]: MOM, [TOK.KID]: KID, [TOK.AUNT]: AUNT },
    sheets: Object.assign({
      line_users: users(),
      _expense_config: expenseConfig(),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']]),
      stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS]),
      stock_watch: new FakeSheet('stock_watch', [['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at']]),
      stock_rules: new FakeSheet('stock_rules', [['id', 'symbol', 'type', 'params', 'enabled', 'auto_push', 'cooldown_days', 'last_fired_at', 'line_id', 'created_at', 'del']])
    }, sheets),
    overrides: Object.assign({
      UrlFetchApp: net.UrlFetchApp,
      lineReply_: (_t, text) => { replies.push(typeof text === 'string' ? text : JSON.stringify(text)); }
    }, overrides)
  });
  e.replies = replies;
  e.net = net;
  return e;
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

function line(e, userId, text, source = { type: 'user', userId }) {
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1] || '';
}

const trades = (e) => e.sheets.stock_trades.toRecords();

/* ========================================================================== */
describe('T1 報價層', () => {
  test('富果拿得到 → source=fugle，漲跌與漲跌% 由昨收算出', () => {
    const e = env();
    const out = e.call('quote_', ['00631L', '2330'], { now: OPEN });
    assert.deepEqual(out.missing, []);
    const q = out.quotes['00631L'];
    assert.equal(q.source, 'fugle');
    assert.equal(q.price, 41.28);
    assert.equal(q.prevClose, 40);
    assert.equal(q.change, 1.28);
    assert.equal(q.changePct, 3.2);
    assert.equal(q.name, '元大台灣50正2');
    assert.equal(e.net.calls.mis, 0, '富果拿到了就不打 MIS');
  });

  test('富果失敗 → MIS；z 是 - 時讀 trade.z（不是最佳買價 1.00）', () => {
    const e = env({ net: network({ fail: { fugle: true }, misZ: '-' }) });
    const q = e.call('quote_', ['00631L'], { now: OPEN }).quotes['00631L'];
    assert.equal(q.source, 'mis');
    assert.equal(q.price, 41.28);
    assert.equal(q.prevClose, 40);
    assert.equal(q.time, '2026-10-08T02:28:15.000Z');
  });

  test('MIS 上櫃代號：tse_ 回空殼、otc_ 才有資料，照樣拿得到', () => {
    const e = env({ net: network({ fail: { fugle: true } }) });
    const q = e.call('quote_', ['6488'], { now: OPEN }).quotes['6488'];
    assert.equal(q.source, 'mis');
    assert.equal(q.price, 1130);
  });

  test('富果與 MIS 都失敗 → GOOGLEFINANCE；都失敗的列進 missing', () => {
    const e = env({
      net: network({ fail: { fugle: true, mis: true } }),
      overrides: { googleFinanceValues_: () => ({ '2330': { price: 2550, prevClose: 2585 }, '0050': { price: '', prevClose: '' } }) }
    });
    const out = e.call('quote_', ['2330', '0050'], { now: OPEN });
    assert.equal(out.quotes['2330'].source, 'google');
    assert.equal(out.quotes['2330'].price, 2550);
    assert.deepEqual(out.missing, ['0050']);
  });

  test('沒設 FUGLE_API_KEY → 不打富果，直接 MIS', () => {
    const e = env({ properties: {} });
    const q = e.call('quote_', ['2330'], { now: OPEN }).quotes['2330'];
    assert.equal(e.net.calls.fugle, 0);
    assert.equal(q.source, 'mis');
  });

  test('60 秒內同代號不重打；過了 60 秒才再打', () => {
    const e = env();
    e.call('quote_', ['2330'], { now: OPEN });
    e.call('quote_', ['2330'], { now: OPEN });
    assert.equal(e.net.calls.fugle, 1);
    e.clock.advance(61);
    e.call('quote_', ['2330'], { now: OPEN });
    assert.equal(e.net.calls.fugle, 2);
  });

  test('多檔只打沒命中的那幾檔', () => {
    const e = env();
    e.call('quote_', ['2330'], { now: OPEN });
    e.call('quote_', ['2330', '0050'], { now: OPEN });
    assert.equal(e.net.calls.fugle, 2, '第二次只打 0050');
  });

  test('非交易時段：讀 stock_daily 的收盤價，不打外部', () => {
    const daily = new FakeSheet('stock_daily', [['date', 'symbol', 'close', 'prev_close', 'source'],
      ['2026-10-09', '2330', 2560, 2585, 'twse'], ['2026-10-08', '2330', 2585, 2585, 'twse']]);
    const e = env({ sheets: { stock_daily: daily } });
    const q = e.call('quote_', ['2330'], { now: SATURDAY }).quotes['2330'];
    assert.equal(q.source, 'close');
    assert.equal(q.price, 2560, '取最新那一天');
    assert.equal(e.net.calls.all.length, 0);
  });

  test('收盤價不是最近一個交易日的（排程拿到的是前一天）→ 不採用，打外部', () => {
    const daily = new FakeSheet('stock_daily', [['date', 'symbol', 'close', 'prev_close', 'source'],
      ['2026-10-08', '2330', 2585, 2585, 'twse']]);
    const e = env({ sheets: { stock_daily: daily } });
    const q = e.call('quote_', ['2330'], { now: SATURDAY }).quotes['2330'];
    assert.equal(q.source, 'fugle', '週六的最近交易日是週五 10/9，10/8 的收盤價過期了');
  });

  test('最近一個交易日：平日收盤後是今天、盤中與開盤前是前一個平日、週末往回找週五', () => {
    const e = env();
    const at = (iso) => e.call('lastTradingDayKey_', new Date(iso));
    assert.equal(at('2026-10-08T06:00:00Z'), '2026-10-08', '週四 14:00');
    assert.equal(at('2026-10-08T02:00:00Z'), '2026-10-07', '週四 10:00 盤中');
    assert.equal(at('2026-10-12T00:00:00Z'), '2026-10-09', '週一 8:00 開盤前');
    assert.equal(at('2026-10-11T02:00:00Z'), '2026-10-09', '週日');
  });

  test('非交易時段但還沒有收盤價（PR-B 的排程還沒跑過）→ 才打外部', () => {
    const e = env();
    const q = e.call('quote_', ['2330'], { now: SATURDAY }).quotes['2330'];
    assert.equal(q.source, 'fugle');
  });

  test('GOLD 與格式不對的代號不報價、不打外部', () => {
    const e = env();
    const out = e.call('quote_', ['GOLD', 'abc', ''], { now: OPEN });
    assert.deepEqual(out.quotes, {});
    assert.equal(e.net.calls.all.length, 0);
  });

  test('每次外部呼叫寫 performance：action=quote、sheets＝來源×檔數', () => {
    const e = env({ net: network({ fail: { fugle: true } }) });
    e.call('quote_', ['2330', '0050'], { now: OPEN, trigger: 'poll', line_id: NEIL });
    const rows = e.sheets.performance.toRecords().filter((r) => r.action === 'quote');
    assert.deepEqual(rows.map((r) => r.sheets), ['fugle×2', 'mis×2']);
    assert.ok(rows.every((r) => r.trigger === 'poll' && r.line_id === NEIL));
  });

  test('富果 429 → logs 記一列 ⚠️，十分鐘內不重複記', () => {
    const e = env({ net: network({ fugleStatus: 429 }) });
    e.call('quote_', ['2330'], { now: OPEN });
    e.clock.advance(61);
    e.call('quote_', ['2330'], { now: OPEN });
    const warned = e.transactions.filter((t) => t[0] === '股票' && /429/.test(t[3]));
    assert.equal(warned.length, 1);
  });

  test('isValidSymbol_：GOLD 不分大小寫直接通過；查不到報價就是無效；格式不對不打外部', () => {
    const e = env();
    assert.equal(e.call('isValidSymbol_', 'gold'), true);
    assert.equal(e.net.calls.all.length, 0);
    assert.equal(e.call('isValidSymbol_', '00631L', { now: OPEN }), true);
    assert.equal(e.call('isValidSymbol_', '0063L', { now: OPEN }), false);
    const before = e.net.calls.all.length;
    assert.equal(e.call('isValidSymbol_', '台積電'), false);
    assert.equal(e.net.calls.all.length, before);
  });
});

/* ========================================================================== */
describe('移動平均成本（computeHoldings_）', () => {
  const book = (e, rows) => e.call('computeHoldings_', rows.map((r) => Object.fromEntries(TRADE_HEADERS.map((h, i) => [h, r[i]]))));

  test('買 1000@40、買 1000@42 → 均價 41；賣 500 後均價仍 41、剩 1500 股', () => {
    const e = env();
    const a = book(e, [trade(1, '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL), trade(2, '2026-10-02', '00631L', 'buy', 1000, 42, '爸爸', NEIL)]);
    assert.equal(a.holdings[0].avg_cost, 41);
    const b = book(e, [trade(1, '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL), trade(2, '2026-10-02', '00631L', 'buy', 1000, 42, '爸爸', NEIL),
      trade(3, '2026-10-03', '00631L', 'sell', 500, 50, '爸爸', NEIL)]);
    assert.equal(b.holdings[0].qty, 1500);
    assert.equal(b.holdings[0].avg_cost, 41);
    assert.equal(b.holdings[0].cost, 61500);
  });

  test('買進手續費計入成本', () => {
    const e = env();
    const a = book(e, [trade(1, '2026-10-01', '2330', 'buy', 1000, 40, '爸爸', NEIL, 20)]);
    assert.equal(a.holdings[0].avg_cost, 40.02);
  });

  test('GOLD 小數公克：1.5＋0.25＝1.75，賣 0.75 剩 1', () => {
    const e = env();
    const a = book(e, [trade(1, '2026-10-01', 'GOLD', 'buy', 1.5, 3500, '媽媽', MOM), trade(2, '2026-10-02', 'GOLD', 'buy', 0.25, 3600, '媽媽', MOM),
      trade(3, '2026-10-03', 'GOLD', 'sell', 0.75, 3700, '媽媽', MOM)]);
    assert.equal(a.holdings[0].qty, 1);
  });

  test('依交易日重播，不是依寫入順序；任何一刻賣超就回 oversold', () => {
    const e = env();
    const ok = book(e, [trade(2, '2026-10-05', '2330', 'sell', 500, 50, '爸爸', NEIL), trade(1, '2026-10-01', '2330', 'buy', 1000, 40, '爸爸', NEIL)]);
    assert.equal(ok.ok, true);
    const bad = book(e, [trade(1, '2026-10-05', '2330', 'buy', 1000, 40, '爸爸', NEIL), trade(2, '2026-10-01', '2330', 'sell', 500, 50, '爸爸', NEIL)]);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'oversold');
  });

  test('不同持有者各算各的；已刪除的交易不算', () => {
    const e = env();
    const rows = [trade(1, '2026-10-01', '2330', 'buy', 1000, 40, '爸爸', NEIL), trade(2, '2026-10-01', '2330', 'buy', 300, 40, '媽媽', MOM)];
    const del = trade(3, '2026-10-01', '2330', 'buy', 999, 40, '爸爸', NEIL); del[11] = 'TRUE';
    const a = book(e, rows.concat([del]));
    assert.deepEqual(a.holdings.map((h) => h.owner + h.qty), ['爸爸1000', '媽媽300']);
  });
});

/* ========================================================================== */
describe('T2 自選清單（只有管理者、最多 15 檔）', () => {
  const add = (e, tok, symbol, extra = {}) =>
    post(e, { action: 'upsert', token: TOK[tok], sheet: 'stock_watch', key_field: 'symbol', record: Object.assign({ symbol }, extra), trigger: 'write' });

  test('管理者加一檔：代號轉大寫、名稱自動帶、added_by 是自己', () => {
    const e = env();
    const out = add(e, 'NEIL', '00631l');
    assert.equal(out.success, true, JSON.stringify(out));
    const row = e.sheets.stock_watch.toRecords()[0];
    assert.equal(row.symbol, '00631L');
    assert.equal(row.name, '元大台灣50正2');
    assert.equal(row.added_by, NEIL);
    assert.equal(row.is_active, 'TRUE');
  });

  test('非管理者不能改自選', () => {
    const e = env();
    assert.equal(add(e, 'MOM', '2330').error, 'forbidden');
    assert.equal(e.sheets.stock_watch.toRecords().length, 0);
  });

  test('第 16 檔被拒絕；停用一檔之後就加得進去', () => {
    const rows = [['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at']];
    for (let i = 0; i < 15; i++) rows.push([String(1101 + i), 'x', i * 10, 'TRUE', NEIL, '']);
    const e = env({ sheets: { stock_watch: new FakeSheet('stock_watch', rows) } });
    assert.equal(add(e, 'NEIL', '2330').error, 'watch_full');
    assert.equal(add(e, 'NEIL', '1101', { is_active: false }).success, true);
    assert.equal(add(e, 'NEIL', '2330').success, true);
    assert.equal(e.sheets.stock_watch.toRecords().filter((r) => r.is_active === 'TRUE').length, 15);
  });

  test('查不到的代號不寫入', () => {
    const e = env();
    assert.equal(add(e, 'NEIL', '0063L').error, 'invalid_symbol');
  });
});

/* ========================================================================== */
describe('T2 交易：持有者與權限由後端強制（PWA upsert）', () => {
  const up = (e, tok, record) => post(e, { action: 'upsert', token: TOK[tok], sheet: 'stock_trades', record, trigger: 'write' });
  const base = { trade_date: '2026-10-08', symbol: '00631L', side: 'buy', qty: 1000, price: 41.28 };

  test('非管理者指定別人 → 覆寫成自己的 member，並回 owner_overridden', () => {
    const e = env();
    const out = up(e, 'MOM', Object.assign({ id: 't1', owner: '爸爸' }, base));
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.owner_overridden, true);
    assert.equal(trades(e)[0].owner, '媽媽');
    assert.equal(trades(e)[0].line_id, MOM);
  });

  test('沒設 member 的非管理者拒絕寫入', () => {
    const e = env();
    assert.equal(up(e, 'KID', Object.assign({ id: 't1' }, base)).error, 'no_member');
    assert.equal(trades(e).length, 0);
  });

  test('管理者可以指定家人；不在家人名單（含停用的）就拒絕', () => {
    const e = env();
    assert.equal(up(e, 'NEIL', Object.assign({ id: 't1', owner: '媽媽' }, base)).success, true);
    assert.equal(trades(e)[0].owner, '媽媽');
    assert.equal(up(e, 'NEIL', Object.assign({ id: 't2', owner: '前室友' }, base)).error, 'owner_not_member');
    assert.equal(up(e, 'NEIL', Object.assign({ id: 't3', owner: '汽車V' }, base)).error, 'owner_not_member');
  });

  test('管理者沒指定 → 自己的 member', () => {
    const e = env();
    up(e, 'NEIL', Object.assign({ id: 't1' }, base));
    assert.equal(trades(e)[0].owner, '爸爸');
  });

  test('非管理者改不到別人記的那一筆；line_id 不能被前端改掉', () => {
    const e = env({ sheets: { stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('t1', '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL)]) } });
    assert.equal(up(e, 'MOM', Object.assign({}, base, { id: 't1', qty: 1 })).error, 'not_your_trade');
    assert.equal(trades(e)[0].qty, 1000);
    up(e, 'NEIL', Object.assign({}, base, { id: 't1', line_id: MOM, owner: '爸爸' }));
    assert.equal(trades(e)[0].line_id, NEIL);
  });

  test('賣超過持有量拒絕；刪掉一筆買進讓後面的賣出變賣超，也拒絕', () => {
    const e = env({ sheets: { stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('b1', '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL),
      trade('s1', '2026-10-02', '00631L', 'sell', 800, 45, '爸爸', NEIL)]) } });
    const over = up(e, 'NEIL', { id: 's2', trade_date: '2026-10-08', symbol: '00631L', side: 'sell', qty: 300, price: 41, owner: '爸爸' });
    assert.equal(over.error, 'oversold');
    assert.equal(over.held, 200);
    assert.equal(up(e, 'NEIL', { id: 'b1', del: 'TRUE' }).error, 'oversold');
    assert.equal(trades(e).length, 2);
    // 先刪賣出、再刪買進：兩步都放行（軟刪除）
    assert.equal(up(e, 'NEIL', { id: 's1', del: 'TRUE' }).success, true);
    assert.equal(up(e, 'NEIL', { id: 'b1', del: 'TRUE' }).success, true);
    assert.ok(trades(e).every((t) => t.del === 'TRUE'));
  });

  test('格式：side、數量（股票整數股）、價格、日期不對都擋；全形與千分位收', () => {
    const e = env();
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', side: 'hold' })).field, 'side');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', qty: 1.5 })).field, 'qty');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', price: 0 })).field, 'price');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', trade_date: '10/8' })).field, 'trade_date');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', symbol: '００６３１ｌ', qty: '1,000' })).success, true);
    assert.equal(trades(e)[0].symbol, '00631L');
    assert.equal(trades(e)[0].qty, 1000);
  });

  test('沒出現過的代號查報價確認；查不到不寫入', () => {
    const e = env();
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', symbol: '0063L' })).error, 'invalid_symbol');
    assert.equal(trades(e).length, 0);
  });

  test('股票表只開 upsert 與封存', () => {
    const e = env();
    assert.equal(post(e, { action: 'completeRecurring', token: TOK.NEIL, sheet: 'stock_trades', record: { id: 'x' } }).error, 'unknown_action');
    assert.equal(post(e, { action: 'completeRecurring', token: TOK.NEIL, sheet: 'stock_rules', record: { id: 'x' } }).error, 'unknown_action');
  });

  test('feat_stock 關閉者：讀不到、寫不進、readMany 不帶股票資料', () => {
    const e = env();
    assert.equal(post(e, { action: 'read', token: TOK.AUNT, sheet: 'stock_trades' }).error, 'forbidden');
    assert.equal(up(e, 'AUNT', Object.assign({ id: 't1' }, base)).error, 'forbidden');
    const many = post(e, { action: 'readMany', token: TOK.AUNT, sheets: ['tasks'], stock: true, trigger: 'poll' });
    assert.equal(many.stock, undefined);
    assert.equal(e.net.calls.all.length, 0);
  });

  test('名單只有管理者能改：非管理者不能改自己的 member 或 is_admin', () => {
    const e = env();
    for (const record of [{ line_id: MOM, member: '爸爸' }, { line_id: MOM, is_admin: 'TRUE' }]) {
      const out = post(e, { action: 'upsert', token: TOK.MOM, sheet: 'line_users', key_field: 'line_id', record, trigger: 'write' });
      assert.equal(out.error, 'forbidden');
    }
    const mom = e.sheets.line_users.toRecords().find((u) => u.line_id === MOM);
    assert.equal(mom.member, '媽媽');
    assert.equal(mom.is_admin, '');
    const ok = post(e, { action: 'upsert', token: TOK.NEIL, sheet: 'line_users', key_field: 'line_id',
      record: Object.assign({}, mom, { member: '姐姐' }), trigger: 'write' });
    assert.equal(ok.success, true);
  });

  test('_stock_config／stock_daily 對 PWA 不可讀不可寫', () => {
    const e = env();
    for (const sheet of ['_stock_config', 'stock_daily', '_stock_gf']) {
      assert.equal(post(e, { action: 'read', token: TOK.NEIL, sheet }).error, 'sheet_not_readable', sheet);
      assert.equal(post(e, { action: 'upsert', token: TOK.NEIL, sheet, record: { key: 'cash', value: 1 } }).error, 'sheet_not_writable', sheet);
    }
  });
});

/* ========================================================================== */
describe('T4 的資料來源：readMany 附帶股票資料', () => {
  const sheets = () => ({
    stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('b1', '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL),
      trade('b2', '2026-10-02', '2330', 'buy', 100, 2400, '媽媽', MOM)]),
    stock_watch: new FakeSheet('stock_watch', [['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at'],
      ['0050', '元大台灣50', 20, 'TRUE', NEIL, ''], ['00631L', '元大台灣50正2', 10, 'TRUE', NEIL, ''], ['6488', '環球晶', 30, 'FALSE', NEIL, '']])
  });

  test('stock:true → 自選（只有啟用中、依 sort）、全家交易、持股、報價、家人名單、我的 member', () => {
    const e = env({ sheets: sheets() });
    const out = post(e, { action: 'readMany', token: TOK.MOM, sheets: ['tasks'], stock: true, trigger: 'poll' });
    const s = out.stock;
    assert.deepEqual(s.watch.map((w) => w.symbol), ['00631L', '0050']);
    assert.equal(s.trades.length, 2, '有 feat_stock 看全家，不套用「只看我的」');
    assert.deepEqual(s.holdings.map((h) => h.owner + h.symbol), ['爸爸00631L', '媽媽2330']);
    assert.deepEqual(Object.keys(s.quotes).sort(), ['0050', '00631L', '2330']);
    assert.deepEqual(s.members, ['姐姐', '爸爸', '媽媽']);
    assert.equal(s.my_member, '媽媽');
    assert.equal(s.ready, true);
  });

  test('沒帶 stock:true（不在財務區）→ 不帶、不打外部', () => {
    const e = env({ sheets: sheets() });
    const out = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], trigger: 'poll' });
    assert.equal(out.stock, undefined);
    assert.equal(e.net.calls.all.length, 0);
  });

  test('boot 也帶（開機就在財務區）', () => {
    const e = env({ sheets: sheets() });
    const out = post(e, { action: 'boot', token: TOK.NEIL, stock: true, trigger: 'cold' });
    assert.equal(out.stock.holdings.length, 2);
  });

  test('報價整個掛掉：交易與持股照常回，報價是空的', () => {
    const e = env({ sheets: sheets(), net: network({ fail: { fugle: true, mis: true } }), overrides: { googleFinanceValues_: () => { throw new Error('quota'); } } });
    const out = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], stock: true, trigger: 'poll' });
    assert.equal(out.stock.holdings.length, 2);
    assert.deepEqual(out.stock.quotes, {});
    assert.equal(out.stock.missing.length, 3);
  });

  test('分頁還沒建（還沒「初始化」）→ ready:false，不報錯', () => {
    const e = env();
    delete e.sheets.stock_trades;
    const out = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], stock: true, trigger: 'poll' });
    assert.equal(out.stock.ready, false);
  });
});

/* ========================================================================== */
describe('T3 LINE「買/」「賣/」「股/」', () => {
  test('買/00631L/1000/41.28 → 寫一列、持有者＝自己的 member、回覆照票面格式', () => {
    const e = env({ sheets: { stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('b0', '2026-10-01', '00631L', 'buy', 2000, 39.135, '爸爸', NEIL)]) } });
    const reply = line(e, NEIL, '買/00631L/1000/41.28');
    assert.equal(reply, '✅ 買進 00631L 元大台灣50正2\n1,000 股 × 41.28 = 41,280\n爸爸持有 3,000 股｜均價 39.85');
    const row = trades(e)[1];
    assert.equal(row.symbol, '00631L');
    assert.equal(row.side, 'buy');
    assert.equal(row.owner, '爸爸');
    assert.equal(row.line_id, NEIL);
    assert.match(row.trade_date, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('買/gold/1.5/3518 → GOLD、公克、不打報價', () => {
    const e = env();
    const reply = line(e, NEIL, '買/gold/1.5/3518');
    assert.match(reply, /^✅ 買進 GOLD 黃金\n1\.5 公克 × 3,518 = 5,277\n爸爸持有 1\.5 公克/);
    assert.equal(trades(e)[0].symbol, 'GOLD');
    assert.equal(trades(e)[0].qty, 1.5);
    assert.equal(e.net.calls.all.length, 0);
  });

  test('全形代號、全形數字、千分位：買/００６３１Ｌ/1,000/41.28', () => {
    const e = env();
    line(e, NEIL, '買/００６３１Ｌ/１,０００/41.28');
    assert.equal(trades(e)[0].symbol, '00631L');
    assert.equal(trades(e)[0].qty, 1000);
  });

  test('代號無效（0063L）→ 不寫入', () => {
    const e = env();
    const reply = line(e, NEIL, '買/0063L/1000/41.28');
    assert.match(reply, /查不到「0063L」/);
    assert.equal(trades(e).length, 0);
  });

  test('缺價格、數量不是數字、股票打小數 → 回格式提示、不寫入', () => {
    const e = env();
    assert.match(line(e, NEIL, '買/00631L/1000'), /少了欄位/);
    assert.match(line(e, NEIL, '買/00631L/很多/41'), /數量要是正數/);
    assert.match(line(e, NEIL, '買/00631L/1.5/41'), /整數股/);
    assert.match(line(e, NEIL, '買/00631L/1000/零'), /價格要是正數/);
    assert.equal(trades(e).length, 0);
  });

  test('賣超過持有量 → 拒絕並回目前持有量', () => {
    const e = env({ sheets: { stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('b0', '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL)]) } });
    const reply = line(e, NEIL, '賣/00631L/1500/45');
    assert.match(reply, /爸爸目前持有 00631L 1,000 股/);
    assert.equal(trades(e).length, 1);
    assert.match(line(e, NEIL, '賣/00631L/400/45'), /✅ 賣出 00631L.*\n.*\n爸爸持有 600 股｜均價 40$/);
  });

  test('第五段：管理者生效；非管理者被覆寫並提示；沒設 member 拒絕', () => {
    const e = env();
    line(e, NEIL, '買/00631L/1000/41.28/媽媽');
    assert.equal(trades(e)[0].owner, '媽媽');
    const momReply = line(e, MOM, '買/00631L/100/41.28/爸爸');
    assert.match(momReply, /持有者只能是你自己/);
    assert.equal(trades(e)[1].owner, '媽媽');
    assert.match(line(e, KID, '買/00631L/100/41.28'), /請管理者先設定你是家人名單裡的哪一位/);
    assert.match(line(e, NEIL, '買/00631L/100/41.28/路人'), /不在家人名單/);
    assert.equal(trades(e).length, 2);
  });

  test('群組裡的「買/」「賣/」「股/」被拒絕、不寫入、不報價', () => {
    const groups = new FakeSheet('line_groups', [['group_id', 'type', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'notify_due', 'left_at'],
      ['Cgroup', 'group', '家', 'TRUE', 'TRUE', 'TRUE', 'TRUE', '', '']]);
    const e = env({ sheets: { line_groups: groups } });
    for (const text of ['買/00631L/1000/41.28', '賣/00631L/1/41', '股/2330']) {
      const reply = line(e, NEIL, text, { type: 'group', groupId: 'Cgroup', userId: NEIL });
      assert.match(reply, /只能在跟 bot 的一對一聊天室用/, text);
    }
    assert.equal(trades(e).length, 0);
    assert.equal(e.net.calls.all.length, 0);
  });

  test('feat_stock 關閉者：被擋、寫 logs、不寫入', () => {
    const e = env();
    assert.match(line(e, AUNT, '買/00631L/1000/41.28'), /沒有「股票」功能的權限/);
    assert.match(line(e, AUNT, '股/2330'), /沒有「股票」功能的權限/);
    assert.equal(trades(e).length, 0);
    assert.ok(e.transactions.some((t) => t[0] === '股票' && t[1] === '失敗' && t[6] === AUNT));
  });

  test('股/2330 → 現價、漲跌、漲跌%、來源與時間；有持股加一行持有量與損益', () => {
    const e = env({ sheets: { stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS,
      trade('b0', '2026-10-01', '2330', 'buy', 100, 2400, '媽媽', MOM)]) } });
    const reply = line(e, MOM, '股/2330');
    assert.match(reply, /^📈 2330 台積電\n2,560（-25｜-0\.97%）\n富果 · \d\d:\d\d:\d\d\n媽媽持有 100 股｜均價 2,400｜損益 \+16,000（\+6\.67%）$/);
    assert.doesNotMatch(line(e, NEIL, '股/2330'), /持有/, '爸爸沒有持股，不加那一行');
  });

  test('股/GOLD 不抓價；股/0063L 查不到', () => {
    const e = env();
    assert.match(line(e, NEIL, '股/gold'), /黃金只記錄、不抓價/);
    assert.match(line(e, NEIL, '股/0063L'), /查不到/);
  });

  test('分頁還沒建 → 請管理者初始化', () => {
    const e = env();
    delete e.sheets.stock_trades;
    assert.match(line(e, NEIL, '買/00631L/1000/41.28'), /請管理者傳「初始化」/);
  });
});

/* ========================================================================== */
describe('初始化：建表、補欄位、feat_stock 只預設開管理者', () => {
  test('重複執行三次：五張表各一張、表頭正確；feat_stock 只在第一次補欄時替管理者打勾', () => {
    const e = env({ sheets: { line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense'],
      [NEIL, 'Neil', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '麗英', 'TRUE', '', 'TRUE']]) } });
    delete e.sheets.stock_trades; delete e.sheets.stock_watch; delete e.sheets.stock_rules;
    const first = e.call('installStock_');
    assert.equal(first.level, 'ok', first.text);
    const u = e.sheets.line_users.toRecords();
    assert.equal(u[0].feat_stock, 'TRUE');
    assert.equal(u[1].feat_stock, '');
    // Neil 之後把自己的關掉：再跑兩次也不會被蓋回來
    e.sheets.line_users.values[1][5] = '';
    e.call('installStock_');
    e.call('installStock_');
    assert.equal(e.sheets.line_users.toRecords()[0].feat_stock, '');
    for (const name of ['stock_trades', 'stock_watch', 'stock_rules', 'stock_daily', '_stock_config']) {
      assert.equal(e.ss.getSheets().filter((s) => s.getName() === name).length, 1, name);
    }
    assert.deepEqual(e.sheets.stock_trades.values[0], TRADE_HEADERS);
    assert.deepEqual(e.sheets._stock_config.toRecords().map((r) => r.key),
      ['rebalance_symbol', 'rebalance_owner', 'cash', 'cash_updated_at', 'target_pct', 'threshold_rel_pct']);
  });

  test('已經有 feat_stock、只缺 member：只補 member，不動任何人的 feat_stock', () => {
    const e = env({ sheets: { line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_stock'],
      [NEIL, 'Neil', 'TRUE', 'TRUE', '']]) } });
    const out = e.call('installStock_');
    assert.match(out.text, /line_users 補上：member/);
    assert.equal(e.sheets.line_users.toRecords()[0].feat_stock, '');
  });

  test('「初始化」的回覆列出股票那一步', () => {
    const e = env();
    const reply = line(e, NEIL, '初始化');
    assert.match(reply, /股票（ADR-015）/);
  });
});

/* ========================================================================== */
/* PR-B                                                                        */
/* ========================================================================== */

const CONFIG = (over = {}) => {
  const c = Object.assign({ rebalance_symbol: '00631L', rebalance_owner: '', cash: 200000, cash_updated_at: '2026-10-08',
    target_pct: 50, threshold_rel_pct: 25 }, over);
  return new FakeSheet('_stock_config', [['key', 'value']].concat(Object.entries(c)));
};
const RULE_HEADERS = ['id', 'symbol', 'type', 'params', 'enabled', 'auto_push', 'cooldown_days', 'last_fired_at', 'line_id', 'created_at', 'del'];
const rule = (id, symbol, type, params, lineId, extra = {}) => Object.assign({ id, symbol, type, params: JSON.stringify(params),
  enabled: 'TRUE', auto_push: '', cooldown_days: 1, last_fired_at: '', line_id: lineId, created_at: '', del: '' }, extra);
const rulesSheet = (rows) => new FakeSheet('stock_rules', [RULE_HEADERS].concat(rows.map((r) => RULE_HEADERS.map((h) => r[h]))));
const Q = (price, changePct = 0) => ({ price, prevClose: price, change: 0, changePct, time: '', source: 'fugle', name: '' });

describe('T5 再平衡（computeRebalance_）', () => {
  const calc = (e, price, cfg = {}, holdings = [{ owner: '爸爸', symbol: '00631L', qty: 1000, cost: 1, avg_cost: 0.001 }]) =>
    e.call('computeRebalance_', Object.assign({ rebalance_symbol: '00631L', rebalance_owner: '', cash: 200000,
      cash_updated_at: '2026-10-08', target_pct: 50, threshold_rel_pct: 25 }, cfg), holdings, { '00631L': Q(price) }, '爸爸', '2026-10-08');

  test('票面三個例子：53.27% 不亮、60% 不亮、64.3% 亮燈建議賣出 80,000', () => {
    const e = env();
    const a = calc(e, 228);
    assert.equal(a.status, 'ok');
    assert.equal(a.value, 228000);
    assert.equal(a.ratio_pct, 53.27);
    assert.equal(a.low_pct, 37.5);
    assert.equal(a.high_pct, 62.5);
    assert.equal(a.alert, false);
    assert.equal(a.suggest_amount, 0, '沒亮燈不給建議');
    const b = calc(e, 300);
    assert.equal(b.ratio_pct, 60);
    assert.equal(b.alert, false);
    const c = calc(e, 360);
    assert.equal(c.ratio_pct, 64.29);
    assert.equal(c.alert, true);
    assert.equal(c.suggest_amount, -80000);
    assert.equal(c.suggest_shares, -222);
  });

  test('低於區間 → 建議買入（正數）', () => {
    const e = env();
    const r = calc(e, 100);                    // V=100,000 / 300,000 = 33.3%
    assert.equal(r.alert, true);
    assert.equal(r.suggest_amount, 50000);
  });

  test('沒持股、沒填現金：卡片不出現（status 不是 ok）', () => {
    const e = env();
    assert.equal(calc(e, 228, {}, []).status, 'no_holding');
    assert.equal(calc(e, 228, { cash: '' }).status, 'no_cash');
  });

  test('持有者：留白＝管理者自己的 member；指定了就看那個人', () => {
    const e = env();
    const momOnly = [{ owner: '媽媽', symbol: '00631L', qty: 1000, cost: 1, avg_cost: 0.001 }];
    assert.equal(calc(e, 228, {}, momOnly).status, 'no_holding');
    assert.equal(calc(e, 228, { rebalance_owner: '媽媽' }, momOnly).status, 'ok');
  });

  test('現金超過 30 天沒更新 → cash_stale', () => {
    const e = env();
    assert.equal(calc(e, 228, { cash_updated_at: '2026-09-08' }).cash_stale, false);
    assert.equal(calc(e, 228, { cash_updated_at: '2026-09-07' }).cash_stale, true);
  });
});

describe('T5 再平衡只給管理者', () => {
  const sheets = () => ({
    _stock_config: CONFIG(),
    stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS, trade('b1', '2026-10-01', '00631L', 'buy', 5000, 40, '爸爸', NEIL)])
  });

  test('管理者的 readMany 帶 config 與 rebalance；非管理者連鍵都沒有', () => {
    const e = env({ sheets: sheets() });
    const admin = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], stock: true, trigger: 'poll' }).stock;
    assert.equal(admin.rebalance.status, 'ok');
    assert.equal(admin.rebalance.value, 206400);
    assert.equal(admin.config.cash, 200000);
    const mom = post(e, { action: 'readMany', token: TOK.MOM, sheets: ['tasks'], stock: true, trigger: 'poll' }).stock;
    assert.equal('rebalance' in mom, false);
    assert.equal('config' in mom, false);
  });

  test('stockConfigSet：管理者改現金會一起寫 cash_updated_at；非管理者被擋；值不對被擋', () => {
    const s = sheets();
    s._stock_config = CONFIG({ cash_updated_at: '2020-01-01' });
    const e = env({ sheets: s });
    const out = post(e, { action: 'stockConfigSet', token: TOK.NEIL, key: 'cash', value: '250,000', trigger: 'write' });
    assert.equal(out.success, true, JSON.stringify(out));
    const cfg = Object.fromEntries(e.sheets._stock_config.toRecords().map((r) => [r.key, r.value]));
    assert.equal(cfg.cash, 250000);
    assert.match(String(cfg.cash_updated_at), /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(cfg.cash_updated_at, '2020-01-01', '改現金要一起更新日期');
    assert.equal(post(e, { action: 'stockConfigSet', token: TOK.MOM, key: 'cash', value: 1 }).error, 'forbidden');
    assert.equal(post(e, { action: 'stockConfigSet', token: TOK.NEIL, key: 'target_pct', value: 100 }).error, 'invalid_value');
    assert.equal(post(e, { action: 'stockConfigSet', token: TOK.NEIL, key: 'rebalance_owner', value: '路人' }).error, 'owner_not_member');
    assert.equal(post(e, { action: 'stockConfigSet', token: TOK.NEIL, key: 'cash_updated_at', value: '2020-01-01' }).error, 'invalid_key');
  });
});

describe('T6 規則判斷（evaluateRule_，判斷只有這一份）', () => {
  const ev = (e, r, q, holdings = []) => e.call('evaluateRule_', r, q, holdings).status;

  test('四種 type 各自命中與不命中', () => {
    const e = env();
    assert.equal(ev(e, rule('1', '2330', 'price_above', { price: 2700 }, NEIL), Q(2700)), 'hit');
    assert.equal(ev(e, rule('1', '2330', 'price_above', { price: 2700 }, NEIL), Q(2699)), 'miss');
    assert.equal(ev(e, rule('2', '00631L', 'price_below', { price: 38 }, NEIL), Q(38)), 'hit');
    assert.equal(ev(e, rule('2', '00631L', 'price_below', { price: 38 }, NEIL), Q(38.01)), 'miss');
    assert.equal(ev(e, rule('3', '2330', 'change_pct', { pct: 3 }, NEIL), Q(1, -3.2)), 'hit');
    assert.equal(ev(e, rule('3', '2330', 'change_pct', { pct: 3 }, NEIL), Q(1, 2.9)), 'miss');
    const held = [{ owner: '爸爸', symbol: '00631L', qty: 1000, cost: 40000, avg_cost: 40 }];
    assert.equal(ev(e, rule('4', '00631L', 'cost_pct', { pct: -15, owner: '爸爸' }, NEIL), Q(34), held), 'hit');
    assert.equal(ev(e, rule('4', '00631L', 'cost_pct', { pct: -15, owner: '爸爸' }, NEIL), Q(34.1), held), 'miss');
    assert.equal(ev(e, rule('5', '00631L', 'cost_pct', { pct: 20, owner: '爸爸' }, NEIL), Q(48), held), 'hit');
    assert.equal(ev(e, rule('5', '00631L', 'cost_pct', { pct: 20, owner: '爸爸' }, NEIL), Q(47.9), held), 'miss');
  });

  test('cost_pct 那個持有者沒持股 → 不判斷（skip，不是 miss 也不是 hit）', () => {
    const e = env();
    assert.equal(ev(e, rule('4', '00631L', 'cost_pct', { pct: -15, owner: '媽媽' }, NEIL), Q(1), []), 'skip');
  });

  test('不認得的 type 回 unknown；參數壞掉回 invalid', () => {
    const e = env();
    assert.equal(ev(e, rule('9', '2330', 'rsi_above', { v: 70 }, NEIL), Q(1)), 'unknown');
    assert.equal(ev(e, Object.assign(rule('8', '2330', 'price_above', {}, NEIL), { params: '{壞掉' }), Q(1)), 'invalid');
  });

  test('ruleHits_：unknown 略過、記 logs（6 小時內同一條只記一次），不中斷其他規則；停用與刪除的不算', () => {
    const e = env();
    const rules = [rule('9', '2330', 'rsi_above', {}, NEIL), rule('1', '2330', 'price_above', { price: 1 }, NEIL),
      rule('2', '2330', 'price_above', { price: 1 }, NEIL, { enabled: '' }), rule('3', '2330', 'price_above', { price: 1 }, NEIL, { del: 'TRUE' })];
    const hits = e.call('ruleHits_', rules, { 2330: Q(2560) }, []);
    assert.deepEqual(hits['2330'].map((h) => h.id), ['1']);
    e.call('ruleHits_', rules, { 2330: Q(2560) }, []);
    assert.equal(e.transactions.filter((t) => /不認得的規則類型/.test(t[3])).length, 1);
  });
});

describe('T6 規則的寫入與讀取', () => {
  const up = (e, tok, record) => post(e, { action: 'upsert', token: TOK[tok], sheet: 'stock_rules', record, trigger: 'write' });
  const base = { id: 'r1', symbol: '2330', type: 'price_above', params: { price: 2700 }, enabled: true, auto_push: true, cooldown_days: 1 };

  test('建立：line_id 一律是本人、params 存成 JSON、布林存 TRUE／空白', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([]) } });
    const out = up(e, 'MOM', Object.assign({}, base, { line_id: NEIL, last_fired_at: '2099-01-01' }));
    assert.equal(out.success, true, JSON.stringify(out));
    const r = e.sheets.stock_rules.toRecords()[0];
    assert.equal(r.line_id, MOM);
    assert.equal(r.params, '{"price":2700}');
    assert.equal(r.enabled, 'TRUE');
    assert.equal(r.last_fired_at, '', '只有排程會寫 last_fired_at');
  });

  test('只能改自己的規則（管理者也一樣）；不認得的 type、冷卻 0 天、黃金、cost_pct 持有者不在名單都擋', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([rule('r1', '2330', 'price_above', { price: 1 }, MOM)]) } });
    assert.equal(up(e, 'NEIL', Object.assign({}, base)).error, 'not_your_rule');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', type: 'rsi_above' })).field, 'type');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', cooldown_days: 0 })).field, 'cooldown_days');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', symbol: 'GOLD' })).error, 'invalid_symbol');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', type: 'cost_pct', params: { pct: -15, owner: '路人' } })).error, 'owner_not_member');
    assert.equal(up(e, 'NEIL', Object.assign({}, base, { id: 'x', params: { price: -1 } })).field, 'params');
  });

  test('readMany：只回自己的規則；命中的帶原因（判斷在雲端）', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([
      rule('r1', '2330', 'price_above', { price: 2500 }, MOM), rule('r2', '2330', 'price_below', { price: 1 }, MOM),
      rule('r3', '2330', 'price_above', { price: 1 }, NEIL)]) } });
    const s = post(e, { action: 'readMany', token: TOK.MOM, sheets: ['tasks'], stock: true, trigger: 'poll' }).stock;
    assert.deepEqual(s.rules.map((r) => r.id), ['r1', 'r2']);
    assert.deepEqual(s.hits['2330'].map((h) => h.id), ['r1']);
    assert.match(s.hits['2330'][0].reason, /現價 2,560 ≥ 2,500/);
    assert.ok('2330' in s.quotes, '規則用到的代號就算不在自選裡也要報價');
  });
});

describe('T6 自動推播（checkStockRules）', () => {
  const run = (e, now = OPEN) => e.call('checkStockRules', now);

  test('非交易時段直接結束，不讀規則、不打外部', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([rule('r1', '2330', 'price_above', { price: 1 }, MOM, { auto_push: 'TRUE' })]) } });
    assert.deepEqual(run(e, SATURDAY), { skipped: 'closed' });
    assert.equal(e.net.calls.all.length, 0);
    assert.equal(e.pushes.length, 0);
  });

  test('沒有 enabled && auto_push 的規則 → 不打報價（fetch 次數＝0），但寫一列 performance', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([rule('r1', '2330', 'price_above', { price: 1 }, MOM),
      rule('r2', '2330', 'price_above', { price: 1 }, MOM, { auto_push: 'TRUE', enabled: '' })]) } });
    assert.equal(run(e).candidates, 0);
    assert.equal(e.net.calls.all.length, 0);
    assert.ok(e.sheets.performance.toRecords().some((r) => r.action === 'stockRules' && r.trigger === 'schedule'));
  });

  test('命中 → 推給規則建立者、寫 last_fired_at、寫 logs；冷卻內不重推；過了冷卻再推', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([rule('r1', '2330', 'price_above', { price: 2500 }, MOM, { auto_push: 'TRUE' })]) } });
    assert.equal(run(e).pushed, 1);
    assert.equal(e.pushes[0].to, MOM);
    assert.match(e.pushes[0].text, /股票提醒：2330 台積電\n現價 2,560 ≥ 2,500/);
    assert.equal(e.sheets.stock_rules.toRecords()[0].last_fired_at, OPEN.toISOString());
    assert.ok(e.transactions.some((t) => t[0] === '股票提醒' && t[1] === '成功'));
    e.clock.advance(61);
    assert.equal(run(e, new Date(OPEN.getTime() + 3600000)).pushed, 0, '一小時後還在冷卻（1 天）');
    assert.equal(e.pushes.length, 1);
    e.clock.advance(61);
    assert.equal(run(e, new Date(OPEN.getTime() + 86400000)).pushed, 1, '隔天同一時間');
  });

  test('不認得的 type 不中斷其他規則；推播失敗不寫 last_fired_at', () => {
    const e = env({
      sheets: { stock_rules: rulesSheet([rule('r0', '2330', 'rsi_above', {}, NEIL, { auto_push: 'TRUE' }),
        rule('r1', '2330', 'price_above', { price: 1 }, MOM, { auto_push: 'TRUE' })]) },
      pushImpl: () => ({ ok: false, code: 429, reason: 'quota' })
    });
    assert.equal(run(e).pushed, 0);
    assert.equal(e.pushes.length, 1, 'r1 還是有試著推');
    assert.equal(e.sheets.stock_rules.toRecords()[1].last_fired_at, '');
    assert.ok(e.transactions.some((t) => t[0] === '股票提醒' && t[1] === '失敗'));
  });

  test('「推給我」：只推給自己、只推自己命中的；沒命中回 no_hit', () => {
    const e = env({ sheets: { stock_rules: rulesSheet([rule('r1', '2330', 'price_above', { price: 2500 }, MOM),
      rule('r2', '0050', 'price_above', { price: 9999 }, MOM)]) } });
    assert.equal(post(e, { action: 'stockPushMe', token: TOK.MOM, symbol: '2330', trigger: 'manual' }).success, true);
    assert.equal(e.pushes[0].to, MOM);
    assert.equal(post(e, { action: 'stockPushMe', token: TOK.MOM, symbol: '0050', trigger: 'manual' }).error, 'no_hit');
    assert.equal(post(e, { action: 'stockPushMe', token: TOK.NEIL, symbol: '2330', trigger: 'manual' }).error, 'no_hit', 'Neil 沒有規則');
    assert.equal(post(e, { action: 'stockPushMe', token: TOK.AUNT, symbol: '2330', trigger: 'manual' }).error, 'forbidden');
    assert.equal(e.pushes.length, 1);
  });
});

describe('T7 盤後收盤價（fetchStockDaily）', () => {
  const DAILY_HEADERS = ['date', 'symbol', 'close', 'prev_close', 'source'];
  const TWSE = [{ Date: '1151008', Code: '2330', ClosingPrice: '2,560.00', Change: '-25.0000' },
    { Date: '1151008', Code: '00631L', ClosingPrice: '41.28', Change: '+1.2800' },
    { Date: '1151008', Code: '1101', ClosingPrice: '30.00', Change: '0.0000' },
    { Date: '1151008', Code: '0050', ClosingPrice: '115.00', Change: '-1.0000' }];
  const TPEX = [{ Date: '1151008', SecuritiesCompanyCode: '6488', Close: '1130.00', Change: '-85.00' }];
  function dailyNet({ twse = TWSE, tpex = TPEX, bom = false } = {}) {
    const calls = { twse: 0, tpex: 0, all: [] };
    const res = (status, body) => ({ getResponseCode: () => status, getContentText: () => (bom ? '﻿' : '') + JSON.stringify(body) });
    return { calls, UrlFetchApp: {
      fetchAll: () => { throw new Error('盤後不該打即時報價'); },
      fetch: (url) => {
        calls.all.push(url);
        if (url.includes('openapi.twse')) { calls.twse++; return res(200, twse); }
        if (url.includes('tpex')) { calls.tpex++; return res(200, tpex); }
        throw new Error('沒預期的網址 ' + url);
      } } };
  }
  const sheets = (dailyRows = []) => ({
    stock_daily: new FakeSheet('stock_daily', [DAILY_HEADERS].concat(dailyRows)),
    stock_watch: new FakeSheet('stock_watch', [['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at'],
      ['2330', '', 10, 'TRUE', NEIL, ''], ['6488', '', 20, 'TRUE', NEIL, ''], ['0050', '', 30, 'FALSE', NEIL, '']]),
    stock_trades: new FakeSheet('stock_trades', [TRADE_HEADERS, trade('b1', '2026-10-01', '00631L', 'buy', 1000, 40, '爸爸', NEIL),
      trade('b2', '2026-10-01', 'GOLD', 'buy', 1, 3500, '爸爸', NEIL)])
  });

  test('只寫自選（啟用中）＋有持股的代號；上市讀證交所、上櫃讀櫃買；昨收＝收盤－漲跌；民國年換西元', () => {
    const e = env({ net: dailyNet(), sheets: sheets() });
    const out = e.call('fetchStockDaily');
    assert.equal(out.written, 3);
    const rows = e.sheets.stock_daily.toRecords();
    assert.deepEqual(rows.map((r) => r.symbol).sort(), ['00631L', '2330', '6488'], '停用的自選（0050）、沒追蹤的（1101）不寫');
    assert.deepEqual(out.missing, [], '黃金不抓收盤價，也不算「找不到」');
    const tsmc = rows.find((r) => r.symbol === '2330');
    assert.equal(tsmc.date, '2026-10-08');
    assert.equal(tsmc.close, 2560);
    assert.equal(tsmc.prev_close, 2585);
    assert.equal(rows.find((r) => r.symbol === '6488').source, 'tpex');
    assert.ok(e.sheets.performance.toRecords().some((r) => r.action === 'stockDaily' && r.trigger === 'schedule'));
  });

  test('同一天重跑不重複寫；資料沒更新（假日）不寫，但寫一列 logs 說明', () => {
    const e = env({ net: dailyNet(), sheets: sheets() });
    e.call('fetchStockDaily');
    const n = e.sheets.stock_daily.toRecords().length;
    const again = e.call('fetchStockDaily');
    assert.equal(again.written, 0);
    assert.equal(e.sheets.stock_daily.toRecords().length, n);
    assert.ok(e.transactions.some((t) => t[2] === '盤後收盤價' && /沒有新的收盤價/.test(t[3]) && /資料日期 2026-10-08/.test(t[4])));
  });

  test('全部都在證交所就不打櫃買；開頭帶 BOM 照樣讀得到', () => {
    const s = sheets();
    s.stock_watch = new FakeSheet('stock_watch', [['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at'], ['2330', '', 10, 'TRUE', NEIL, '']]);
    const net = dailyNet({ bom: true });
    const e = env({ net, sheets: s });
    assert.equal(e.call('fetchStockDaily').written, 2);
    assert.equal(net.calls.tpex, 0);
  });

  test('證交所掛了：上櫃照樣寫，缺的代號與錯誤寫進 logs', () => {
    const net = dailyNet();
    const fetch = net.UrlFetchApp.fetch;
    net.UrlFetchApp.fetch = (url) => (url.includes('openapi.twse') ? { getResponseCode: () => 503, getContentText: () => '' } : fetch(url));
    const e = env({ net, sheets: sheets() });
    assert.equal(e.call('fetchStockDaily').written, 1);
    assert.ok(e.transactions.some((t) => t[2] === '盤後收盤價' && /找不到：.*2330/.test(t[4]) && /HTTP 503/.test(t[4])));
  });
});

describe('初始化：股票的兩個排程', () => {
  test('跑三次：checkStockRules（每 5 分鐘）與 fetchStockDaily（每天約 14:30）各只有一個', () => {
    const e = env();
    for (let i = 0; i < 3; i++) line(e, NEIL, '初始化');
    const rules = e.triggers.filter((t) => t.handler === 'checkStockRules');
    const daily = e.triggers.filter((t) => t.handler === 'fetchStockDaily');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].everyMinutes, 5);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].hour, 14);
    assert.equal(daily[0].minute, 30);
    assert.match(e.replies.pop(), /checkStockRules（每 5 分鐘，只在盤中動作）\n⏰ fetchStockDaily（每天約 14:30）/);
  });
});

/* ========================================================================== */
/* 2026-10-08 實機回報：自選三筆只有第一筆有報價                                  */
/* 根因：真的 Sheet 會把「全是數字」的代號轉成數字，0050 存成 50、00878 存成 878， */
/* 讀回來不符合代號格式就不報價。00631L 帶英文字，不受影響。                       */
/* 這組測試用 autoNumber 模擬真的 Sheet 的轉換。                                  */
/* ========================================================================== */
describe('代號開頭的 0 不能被 Sheet 吃掉', () => {
  const W_HEADERS = ['symbol', 'name', 'sort', 'is_active', 'added_by', 'created_at'];

  test('PWA 加自選 0056、00878：存回來還是文字，readMany 拿得到報價', () => {
    const e = env({ autoNumber: true });
    for (const symbol of ['00631L', '0056', '00878']) {
      const out = post(e, { action: 'upsert', token: TOK.NEIL, sheet: 'stock_watch', key_field: 'symbol', record: { symbol, is_active: true }, trigger: 'write' });
      assert.equal(out.success, true, symbol + ' ' + JSON.stringify(out));
    }
    assert.deepEqual(e.sheets.stock_watch.toRecords().map((r) => r.symbol), ['00631L', '0056', '00878']);
    const s = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], stock: true, trigger: 'poll' }).stock;
    assert.deepEqual(s.watch.map((w) => w.symbol), ['00631L', '0056', '00878']);
    assert.deepEqual(Object.keys(s.quotes).sort(), ['0056', '00631L', '00878']);
  });

  test('同一檔再加一次（重新啟用）不會多出一列', () => {
    const e = env({ autoNumber: true });
    const add = (is_active) => post(e, { action: 'upsert', token: TOK.NEIL, sheet: 'stock_watch', key_field: 'symbol', record: { symbol: '0056', is_active }, trigger: 'write' });
    add(true); add(false); add(true);
    assert.equal(e.sheets.stock_watch.toRecords().length, 1);
  });

  test('LINE 買/0056 與 PWA 記交易：代號存成文字，持股對得起來', () => {
    const e = env({ autoNumber: true });
    line(e, NEIL, '買/0056/1000/36.5');
    post(e, { action: 'upsert', token: TOK.NEIL, sheet: 'stock_trades', trigger: 'write',
      record: { id: 'p1', trade_date: '2026-10-08', symbol: '00878', side: 'buy', qty: 100, price: 21.9 } });
    assert.deepEqual(trades(e).map((t) => t.symbol), ['0056', '00878']);
    const s = post(e, { action: 'readMany', token: TOK.NEIL, sheets: ['tasks'], stock: true, trigger: 'poll' }).stock;
    assert.deepEqual(s.holdings.map((h) => h.symbol), ['0056', '00878']);
    assert.match(line(e, NEIL, '賣/0056/1000/37'), /✅ 賣出 0056/);
  });

  test('提醒規則、再平衡標的也一樣', () => {
    const e = env({ autoNumber: true, sheets: {
      _stock_config: CONFIG(),
      stock_rules: rulesSheet([]),
      stock_daily: new FakeSheet('stock_daily', [['date', 'symbol', 'close', 'prev_close', 'source']]) } });
    post(e, { action: 'upsert', token: TOK.NEIL, sheet: 'stock_rules', trigger: 'write',
      record: { id: 'r1', symbol: '0056', type: 'price_above', params: { price: 1 }, enabled: true } });
    assert.equal(e.sheets.stock_rules.toRecords()[0].symbol, '0056');
    post(e, { action: 'stockConfigSet', token: TOK.NEIL, key: 'rebalance_symbol', value: '0056', trigger: 'write' });
    assert.equal(Object.fromEntries(e.sheets._stock_config.toRecords().map((r) => [r.key, r.value])).rebalance_symbol, '0056');
  });

  test('盤後收盤價：0056 寫成文字', () => {
    const daily = new FakeSheet('stock_daily', [['date', 'symbol', 'close', 'prev_close', 'source']]);
    const watch = new FakeSheet('stock_watch', [W_HEADERS]);
    const twse = [{ Date: '1151008', Code: '0056', ClosingPrice: '36.50', Change: '0.3000' }];
    const UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(twse) }), fetchAll: () => [] };
    const e = env({ autoNumber: true, sheets: { stock_daily: daily, stock_watch: watch }, net: { calls: { all: [] }, UrlFetchApp } });
    e.call('installStock_');
    watch.values.push(['0056', '', 10, 'TRUE', NEIL, '']);
    e.call('fetchStockDaily');
    assert.equal(e.sheets.stock_daily.toRecords()[0].symbol, '0056');
  });

  test('「初始化」：已經被轉成數字的舊代號要講出來（不猜它原本有幾個 0）', () => {
    const watch = new FakeSheet('stock_watch', [W_HEADERS, ['00631L', '', 10, 'TRUE', NEIL, ''], [56, '', 20, 'TRUE', NEIL, ''], [878, '', 30, 'TRUE', NEIL, '']]);
    const e = env({ autoNumber: true, sheets: { stock_watch: watch } });
    const out = e.call('installStock_');
    assert.equal(out.level, 'warn');
    assert.match(out.text, /stock_watch 有 2 列代號被 Sheet 轉成數字（56、878）/);
  });
});
