/**
 * ADR-018 PR-0（D-4）— 開機分段計時
 *
 * 為什麼有這批測試：10/8 後 boot cold 的 server_ms 中位 6345ms，auth 1554＋open 11＋read 1890，
 * 約 2.9 秒說不出花在哪。PR-A 要優化之前得先知道是哪一段——所以這裡盯的是：
 *   - boot／readMany 的每一段都有記到（驗證的三個子段、名單、各表、分類設定、分期、群組、
 *     管理員的 perf_rows／unauth_alert、股票與報價、序列化），寫進 performance 的 stages 欄
 *   - 頂層各段加總不超過 server_ms（子段不重複算）；只有段名與毫秒，沒有資料內容
 *   - perfSummary 依 action 算各段中位數，以及「未歸屬」＝server_ms − 頂層加總 的中位數
 *   - 管理員的效能卡片把分段畫出來（看得到就不用去 Sheet 手算）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';     // 管理者
const MOM = 'Umom';     // 一般成員（沒有股票、沒有記帳）
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const PERF_HEADERS = ['id', 'ts', 'action', 'trigger', 'client_ms', 'server_ms', 'auth_ms', 'open_ms', 'read_ms',
  'sheets', 'rows', 'device_id', 'line_id', 'reply_ms', 'stages'];

function env({ sheets = {} } = {}) {
  return loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: Object.assign({
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks', 'feat_stock'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '', '', 'TRUE', '']
      ]),
      tasks: new FakeSheet('tasks', [
        ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'origin_chat'],
        ['1', '買菜祕密', '', '', 'M', ME, '', '']
      ]),
      expenses: new FakeSheet('expenses', [
        ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del'],
        ['10', '2026-10-01', 'expense', '餐飲', 120, '午餐祕密', '', ME, '']
      ]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }, sheets),
    // 報價不打外部：這裡只驗「有被計時」，報價本身的行為在 adr-015-stock
    overrides: { quote_: () => ({ quotes: {}, missing: [] }) }
  });
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

const perfRows = (e) => (e.sheets.performance ? e.sheets.performance.toRecords() : []);
const stagesOf = (row) => JSON.parse(row.stages);
const topLevelSum = (st) => Object.keys(st).filter((k) => k.indexOf('.') === -1).reduce((a, k) => a + st[k], 0);

/* ========================================================================== */
describe('boot／readMany：每一段都記到 stages 欄', () => {

  test('管理員 boot（財務區）：驗證三子段、名單、各表、分類、分期、群組、perf_rows、報價、序列化都在', () => {
    const e = env();
    const out = post(e, { token: TOK_ME, action: 'boot', trigger: 'cold', stock: true });
    assert.equal(out.session.status, 'ok', '主流程照常');
    assert.ok(out.stock, '有帶股票');

    const row = perfRows(e).find((r) => r.action === 'boot');
    assert.ok(row, 'boot 寫了一列');
    const st = stagesOf(row);
    for (const k of ['parse', 'auth', 'auth.device', 'auth.gate', 'auth.touch', 'open', 'users',
      'sheets', 'sheets.tasks', 'sheets.expenses', 'groups', 'perf_rows', 'unauth_alert',
      'expense_config', 'installments', 'stock', 'stock.quote', 'json']) {
      assert.equal(typeof st[k], 'number', '缺 ' + k);
      assert.ok(st[k] >= 0, k + ' 不能是負數');
    }
    assert.equal(st.auth, row.auth_ms, 'auth 段就是原本的 auth_ms，不重量');
    assert.ok(topLevelSum(st) <= row.server_ms, '頂層加總不超過 server_ms：子段沒有被重複加');
  });

  test('一般成員 boot：沒權限的段不出現（沒有記帳就沒有分類／分期、不是管理員就沒有 perf_rows、沒帶 stock 就沒有報價）', () => {
    const e = env();
    post(e, { token: TOK_MOM, action: 'boot', trigger: 'cold' });
    const st = stagesOf(perfRows(e).find((r) => r.action === 'boot'));
    for (const k of ['expense_config', 'installments', 'perf_rows', 'unauth_alert', 'stock', 'stock.quote', 'sheets.expenses']) {
      assert.equal(st[k], undefined, k + ' 不該出現');
    }
    assert.equal(typeof st['sheets.tasks'], 'number');
  });

  test('readMany（輪詢）：同一套分段；不讀名單所以沒有 users', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks', 'expenses'], trigger: 'poll', stock: true });
    const st = stagesOf(perfRows(e).find((r) => r.action === 'readMany'));
    for (const k of ['auth', 'open', 'sheets', 'sheets.tasks', 'sheets.expenses', 'expense_config', 'installments', 'stock', 'json']) {
      assert.equal(typeof st[k], 'number', '缺 ' + k);
    }
    assert.equal(st.users, undefined);
  });

  test('stages 只有段名與毫秒：找不到 token、資料內容', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'boot', trigger: 'cold', stock: true });
    const raw = perfRows(e).find((r) => r.action === 'boot').stages;
    assert.ok(!raw.includes(TOK_ME) && !raw.includes('祕密'), raw);
    for (const [k, v] of Object.entries(JSON.parse(raw))) {
      assert.match(k, /^[a-z_]+(\.[a-z_]+)?$/, '段名只能是英文小寫：' + k);
      assert.equal(typeof v, 'number');
    }
  });

  test('舊表（沒有 stages 欄）：自動補在最右邊，舊欄位一格不動', () => {
    const old = PERF_HEADERS.slice(0, -1);
    const e = env({ sheets: { performance: new FakeSheet('performance', [old.slice()]) } });
    post(e, { token: TOK_ME, action: 'boot', trigger: 'cold' });
    assert.deepEqual(e.sheets.performance.values[0], PERF_HEADERS);
    assert.ok(stagesOf(perfRows(e)[0]).auth >= 0);
  });
});

