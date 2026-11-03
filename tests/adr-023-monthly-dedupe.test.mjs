/**
 * ADR-023 PR-A — api_cost_monthly 重複列（D-11）
 *
 * 為什麼：apiUpdateMonthly_ 寫入 month='2026-10'，真的 Sheet 會把它轉成日期 2026-10-01；
 * 下一次用 String(v[iM]) === month 比對永遠不成立 → 每次收尾都 append 一列（線上 10 月已累積 24 列）。
 * 成本卡讀實際金額也用同一種比對，於是 Neil 填的 actual_amount 永遠讀不到、差額永遠算不出來。
 * 盯的事：
 *   - 假 Sheet 會自動轉型（autoDate）時，這個 bug 測得出來
 *   - 連跑兩次只有一列、估算值更新；舊的「已被轉成 Date」的列也認得
 *   - 月份欄改存純文字，之後不再被轉型
 *   - 初始化清重複：同 month＋api_id 只留一列，Neil 填過的 actual_amount／actual_currency／note 不丟
 *   - 成本卡 actuals 讀得到 Date 型的月份
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const TOK_ME = 'tok-me';
const USAGE_H = ['ts', 'request_id', 'api_id', 'model', 'feature', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'units', 'unit_price_in', 'unit_price_out', 'unit_price_other', 'cost_usd', 'priced'];
const MONTHLY_H = ['month', 'api_id', 'est_cost_usd', 'actual_amount', 'actual_currency', 'note'];
const row = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));
const U = (ts, api_id, cost) => row(USAGE_H, { ts, request_id: ts + api_id, api_id, model: 'm', feature: 'query', cost_usd: cost, priced: 'Y' });
/** 真的 Sheet 已經轉好的月份格：該月 1 號當地午夜 */
const MONTH_DATE = (y, m) => new Date(y, m - 1, 1);

function env({ usage = [], monthly = [] } = {}) {
  const e = loadCodeGs({
    cache: true,
    propsWritable: true,
    autoDate: true,
    extraFiles: ['line-router.gs'],
    tokens: { [TOK_ME]: ME },
    properties: { LINE_CHANNEL_ACCESS_TOKEN: 't' },
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'], [ME, 'Neil', 'TRUE', 'TRUE']]),
      api_usage: new FakeSheet('api_usage', [USAGE_H].concat(usage)),
      api_cost_monthly: new FakeSheet('api_cost_monthly', [MONTHLY_H].concat(monthly.map((o) => row(MONTHLY_H, o)))),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: { apiNow_: () => new Date('2026-10-21T02:00:00Z') }
  });
  e.monthly = () => e.sheets.api_cost_monthly.toRecords();
  e.post = (body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK_ME }, body)) } }).body);
  e.dedupe = () => e.read('initSteps_().filter(function (s) { return s.label === "用量與成本記帳"; })[0].run()');
  return e;
}

describe('假 Sheet 的自動轉型（讓這類 bug 測得到）', () => {

  test('一般欄：YYYY-MM／YYYY-MM-DD 變成 Date；純文字欄原樣；開頭 \' 強制文字', () => {
    const sh = new FakeSheet('x', [['a', 'b', 'c']], { autoDate: true });
    sh.getRange(1, 2, 1000, 1).setNumberFormat('@');
    sh.getRange(2, 1, 1, 3).setValues([['2026-10', '2026-10', "'2026-10-05"]]);
    const [a, b, c] = sh.values[1];
    assert.ok(a instanceof Date);
    assert.equal(a.getFullYear(), 2026); assert.equal(a.getMonth(), 9); assert.equal(a.getDate(), 1);
    assert.equal(b, '2026-10');
    assert.equal(c, '2026-10-05');
    sh.getRange(3, 1, 1, 1).setValues([['2026-10-05']]);
    assert.equal(sh.values[2][0].getDate(), 5);
  });
});

