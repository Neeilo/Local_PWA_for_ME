/**
 * ADR-023 PR-D（後端）— 股票 widget：個人 pin＋今日損益（D-1～D-3）
 *
 * 為什麼：首頁自選股在 iOS 橫向滑不動，Neil 也只想看「需要我注意的」幾檔；
 * 加上「今天賺賠多少」是打開首頁最想知道的數字。
 * 盯的事：
 *   - pin 一人一份存 widget_config.stock_pins、最多 4 檔（第 5 檔拒絕，不默默截掉）、只改得到自己的
 *   - 今日損益：昨天以前就有的（現價−昨收）、今天買的（現價−買進價）、今天賣掉的不算
 *   - 盤後／假日：標「報價日（週）vs 前一交易日」；盤中標「今日」
 *   - 沒持股（只有黃金也算沒有）→ null，兩格都不出現；有持股沒報價的不算、計數
 *   - 交易資料用 stock 已經讀的那份，不多讀一張表
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil', MOM = 'Umom';
const e0 = loadCodeGs({});
const pnl = (holdings, trades, quotes, nowIso) =>
  e0.read(`stockTodayPnl_(${JSON.stringify(holdings)}, ${JSON.stringify(trades)}, ${JSON.stringify(quotes)}, new Date(${JSON.stringify(nowIso)}))`);

const H = (owner, symbol, qty, cost) => ({ owner, symbol, qty, cost, avg_cost: cost / qty });
const T = (owner, symbol, side, qty, price, trade_date) => ({ owner, symbol, side, qty, price, fee: 0, trade_date, id: owner + symbol + side + trade_date });
const LIVE = (price, prevClose, time) => ({ price, prevClose, change: price - prevClose, source: 'fugle', time });
const CLOSE = (price, prevClose, date) => ({ price, prevClose, change: price - prevClose, source: 'close', date });
const TUE_1030 = '2026-11-03T02:30:00Z';       // 台北 11/3（二）10:30 盤中
const SAT_NOON = '2026-10-31T04:00:00Z';       // 台北 10/31（六）中午

describe('今日損益（D-2、D-3）', () => {

  test('昨天以前就有的：Σ（現價 − 昨收）× 持股；% ＝ ÷ 昨收市值', () => {
    const r = pnl([H('Neil', '2330', 100, 90000)], [T('Neil', '2330', 'buy', 100, 900, '2026-10-01')],
      { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z') }, TUE_1030);
    assert.equal(r.amount, 1000);
    assert.equal(r.pct, 1);
    assert.equal(r.intraday, true);
    assert.equal(r.label, '今日');
  });

  test('今天買進的股數用（現價 − 買進價）比，不是昨收', () => {
    const r = pnl([H('Neil', '2330', 150, 0)],
      [T('Neil', '2330', 'buy', 100, 900, '2026-10-01'), T('Neil', '2330', 'buy', 50, 1005, '2026-11-03')],
      { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z') }, TUE_1030);
    assert.equal(r.amount, 100 * 10 + 50 * 5);
    assert.equal(r.pct, Math.round(1250 / (100 * 1000 + 50 * 1005) * 10000) / 100);
  });

  test('今天賣出的不算（屬已實現）：只算還留著的股數', () => {
    const r = pnl([H('Neil', '2330', 60, 0)],
      [T('Neil', '2330', 'buy', 100, 900, '2026-10-01'), T('Neil', '2330', 'sell', 40, 1008, '2026-11-03')],
      { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z') }, TUE_1030);
    assert.equal(r.amount, 60 * 10);
  });

  test('全家加總；別人今天買的只對他自己那筆算買進價', () => {
    const r = pnl([H('Neil', '2330', 100, 0), H('媽媽', '2330', 10, 0)],
      [T('Neil', '2330', 'buy', 100, 900, '2026-10-01'), T('媽媽', '2330', 'buy', 10, 1020, '2026-11-03')],
      { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z') }, TUE_1030);
    assert.equal(r.amount, 1000 - 100);
  });

  test('假日：用最近一個交易日的收盤，標籤寫「10/30（五）vs 10/29」，不是盤中', () => {
    const r = pnl([H('Neil', '2330', 100, 0)], [T('Neil', '2330', 'buy', 100, 900, '2026-10-01')],
      { 2330: CLOSE(1010, 1000, '2026-10-30') }, SAT_NOON);
    assert.equal(r.intraday, false);
    assert.equal(r.day, '2026-10-30');
    assert.equal(r.base_date, '2026-10-29');
    assert.equal(r.label, '10/30（五）vs 10/29');
    assert.equal(r.amount, 1000);
  });

  test('週一的前一交易日跳過週末', () => {
    const r = pnl([H('Neil', '2330', 1, 0)], [], { 2330: CLOSE(11, 10, '2026-11-02') }, '2026-11-02T08:00:00Z');
    assert.equal(r.label, '11/2（一）vs 10/30');
  });

  test('沒持股、只有黃金：null（兩格都不出現）', () => {
    assert.equal(pnl([], [], {}, TUE_1030), null);
    assert.equal(pnl([H('Neil', 'GOLD', 10, 30000)], [], {}, TUE_1030), null);
  });

  test('黃金不算；有持股沒報價（或沒有昨收）的不算進去、計數', () => {
    const r = pnl([H('Neil', '2330', 100, 0), H('Neil', 'GOLD', 10, 30000), H('Neil', '0050', 10, 0), H('Neil', '2317', 10, 0)], [],
      { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z'), 2317: { price: 200, prevClose: '', source: 'fugle', time: '2026-11-03T02:29:00Z' } }, TUE_1030);
    assert.equal(r.amount, 1000);
    assert.equal(r.missing, 2);
  });

  test('全部都沒報價：金額 null、% null（不顯示 0 假裝沒漲跌）', () => {
    const r = pnl([H('Neil', '2330', 100, 0)], [], {}, TUE_1030);
    assert.equal(r.amount, null);
    assert.equal(r.pct, null);
    assert.equal(r.missing, 1);
  });

  test('刪除的交易（tombstone）不當今天買進', () => {
    const t = Object.assign(T('Neil', '2330', 'buy', 50, 1005, '2026-11-03'), { del: 'TRUE' });
    const r = pnl([H('Neil', '2330', 100, 0)], [t], { 2330: LIVE(1010, 1000, '2026-11-03T02:29:00Z') }, TUE_1030);
    assert.equal(r.amount, 1000);
  });
});

/* ========================================================================== */
/* pin：widget_config.stock_pins（D-1）                                         */
/* ========================================================================== */

