/**
 * ADR-022 PR-A — callApi_ 唯一出口 × 流水帳 × 每日彙總 × CI 防漏記
 *
 * 為什麼：外部 API 散在 17 個地方，「💸 用量與成本」只看得到 Apify，AI 花多少完全沒記。
 * 盯的事：
 *   - AI 呼叫後 api_usage 多一列：model、token、**當下的單價**、費用（D-8：每筆自帶單價）
 *   - 改價＝價目表新增一列：舊列費用不變、新呼叫用新價
 *   - 查不到單價的 model：tokens 照記、cost_usd 空、priced=N（D-9）
 *   - 計次型一天只寫一列；gas_urlfetch 算所有呼叫
 *   - 記帳壞掉不可以拖垮主流程（LINE 照樣回話）
 *   - UrlFetchApp 只准出現在 callApi_／callApiAll_（CI 關卡，D-10）
 *   - 四張表 PWA 讀寫都擋；初始化建表、補價目列、可重複
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ME = 'Uneil';
const REG_H = ['api_id', 'model', 'price_key', 'billing_mode', 'input_per_token', 'output_per_token',
  'cache_read_per_token', 'cache_write_per_token', 'unit_price', 'quota', 'quota_period', 'quota_unit', 'effective_from',
  'source_url', 'checked_at', 'active'];
const regRow = (o) => REG_H.map((h) => (o[h] === undefined ? '' : o[h]));
const PRICE = (model, input, output, from = '', extra = {}) => regRow(Object.assign({ api_id: 'claude', model, billing_mode: 'per_token',
  input_per_token: input, output_per_token: output, effective_from: from, active: 'TRUE' }, extra));

const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const CLAUDE_OK = reply(200, { content: [{ type: 'text', text: '答案' }], stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

/** at：台北時間字串 → 呼叫時的「現在」。flush 也用同一個時鐘推進 */
function env({ registry = [], fetch = () => CLAUDE_OK, properties = {}, sheets = {}, overrides = {} } = {}) {
  const clock = { at: new Date('2026-10-20T02:00:00Z') };        // 台北 10:00
  const calls = [];
  const e = loadCodeGs({
    cache: true,
    propsWritable: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    properties: Object.assign({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'k', LINE_CHANNEL_ACCESS_TOKEN: 't' }, properties),
    sheets: Object.assign({
      api_registry: new FakeSheet('api_registry', [REG_H].concat(registry)),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }, sheets),
    overrides: Object.assign({
      apiNow_: () => new Date(clock.at.getTime()),
      UrlFetchApp: {
        fetch: (url, opts) => { calls.push(url); return fetch(url, opts); },
        fetchAll: (reqs) => reqs.map((r) => { calls.push(r.url); return fetch(r.url, r); })
      }
    }, overrides)
  });
  e.clock = clock;
  e.calls = calls;
  e.flush = (iso) => e.read(`flushApiUsage(new Date('${iso}'))`);
  // 上線是每 10 分鐘收一次；快取最多留 6 小時，所以這裡也要一路收過去，不能直接跳到隔天
  e.endOfDay = () => ['2026-10-20T03:30:00Z', '2026-10-20T08:30:00Z', '2026-10-20T13:30:00Z', '2026-10-20T16:05:00Z'].forEach(e.flush);
  e.usage = () => (e.sheets.api_usage ? e.sheets.api_usage.toRecords() : []);
  e.daily = () => (e.sheets.api_usage_daily ? e.sheets.api_usage_daily.toRecords() : []);
  return e;
}
const ai = (e, feature = 'query') => e.call('callAi_', '問題', feature);

