/**
 * ADR-021 PR-C（後端）— Finance／Mail／Weather Widget、WidgetConfig、天氣排程
 *
 * 為什麼有這批測試：
 *  - Finance 要讀 expenses：不放進開機（PR-B 守住的冷開機），開機後另外要（widgets only:['finance']）
 *  - Mail：只給管理者＋feat_gmail（D-16），帶今日各標籤筆數＋異常警告（規則掛了不存在的解析器）
 *  - Weather（D-15）：排程每小時依縣市抓一次、存雲端；Widget 只讀存好的，不在請求裡打氣象署。
 *    解析照官方文件的值欄位（Temperature／ProbabilityOfPrecipitation／Weather），≥50% 帶傘；
 *    抓取失敗只有天氣那一格不行，排程寫 logs
 *  - WidgetConfig（D-8）：一人一列，只能改自己的（鍵用驗證出來的 line_id，不信 body）；只收認得的值
 *  - 盤中排序要的 trading 由後端給（沿用股票模組的交易時段判斷，不在前端另寫一份）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes', 'feat_clips', 'feat_gmail', 'feat_stock'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'subcategory', 'amount', 'note', 'created_at', 'line_id', 'del', 'archive', 'board', 'plan_id', 'plan_seq'];

/** 官方文件格式的鄉鎮預報（未來 3 天）：溫度逐小時（DataTime）、降雨機率與天氣現象逐 3 小時（StartTime／EndTime） */
function cwaSample(district = '中正區', day = '2026-10-20') {
  const hours = [12, 15, 18, 21];
  const iso = (d, h) => `${d}T${String(h).padStart(2, '0')}:00:00+08:00`;
  return {
    success: 'true',
    records: { Locations: [{ LocationsName: '臺北市', Location: [
      { LocationName: '大安區', WeatherElement: [] },
      { LocationName: district, WeatherElement: [
        { ElementName: '溫度', Time: hours.map((h, i) => ({ DataTime: iso(day, h), ElementValue: [{ Temperature: String(24 + i * 2) }] }))
            .concat([{ DataTime: iso('2026-10-21', 9), ElementValue: [{ Temperature: '35' }] }]) },
        { ElementName: '3小時降雨機率', Time: hours.map((h, i) => ({ StartTime: iso(day, h), EndTime: iso(day, h + 3),
            ElementValue: [{ ProbabilityOfPrecipitation: String([20, 60, 30, 10][i]) }] })) },
        { ElementName: '天氣現象', Time: hours.map((h) => ({ StartTime: iso(day, h), EndTime: iso(day, h + 3),
            ElementValue: [{ Weather: h < 15 ? '多雲' : '短暫陣雨', WeatherCode: '04' }] })) }
      ] }
    ] }] }
  };
}