const CFG_H = ['line_id', 'widget_order', 'widget_hidden', 'widget_pinned', 'apps_pinned', 'apps_hidden',
  'weather_county', 'weather_district', 'updated_at'];
function cfgEnv(rows = []) {
  const e = loadCodeGs({ sheets: { widget_config: new FakeSheet('widget_config', [CFG_H].concat(rows)) } });
  e.set = (who, config) => e.call('widgetConfigSet_', { line_id: who }, config);
  e.cfgOf = (who) => e.read(`widgetConfigOf_(SpreadsheetApp.getActiveSpreadsheet(), ${JSON.stringify(who)})`);
  return e;
}

describe('pin（D-1）', () => {

  test('存雲端、各人各自：Neil 的 pin 不影響媽媽', () => {
    const e = cfgEnv();
    assert.equal(e.set(ME, { stock_pins: ['2330', '0050'] }).success, true);
    assert.equal(e.set(MOM, { stock_pins: ['2317'] }).success, true);
    assert.deepEqual(e.cfgOf(ME).stock_pins, ['2330', '0050']);
    assert.deepEqual(e.cfgOf(MOM).stock_pins, ['2317']);
    const sheet = e.sheets.widget_config;
    assert.ok(sheet.values[0].includes('stock_pins'), '舊表自動補欄');
  });

  test('上限 4 檔：第 5 檔整筆拒絕（pins_full），原本的不動', () => {
    const e = cfgEnv();
    e.set(ME, { stock_pins: ['2330', '0050', '2317', '2454'] });
    const r = e.set(ME, { stock_pins: ['2330', '0050', '2317', '2454', '00631L'] });
    assert.equal(r.error, 'pins_full');
    assert.equal(r.max, 4);
    assert.deepEqual(e.cfgOf(ME).stock_pins, ['2330', '0050', '2317', '2454']);
  });

  test('代號正規化（全形、小寫）、去重；不像代號的丟掉', () => {
    const e = cfgEnv();
    e.set(ME, { stock_pins: ['２３３０', '00631l', '2330', '<b>', ''] });
    assert.deepEqual(e.cfgOf(ME).stock_pins, ['2330', '00631L']);
  });

  test('沒送 stock_pins：其他設定照存，pin 不動；預設是空陣列', () => {
    const e = cfgEnv();
    assert.deepEqual(e.cfgOf(ME).stock_pins, []);
    e.set(ME, { stock_pins: ['2330'] });
    e.set(ME, { hidden: ['weather'] });
    assert.deepEqual(e.cfgOf(ME).stock_pins, ['2330']);
  });

  test('Sheet 上被手動填了超過 4 檔：讀出來只取前 4', () => {
    const row = CFG_H.map(() => '');
    const e = cfgEnv();
    e.sheets.widget_config.values[0].push('stock_pins');
    row[0] = ME; row.push('1101,1102,1103,1104,1105');
    e.sheets.widget_config.values.push(row);
    assert.deepEqual(e.cfgOf(ME).stock_pins, ['1101', '1102', '1103', '1104']);
  });
});