describe('付費型：每筆自帶單價', () => {

  test('AI 呼叫後 api_usage 多一列：model、功能、token、單價、費用', () => {
    const e = env({ registry: [PRICE('claude-haiku-5-5', 0.000001, 0.000005)] });
    assert.equal(ai(e).ok, true);
    assert.equal(e.usage().length, 0, '呼叫當下只排隊，不碰 Sheet');
    e.flush('2026-10-20T02:10:00Z');
    const [r] = e.usage();
    assert.equal(r.api_id, 'claude');
    assert.equal(r.model, 'claude-haiku-5-5');
    assert.equal(r.feature, 'query');
    assert.equal(r.input_tokens, 1000);
    assert.equal(r.output_tokens, 200);
    assert.equal(r.unit_price_in, 0.000001);
    assert.equal(r.unit_price_out, 0.000005);
    assert.equal(r.cost_usd, 0.002);
    assert.equal(r.priced, 'Y');
    assert.ok(r.request_id);
  });

  test('改價＝新增一列：舊列費用不變，effective_from 之後的呼叫用新價', () => {
    const e = env({ registry: [PRICE('claude-haiku-5-5', 0.000001, 0.000005, '2026-10-01')] });
    ai(e);
    e.flush('2026-10-20T02:10:00Z');
    e.sheets.api_registry.values.push(PRICE('claude-haiku-5-5', 0.000002, 0.00001, '2026-10-21'));
    e.call('apiClearPriceCache_');
    ai(e);                                            // 還是 10/20：新價還沒生效
    e.clock.at = new Date('2026-10-21T02:00:00Z');
    ai(e);
    e.flush('2026-10-21T02:10:00Z');
    assert.deepEqual(e.usage().map((r) => r.cost_usd), [0.002, 0.002, 0.004]);
    assert.equal(e.sheets.api_usage.values[1][e.sheets.api_usage.values[0].indexOf('cost_usd')], 0.002, '舊列一格都沒動');
  });

  test('價目表沒有這個 model：tokens 照記、費用空、priced=N', () => {
    const e = env({ registry: [PRICE('claude-sonnet-5-5', 0.000003, 0.000015)] });
    ai(e, 'clip_ai');
    e.flush('2026-10-20T02:10:00Z');
    const [r] = e.usage();
    assert.equal(r.model, 'claude-haiku-5-5');
    assert.equal(r.input_tokens, 1000);
    assert.equal(r.cost_usd, '');
    assert.equal(r.priced, 'N');
    assert.equal(r.feature, 'clip_ai');
  });

  test('只登記 model、還沒填價（初始化的種子列）也算未定價', () => {
    const e = env({ registry: [regRow({ api_id: 'claude', model: 'claude-haiku-5-5', billing_mode: 'per_token', active: 'TRUE' })] });
    ai(e);
    e.flush('2026-10-20T02:10:00Z');
    assert.equal(e.usage()[0].priced, 'N');
  });

  test('三家的 token 換成同一套：快取那段從輸入扣掉、Gemini 思考算輸出', () => {
    const e = env();
    const t = (id, body) => e.read(`apiTokens_('${id}', { getContentText: function () { return ${JSON.stringify(JSON.stringify(body))}; } })`);
    assert.deepEqual(t('openai', { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } }),
      { input: 70, output: 20, cacheRead: 30, cacheWrite: 0 });
    assert.deepEqual(t('gemini', { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 8 } }),
      { input: 42, output: 15, cacheRead: 8, cacheWrite: 0 });
    assert.deepEqual(t('claude', { usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } }),
      { input: 9, output: 3, cacheRead: 4, cacheWrite: 2 });
  });

  test('AI 回錯誤（HTTP 500）不記 api_usage（沒用到 token），但次數照算', () => {
    const e = env({ fetch: () => reply(500, 'boom') });
    assert.equal(ai(e).ok, false);
    e.endOfDay();
    assert.equal(e.usage().length, 0);
    assert.equal(e.daily().find((r) => r.api_id === 'gas_urlfetch').calls, 1);
  });
});

