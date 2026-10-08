/**
 * ADR-012 T1（PR-A）— 效能紀錄：後端
 *
 * 這批測試盯的事：
 *   - 記錄規則：哪些請求會留一列、哪些不會（poll 只在帶 perf_sample 時記、續期輪詢不記、
 *     沒有 trigger 的不記、沒通過驗證的一列都不准寫）
 *   - 手機量到的 client_ms 夾在下一個請求裡送上來，雲端另寫一列（trigger 照舊、server_ms 空白）
 *   - performance 表裡找不到 token、token 雜湊或任何資料內容
 *   - PWA 不能直接讀寫原始列；只能透過管理員的 perfSummary／perfPurge
 *   - perfSummary 雲端算好再送；perfPurge 只刪超過 N 天的列，寫一筆 logs
 *   - 寫紀錄失敗不影響主流程
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';     // 管理者
const MOM = 'Umom';     // 一般成員
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const DAY = 86400000;

const TASK_HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive'];
const PERF_HEADERS = ['id', 'ts', 'action', 'trigger', 'client_ms', 'server_ms', 'auth_ms', 'open_ms', 'read_ms',
  'sheets', 'rows', 'device_id', 'line_id', 'reply_ms'];

function env({ sheets = {}, cache = false } = {}) {
  const e = loadCodeGs({
    cache,
    extraFiles: ['sheet-guide.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: Object.assign({
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'],
        [ME, 'Neil', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '']
      ]),
      tasks: new FakeSheet('tasks', [TASK_HEADERS.slice(), ['1', '買菜', '', '', 'M', ME, '', '']])
    }, sheets)
  });
  return e;
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

const perfRows = (e) => (e.sheets.performance ? e.sheets.performance.toRecords() : []);

/** 測試自己造的 performance 表：ts 以「現在」往回推 */
function seededPerf(rows) {
  return new FakeSheet('performance', [PERF_HEADERS.slice()].concat(rows.map((r, i) => PERF_HEADERS.map((h) => {
    if (h === 'id') return String(1000 + i);
    return r[h] === undefined ? '' : r[h];
  }))));
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/* ========================================================================== */
describe('記錄規則：哪些請求會留一列', () => {

  test('cold 的 read：寫一列，含分段、表名、列數、裝置與人；表自己長出來', () => {
    const e = env();
    const out = post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'cold' });
    assert.equal(out.data.length, 1, '主流程照常');

    assert.ok(e.sheets.performance, 'performance 分頁要自己建出來');
    assert.deepEqual(e.sheets.performance.values[0], PERF_HEADERS, '表頭依票面欄序');
    const rows = perfRows(e);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.action, 'read');
    assert.equal(r.trigger, 'cold');
    assert.equal(r.sheets, 'tasks');
    assert.equal(r.rows, 1);
    assert.equal(r.device_id, 'dev-0');
    assert.equal(r.line_id, ME);
    assert.equal(r.client_ms, '', '雲端那一列沒有 client_ms');
    for (const k of ['server_ms', 'auth_ms', 'open_ms', 'read_ms']) {
      assert.equal(typeof r[k], 'number', k + ' 要是數字');
      assert.ok(r[k] >= 0, k + ' 不可為負');
    }
    assert.ok(!Number.isNaN(new Date(r.ts).getTime()), 'ts 是 ISO');
  });

  test('foreground／manual／write 每次都記', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'foreground' });
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'manual' });
    post(e, { token: TOK_ME, action: 'upsert', sheet: 'tasks', key_field: 'id', trigger: 'write',
      record: { id: '2', text: '寫一筆', line_id: ME } });
    const rows = perfRows(e);
    assert.deepEqual(rows.map((r) => r.trigger), ['foreground', 'manual', 'write']);
    const w = rows[2];
    assert.equal(w.action, 'upsert');
    assert.equal(w.sheets, 'tasks');
    assert.equal(typeof w.open_ms, 'number', '寫入也量開表的時間');
  });

  test('poll：每一輪都記（ADR-014 D-13 取消抽樣），perf_sample 不再有作用', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'poll' });
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'poll', perf_sample: false });
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'poll', perf_sample: true });
    assert.equal(perfRows(e).length, 3);
    assert.deepEqual(perfRows(e).map((r) => r.trigger), ['poll', 'poll', 'poll']);
  });

  test('沒有 trigger 的請求不記（LOG 頁、管理頁、續期輪詢的 session）', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'read', sheet: 'logs' });
    post(e, { token: TOK_ME, action: 'session' });
    post(e, { token: TOK_ME, action: 'listDevices' });
    assert.equal(perfRows(e).length, 0);
  });

  test('不認得的 trigger 不記（只收 cold／foreground／poll／manual／write）', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: '<script>' });
    assert.equal(perfRows(e).length, 0);
  });

  test('開機的 session（帶 cold）會記，分段只有驗證', () => {
    const e = env();
    const out = post(e, { token: TOK_ME, action: 'session', trigger: 'cold' });
    assert.equal(out.status, 'ok');
    const rows = perfRows(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'session');
    assert.equal(typeof rows[0].auth_ms, 'number');
    assert.equal(rows[0].open_ms, '');
    assert.equal(rows[0].line_id, ME);
  });

  test('沒通過驗證：一列都不寫（就算帶了 trigger 與 perf）', () => {
    const e = env();
    const out = post(e, { token: 'tok-nobody', action: 'read', sheet: 'tasks', trigger: 'cold',
      perf: [{ action: 'startup', trigger: 'cold', client_ms: 1200 }] });
    assert.equal(out.error, 'unknown_token');
    const s = post(e, { token: 'tok-nobody', action: 'session', trigger: 'cold' });
    assert.equal(s.status, 'unknown_token');
    assert.equal(perfRows(e).length, 0, '拿到網址的人不能灌表');
    assert.equal(e.sheets.performance, undefined, '連表都不該為它建');
  });
});