function env({ feats = FEATS, admin = true, extra = {}, props = {}, fetch = null, opts = {} } = {}) {
  const sheets = Object.assign({
    line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
      [ME, 'Neil', 'TRUE', admin ? 'TRUE' : ''].concat(FEATS.map((f) => (feats.includes(f) ? 'TRUE' : ''))),
      [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
    ]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'line_id', 'del', 'board', 'kind']]),
    expenses: new FakeSheet('expenses', [EXP_H]),
    logs: new FakeSheet('logs', [['id']])
  }, extra);
  const overrides = Object.assign({}, opts.overrides || {});
  if (fetch) overrides.UrlFetchApp = { fetch };
  return loadCodeGs(Object.assign({ tokens: { 'tok-me': ME, 'tok-mom': MOM }, sheets, properties: Object.assign({ WEATHER_API: 'k' }, props),
    propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'] }, opts, { overrides }));
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const core = (e, tok) => post(e, { action: 'boot', core: true, trigger: 'cold' }, tok);
const okFetch = (json, seen = []) => (url) => { seen.push(url); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(json) }; };

/* ========================================================================== */
describe('Finance：不在開機，另外要', () => {

  test('boot core 不帶 finance、不整張讀 expenses', () => {
    const e = env();
    let reads = 0;
    const orig = e.sheets.expenses.getDataRange.bind(e.sheets.expenses);
    e.sheets.expenses.getDataRange = () => { reads++; return orig(); };
    const b = core(e);
    assert.equal(b.widgets.finance, undefined);
    assert.equal(reads, 0);
  });

  test('widgets only:[finance]：本月的列＋之後的分期列；別的月份、刪掉的不帶；附分類設定與分期計畫', () => {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const mk = now.getFullYear() + '-' + p(now.getMonth() + 1);
    const nextYear = (now.getFullYear() + 1) + '-01-01';
    const e = env();
    e.sheets.expenses.values.push(
      ['1', mk + '-01', 'expense', '餐飲', '', 120, '', '', ME, '', '', '', '', ''],
      ['2', '2020-01-01', 'expense', '餐飲', '', 999, '', '', ME, '', '', '', '', ''],
      ['3', mk + '-02', 'expense', '交通', '', 50, '', '', ME, 'TRUE', '', '', '', ''],
      ['4', nextYear, 'expense', '分期', '', 300, '', '', ME, '', '', '', 'P1', '3/12']);
    const r = post(e, { action: 'widgets', only: ['finance'], trigger: 'manual' });
    assert.deepEqual(r.widgets.finance.rows.map((x) => String(x.id)).sort(), ['1', '4']);
    assert.ok(r.widgets.finance.expense_config);
    assert.ok(Array.isArray(r.widgets.finance.installments));
    assert.equal(r.widgets.tasks, undefined, 'only 只回要的那幾個');
  });

  test('沒有記帳權限：不帶 finance', () => {
    const e = env({ feats: ['feat_tasks'] });
    assert.equal(post(e, { action: 'widgets', only: ['finance'], trigger: 'manual' }).widgets.finance, undefined);
  });
});

/* ========================================================================== */
describe('Mail：管理者＋feat_gmail，筆數＋異常警告', () => {

  const rules = () => new FakeSheet('gmail_rules', [
    ['rule_id', 'is_active', 'source_name', 'mail_type', 'bill_category', 'from', 'subject_kw', 'label', 'save_attachment', 'notify', 'parser', 'note'],
    ['R1', 'TRUE', '電信', 'bill', '電信', 'a@b.c', '帳單', 'NeilOS/帳單', '', '', '不存在的解析器', ''],
    ['R2', 'TRUE', '電子報', 'newsletter', '', 'x@y.z', '', 'NeilOS/電子報', '', '', '', '']
  ]);
  const log = () => new FakeSheet('gmail_log', [['msg_id', 'received_at', 'mail_type'], ['m1', new Date().toISOString(), 'bill']]);

  test('管理者：today 筆數＋警告（規則掛了不存在的解析器）', () => {
    const e = env({ extra: { gmail_rules: rules(), gmail_log: log() } });
    const m = core(e).widgets.mail;
    assert.equal(m.bill, 1);
    assert.ok(m.warnings.some((w) => /不存在的解析器/.test(w)));
  });

  test('非管理者：不帶 mail', () => {
    const e = env({ admin: false, extra: { gmail_rules: rules(), gmail_log: log() } });
    assert.equal(core(e).widgets.mail, undefined);
  });
});

/* ========================================================================== */
describe('Weather：排程抓、存雲端；Widget 只讀存好的', () => {

  test('解析：今天剩下的時段取高低溫、最高降雨機率、天氣現象；≥50% 帶傘', () => {
    const e = env();
    const w = e.call('weatherSummaryOf_', cwaSample(), '中正區', Date.parse('2026-10-20T11:00:00+08:00'));
    assert.deepEqual([w.district, w.wx, w.max, w.min, w.pop, w.umbrella, w.period], ['中正區', '多雲', 30, 24, 60, true, '今天']);
  });

  test('晚上今天已沒有時段：改報明天', () => {
    const e = env();
    const w = e.call('weatherSummaryOf_', cwaSample(), '中正區', Date.parse('2026-10-20T23:30:00+08:00'));
    assert.equal(w.period, '明天');
    assert.equal(w.max, 35);
  });

  test('找不到鄉鎮：回 error（不是丟例外）', () => {
    const e = env();
    assert.equal(e.call('weatherSummaryOf_', cwaSample(), '不存在區', Date.now()).error, 'district_not_found');
  });

  test('排程：每個縣市只抓一次（帶授權碼、縣市的資料集），結果存進指令碼屬性', () => {
    const seen = [];
    const cfg = new FakeSheet('widget_config', [['line_id', 'weather_county', 'weather_district'], [ME, '臺北市', '中正區'], [MOM, '臺北市', '大安區']]);
    const sample = cwaSample();
    sample.records.Locations[0].Location[0] = cwaSample('大安區').records.Locations[0].Location[1];
    const e = env({ extra: { widget_config: cfg }, fetch: okFetch(sample, seen) });
    e.call('runWeatherJob_', new Date('2026-10-20T03:00:00Z'));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /F-D0047-061/);
    assert.match(seen[0], /Authorization=k/);
    const cache = JSON.parse(e.properties.weather_cache);
    assert.equal(cache['臺北市|中正區'].wx, '多雲');
    assert.equal(cache['臺北市|大安區'].district, '大安區');
  });

  test('排程抓失敗：寫 logs；那個地點記 error，其他照常', () => {
    const e = env({ fetch: () => { throw new Error('模擬：連不上'); } });
    e.call('runWeatherJob_', new Date('2026-10-20T03:00:00Z'));
    assert.ok(e.transactions.some((t) => t[0] === '天氣' && t[1] === '失敗'));
    assert.equal(JSON.parse(e.properties.weather_cache)['臺北市|中正區'].error, 'fetch_failed');
  });

  test('網路例外訊息帶著網址（含授權碼）：寫進 logs 前遮掉', () => {
    const e = env({ props: { WEATHER_API: 'SECRET-KEY-123' }, fetch: (url) => { throw new Error('Address unavailable: ' + url); } });
    e.call('runWeatherJob_', new Date('2026-10-20T03:00:00Z'));
    const logged = JSON.stringify(e.transactions.filter((t) => t[0] === '天氣'));
    assert.doesNotMatch(logged, /SECRET-KEY-123/);
    assert.match(logged, /\*\*\*/);
  });

  test('沒設授權碼：寫 logs、不打網路', () => {
    let called = 0;
    const e = env({ props: { WEATHER_API: '' }, fetch: () => { called++; } });
    e.call('runWeatherJob_', new Date());
    assert.equal(called, 0);
    assert.ok(e.transactions.some((t) => t[0] === '天氣' && /WEATHER_API/.test(t[3] + t[4])));
  });

  test('Widget：讀這個人地點的那一份（預設臺北市中正區）；不在請求裡打氣象署', () => {
    let called = 0;
    const e = env({ props: { weather_cache: JSON.stringify({ '臺北市|中正區': { district: '中正區', wx: '晴', max: 30, min: 22, pop: 10, umbrella: false, period: '今天', at: 'x' } }) },
      fetch: () => { called++; } });
    const w = core(e).widgets.weather;
    assert.equal(w.wx, '晴');
    assert.equal(w.county, '臺北市');
    assert.equal(called, 0);
  });

  test('Widget：那個地點抓失敗過 → 回 error（只有天氣那一格「連不上」）', () => {
    const e = env({ props: { weather_cache: JSON.stringify({ '臺北市|中正區': { error: 'fetch_failed', at: 'x' } }) } });
    const b = core(e);
    assert.equal(b.widgets.weather.error, 'fetch_failed');
    assert.equal(b.session.status, 'ok');
  });

  test('排程登記表有天氣（每小時）', () => {
    const e = env();
    const job = e.read('schedulerJobs_().filter(function(j){ return j.name === "weather"; })[0]');
    assert.deepEqual(job.rule, { kind: 'hourly' });
  });
});

/* ========================================================================== */
describe('WidgetConfig（D-8）：一人一份、只能改自己的', () => {

  test('沒存過：boot core 帶預設（Tasks→Finance→Mail→Stocks→Reading→Weather、臺北市中正區）', () => {
    const c = core(env()).widget_config;
    assert.deepEqual(c.order, ['tasks', 'finance', 'mail', 'stocks', 'reading', 'weather']);
    assert.deepEqual([c.weather_county, c.weather_district], ['臺北市', '中正區']);
    assert.deepEqual([c.pinned, c.hidden, c.apps_pinned, c.apps_hidden], [[], [], [], []]);
  });

  test('存自己的：寫進 widget_config 一列；再讀回來一樣', () => {
    const e = env({ fetch: okFetch(cwaSample('大安區')) });
    const r = post(e, { action: 'widgetConfigSet', trigger: 'write', config: { order: ['weather', 'tasks'], pinned: ['weather'], hidden: ['mail'],
      apps_pinned: ['expenses'], apps_hidden: ['plans'], weather_county: '臺北市', weather_district: '大安區' } });
    assert.equal(r.success, true);
    const c = core(e).widget_config;
    assert.deepEqual(c.order.slice(0, 2), ['weather', 'tasks']);
    assert.deepEqual([c.pinned, c.hidden, c.apps_pinned, c.apps_hidden], [['weather'], ['mail'], ['expenses'], ['plans']]);
    assert.equal(c.weather_district, '大安區');
    assert.equal(e.sheets.widget_config.toRecords().length, 1);
  });

  test('別人改不到我的：body 帶我的 line_id 也只會寫到他自己那列', () => {
    const e = env();
    post(e, { action: 'widgetConfigSet', trigger: 'write', config: { pinned: ['tasks'] } });
    post(e, { action: 'widgetConfigSet', trigger: 'write', line_id: ME, config: { pinned: ['mail'], line_id: ME } }, 'tok-mom');
    const rows = e.sheets.widget_config.toRecords();
    assert.equal(rows.find((r) => r.line_id === ME).widget_pinned, 'tasks');
    assert.equal(rows.find((r) => r.line_id === MOM).widget_pinned, 'mail');
  });

  test('只收認得的值：不認得的 Widget／模組丟掉；縣市不在清單、鄉鎮太長 → invalid', () => {
    const e = env();
    post(e, { action: 'widgetConfigSet', trigger: 'write', config: { order: ['tasks', 'hack', '=CMD()'], apps_pinned: ['expenses', 'nope'] } });
    const c = core(e).widget_config;
    assert.ok(!c.order.includes('hack'));
    assert.deepEqual(c.apps_pinned, ['expenses']);
    assert.equal(post(e, { action: 'widgetConfigSet', trigger: 'write', config: { weather_county: '火星', weather_district: '一區' } }).error, 'invalid_location');
    assert.equal(post(e, { action: 'widgetConfigSet', trigger: 'write', config: { weather_county: '臺北市', weather_district: 'x'.repeat(20) } }).error, 'invalid_location');
  });

  test('換了地點：當場抓一次那個縣市（不用等下一輪排程）', () => {
    const seen = [];
    const e = env({ fetch: okFetch(cwaSample('大安區'), seen) });
    post(e, { action: 'widgetConfigSet', trigger: 'write', config: { weather_county: '臺北市', weather_district: '大安區' } });
    assert.equal(seen.length, 1);
    assert.equal(core(e).widgets.weather.district, '大安區');
  });

  test('PWA 不能直接讀寫 widget_config（只走 boot 與 widgetConfigSet）', () => {
    const e = env();
    assert.equal(post(e, { action: 'read', sheet: 'widget_config', trigger: 'manual' }).error, 'sheet_not_readable');
    assert.equal(post(e, { action: 'upsert', sheet: 'widget_config', key_field: 'line_id', record: { line_id: ME } }).error, 'sheet_not_writable');
  });
});

/* ========================================================================== */
describe('盤中排序要的 trading', () => {
  test('boot core 帶 trading（沿用 isTwTradingTime_）', () => {
    const b = core(env());
    assert.equal(typeof b.widgets_meta.trading, 'boolean');
  });
});