/* ========================================================================== */
describe('perfSummary：各段中位數＋未歸屬', () => {

  function seeded(rows) {
    return new FakeSheet('performance', [PERF_HEADERS.slice()].concat(rows.map((r, i) => PERF_HEADERS.map((h) => {
      if (h === 'id') return String(1000 + i);
      if (h === 'ts') return new Date(Date.now() - 3600000).toISOString();
      if (h === 'stages') return r.stages ? JSON.stringify(r.stages) : '';
      return r[h] === undefined ? '' : r[h];
    }))));
  }

  test('依 action 算各段中位數（由慢到快），未歸屬＝server_ms − 頂層加總；子段不扣', () => {
    const e = env({ sheets: { performance: seeded([
      { action: 'boot', trigger: 'cold', server_ms: 6000, stages: { auth: 1500, 'auth.gate': 1400, sheets: 1900, stock: 2000, 'stock.quote': 1800 } },
      { action: 'boot', trigger: 'cold', server_ms: 7000, stages: { auth: 1600, 'auth.gate': 1500, sheets: 2000, stock: 2400, 'stock.quote': 2200 } },
      { action: 'boot', trigger: 'cold', server_ms: 5000, stages: { auth: 1400, 'auth.gate': 1300, sheets: 1800, stock: 1000, 'stock.quote': 900 } },
      { action: 'boot', trigger: 'cold', server_ms: 9999 },            // 改版前的列：沒有 stages，不算進分段
      { action: 'read', trigger: 'poll', server_ms: 300, stages: { auth: 100 } }
    ]) } });
    const s = post(e, { token: TOK_ME, action: 'perfSummary', trigger: 'manual' });
    const boot = s.server.find((g) => g.action === 'boot');
    assert.equal(boot.count, 4, '總次數照舊含舊列');
    assert.equal(boot.staged, 3, '有分段的只有 3 列');
    assert.deepEqual(boot.stages.map((x) => x.name), ['stock', 'sheets', 'stock.quote', 'auth', 'auth.gate'], '由慢到快');
    assert.deepEqual(boot.stages.find((x) => x.name === 'stock'), { name: 'stock', p50: 2000, count: 3 });
    // 未歸屬：600、1000、800 → 中位 800
    assert.equal(boot.other_p50, 800);
    assert.equal(s.server.find((g) => g.action === 'read').other_p50, 200);
  });

  test('沒有任何一列有分段：不帶 stages（畫面就不多一行）', () => {
    const e = env({ sheets: { performance: seeded([{ action: 'boot', trigger: 'cold', server_ms: 6000 }]) } });
    const s = post(e, { token: TOK_ME, action: 'perfSummary', trigger: 'manual' });
    const boot = s.server.find((g) => g.action === 'boot');
    assert.equal(boot.stages, undefined);
    assert.equal(boot.other_p50, undefined);
  });
});

/* ========================================================================== */
describe('效能卡片畫出分段', () => {

  test('有分段的動作多一行：頂層段＋未歸屬，子段縮排；中文名', () => {
    const e = loadFrontend({ fetchImpl: () => Promise.reject(new Error('offline')) });
    const html = e.call('perfSummaryHtml', {
      success: true, days: 7, total: 3, oldest: '2026-10-10T00:00:00.000Z',
      client: [],
      server: [{ action: 'boot', count: 3, p50: 6000, p90: 7000, auth_pct: 25, open_pct: 0, read_pct: 30, staged: 3,
        other_p50: 800,
        stages: [{ name: 'stock', p50: 2000, count: 3 }, { name: 'stock.quote', p50: 1800, count: 3 }, { name: 'auth', p50: 1500, count: 3 }] }]
    });
    assert.match(html, /分段（一般，3 筆）/);
    assert.match(html, /股票 2\.0 秒/);
    assert.match(html, /└ 報價 1\.8 秒/);
    assert.match(html, /驗證 1\.5 秒/);
    assert.match(html, /未歸屬 800 ms/);
  });
});
