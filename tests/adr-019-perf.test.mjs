/**
 * ADR-019 B-2／B-3（交棒 PR-2）— 效能紀錄單一寫入者＋request_id：後端
 *
 * 為什麼有這批測試：10/15 一次 flush 37 列花 150 秒（逐列 appendRow），12:00 又跟股票規則、
 * 輪詢撞在一起。B-2 讓「碰撞不可能發生」：PWA、LINE、排程的效能紀錄一律先排隊，
 * **只有 flushPerfQueue 寫 performance**，而且一次 setValues 整批寫。
 * B-3 讓手機耗時能跟同一次請求的 server 耗時對上，算出「server 外的時間」。
 *
 * 盯的事：
 *   - 一次 flush 50 筆只呼叫一次寫入（不是 50 次 appendRow）
 *   - 寫入失敗：排隊的紀錄一筆都不少；重跑時每筆只寫一次
 *   - LINE、排程、未驗證彙總都只排隊；整份原始碼除了 flush 沒有別的寫入點
 *   - 排隊放不進去 → 先 flush 一次再放；仍放不進去 → 丟棄並寫 logs（可丟，但不可無聲）
 *   - flush 自己那列也排隊，但不會讓排隊區永遠不空（空的那幾輪照舊不寫）
 *   - request_id：server 列與手機列各帶自己的 ID；手機列的 ts 是手機端「實際發生時間」
 *   - perfSummary：同一 request_id 的 client 與 server 對起來，給出 server 外的時間中位數
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ME = 'Uneil';
const TOK_ME = 'tok-neil-device';
const HOUR_MS = 3600000;

function env(opts = {}) {
  return loadCodeGs(Object.assign({
    cache: true,
    propsWritable: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK_ME]: ME },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE']
      ]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'line_id', 'del'], ['1', '買菜', '', ME, '']]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }
  }, opts));
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK_ME }, body)) } }).body);
}
const perfRows = (e) => (e.sheets.performance ? e.sheets.performance.toRecords() : []);
const queueKeys = (store) => Object.keys(store).filter((k) => k.indexOf('perfq_') === 0);

/** 先建好 performance（表頭齊全），並數 appendRow 與 setValues 各被呼叫幾次 */
function spyPerfSheet(e) {
  const sh = e.sheets.performance = new FakeSheet('performance', [e.read('PERFORMANCE_HEADERS')]);
  const spy = { appends: 0, sets: 0, failNext: false };
  const append = sh.appendRow.bind(sh);
  sh.appendRow = (r) => { spy.appends++; return append(r); };
  const range = sh.getRange.bind(sh);
  sh.getRange = (...a) => {
    const rg = range(...a);
    const set = rg.setValues.bind(rg);
    rg.setValues = (v) => {
      if (spy.failNext) { spy.failNext = false; throw new Error('模擬：Sheet 寫入逾時'); }
      spy.sets++;
      return set(v);
    };
    return rg;
  };
  return spy;
}

/** 有容量上限的指令碼屬性：perfq_ 鍵滿 cap 個就 setProperty 丟例外（模擬 500KB 滿了） */
function cappedProps(cap) {
  const store = {};
  const api = {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => {
      if (k.indexOf('perfq_') === 0 && queueKeys(store).length >= cap) throw new Error('模擬：屬性容量已滿');
      store[k] = String(v);
    },
    getProperties: () => Object.assign({}, store),
    deleteProperty: (k) => { delete store[k]; }
  };
  return { store, PropertiesService: { getScriptProperties: () => api } };
}

