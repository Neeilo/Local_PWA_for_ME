/**
 * ADR-012 PR-B — 一趟開機（boot／readMany）× 功能權限上雲（canUse_）：後端
 *
 * 盯的事：
 *   - boot 先驗再讀：驗證沒過，一張資料表都不讀
 *   - boot 只開一次試算表，一個請求帶回 session、名單、有權限的各表
 *   - readMany：沒權限、不開放的表放進 denied，不報錯；墓碑過濾只有一份
 *   - feat_* 是雲端權限：關掉＝讀不到、寫不進、LINE 打不進、「查/」看不到
 *   - 完全沒有 feat_ 欄 → 全開；有欄但留空 → 關（ADR-008 E-2b），前後端判斷一字不差
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';     // 管理者，全開
const MOM = 'Umom';     // 一般成員，權限由各測試決定
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const DAY = 86400000;

const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const DATA_SHEETS = ['tasks', 'reviews', 'moods', 'notes', 'expenses'];

/** momFeats：媽媽那列各 feat_ 的值；傳 null 代表整張表沒有 feat_ 欄 */
function roster(momFeats = { feat_expense: 'TRUE', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: 'TRUE', feat_mood: 'TRUE', feat_log: 'TRUE' }, momActive = 'TRUE') {
  if (momFeats === null) {
    return new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin'],
      [ME, 'Neil', 'TRUE', 'TRUE'],
      [MOM, '媽媽', momActive, '']
    ]);
  }
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
    [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
    [MOM, '媽媽', momActive, ''].concat(FEATS.map((f) => (f in momFeats ? momFeats[f] : '')))
  ]);
}

function dataSheets() {
  return {
    tasks: new FakeSheet('tasks', [
      ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'due_date', 'recur_interval', 'recur_unit', 'notified'],
      ['1', '買菜', '', '2026-09-30T00:00:00.000Z', 'M', ME, '', '', '', '', ''],
      ['2', '已刪的', '', '2026-09-30T00:00:00.000Z', 'M', ME, 'TRUE', '', '', '', '']
    ]),
    expenses: new FakeSheet('expenses', [
      ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del'],
      ['10', new Date().toISOString().slice(0, 10), 'expense', '餐飲', 120, '午餐', '2026-09-30T00:00:00.000Z', MOM, '']
    ]),
    reviews: new FakeSheet('reviews', [['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del']]),
    moods: new FakeSheet('moods', [['id', 'mood_date', 'level', 'note', 'line_id', 'del']]),
    notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del'], ['20', '[系統] 筆記', '2026-09-30T00:00:00.000Z', ME, '']]),
    logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
  };
}

function env({ users = roster(), sheets = {}, properties = {}, overrides = {} } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs'],
    properties,
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: Object.assign({ line_users: users }, dataSheets(), sheets),
    overrides: Object.assign({ lineReply_: (_t, text) => { replies.push(String(text)); } }, overrides)
  });
  e.replies = replies;
  return e;
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

function line(e, userId, text) {
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1] || '';
}

/** 數資料表被讀了幾次（getDataRange／getRange 都算） */
function countReads(e, names = DATA_SHEETS) {
  const hits = { n: 0 };
  names.forEach((name) => {
    const s = e.sheets[name];
    const dr = s.getDataRange.bind(s);
    const gr = s.getRange.bind(s);
    s.getDataRange = () => { hits.n++; return dr(); };
    s.getRange = (...a) => { hits.n++; return gr(...a); };
  });
  return hits;
}

/* ========================================================================== */
describe('boot：先驗再讀', () => {

  const cases = {
    unknown_token: (e) => ({ token: 'tok-nobody' }),
    revoked: (e) => { e.sheets.line_devices.values[2][6] = new Date().toISOString(); return { token: TOK_MOM }; },
    token_expired: (e) => { e.sheets.line_devices.values[2][5] = new Date(Date.now() - 200 * DAY).toISOString(); return { token: TOK_MOM }; },
    no_token: () => ({ token: '' })
  };
  for (const [code, arrange] of Object.entries(cases)) {
    test(code + ' → 回認證錯誤（前端 handleAuthError 接得住的形狀），一張資料表都不讀', () => {
      const e = env();
      const auth = arrange(e);
      const hits = countReads(e);
      const out = post(e, Object.assign({ action: 'boot' }, auth));
      assert.equal(out.error, code);
      assert.equal(hits.n, 0, '驗證沒過就讀了資料表');
      assert.equal('data' in out, false);
      assert.equal('line_users' in out, false);
    });
  }

  test('inactive（人被停用）→ inactive，一張資料表都不讀', () => {
    const e = env({ users: roster(undefined, '') });
    const hits = countReads(e);
    const out = post(e, { action: 'boot', token: TOK_MOM });
    assert.equal(out.error, 'inactive');
    assert.equal(hits.n, 0);
  });
});