describe('計次型：一天一列', () => {

  test('同一天打很多次 → 跨日後每個 API 一列；gas_urlfetch 算全部；429 另計', () => {
    const e = env({ fetch: (url) => (/fugle/.test(url) ? reply(429, '') : reply(200, '{}')) });
    e.call('callApi_', 'cwa', 'https://opendata.cwa.gov.tw/x', {});
    e.call('callApi_', 'cwa', 'https://opendata.cwa.gov.tw/x', {});
    e.call('callApiAll_', 'fugle', [{ url: 'https://api.fugle.tw/a' }, { url: 'https://api.fugle.tw/b' }]);
    e.clock.at = new Date('2026-10-20T12:30:00Z');                  // 台北 20:30
    e.call('callApi_', 'cwa', 'https://opendata.cwa.gov.tw/x', {});
    e.flush('2026-10-20T05:00:00Z');                                 // 當天：搬了早上的桶，還不寫列
    assert.equal(e.daily().length, 0);
    e.endOfDay();                                                    // 最後一次是台北隔天 00:05
    const rows = e.daily();
    const by = Object.fromEntries(rows.map((r) => [r.api_id, r]));
    assert.equal(rows.filter((r) => r.api_id === 'cwa').length, 1, '一天一列');
    assert.equal(by.cwa.calls, 3);
    assert.equal(by.cwa.date, '2026-10-20');
    assert.equal(by.fugle.calls, 2);
    assert.equal(by.fugle.rate_limited, 2);
    assert.equal(by.gas_urlfetch.calls, 5);
    e.flush('2026-10-20T16:20:00Z');
    assert.equal(e.daily().length, rows.length, '再跑一次不重寫');
  });

  test('有額度的 API 算出用量百分比（gas_urlfetch 每天 20000）', () => {
    const e = env({ fetch: () => reply(200, '{}'), registry: [regRow({ api_id: 'gas_urlfetch', billing_mode: 'free_quota',
      quota: 20000, quota_period: 'day', quota_unit: 'call', effective_from: '2026-10-20', active: 'TRUE' })] });
    for (let i = 0; i < 4; i++) e.call('callApi_', 'web', 'https://example.com/', {});
    e.endOfDay();
    const g = e.daily().find((r) => r.api_id === 'gas_urlfetch');
    assert.equal(g.quota, 20000);
    assert.equal(g.used_in_period, 4);
    assert.equal(g.pct, 0);
  });

  test('付費型不寫每日列（逐筆已經在 api_usage）', () => {
    const e = env();
    ai(e);
    e.endOfDay();
    assert.ok(!e.daily().some((r) => r.api_id === 'claude'));
    assert.ok(e.daily().some((r) => r.api_id === 'gas_urlfetch'));
  });
});

describe('記帳不可以拖垮主流程', () => {

  test('快取壞掉：回應照樣交回、不丟例外', () => {
    const e = env({ overrides: { CacheService: { getScriptCache: () => { throw new Error('快取掛了'); } } } });
    const r = e.call('callApi_', 'line_reply', 'https://api.line.me/v2/bot/message/reply', {});
    assert.equal(r.getResponseCode(), 200);
  });

  test('網路例外原樣丟回呼叫者，次數照算', () => {
    const e = env({ fetch: () => { throw new Error('DNS'); } });
    assert.throws(() => e.call('callApi_', 'cwa', 'https://x', {}), /DNS/);
    e.endOfDay();
    assert.equal(e.daily().find((r) => r.api_id === 'cwa').calls, 1);
  });
});

describe('月結估算', () => {

  test('AI 各家加總本月 cost_usd、Apify 用 clips_usage 實際值；Neil 填的實際金額不動', () => {
    const e = env({ registry: [PRICE('claude-haiku-5-5', 0.000001, 0.000005)],
      properties: { clips_usage: JSON.stringify({ usd: 1.23, at: '2026-10-20T00:00:00Z' }) },
      sheets: { api_cost_monthly: new FakeSheet('api_cost_monthly', [['month', 'api_id', 'est_cost_usd', 'actual_amount', 'actual_currency', 'note'],
        ['2026-10', 'claude', 0, 9.99, 'USD', '帳單']]) } });
    ai(e); ai(e);
    e.endOfDay();
    const m = Object.fromEntries(e.sheets.api_cost_monthly.toRecords().map((r) => [r.api_id, r]));
    assert.equal(m.claude.est_cost_usd, 0.004);
    assert.equal(m.claude.actual_amount, 9.99);
    assert.equal(m.claude.note, '帳單');
    assert.equal(m.apify.est_cost_usd, 1.23);
  });
});