/* ========================================================================== */
describe('B-2 單一寫入者：flush 批次寫', () => {

  test('一次 flush 50 筆只呼叫一次寫入（不是 50 次 appendRow）', () => {
    const e = env();
    const spy = spyPerfSheet(e);
    for (let i = 0; i < 50; i++) e.call('recordSchedulePerf_', 'job' + i, i, 100 + i);
    assert.equal(queueKeys(e.properties).length, 50);
    assert.equal(perfRows(e).length, 0, '排隊時沒碰 Sheet');

    assert.equal(e.call('flushPerfQueue').written, 50);
    assert.equal(spy.appends, 0, '不再逐列 appendRow');
    assert.equal(spy.sets, 1, '一次 setValues 寫完');
    assert.equal(perfRows(e).length, 50);
    assert.deepEqual(perfRows(e).map((r) => r.action), Array.from({ length: 50 }, (_, i) => 'job' + i), '依時間先後');
  });

  test('寫入失敗：排隊的紀錄一筆都不少；重跑時每筆只寫一次', () => {
    const e = env();
    const spy = spyPerfSheet(e);
    for (let i = 0; i < 5; i++) e.call('recordSchedulePerf_', 'job' + i, i, 10);
    spy.failNext = true;
    const out = e.call('flushPerfQueue');
    assert.equal(out.written, 0);
    assert.equal(out.reason, 'error');
    assert.equal(queueKeys(e.properties).length, 5, '寫失敗不刪鍵');
    assert.equal(perfRows(e).length, 0);
    assert.ok(e.transactions.some((t) => t[0] === '效能' && t[1] === '失敗'), '失敗要寫 logs，不可無聲');

    assert.equal(e.call('flushPerfQueue').written, 5);
    const actions = perfRows(e).map((r) => r.action);
    assert.deepEqual(actions, ['job0', 'job1', 'job2', 'job3', 'job4'], '每筆只寫一次');
    assert.equal(e.lock.held, false, '鎖有放掉');
  });

  test('flush 自己那列也排隊，下一輪才落地；再下一輪是空的就一列都不寫', () => {
    const e = env();
    spyPerfSheet(e);
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    assert.equal(e.call('flushPerfQueue').written, 1);
    assert.equal(perfRows(e).length, 1, 'flush 那列不在同一批');
    assert.equal(e.call('flushPerfQueue').written, 1);
    const flushRow = perfRows(e)[1];
    assert.equal(flushRow.action, 'perfFlush');
    assert.equal(flushRow.trigger, 'schedule');
    assert.equal(flushRow.rows, 1);
    assert.deepEqual(e.call('flushPerfQueue'), { written: 0 }, '只寫了 perfFlush 的那輪不再記自己，排隊區會變空');
    assert.equal(perfRows(e).length, 2);
  });
});

