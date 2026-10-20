/**
 * ADR-022 PR-B — 查價功能（D-9）
 *
 * 為什麼：各家都沒有查價 API，AI 單價靠 LiteLLM 社群價目 JSON。社群資料可能晚幾天、可能出錯，
 * 所以「查」和「寫」分開：查只回差異，Neil 看過按確認才新增列（改價＝新增一列，舊帳不動）。
 * 盯的事：
 *   - 未按確認前 Sheet 一格都不變
 *   - 價格沒變：確認後只更新 checked_at；變動 >50% 標出來；查不到 → ⚠️ 未定價
 *   - 確認後清單價快取：下一次呼叫就用新價
 *   - 補價只回填 priced=N 的列，已有費用的列不動
 *   - 非管理者永久拒絕（查與寫都是）
 *   - 未定價可手動填、額度可手動改（一樣是新增列）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
const reg = (o) => REG_H.map((h) => (o[h] === undefined ? '' : o[h]));
const use = (o) => USAGE_H.map((h) => (o[h] === undefined ? '' : o[h]));

const LITELLM = {
  'claude-haiku-5-5': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000005, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6 },
  'claude-sonnet-5-5': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  'gemini/gemini-3.5-flash-lite': { input_cost_per_token: 1e-7, output_cost_per_token: 4e-7 }
};
const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function env({ registry, usage = [], json = LITELLM } = {}) {
  const fetched = [];
  const e = loadCodeGs({
    cache: true,
    propsWritable: true,
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'],
        [ME, 'Neil', 'TRUE', 'TRUE'], [MOM, '媽媽', 'TRUE', '']]),
      api_registry: new FakeSheet('api_registry', [REG_H].concat(registry || [
        reg({ api_id: 'claude', model: 'claude-haiku-5-5', price_key: 'claude-haiku-5-5', billing_mode: 'per_token',
          input_per_token: 0.000001, output_per_token: 0.000005, cache_read_per_token: 1e-7, cache_write_per_token: 1.25e-6,
          effective_from: '2026-10-01', checked_at: '2026-10-01', active: 'TRUE' }),
        reg({ api_id: 'claude', model: 'claude-sonnet-5-5', price_key: 'claude-sonnet-5-5', billing_mode: 'per_token',
          input_per_token: 0.000001, output_per_token: 0.000005, effective_from: '2026-10-01', active: 'TRUE' }),
        reg({ api_id: 'gemini', model: 'gemini-3.5-flash-lite', price_key: 'gemini-3.5-flash-lite', billing_mode: 'per_token', active: 'TRUE' }),
        reg({ api_id: 'openai', model: 'gpt-6-luna', price_key: 'gpt-6-luna', billing_mode: 'per_token', active: 'TRUE' }),
        reg({ api_id: 'openai', model: 'gpt-old', price_key: 'gpt-old', billing_mode: 'per_token', active: 'FALSE' }),
        reg({ api_id: 'gas_urlfetch', billing_mode: 'free_quota', quota: 20000, quota_period: 'day', quota_unit: 'call',
          effective_from: '2026-10-20', checked_at: '2026-10-20', active: 'TRUE' })
      ])),
      api_usage: new FakeSheet('api_usage', [USAGE_H].concat(usage)),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: {
      apiNow_: () => new Date('2026-10-21T02:00:00Z'),
      UrlFetchApp: { fetch: (url) => { fetched.push(url); return json instanceof Error ? (() => { throw json; })() : reply(200, json); } }
    }
  });
  e.fetched = fetched;
  e.post = (body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
  e.reg = () => e.sheets.api_registry.toRecords();
  return e;
}
const item = (r, model) => r.items.find((x) => x.model === model);

describe('查價：只回差異，不寫', () => {

  test('抓 LiteLLM、只看 active 的 per_token model；Sheet 一格都不變', () => {
    const e = env();
    const before = JSON.stringify(e.sheets.api_registry.values);
    const r = e.post({ action: 'apiPriceCheck', trigger: 'manual' });
    assert.equal(r.success, true);
    assert.deepEqual(e.fetched, ['https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json']);
    assert.deepEqual(r.items.map((x) => x.model).sort(), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'gemini-3.5-flash-lite', 'gpt-6-luna']);
    assert.equal(JSON.stringify(e.sheets.api_registry.values), before);
  });

  test('沒變 → same；變動 >50% → big；新登記 → new；查不到 → missing', () => {
    const r = env().post({ action: 'apiPriceCheck', trigger: 'manual' });
    assert.equal(item(r, 'claude-haiku-5-5').status, 'same');
    const s = item(r, 'claude-sonnet-5-5');
    assert.equal(s.status, 'changed');
    assert.equal(s.big, true, '1→3 是 +200%');
    assert.deepEqual([s.old.input, s.new.input], [0.000001, 0.000003]);
    const g = item(r, 'gemini-3.5-flash-lite');
    assert.equal(g.status, 'new');
    assert.equal(g.key, 'gemini/gemini-3.5-flash-lite', 'Gemini 在 LiteLLM 帶 gemini/ 前綴');
    assert.equal(item(r, 'gpt-6-luna').status, 'missing');
  });

  test('小幅變動（<50%）不標 big', () => {
    const e = env({ json: Object.assign({}, LITELLM, { 'claude-haiku-5-5': { input_cost_per_token: 0.0000012, output_cost_per_token: 0.000005 } }) });
    const h = item(e.post({ action: 'apiPriceCheck', trigger: 'manual' }), 'claude-haiku-5-5');
    assert.equal(h.status, 'changed');
    assert.equal(h.big, false);
  });

  test('抓不到 LiteLLM：回錯誤、Sheet 不變', () => {
    const e = env({ json: new Error('timeout') });
    const r = e.post({ action: 'apiPriceCheck', trigger: 'manual' });
    assert.equal(r.success, undefined);
    assert.equal(r.error, 'fetch_failed');
  });

  test('非管理者：查與寫都永久拒絕，寫 logs', () => {
    const e = env();
    for (const action of ['apiPriceCheck', 'apiPriceApply']) {
      const r = e.post({ action, trigger: 'manual', prices: [], checked: [] }, TOK_MOM);
      assert.equal(r.error, 'forbidden');
      assert.equal(r.permanent, true);
    }
    assert.deepEqual(e.fetched, []);
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && t[6] === MOM));
  });
});

describe('確認寫入：改價＝新增列', () => {

  test('改價新增一列（effective_from＝台北今天），舊列不動；沒變的只更新 checked_at', () => {
    const e = env();
    const before = e.reg().length;
    const r = e.post({ action: 'apiPriceApply', trigger: 'write',
      prices: [{ api_id: 'claude', model: 'claude-sonnet-5-5', input: 0.000003, output: 0.000015, cache_read: '', cache_write: '', source: 'litellm' }],
      checked: [{ api_id: 'claude', model: 'claude-haiku-5-5' }] });
    assert.equal(r.success, true);
    const rows = e.reg();
    assert.equal(rows.length, before + 1);
    const added = rows.at(-1);
    assert.equal(added.model, 'claude-sonnet-5-5');
    assert.equal(added.input_per_token, 0.000003);
    assert.equal(added.effective_from, '2026-10-21');
    assert.equal(added.checked_at, '2026-10-21');
    assert.match(added.source_url, /litellm/);
    assert.equal(rows[1].input_per_token, 0.000001, '舊價列一格都沒動');
    assert.equal(rows[0].checked_at, '2026-10-21', 'haiku 沒變：只更新核價日');
    assert.equal(rows[0].input_per_token, 0.000001);
  });

  test('確認後清快取：下一次呼叫用新價', () => {
    const e = env();
    e.call('apiRegistryRows_');                                    // 先把舊價表放進快取
    e.post({ action: 'apiPriceApply', trigger: 'write',
      prices: [{ api_id: 'claude', model: 'claude-sonnet-5-5', input: 0.000003, output: 0.000015, source: 'litellm' }], checked: [] });
    assert.equal(e.read("apiPrice_('claude', 'claude-sonnet-5-5', new Date('2026-10-21T03:00:00Z')).input"), 0.000003);
  });

  test('補價只回填 priced=N 的列；已有費用的列不動', () => {
    const e = env({ usage: [
      use({ ts: '2026-10-20T01:00:00Z', request_id: 'a', api_id: 'gemini', model: 'gemini-3.5-flash-lite', input_tokens: 1000, output_tokens: 100, priced: 'N' }),
      use({ ts: '2026-10-20T01:00:00Z', request_id: 'b', api_id: 'claude', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 100,
        unit_price_in: 0.000001, unit_price_out: 0.000005, cost_usd: 0.0015, priced: 'Y' })
    ] });
    const r = e.post({ action: 'apiPriceApply', trigger: 'write', checked: [], prices: [
      { api_id: 'gemini', model: 'gemini-3.5-flash-lite', input: 1e-7, output: 4e-7, source: 'litellm' },
      { api_id: 'claude', model: 'claude-sonnet-5-5', input: 0.000003, output: 0.000015, source: 'litellm' }] });
    assert.equal(r.backfilled, 1);
    const [g, c] = e.sheets.api_usage.toRecords();
    assert.equal(g.priced, 'Y');
    assert.equal(g.cost_usd, 0.00014);
    assert.equal(g.unit_price_in, 1e-7);
    assert.equal(c.cost_usd, 0.0015, '已有費用的列不改');
    assert.equal(c.unit_price_in, 0.000001);
  });

  test('排隊中還沒落地的未定價列，也先落地再回填', () => {
    const e = env();
    e.read(`apiQueueUsage_(${JSON.stringify({ ts: '2026-10-21T01:00:00.000Z', request_id: 'q', api_id: 'gemini', model: 'gemini-3.5-flash-lite',
      feature: 'query', input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, units: '',
      unit_price_in: '', unit_price_out: '', unit_price_other: '', cost_usd: '', priced: 'N' })})`);
    e.post({ action: 'apiPriceApply', trigger: 'write', checked: [],
      prices: [{ api_id: 'gemini', model: 'gemini-3.5-flash-lite', input: 1e-7, output: 4e-7, source: 'litellm' }] });
    const [q] = e.sheets.api_usage.toRecords();
    assert.equal(q.priced, 'Y');
    assert.equal(q.cost_usd, 0.000001);
  });

  test('手動填未定價：source=manual；額度手動改也是新增一列', () => {
    const e = env();
    e.post({ action: 'apiPriceApply', trigger: 'write', checked: [],
      prices: [{ api_id: 'openai', model: 'gpt-6-luna', input: 2e-7, output: 8e-7, source: 'manual' }],
      quotas: [{ api_id: 'gas_urlfetch', quota: 100000, quota_period: 'day', quota_unit: 'call' }] });
    const rows = e.reg();
    const p = rows.find((x) => x.model === 'gpt-6-luna' && x.input_per_token === 2e-7);
    assert.equal(p.source_url, 'manual');
    const q = rows.filter((x) => x.api_id === 'gas_urlfetch');
    assert.equal(q.length, 2);
    assert.equal(q[0].quota, 20000, '舊額度列不動');
    assert.equal(q[1].quota, 100000);
    assert.equal(q[1].billing_mode, 'free_quota');
    assert.equal(q[1].effective_from, '2026-10-21');
  });

  test('擋掉不合理的輸入：沒登記的 model、負數、非數字、未知的 api', () => {
    const e = env();
    const before = JSON.stringify(e.sheets.api_registry.values);
    for (const bad of [
      { prices: [{ api_id: 'claude', model: 'claude-nope', input: 1e-6, output: 1e-6 }] },
      { prices: [{ api_id: 'claude', model: 'claude-haiku-5-5', input: -1, output: 1e-6 }] },
      { prices: [{ api_id: 'claude', model: 'claude-haiku-5-5', input: 'abc', output: 1e-6 }] },
      { quotas: [{ api_id: 'nope', quota: 1, quota_period: 'day' }] },
      { quotas: [{ api_id: 'claude', quota: 1, quota_period: 'day' }] }
    ]) {
      const r = e.post(Object.assign({ action: 'apiPriceApply', trigger: 'write', checked: [] }, bad));
      assert.equal(r.error, 'invalid', JSON.stringify(bad));
    }
    assert.equal(JSON.stringify(e.sheets.api_registry.values), before, '整批擋下，一列都不寫');
  });
});

describe('前端：用量與成本卡的「🔄 重新查價」', () => {
  test('index.html 有按鈕、查價帶 trigger=manual、寫入帶 trigger=write，畫面以每 1M tokens 顯示', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /🔄 重新查價/);
    assert.match(html, /action:'apiPriceCheck', trigger:'manual'/);
    assert.match(html, /action:'apiPriceApply'[^}]*trigger:'write'/);
    assert.match(html, /1M tokens/);
  });
});

describe('前端：每 1M tokens ↔ 每 token 換算', () => {
  test('查價顯示每 1M；確認時改價照 LiteLLM 原值、手填的換回每 token、沒變的只送核價', async () => {
    const { loadFrontend } = await import('./fake-browser.mjs');
    const CHECK = { success: true, today: '2026-10-21', items: [
      { api_id: 'claude', model: 'claude-haiku-5-5', status: 'same', old: { input: 1e-6, output: 5e-6, cacheRead: '', cacheWrite: '' }, new: { input: 1e-6, output: 5e-6, cacheRead: '', cacheWrite: '' } },
      { api_id: 'claude', model: 'claude-sonnet-5-5', status: 'changed', big: true, old: { input: 1e-6, output: 5e-6, cacheRead: '', cacheWrite: '' }, new: { input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheWrite: '' } },
      { api_id: 'openai', model: 'gpt-6-luna', price_key: 'gpt-6-luna', status: 'missing', old: null }
    ], quotas: [{ api_id: 'gas_urlfetch', quota: 20000, quota_period: 'day', quota_unit: 'call' }] };
    let applied = null;
    const e = loadFrontend({ fetchImpl: ({ body }) => {
      if (!body) return null;
      if (body.action === 'apiPriceCheck') return { json: () => Promise.resolve(CHECK) };
      if (body.action === 'apiPriceApply') { applied = body; return { json: () => Promise.resolve({ success: true, added: 2, checked: 1, backfilled: 0 }) }; }
      return null;
    } });
    e.raw(`__els = {};
      document.getElementById = function(id){ return __els[id] || (__els[id] = { id, value:'', innerHTML:'', hidden:false, disabled:false, style:{} }); };
      confirm = function(){ return true; };
      deviceToken = "tok"; localOnly = false;`);
    await e.call('priceCheck');
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    const html = e.read('__els.priceBody.innerHTML');
    assert.match(html, /入 \$1／出 \$5 → 入 \$3／出 \$15／快取讀 \$0\.3/, '改價顯示每 1M tokens');
    assert.match(html, /變動超過 50%/);
    assert.match(html, /未定價/);
    e.raw(`document.getElementById('pIn2').value = '0.2'; document.getElementById('pOut2').value = '0.8'; document.getElementById('qVal0').value = '20000';`);
    await e.call('priceApply');
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    assert.ok(applied, '有送出寫入');
    assert.equal(applied.trigger, 'write');
    assert.deepEqual(applied.checked, [{ api_id: 'claude', model: 'claude-haiku-5-5' }]);
    const son = applied.prices.find((p) => p.model === 'claude-sonnet-5-5');
    assert.deepEqual([son.input, son.output, son.cache_read, son.source], [3e-6, 1.5e-5, 3e-7, 'litellm']);
    const luna = applied.prices.find((p) => p.model === 'gpt-6-luna');
    assert.ok(Math.abs(luna.input - 2e-7) < 1e-18 && Math.abs(luna.output - 8e-7) < 1e-18, JSON.stringify(luna));
    assert.equal(luna.source, 'manual');
    assert.deepEqual(applied.quotas, [], '額度沒改就不送');
  });
});