/* ========================================================================== */
describe('手機量的 client_ms：夾在下一個請求裡', () => {

  test('另寫一列：action／trigger 照手機送的，client_ms 有值、server 欄空白', () => {
    const e = env();
    // 這次請求本身沒有 trigger（例如續送佇列以外的管理動作），但夾帶的紀錄照收
    post(e, { token: TOK_MOM, action: 'listDevices',
      perf: [{ action: 'startup', trigger: 'cold', client_ms: 2345 }] });
    const rows = perfRows(e);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.action, 'startup');
    assert.equal(r.trigger, 'cold');
    assert.equal(r.client_ms, 2345);
    assert.equal(r.server_ms, '');
    assert.equal(r.line_id, MOM);
    assert.equal(r.device_id, 'dev-1');
  });

  test('同一個請求：自己的雲端列＋夾帶的手機列都寫', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'manual',
      perf: [{ action: 'pull', trigger: 'manual', client_ms: 800 }, { action: 'upsert', trigger: 'write', client_ms: 300 }] });
    const rows = perfRows(e);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter((r) => r.server_ms !== '').length, 1);
    assert.deepEqual(rows.filter((r) => r.client_ms !== '').map((r) => r.client_ms), [800, 300]);
  });

  test('髒資料一律丟掉：不認得的 trigger、負數、非數字、超過 10 分鐘、action 夾怪字', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'listDevices', perf: [
      { action: 'startup', trigger: 'nope', client_ms: 100 },
      { action: 'startup', trigger: 'cold', client_ms: -1 },
      { action: 'startup', trigger: 'cold', client_ms: 'abc' },
      { action: 'startup', trigger: 'cold', client_ms: 600001 },
      { action: '買菜 300 元', trigger: 'cold', client_ms: 100 },
      { action: 'startup', trigger: 'cold', client_ms: 99.6 },
      'not-an-object',
      null
    ] });
    const rows = perfRows(e);
    assert.equal(rows.length, 1, '只有最後那筆合格');
    assert.equal(rows[0].client_ms, 100, '四捨五入成整數毫秒');
  });

  test('一個請求最多收 20 筆', () => {
    const e = env();
    const perf = Array.from({ length: 50 }, () => ({ action: 'pull', trigger: 'poll', client_ms: 10 }));
    post(e, { token: TOK_ME, action: 'listDevices', perf });
    assert.equal(perfRows(e).length, 20);
  });

  test('perf 不是陣列：當沒有，主流程照常', () => {
    const e = env();
    const out = post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', perf: 'oops' });
    assert.equal(out.data.length, 1);
    assert.equal(perfRows(e).length, 0);
  });
});

/* ========================================================================== */
describe('不存 token、不存資料內容', () => {

  test('跑過讀、寫、session、夾帶紀錄之後，整張表找不到 token、雜湊或資料內容', () => {
    const e = env();
    post(e, { token: TOK_ME, action: 'session', trigger: 'cold' });
    post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'cold' });
    post(e, { token: TOK_ME, action: 'upsert', sheet: 'tasks', key_field: 'id', trigger: 'write',
      record: { id: '9', text: '秘密內容 9527', line_id: ME },
      perf: [{ action: 'upsert', trigger: 'write', client_ms: 120, text: '秘密內容 9527', token: TOK_ME }] });

    const dump = JSON.stringify(e.sheets.performance.values);
    const hash = createHash('sha256').update(TOK_ME, 'utf8').digest('hex');
    for (const needle of [TOK_ME, hash, '秘密內容', '9527', '買菜']) {
      assert.ok(!dump.includes(needle), 'performance 表不該出現：' + needle);
    }
    assert.deepEqual(e.sheets.performance.values[0], PERF_HEADERS, '沒有多長出欄位');
  });
});