describe('boot：一個請求帶回全部', () => {

  test('形狀：session／line_users／五張表／denied；墓碑已濾掉', () => {
    const e = env();
    const out = post(e, { action: 'boot', token: TOK_ME });
    assert.equal(out.session.status, 'ok');
    assert.equal(out.session.line_id, ME);
    assert.equal(out.session.device_id, 'dev-0');
    assert.equal(out.session.display_name, 'Neil');
    assert.equal(out.session.is_admin, true);
    assert.deepEqual(out.line_users.map((u) => u.line_id), [ME, MOM]);
    assert.deepEqual(Object.keys(out.data).sort(), DATA_SHEETS.slice().sort());
    assert.deepEqual(out.data.tasks.map((t) => t.id), ['1'], '已刪的那筆不該出現');
    assert.deepEqual(out.denied, []);
  });

  test('只開一次試算表（驗證已暖過快取時）', () => {
    const e = env();
    post(e, { action: 'session', token: TOK_MOM });          // 暖快取：裝置與名單
    e.counters.opens = 0;
    post(e, { action: 'boot', token: TOK_MOM });              // 一般成員：不查效能筆數；沒帶 trigger：不寫效能紀錄
    assert.equal(e.counters.opens, 1);
  });

  test('管理員多帶 perf_rows（門檻提醒用）；一般成員沒有', () => {
    const e = env();
    assert.equal(post(e, { action: 'boot', token: TOK_ME }).perf_rows, 0);
    assert.equal('perf_rows' in post(e, { action: 'boot', token: TOK_MOM }), false);
  });

  test('有帶 trigger 就寫一列效能紀錄：action=boot、表名、列數', () => {
    const e = env();
    post(e, { action: 'boot', token: TOK_ME, trigger: 'cold' });
    const rows = e.sheets.performance.toRecords();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'boot');
    assert.equal(rows[0].trigger, 'cold');
    assert.equal(rows[0].sheets, ['line_users'].concat(DATA_SHEETS).join(','));
    assert.equal(rows[0].rows, 2 + 2 + 0 + 0 + 1 + 1, '讀進來的原始列數（含墓碑）');
    for (const k of ['server_ms', 'auth_ms', 'open_ms', 'read_ms']) assert.equal(typeof rows[0][k], 'number', k);
  });

  test('既有的 session、read 仍然可用（續期輪詢、LOG 頁靠它們）', () => {
    const e = env();
    assert.equal(post(e, { action: 'session', token: TOK_ME }).status, 'ok');
    assert.ok(Array.isArray(post(e, { action: 'read', token: TOK_ME, sheet: 'tasks' }).data));
  });
});

/* ========================================================================== */
describe('readMany', () => {

  test('依要求的表回傳；不存在的分頁是空陣列；不開放的放進 denied', () => {
    const e = env();
    const out = post(e, { action: 'readMany', token: TOK_ME, sheets: ['tasks', 'nope', 'line_devices'] });
    assert.deepEqual(out.data.tasks.map((t) => t.id), ['1']);
    assert.deepEqual(out.data.nope, []);
    assert.equal('line_devices' in out.data, false);
    assert.deepEqual(out.denied, ['line_devices']);
  });

  test('sheets 不是陣列：當成什麼都沒要，不報錯', () => {
    const e = env();
    const out = post(e, { action: 'readMany', token: TOK_ME, sheets: 'tasks' });
    assert.deepEqual(out, { data: {}, denied: [] });
  });

  test('驗證沒過 → 認證錯誤，不讀', () => {
    const e = env();
    const hits = countReads(e);
    assert.equal(post(e, { action: 'readMany', token: 'bad', sheets: DATA_SHEETS }).error, 'unknown_token');
    assert.equal(hits.n, 0);
  });

  test('輪詢每一輪都記一列效能紀錄（ADR-014 D-13：取消 20 抽 1）', () => {
    const e = env();
    post(e, { action: 'readMany', token: TOK_ME, sheets: DATA_SHEETS, trigger: 'poll' });
    const rows = e.sheets.performance.toRecords();
    assert.equal(rows.length, 1, '沒有 perf_sample 也要記');
    assert.equal(rows[0].action, 'readMany');
    assert.equal(rows[0].sheets, DATA_SHEETS.join(','));
  });
});