/* ========================================================================== */
describe('B-2 單一寫入者：其他路徑只排隊', () => {

  test('LINE 的效能紀錄只排隊，不碰 performance', () => {
    const e = env();
    const spy = spyPerfSheet(e);
    e.call('recordLinePerf_', 'lineText', ME, 1200, 300, { route: 5 });
    assert.equal(spy.appends + spy.sets, 0);
    assert.equal(queueKeys(e.properties).length, 1);
    e.call('flushPerfQueue');
    const r = perfRows(e)[0];
    assert.equal(r.trigger, 'line');
    assert.equal(r.reply_ms, 300);
    assert.equal(r.line_id, ME);
  });

  test('排程的效能紀錄只排隊，不碰 performance', () => {
    const e = env();
    const spy = spyPerfSheet(e);
    e.call('recordSchedulePerf_', 'dueCheck', 3, 800);
    assert.equal(spy.appends + spy.sets, 0);
    assert.equal(queueKeys(e.properties).length, 1);
  });

  test('未驗證請求的每小時彙總也只排隊', () => {
    const e = env();
    const spy = spyPerfSheet(e);
    const now = Date.now();
    e.call('noteUnauth_', 'unknown_token', 40, now - HOUR_MS);
    assert.equal(e.call('flushUnauthPerf', now).written, 1);
    assert.equal(spy.appends + spy.sets, 0);
    e.call('flushPerfQueue');
    const r = perfRows(e).find((x) => x.action === 'unauth');
    assert.equal(r.trigger, 'hourly');
    assert.equal(r.rows, 1);
  });

  test('原始碼裡寫 performance 的只有 flushPerfQueue（經 writePerfRows_）', () => {
    const files = readdirSync(join(ROOT, 'apps-script')).filter((f) => f.endsWith('.gs'));
    const src = files.map((f) => readFileSync(join(ROOT, 'apps-script', f), 'utf8')).join('\n');
    const calls = (name) => (src.match(new RegExp('\\b' + name + '\\(', 'g')) || []).length
      - (src.match(new RegExp('function ' + name + '\\(', 'g')) || []).length;
    assert.equal(calls('ensurePerformanceSheet_'), 1, '只有 writePerfRows_ 開 performance 來寫');
    assert.equal(calls('writePerfRows_'), 1, '只有 flushPerfQueue 呼叫 writePerfRows_');
    const flush = src.slice(src.indexOf('function flushPerfQueue('), src.indexOf('function installPerfQueueTrigger('));
    assert.match(flush, /writePerfRows_\(/);
    const writer = src.slice(src.indexOf('function writePerfRows_('), src.indexOf('function writePerfRows_(') + 1200);
    assert.match(writer, /ensurePerformanceSheet_\(/);
  });
});

/* ========================================================================== */
describe('B-2 排隊放不進去', () => {

  test('放不進去 → 先 flush 一次再放；這次的紀錄還在', () => {
    const p = cappedProps(3);
    const e = env({ overrides: { PropertiesService: p.PropertiesService } });
    spyPerfSheet(e);
    for (let i = 0; i < 3; i++) e.call('recordSchedulePerf_', 'job' + i, i, 10);
    assert.equal(queueKeys(p.store).length, 3);
    e.call('recordSchedulePerf_', 'job3', 3, 10);
    assert.deepEqual(perfRows(e).map((r) => r.action), ['job0', 'job1', 'job2'], '滿了先落地');
    const queued = queueKeys(p.store).map((k) => JSON.parse(p.store[k])[0].action);
    assert.ok(queued.includes('job3'), '這次的紀錄放進去了');
    assert.equal(e.transactions.filter((t) => t[0] === '效能').length, 0, '沒有丟資料就不寫 logs');
  });

  test('flush 後仍放不進去 → 丟棄該筆並寫 logs；performance 不被直接寫', () => {
    const p = cappedProps(0);
    const e = env({ overrides: { PropertiesService: p.PropertiesService } });
    const spy = spyPerfSheet(e);
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    assert.equal(spy.appends + spy.sets, 0, '不再退回直接寫');
    const t = e.transactions.find((x) => x[0] === '效能' && x[1] === '失敗');
    assert.ok(t, '丟棄要寫 logs');
    assert.match(String(t[3]), /丟棄 1 筆/);
  });
});

/* ========================================================================== */
describe('B-3 request_id', () => {

  test('server 列記下請求的 request_id；手機列帶自己那次的 ID 與實際發生時間', () => {
    const e = env();
    spyPerfSheet(e);
    const at = Date.now() - 5000;
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', request_id: 'req-aaaa1111',
      perf: [{ action: 'pull', trigger: 'poll', client_ms: 900, request_id: 'req-prev0001', at }] });
    e.call('flushPerfQueue');
    const rows = perfRows(e);
    const server = rows.find((r) => r.server_ms !== '');
    const client = rows.find((r) => r.client_ms !== '');
    assert.equal(server.request_id, 'req-aaaa1111');
    assert.equal(client.request_id, 'req-prev0001');
    assert.equal(client.ts, new Date(at).toISOString(), '不再用上傳時間代替');
  });

  test('形狀不對的 request_id 留空；不合理的發生時間退回上傳時間', () => {
    const e = env();
    spyPerfSheet(e);
    const before = Date.now();
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', request_id: 'has space <x>',
      perf: [{ action: 'pull', trigger: 'poll', client_ms: 900, request_id: 'x'.repeat(200), at: before + 86400000 },
             { action: 'pull', trigger: 'poll', client_ms: 800, at: 'yesterday' }] });
    e.call('flushPerfQueue');
    const rows = perfRows(e);
    assert.equal(rows.find((r) => r.server_ms !== '').request_id, '');
    rows.filter((r) => r.client_ms !== '').forEach((r) => {
      assert.equal(r.request_id, '');
      assert.ok(Date.parse(r.ts) >= before - 1000 && Date.parse(r.ts) <= Date.now() + 1000, '退回上傳時間');
    });
  });

  test('舊表沒有 request_id 欄：補在最右邊，舊列留空', () => {
    const e = env();
    const old = e.read('PERFORMANCE_HEADERS').filter((h) => h !== 'request_id');
    e.sheets.performance = new FakeSheet('performance', [old, old.map((h) => (h === 'id' ? '1' : h === 'action' ? 'old' : ''))]);
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', request_id: 'req-bbbb2222' });
    e.call('flushPerfQueue');
    const sh = e.sheets.performance;
    assert.equal(sh.values[0][sh.values[0].length - 1], 'request_id');
    const rows = sh.toRecords();
    assert.equal(rows[0].request_id, '');
    assert.equal(rows[1].request_id, 'req-bbbb2222');
  });
});