describe('apiUpdateMonthly_：同月同 API 只有一列', () => {

  test('連跑兩次：只有一列、估算值更新成最新', () => {
    const e = env({ usage: [U('2026-10-20T01:00:00Z', 'claude', 0.01)] });
    e.call('apiUpdateMonthly_', '2026-10');
    e.sheets.api_usage.values.push(U('2026-10-20T03:00:00Z', 'claude', 0.02));
    e.call('apiUpdateMonthly_', '2026-10');
    const rows = e.monthly().filter((r) => r.api_id === 'claude');
    assert.equal(rows.length, 1, '第二次不可以再新增一列');
    assert.equal(rows[0].est_cost_usd, 0.03);
  });

  test('月份欄寫成純文字，不被轉成日期', () => {
    const e = env({ usage: [U('2026-10-20T01:00:00Z', 'claude', 0.01)] });
    e.call('apiUpdateMonthly_', '2026-10');
    assert.equal(e.monthly()[0].month, '2026-10');
  });

  test('之前已被轉成 Date 的舊列也認得：更新它，不另外新增', () => {
    const e = env({ usage: [U('2026-10-20T01:00:00Z', 'claude', 0.05)],
      monthly: [{ month: MONTH_DATE(2026, 10), api_id: 'claude', est_cost_usd: 0.01, actual_amount: 1.5, actual_currency: 'USD', note: '帳單' }] });
    e.call('apiUpdateMonthly_', '2026-10');
    const rows = e.monthly();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].est_cost_usd, 0.05);
    assert.equal(rows[0].actual_amount, 1.5);
  });

  test('不同月份各自一列（9 月的不會被 10 月蓋掉）', () => {
    const e = env({ usage: [U('2026-10-20T01:00:00Z', 'claude', 0.05)],
      monthly: [{ month: MONTH_DATE(2026, 9), api_id: 'claude', est_cost_usd: 0.9 }] });
    e.call('apiUpdateMonthly_', '2026-10');
    const rows = e.monthly();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].est_cost_usd, 0.9);
  });
});

describe('初始化：清掉已累積的重複列', () => {

  test('同 month＋api_id 只留一列（最新的估算值）；Neil 填過的實際金額、幣別、備註保留', () => {
    const d = MONTH_DATE(2026, 10);
    const e = env({ monthly: [
      { month: d, api_id: 'claude', est_cost_usd: 0.01 },
      { month: d, api_id: 'apify', est_cost_usd: 1.0 },
      { month: d, api_id: 'claude', est_cost_usd: 0.02, actual_amount: 0.62, actual_currency: 'USD' },
      { month: d, api_id: 'claude', est_cost_usd: 0.03, note: '已對帳' },
      { month: d, api_id: 'apify', est_cost_usd: 1.2 },
      { month: MONTH_DATE(2026, 9), api_id: 'claude', est_cost_usd: 0.5 }
    ] });
    const r = e.dedupe();
    assert.equal(r.changed, true);
    assert.match(r.text, /清掉 3 列重複/);
    const rows = e.monthly();
    assert.equal(rows.length, 3);
    const oct = (id) => rows.find((x) => x.month === '2026-10' && x.api_id === id);
    assert.deepEqual(oct('claude'), { month: '2026-10', api_id: 'claude', est_cost_usd: 0.03, actual_amount: 0.62, actual_currency: 'USD', note: '已對帳' });
    assert.equal(oct('apify').est_cost_usd, 1.2);
    assert.ok(rows.some((x) => x.month === '2026-09' && x.est_cost_usd === 0.5), '舊月份的列也改存成文字 YYYY-MM');
  });

  test('兩列都填了實際金額：保留較新那列填的', () => {
    const d = MONTH_DATE(2026, 10);
    const e = env({ monthly: [
      { month: d, api_id: 'claude', est_cost_usd: 0.01, actual_amount: 0.5, actual_currency: 'USD' },
      { month: d, api_id: 'claude', est_cost_usd: 0.02, actual_amount: 0.6, actual_currency: 'USD' }
    ] });
    e.dedupe();
    const [r] = e.monthly();
    assert.equal(r.actual_amount, 0.6);
  });

  test('沒有重複：再跑一次不改任何列', () => {
    const e = env({ monthly: [{ month: '2026-10', api_id: 'claude', est_cost_usd: 0.01 }] });
    e.dedupe();
    const before = JSON.stringify(e.sheets.api_cost_monthly.values);
    const r = e.dedupe();
    assert.equal(r.changed, false);
    assert.equal(JSON.stringify(e.sheets.api_cost_monthly.values), before);
  });

  test('另一個收尾正在跑（拿不到鎖）：不動資料、回報稍後再試', () => {
    const d = MONTH_DATE(2026, 10);
    const e = env({ monthly: [{ month: d, api_id: 'claude', est_cost_usd: 0.01 }, { month: d, api_id: 'claude', est_cost_usd: 0.02 }] });
    e.lock.busy = true;
    const r = e.dedupe();
    assert.equal(r.level, 'warn');
    assert.equal(e.monthly().length, 2);
  });
});

describe('成本卡：對帳讀得到', () => {

  test('月份格是 Date（舊列）：填了 actual_amount 後 actuals 讀得到、差額算得出來', () => {
    const e = env({ usage: [U('2026-10-20T01:00:00Z', 'claude', 0.5)],
      monthly: [{ month: MONTH_DATE(2026, 10), api_id: 'claude', est_cost_usd: 0.5, actual_amount: 0.62, actual_currency: 'USD' }] });
    const r = e.post({ action: 'apiCostSummary', trigger: 'manual' });
    assert.equal(r.success, true);
    assert.deepEqual(r.actuals, [{ api_id: 'claude', est_usd: 0.5, actual: 0.62, currency: 'USD', diff_usd: 0.12 }]);
  });
});