describe('CI 關卡：UrlFetchApp 只准在 callApi_／callApiAll_', () => {
  const run = (dir) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-api-exit.mjs'), dir], { encoding: 'utf8' });

  test('repo 現況：通過', () => {
    const r = run(join(ROOT, 'apps-script'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('在別的函式直接呼叫 UrlFetchApp.fetch → 紅燈，並指出檔案與函式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-exit-'));
    writeFileSync(join(dir, 'api-cost.gs'), readFileSync(join(ROOT, 'apps-script', 'api-cost.gs')));
    writeFileSync(join(dir, 'sneaky.gs'), "function sneaky_() {\n  return UrlFetchApp.fetch('https://x');\n}\n");
    const r = run(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /sneaky\.gs:2.*sneaky_/);
  });

  test('fetchAll、把 UrlFetchApp 存到變數也擋', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-exit-'));
    writeFileSync(join(dir, 'a.gs'), "function a_() { var f = UrlFetchApp; return f.fetchAll([]); }\n");
    assert.notEqual(run(dir).status, 0);
  });

  test('註解裡提到 UrlFetchApp 不算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-exit-'));
    writeFileSync(join(dir, 'a.gs'), "/**\n * UrlFetchApp.fetch 有逾時上限\n */\n// UrlFetchApp.fetchAll 也是\nfunction a_() { return 1; }\n");
    assert.equal(run(dir).status, 0);
  });

  test('pr-check 會跑這一關', () => {
    assert.match(readFileSync(join(ROOT, '.github', 'workflows', 'pr-check.yml'), 'utf8'), /node scripts\/check-api-exit\.mjs apps-script/);
  });

  test('每個 callApi_／callApiAll_ 的 api_id 都在登記表裡（漏登記的 API 次數會搬不到）', () => {
    const e = env();
    const catalog = e.read('Object.keys(apiCatalog_())');
    const dir = join(ROOT, 'apps-script');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.gs'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/callApi(?:All)?_\(\s*([^,)]+)/g)) {
        const arg = m[1].trim();
        if (/^(apiId|clipApiId_|stockApiId_)/.test(arg)) continue;     // 依網址判斷的兩個 helper，下面另測
        assert.ok(catalog.includes(arg.replace(/'/g, '')), `${f}: ${arg}`);
      }
    }
    assert.equal(e.call('clipApiId_', 'https://api.apify.com/v2/acts'), 'apify');
    assert.equal(e.call('clipApiId_', 'https://scontent.cdninstagram.com/x.jpg'), 'web');
    assert.equal(e.call('stockApiId_', 'https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/2330'), 'fugle');
    assert.equal(e.call('stockApiId_', 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'), 'tpex');
    assert.equal(e.call('stockApiId_', 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'), 'twse');
  });
});

describe('四張表：PWA 碰不到、初始化建好、排程收尾', () => {

  test('PWA 讀寫都擋', () => {
    const e = env();
    for (const s of ['api_registry', 'api_usage', 'api_usage_daily', 'api_cost_monthly']) {
      assert.ok(e.read('NO_PWA_READ').includes(s), s);
      assert.ok(e.read('NO_PWA_WRITE').includes(s), s);
    }
  });

  test('初始化建四張表＋登記價目；再跑一次不重複，Neil 改過的列不動', () => {
    const e = env({ sheets: { api_registry: undefined } });
    delete e.sheets.api_registry;
    const step = () => e.read('initSteps_().filter(function (s) { return s.label === "用量與成本記帳"; })[0].run()');
    const first = step();
    assert.equal(first.changed, true);
    for (const s of ['api_registry', 'api_usage', 'api_usage_daily', 'api_cost_monthly']) assert.ok(e.sheets[s], s);
    const reg = e.sheets.api_registry.toRecords();
    assert.ok(reg.some((r) => r.api_id === 'claude' && r.model === 'claude-haiku-5-5' && r.input_per_token === ''), 'AI 只登記 model');
    assert.ok(reg.some((r) => r.api_id === 'gas_urlfetch' && r.quota === 20000 && r.quota_period === 'day'));
    assert.ok(reg.some((r) => r.api_id === 'fugle' && r.quota === 60 && r.quota_period === 'minute'));
    const n = reg.length;
    const h = e.sheets.api_registry.values[0];
    e.sheets.api_registry.values[1][h.indexOf('active')] = 'FALSE';
    const again = step();
    assert.equal(again.changed, false);
    assert.equal(e.sheets.api_registry.values.length - 1, n);
    assert.equal(e.sheets.api_registry.values[1][h.indexOf('active')], 'FALSE');
  });

  test('排程總管登記了收尾工作（每 10 分鐘）', () => {
    const e = env();
    const job = e.read('schedulerJobs_().filter(function (j) { return j.name === "apiFlush"; })[0]');
    assert.ok(job);
    assert.deepEqual(job.rule, { kind: 'every', minutes: 10 });
  });

  test('_guide 登記了四張表', () => {
    const e = env();
    const names = e.read('guideRegistry_().map(function (g) { return g.sheet; })');
    for (const s of ['api_registry', 'api_usage', 'api_usage_daily', 'api_cost_monthly']) assert.ok(names.includes(s), s);
  });
});