/* ========================================================================== */
describe('feat_* 是雲端權限（D-3）', () => {

  const NO_EXPENSE = { feat_expense: '', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: 'TRUE', feat_mood: 'TRUE', feat_log: 'TRUE' };

  test('feat_expense 關掉：boot／readMany 沒有 expenses、denied 有；其他照常', () => {
    const e = env({ users: roster(NO_EXPENSE) });
    const boot = post(e, { action: 'boot', token: TOK_MOM });
    assert.equal('expenses' in boot.data, false);
    assert.deepEqual(boot.denied, ['expenses']);
    assert.deepEqual(boot.data.tasks.map((t) => t.id), ['1']);

    const many = post(e, { action: 'readMany', token: TOK_MOM, sheets: DATA_SHEETS });
    assert.equal('expenses' in many.data, false);
    assert.deepEqual(many.denied, ['expenses']);
  });

  test('feat_expense 關掉：連表都不讀（不是讀了再丟）', () => {
    const e = env({ users: roster(NO_EXPENSE) });
    const hits = countReads(e, ['expenses']);
    post(e, { action: 'boot', token: TOK_MOM });
    assert.equal(hits.n, 0);
  });

  test('feat_expense 關掉：read expenses → forbidden', () => {
    const e = env({ users: roster(NO_EXPENSE) });
    assert.equal(post(e, { action: 'read', token: TOK_MOM, sheet: 'expenses' }).error, 'forbidden');
  });

  for (const action of ['upsert', 'archivePurge']) {
    test('feat_expense 關掉：' + action + ' expenses → forbidden，寫 logs，表沒動', () => {
      const e = env({ users: roster(NO_EXPENSE) });
      const before = JSON.stringify(e.sheets.expenses.values);
      const out = post(e, { action, token: TOK_MOM, sheet: 'expenses', key_field: 'id',
        record: { id: '99', amount: 1, line_id: MOM }, keys: ['10'] });
      assert.equal(out.error, 'forbidden');
      assert.equal(JSON.stringify(e.sheets.expenses.values), before);
      assert.ok(e.transactions.some((t) => String(t[2]).includes(action) && String(t[2]).includes('expenses') && t[6] === MOM),
        '要留一列 logs');
    });
  }

  test('feat_tasks 關掉：completeRecurring → forbidden', () => {
    const e = env({ users: roster(Object.assign({}, NO_EXPENSE, { feat_expense: 'TRUE', feat_tasks: '' })) });
    const out = post(e, { action: 'completeRecurring', token: TOK_MOM, sheet: 'tasks', key_field: 'id',
      record: { id: '1', due_date: '2026-10-01', recur_interval: 1, recur_unit: '月' } });
    assert.equal(out.error, 'forbidden');
  });

  test('logs 只限管理員（ADR-014，feat_log 退場）：一般成員就算 feat_log 開著也讀不到', () => {
    const e = env({ users: roster(Object.assign({}, NO_EXPENSE, { feat_expense: 'TRUE', feat_log: 'TRUE' })) });
    assert.equal(post(e, { action: 'read', token: TOK_MOM, sheet: 'logs' }).error, 'forbidden');
  });

  test('logs：管理員讀得到，跟 feat_log 欄位無關', () => {
    const e = env();
    e.sheets.line_users.values[1][e.sheets.line_users.values[0].indexOf('feat_log')] = '';
    const out = post(e, { action: 'read', token: TOK_ME, sheet: 'logs' });
    assert.equal(out.error, undefined, JSON.stringify(out));
  });

  test('line_users 一律讀得到（前端要靠它知道自己的權限），就算功能全關', () => {
    const e = env({ users: roster({}) });
    const boot = post(e, { action: 'boot', token: TOK_MOM });
    assert.deepEqual(boot.line_users.map((u) => u.line_id), [ME, MOM]);
    assert.deepEqual(boot.denied.slice().sort(), DATA_SHEETS.slice().sort());
    assert.deepEqual(boot.data, {});
  });

  test('管理員改 line_users 不受 feat 限制（看 is_admin）', () => {
    const e = env({ users: roster({}) });
    // 管理員自己全開；這裡驗的是「line_users 不對應任何 feat」
    const out = post(e, { action: 'upsert', token: TOK_ME, sheet: 'line_users', key_field: 'line_id',
      record: { line_id: MOM, feat_expense: 'TRUE' } });
    assert.equal(out.success, true);
  });

  test('完全沒有 feat_ 欄的名單 → 全部開放（矩陣還沒佈署，不是全關）', () => {
    const e = env({ users: roster(null) });
    const boot = post(e, { action: 'boot', token: TOK_MOM });
    assert.deepEqual(boot.denied, []);
    assert.deepEqual(Object.keys(boot.data).sort(), DATA_SHEETS.slice().sort());
  });
});

