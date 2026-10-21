/**
 * ADR-022 PR-C — 用量與成本卡＋額度提醒（D-2、D-3、D-5、D-7）
 *
 * 為什麼：PR-A 開始記帳、PR-B 有了單價，Neil 要在管理區看得到「這個月花多少、花在哪、額度用到哪」。
 * 盯的事：
 *   - 卡片資料按需載入（apiCostSummary），不進冷開機；非管理者連卡帶資料都拿不到
 *   - 金額全是 USD；各 API／各功能占比；Apify 併入（用它自己回報的實際值）
 *   - 未定價清單；checked_at 超過 90 天（或從沒核過）→ 建議重新核價
 *   - 月結有填實際金額才算差額
 *   - 額度提醒：跨過 80% 推 LINE（每週期一次，週期換了可再推）；100% 進 boot 給 2.0 總覽頂端與管理區紅色警示
 *   - 只在 2.0；1.0 不動
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-me';
const TOK_MOM = 'tok-mom';
const REG_H = ['api_id', 'model', 'price_key', 'billing_mode', 'input_per_token', 'output_per_token',
  'cache_read_per_token', 'cache_write_per_token', 'unit_price', 'quota', 'quota_period', 'quota_unit', 'effective_from',
  'source_url', 'checked_at', 'active'];
const USAGE_H = ['ts', 'request_id', 'api_id', 'model', 'feature', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'units', 'unit_price_in', 'unit_price_out', 'unit_price_other', 'cost_usd', 'priced'];
const DAILY_H = ['date', 'api_id', 'calls', 'rate_limited', 'quota', 'quota_period', 'used_in_period', 'pct'];
const MONTHLY_H = ['month', 'api_id', 'est_cost_usd', 'actual_amount', 'actual_currency', 'note'];
const row = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));
const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function env({ registry = [], usage = [], daily = [], monthly = [], properties = {}, now = '2026-10-21T02:00:00Z' } = {}) {
  const pushes = [];
  const clock = { at: new Date(now) };
  const e = loadCodeGs({
    cache: true,
    propsWritable: true,
    extraFiles: ['line-router.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    properties: Object.assign({ LINE_CHANNEL_ACCESS_TOKEN: 't' }, properties),
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'],
        [ME, 'Neil', 'TRUE', 'TRUE'], [MOM, '媽媽', 'TRUE', '']]),
      api_registry: new FakeSheet('api_registry', [REG_H].concat(registry.map((o) => row(REG_H, o)))),
      api_usage: new FakeSheet('api_usage', [USAGE_H].concat(usage.map((o) => row(USAGE_H, o)))),
      api_usage_daily: new FakeSheet('api_usage_daily', [DAILY_H].concat(daily.map((o) => row(DAILY_H, o)))),
      api_cost_monthly: new FakeSheet('api_cost_monthly', [MONTHLY_H].concat(monthly.map((o) => row(MONTHLY_H, o)))),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: {
      apiNow_: () => new Date(clock.at.getTime()),
      linePush_: (to, text) => { pushes.push({ to, text: String(text) }); return { ok: true }; },
      UrlFetchApp: { fetch: () => reply(200, '{}'), fetchAll: (r) => r.map(() => reply(200, '{}')) }
    }
  });
  e.clock = clock;
  e.pushes = pushes;
  e.post = (body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
  e.flush = (iso) => e.read(`flushApiUsage(new Date('${iso}'))`);
  return e;
}

const U = (ts, api_id, model, feature, cost, priced = 'Y') => ({ ts, request_id: ts + model, api_id, model, feature,
  input_tokens: 100, output_tokens: 10, cost_usd: priced === 'Y' ? cost : '', priced });

describe('apiCostSummary：本月估算', () => {

  test('金額全是 USD；各 API／各功能加總；Apify 用 clips_usage 實際值；上個月的不算', () => {
    const e = env({
      usage: [
        U('2026-10-01T01:00:00Z', 'claude', 'claude-haiku-5-5', 'query', 0.01),
        U('2026-10-20T01:00:00Z', 'claude', 'claude-haiku-5-5', 'clip_ai', 0.02),
        U('2026-10-20T02:00:00Z', 'gemini', 'gemini-3.5-flash-lite', 'query', 0.005),
        U('2026-09-30T01:00:00Z', 'claude', 'claude-haiku-5-5', 'query', 9)          // 上個月
      ],
      properties: { clips_usage: JSON.stringify({ usd: 1.5, at: '2026-10-20T00:00:00Z' }) }
    });
    const r = e.post({ action: 'apiCostSummary', trigger: 'manual' });
    assert.equal(r.success, true);
    assert.equal(r.currency, 'USD');
    assert.equal(r.month, '2026-10');
    assert.equal(r.total_usd, 1.535);
    assert.deepEqual(r.by_api, [{ api_id: 'apify', usd: 1.5 }, { api_id: 'claude', usd: 0.03 }, { api_id: 'gemini', usd: 0.005 }]);
    assert.deepEqual(r.by_feature, [{ feature: 'query', usd: 0.015 }, { feature: 'clip_ai', usd: 0.02 }].sort((a, b) => b.usd - a.usd));
  });

  test('未定價清單：本月 priced=N 的 model 與筆數', () => {
    const e = env({ usage: [
      U('2026-10-20T01:00:00Z', 'openai', 'gpt-6-luna', 'query', 0, 'N'),
      U('2026-10-20T02:00:00Z', 'openai', 'gpt-6-luna', 'query', 0, 'N'),
      U('2026-10-20T03:00:00Z', 'claude', 'claude-haiku-5-5', 'query', 0.01)
    ] });
    const r = e.post({ action: 'apiCostSummary', trigger: 'manual' });
    assert.deepEqual(r.unpriced, [{ api_id: 'openai', model: 'gpt-6-luna', count: 2 }]);
  });

  test('核價超過 90 天或從沒核過 → 建議重新核價；停用的不算', () => {
    const e = env({ registry: [
      { api_id: 'claude', model: 'claude-haiku-5-5', billing_mode: 'per_token', checked_at: '2026-10-01', active: 'TRUE' },
      { api_id: 'claude', model: 'claude-opus-5-5', billing_mode: 'per_token', checked_at: '2026-07-01', active: 'TRUE' },
      { api_id: 'openai', model: 'gpt-6-luna', billing_mode: 'per_token', checked_at: '', active: 'TRUE' },
      { api_id: 'openai', model: 'gpt-old', billing_mode: 'per_token', checked_at: '', active: 'FALSE' }
    ] });
    const r = e.post({ action: 'apiCostSummary', trigger: 'manual' });
    assert.deepEqual(r.stale.map((s) => s.model).sort(), ['claude-opus-5-5', 'gpt-6-luna']);
  });

  test('額度：每個 API 取最新一天的每日列；月結有填實際金額才算差額', () => {
    const e = env({
      daily: [
        { date: '2026-10-19', api_id: 'gas_urlfetch', calls: 100, quota: 20000, quota_period: 'day', used_in_period: 100, pct: 0.5 },
        { date: '2026-10-20', api_id: 'gas_urlfetch', calls: 300, quota: 20000, quota_period: 'day', used_in_period: 300, pct: 1.5 },
        { date: '2026-10-20', api_id: 'cwa', calls: 24 }
      ],
      monthly: [
        { month: '2026-10', api_id: 'claude', est_cost_usd: 0.5, actual_amount: 0.62, actual_currency: 'USD' },
        { month: '2026-10', api_id: 'gemini', est_cost_usd: 0.1 }
      ]
    });
    const r = e.post({ action: 'apiCostSummary', trigger: 'manual' });
    assert.deepEqual(r.quotas, [{ api_id: 'gas_urlfetch', date: '2026-10-20', used: 300, quota: 20000, period: 'day', pct: 1.5, rate_limited: 0 }]);
    assert.deepEqual(r.actuals, [{ api_id: 'claude', est_usd: 0.5, actual: 0.62, currency: 'USD', diff_usd: 0.12 }]);
  });

  test('非管理者：永久拒絕', () => {
    const r = env().post({ action: 'apiCostSummary', trigger: 'manual' }, TOK_MOM);
    assert.equal(r.error, 'forbidden');
    assert.equal(r.permanent, true);
  });
});

describe('額度提醒（D-5）', () => {
  const QUOTA = { api_id: 'gas_urlfetch', billing_mode: 'free_quota', quota: 10, quota_period: 'day', quota_unit: 'call',
    effective_from: '2026-10-01', active: 'TRUE' };
  const calls = (e, n) => { for (let i = 0; i < n; i++) e.call('callApi_', 'web', 'https://x/', {}); };
  const day = (e, d) => {               // 台北 d 那天 10:00 打，隔天 00:05 收尾（中間照上線節奏收）
    ['T03:30:00Z', 'T08:30:00Z', 'T13:30:00Z'].forEach((t) => e.flush(d + t));
    const next = new Date(new Date(d + 'T16:05:00Z').getTime()).toISOString();
    e.flush(next);
  };

  test('跨過 80% 推 LINE 給管理者（不推非管理者）；同一週期只推一次', () => {
    const e = env({ registry: [QUOTA], now: '2026-10-20T02:00:00Z' });
    calls(e, 9);                                                           // 9／10 = 90%（gas_urlfetch 算所有呼叫）
    day(e, '2026-10-20');
    assert.equal(e.pushes.length, 1);
    assert.equal(e.pushes[0].to, ME);
    assert.match(e.pushes[0].text, /GAS UrlFetch.*90%/);
    e.flush('2026-10-20T16:30:00Z');                                       // 同一天再收一次：不重推
    assert.equal(e.pushes.length, 1);
  });

  test('週期換了（隔天）再跨過 80% 可以再推', () => {
    const e = env({ registry: [QUOTA], now: '2026-10-20T02:00:00Z' });
    calls(e, 9);
    day(e, '2026-10-20');
    e.clock.at = new Date('2026-10-21T02:00:00Z');
    calls(e, 8);
    ['T03:30:00Z', 'T08:30:00Z', 'T13:30:00Z', 'T16:05:00Z'].forEach((t) => e.flush('2026-10-21' + t));
    assert.equal(e.pushes.length, 2);
  });

  test('沒到 80% 不推', () => {
    const e = env({ registry: [QUOTA], now: '2026-10-20T02:00:00Z' });
    calls(e, 7);
    day(e, '2026-10-20');
    assert.equal(e.pushes.length, 0);
  });

  test('100%：boot 帶 api_alerts 給管理者（2.0 紅色警示）；非管理者的 boot 沒有', () => {
    const e = env({ registry: [QUOTA], now: '2026-10-20T02:00:00Z' });
    calls(e, 12);
    day(e, '2026-10-20');
    const alerts = JSON.parse(e.read('PropertiesService.getScriptProperties().getProperty(API_ALERTS_KEY)'));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].api_id, 'gas_urlfetch');
    assert.equal(alerts[0].pct, 120);
    const admin = e.post({ action: 'boot', trigger: 'cold' });
    assert.equal(admin.api_alerts[0].api_id, 'gas_urlfetch');
    const mom = e.post({ action: 'boot', trigger: 'cold' }, TOK_MOM);
    assert.equal(mom.api_alerts, undefined);
  });

  test('下一次收尾沒有 100% 的 → 警示清掉', () => {
    const e = env({ registry: [QUOTA], now: '2026-10-20T02:00:00Z' });
    calls(e, 12);
    day(e, '2026-10-20');
    e.clock.at = new Date('2026-10-21T02:00:00Z');
    calls(e, 1);
    ['T03:30:00Z', 'T08:30:00Z', 'T13:30:00Z', 'T16:05:00Z'].forEach((t) => e.flush('2026-10-21' + t));
    assert.equal(e.read('PropertiesService.getScriptProperties().getProperty(API_ALERTS_KEY)'), '[]');
  });
});

describe('前端（2.0 才有）', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  test('卡片按需載入摘要（trigger=manual），不再寫「AI 還沒有記錄」', () => {
    assert.match(html, /action:'apiCostSummary', trigger:'manual'/);
    assert.doesNotMatch(html, /AI（查\/）用量還沒有記錄/);
  });
  test('總覽頂端有額度警示的位置，只給 2.0 管理者', () => {
    assert.match(html, /id="v2QuotaAlert"/);
    assert.match(html, /function renderQuotaAlert\(\)\{[^]*isV2\(\)[^]*isAdmin\(\)/);
  });
});

describe('前端行為：總覽頂端紅色警示', () => {
  const ALERT = [{ api_id: 'line_push', label: 'LINE 推播', pct: 100, date: '2026-10-20', period: 'month' }];
  const setup = async ({ v2 = true, admin = true } = {}) => {
    const { loadFrontend } = await import('./fake-browser.mjs');
    const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {} });
    e.raw(`__els = {}; document.getElementById = function(id){ return __els[id] || (__els[id] = { id, value:'', innerHTML:'', hidden:false, style:{} }); };
      myLineId = "${ME}"; roster = ${JSON.stringify([{ line_id: ME, is_active: 'TRUE', is_admin: admin ? 'TRUE' : '', feat_ui_v2: 'TRUE' }])};
      apiAlerts = ${JSON.stringify(ALERT)};`);
    e.call('renderQuotaAlert');
    return { hidden: e.read('__els.v2QuotaAlert.hidden'), html: e.read('__els.v2QuotaAlert.innerHTML') };
  };
  test('2.0 管理者：看得到「LINE 推播 100%」', async () => {
    const r = await setup();
    assert.equal(r.hidden, false);
    assert.match(r.html, /LINE 推播 100%/);
  });
  test('非管理者、1.0：都看不到', async () => {
    assert.equal((await setup({ admin: false })).hidden, true);
    assert.equal((await setup({ v2: false })).hidden, true);
  });
});