/* ========================================================================== */
describe('B-3 perfSummary：server 外的時間', () => {

  test('同一 request_id 的 client 與 server 對起來；對不到的照舊分開算', () => {
    const e = env();
    const H = e.read('PERFORMANCE_HEADERS');
    const ts = new Date().toISOString();
    const row = (o) => H.map((h) => (o[h] === undefined ? '' : o[h]));
    e.sheets.performance = new FakeSheet('performance', [H,
      row({ id: '1', ts, action: 'boot', trigger: 'cold', client_ms: 5000, request_id: 'rid-A0000001' }),
      row({ id: '2', ts, action: 'boot', trigger: 'cold', server_ms: 3000, request_id: 'rid-A0000001' }),
      row({ id: '3', ts, action: 'boot', trigger: 'cold', client_ms: 4000, request_id: 'rid-B0000002' }),   // 對不到 server
      row({ id: '4', ts, action: 'boot', trigger: 'cold', server_ms: 1000, request_id: 'rid-C0000003' }),   // 對不到 client
      row({ id: '5', ts, action: 'pull', trigger: 'poll', client_ms: 900, request_id: 'rid-D0000004' }),
      row({ id: '6', ts, action: 'readMany', trigger: 'poll', server_ms: 600, request_id: 'rid-D0000004' }),
      row({ id: '7', ts, action: 'pull', trigger: 'poll', client_ms: 1500, request_id: 'rid-E0000005' }),
      row({ id: '8', ts, action: 'readMany', trigger: 'poll', server_ms: 700, request_id: 'rid-E0000005' }),
      row({ id: '9', ts, action: 'pull', trigger: 'poll', client_ms: 700 })                                  // 舊列，沒有 ID
    ]);
    const s = post(e, { action: 'perfSummary', trigger: 'manual' });
    const cold = s.client.find((g) => g.trigger === 'cold');
    assert.equal(cold.count, 2, '對不到的 client 列照舊算進手機那組');
    assert.equal(cold.paired, 1);
    assert.equal(cold.outside_p50, 2000);
    const poll = s.client.find((g) => g.trigger === 'poll');
    assert.equal(poll.count, 3);
    assert.equal(poll.paired, 2);
    assert.equal(poll.outside_p50, 300, '[300, 800] 的 nearest-rank 中位');
    assert.equal(s.server.find((g) => g.action === 'boot').count, 2, '對不到的 server 列照舊算進雲端那組');
  });

  test('沒有任何一筆對得上：不給 outside 數字（不是 0）', () => {
    const e = env();
    const H = e.read('PERFORMANCE_HEADERS');
    const ts = new Date().toISOString();
    e.sheets.performance = new FakeSheet('performance', [H,
      H.map((h) => ({ id: '1', ts, action: 'boot', trigger: 'cold', client_ms: 5000 })[h] ?? '')]);
    const cold = post(e, { action: 'perfSummary', trigger: 'manual' }).client.find((g) => g.trigger === 'cold');
    assert.equal(cold.paired, 0);
    assert.equal(cold.outside_p50, null);
  });
});