/* ========================================================================== */
describe('PWA 不能直接碰原始列', () => {

  test('read performance → sheet_not_readable', () => {
    const e = env({ sheets: { performance: seededPerf([{ ts: ago(0), action: 'read', trigger: 'cold', server_ms: 10 }]) } });
    const out = post(e, { token: TOK_ME, action: 'read', sheet: 'performance' });
    assert.equal(out.error, 'sheet_not_readable');
    const t = post(e, { token: TOK_ME, action: 'readTombstones', sheet: 'performance' });
    assert.ok(t.error, 'readTombstones 已拆（2026-10-08），送上來也拿不到東西');
    assert.equal('data' in t, false);
  });

  for (const action of ['upsert', 'archivePurge', 'completeRecurring']) {
    test(action + ' performance → 被擋，表沒變', () => {
      const e = env({ sheets: { performance: seededPerf([{ ts: ago(0), action: 'read', trigger: 'cold', server_ms: 10 }]) } });
      const before = JSON.stringify(e.sheets.performance.values);
      const out = post(e, { token: TOK_ME, action, sheet: 'performance', key_field: 'id', record: { id: '1000', action: 'x' }, keys: ['1000'] });
      assert.ok(out.error, '要被擋：' + JSON.stringify(out));
      assert.equal(JSON.stringify(e.sheets.performance.values), before);
    });
  }
});

/* ========================================================================== */
describe('perfSummary：雲端算好再送', () => {

  test('非管理員 → forbidden，寫 logs', () => {
    const e = env();
    const out = post(e, { token: TOK_MOM, action: 'perfSummary' });
    assert.equal(out.error, 'forbidden');
    assert.ok(e.transactions.some((t) => String(t[2]).includes('perfSummary') && t[6] === MOM), '要寫 logs');
  });

  test('還沒有任何紀錄：回空的摘要，不報錯', () => {
    const e = env();
    const out = post(e, { token: TOK_ME, action: 'perfSummary' });
    assert.equal(out.success, true);
    assert.equal(out.total, 0);
    assert.deepEqual(out.client, []);
    assert.deepEqual(out.server, []);
  });

  test('近 7 天：手機依 trigger、雲端依 action 分組；中位數與 p90 用 nearest-rank；不傳原始列', () => {
    const rows = [];
    // 手機 cold：10 筆 100..1000
    for (let i = 1; i <= 10; i++) rows.push({ ts: ago(DAY), action: 'startup', trigger: 'cold', client_ms: i * 100 });
    // 雲端 read：4 筆，分段加總可算佔比
    [40, 10, 30, 20].forEach((ms) => rows.push({ ts: ago(DAY), action: 'read', trigger: 'cold', server_ms: ms,
      auth_ms: ms / 2, open_ms: ms / 4, read_ms: ms / 4 }));
    // 8 天前的：不算進摘要，但算進總筆數，也是最舊的一筆
    rows.unshift({ ts: ago(8 * DAY), action: 'startup', trigger: 'cold', client_ms: 99999 });
    const e = env({ sheets: { performance: seededPerf(rows) } });

    const out = post(e, { token: TOK_ME, action: 'perfSummary' });
    assert.equal(out.success, true);
    assert.equal(out.days, 7);
    assert.equal(out.total, 15, '總筆數含 7 天以前的');
    assert.equal(out.oldest, rows[0].ts);

    const cold = out.client.find((g) => g.trigger === 'cold');
    assert.deepEqual(cold, { trigger: 'cold', count: 10, p50: 500, p90: 900 });

    const read = out.server.find((g) => g.action === 'read');
    assert.equal(read.count, 4);
    assert.equal(read.p50, 20);
    assert.equal(read.p90, 40);
    assert.equal(read.auth_pct, 50);
    assert.equal(read.open_pct, 25);
    assert.equal(read.read_pct, 25);

    assert.ok(!('rows' in out) && !('data' in out), '不傳原始列');
    assert.ok(!JSON.stringify(out).includes('99999'), '7 天以前的不進統計');
  });

  test('ts 讀回來是 Date（Sheet 自動辨識）也算得到', () => {
    const e = env({ sheets: { performance: seededPerf([
      { ts: new Date(Date.now() - DAY), action: 'startup', trigger: 'poll', client_ms: 300 }
    ]) } });
    const out = post(e, { token: TOK_ME, action: 'perfSummary' });
    assert.deepEqual(out.client, [{ trigger: 'poll', count: 1, p50: 300, p90: 300 }]);
  });
});