/* ========================================================================== */
describe('LINE 也套用功能權限', () => {

  const NO_EXPENSE = { feat_expense: '', feat_tasks: 'TRUE', feat_review: 'TRUE', feat_notes: 'TRUE', feat_mood: 'TRUE', feat_log: 'TRUE' };

  for (const text of ['記帳/120/餐飲', '收入/100/其他']) {
    test('feat_expense 關掉：「' + text + '」被擋、寫 logs、不寫入', () => {
      const e = env({ users: roster(NO_EXPENSE) });
      const before = e.sheets.expenses.values.length;
      const reply = line(e, MOM, text);
      assert.match(reply, /沒有「記帳」功能的權限/);
      assert.equal(e.sheets.expenses.values.length, before);
      assert.ok(e.transactions.some((t) => t[1] === '失敗' && t[2] === text && t[6] === MOM));
    });
  }

  test('feat_tasks 關掉：「任務/」被擋；記帳照常', () => {
    const e = env({ users: roster(Object.assign({}, NO_EXPENSE, { feat_expense: 'TRUE', feat_tasks: '' })) });
    assert.match(line(e, MOM, '任務/買牛奶'), /沒有「任務」功能的權限/);
    assert.equal(e.sheets.tasks.values.length, 3);
    line(e, MOM, '記帳/50/餐飲');
    assert.equal(e.sheets.expenses.values.length, 3, '記帳沒被誤擋');
  });

  test('「查/」：feat_expense 關掉 → 送給 Gemini 的 prompt 沒有記帳彙總，並註明看得到哪些模組', () => {
    let prompt = '';
    const e = env({
      users: roster(NO_EXPENSE),
      properties: { GEMINI_API_KEY: 'k' },
      overrides: { callGemini_: (_k, p) => { prompt = p; return { ok: true, text: '好' }; } }
    });
    line(e, MOM, '查/這個月花多少');
    assert.ok(prompt, '前提：有送出 prompt');
    assert.doesNotMatch(prompt, /記帳彙總/);
    assert.doesNotMatch(prompt, /支出合計/);
    assert.match(prompt, /你只看得到以下模組：任務、日誌、心情/);
    assert.match(prompt, /沒有權限/);
  });

  test('「查/」：全開時記帳彙總照舊', () => {
    let prompt = '';
    const e = env({
      properties: { GEMINI_API_KEY: 'k' },
      overrides: { callGemini_: (_k, p) => { prompt = p; return { ok: true, text: '好' }; } }
    });
    line(e, MOM, '查/這個月花多少');
    assert.match(prompt, /記帳彙總/);
    assert.match(prompt, /支出合計 120 元/);
  });
});

/* ========================================================================== */
describe('canUse_ 與前端 featureAllowed 一字不差', () => {

  const VIEW_OF = { feat_expense: 'expenses', feat_tasks: 'tasks', feat_review: 'review', feat_notes: 'notes', feat_mood: 'mood' };
  const USERS = [
    { line_id: 'U1' },                                         // 沒有任何 feat_ 欄 → 全開
    { line_id: 'U2', feat_expense: '', feat_tasks: 'TRUE' },  // 有欄但留空 → 關
    { line_id: 'U3', feat_expense: true, feat_tasks: 'yes', feat_review: '1', feat_notes: 'Y', feat_mood: 'FALSE', feat_log: ' true ' },
    { line_id: 'U4', feat_expense: 0, feat_tasks: null, feat_review: 'no', feat_notes: 'TRUE', feat_mood: undefined, feat_log: 'TRUE' }
  ];

  for (const u of USERS) {
    test(JSON.stringify(u), () => {
      const back = env();
      const front = loadFrontend();
      front.raw('roster = ' + JSON.stringify([u]) + '; myLineId = "' + u.line_id + '"; cloudDenied = []');
      for (const feat of Object.keys(VIEW_OF)) {
        assert.equal(front.call('featureAllowed', VIEW_OF[feat]), back.call('canUse_', u, feat), u.line_id + ' ' + feat);
      }
    });
  }

  test('分頁對照表只有一份，與前端的 FEATURE_BY_VIEW 對得起來', () => {
    const back = env();
    const front = loadFrontend();
    const bySheet = back.read('FEATURE_BY_SHEET');
    assert.deepEqual(bySheet, { tasks: 'feat_tasks', expenses: 'feat_expense', reviews: 'feat_review',
      notes: 'feat_notes', moods: 'feat_mood',
      // ADR-015：股票三張表同一個功能
      stock_trades: 'feat_stock', stock_watch: 'feat_stock', stock_rules: 'feat_stock' });
    const byView = front.read('FEATURE_BY_VIEW');
    const uniq = (o) => [...new Set(Object.values(o))].sort();
    assert.deepEqual(uniq(byView), uniq(bySheet));
  });
});