/* ========================================================================== */
describe('perfPurge：只刪超過 N 天的列', () => {

  function purgeEnv() {
    return env({ sheets: { performance: seededPerf([
      { ts: ago(40 * DAY), action: 'read', trigger: 'cold', server_ms: 1 },   // 刪
      { ts: ago(1 * DAY), action: 'read', trigger: 'cold', server_ms: 2 },    // 留
      { ts: ago(31 * DAY), action: 'read', trigger: 'cold', server_ms: 3 },   // 刪（不相鄰，驗由下往上不刪錯）
      { ts: ago(35 * DAY), action: 'read', trigger: 'cold', server_ms: 4 },   // 刪
      { ts: 'not-a-date', action: 'read', trigger: 'cold', server_ms: 5 },    // 留：認不出日期的不刪
      { ts: ago(29 * DAY), action: 'read', trigger: 'cold', server_ms: 6 }    // 留
    ]) } });
  }

  test('非管理員 → forbidden，寫 logs，一列都沒動', () => {
    const e = purgeEnv();
    const before = JSON.stringify(e.sheets.performance.values);
    const out = post(e, { token: TOK_MOM, action: 'perfPurge', days: 30 });
    assert.equal(out.error, 'forbidden');
    assert.equal(JSON.stringify(e.sheets.performance.values), before);
    assert.ok(e.transactions.some((t) => String(t[2]).includes('perfPurge') && t[6] === MOM));
  });

  test('預設 30 天：刪掉 3 列、留下對的 3 列，寫一筆 logs 記刪了幾列', () => {
    const e = purgeEnv();
    const out = post(e, { token: TOK_ME, action: 'perfPurge' });
    assert.equal(out.success, true);
    assert.equal(out.deleted, 3);
    assert.equal(out.days, 30);
    assert.equal(out.remaining, 3);
    assert.deepEqual(perfRows(e).map((r) => r.server_ms), [2, 5, 6]);
    const log = e.transactions.find((t) => String(t[2]).includes('perfPurge'));
    assert.ok(log, '要寫 logs');
    assert.ok(String(log[3]).includes('3'), 'logs 要寫刪了幾列：' + log[3]);
  });

  test('指定天數：days=2 只留 1 天內與認不出日期的', () => {
    const e = purgeEnv();
    const out = post(e, { token: TOK_ME, action: 'perfPurge', days: 2 });
    assert.equal(out.deleted, 4);
    assert.deepEqual(perfRows(e).map((r) => r.server_ms), [2, 5]);
  });

  test('天數亂填（0、負數、字串）→ 退回 30 天，不會變成全刪', () => {
    for (const days of [0, -5, 'all', null]) {
      const e = purgeEnv();
      const out = post(e, { token: TOK_ME, action: 'perfPurge', days });
      assert.equal(out.days, 30, 'days=' + days);
      assert.equal(out.deleted, 3, 'days=' + days);
    }
  });

  test('另一個整理正在跑 → busy，一列都沒動', () => {
    const e = purgeEnv();
    e.lock.busy = true;
    const before = JSON.stringify(e.sheets.performance.values);
    const out = post(e, { token: TOK_ME, action: 'perfPurge' });
    assert.equal(out.error, 'busy');
    assert.equal(JSON.stringify(e.sheets.performance.values), before);
  });
});

/* ========================================================================== */
describe('門檻提醒的筆數：session 順便回給管理員', () => {

  test('管理員的 session 帶 perf_rows；一般成員沒有', () => {
    const e = env({ sheets: { performance: seededPerf([
      { ts: ago(0), action: 'read', trigger: 'cold', server_ms: 1 },
      { ts: ago(0), action: 'read', trigger: 'cold', server_ms: 2 }
    ]) } });
    const me = post(e, { token: TOK_ME, action: 'session' });
    assert.equal(me.perf_rows, 2);
    const mom = post(e, { token: TOK_MOM, action: 'session' });
    assert.equal('perf_rows' in mom, false);
  });

  test('還沒有 performance 表：管理員拿到 0', () => {
    const e = env();
    assert.equal(post(e, { token: TOK_ME, action: 'session' }).perf_rows, 0);
  });
});

/* ========================================================================== */
describe('寫紀錄失敗不影響主流程', () => {

  test('performance 寫入丟例外 → 讀取照常回資料', () => {
    const broken = new FakeSheet('performance', [PERF_HEADERS.slice()]);
    broken.appendRow = () => { throw new Error('配額用完'); };
    const e = env({ sheets: { performance: broken } });
    const out = post(e, { token: TOK_ME, action: 'read', sheet: 'tasks', trigger: 'cold' });
    assert.equal(out.data.length, 1);
    assert.ok(e.logs.some((l) => l.includes('配額用完')), '失敗要記 console，不安靜吞掉');
  });
});

/* ========================================================================== */
describe('_guide 登記表', () => {

  test('performance 已登記', () => {
    const e = env();
    const names = e.call('guideRegistry_').map((g) => g.sheet);
    assert.ok(names.includes('performance'));
  });
});
