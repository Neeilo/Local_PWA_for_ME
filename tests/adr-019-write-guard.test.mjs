/**
 * ADR-019 PR-4（後端）— B-4 upsert 上鎖、B-5 白板只改自己的
 *
 * 為什麼有這批測試：
 *  - B-4：一般 upsert 是「找列 → 找不到就 append」。兩個請求幾乎同時送同一個新 id，
 *    兩邊都找不到列，就各 append 一列（GPT 健檢 R02）。這裡在第一個請求 append 的那一瞬間
 *    插進第二個請求，沒上鎖就真的會長出兩列——不是寫死回傳值的假測試
 *  - B-5：白板項目大家看得到，只有建立者能改／刪／改狀態，判斷用雲端那列現有的值（不信 PWA 送的）。
 *    拒絕要回 permanent:true，前端才知道別重送（ADR-018 實作差異 A-2：被擋的寫入卡死整個佇列）
 *  - Neil 2026-10-19 裁示：只管白板項目；line_id 空白的舊資料誰都能改；管理員不例外（票面）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';      // 管理員
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'archive', 'board'];
const NOTE_H = ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board'];

function task(id, owner, extra = {}) {
  const r = { id, text: '倒垃圾', is_completed: '', created_at: '2026-10-01T00:00:00.000Z', priority: 'M', line_id: owner,
    del: '', archive: '', board: '', due_date: '', recur_interval: '', recur_unit: '', notified: '', origin_chat: '', kind: 'todo' };
  return TASK_H.map((h) => (h in extra ? extra[h] : r[h]));
}

/** 跟真的 LockService 一樣：拿著的時候別人 tryLock 拿不到。fake 預設的鎖不分誰拿著，模擬不了兩個請求 */
function realLock() {
  const state = { held: false, tries: 0 };
  const mk = () => ({
    tryLock: () => { state.tries++; if (state.held) return false; state.held = true; return true; },
    releaseLock: () => { state.held = false; }
  });
  return { state, LockService: { getScriptLock: mk, getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) } };
}

function env({ tasks = [], expenses = [], notes = [], lock = null } = {}) {
  const e = loadCodeGs({
    tokens: { 'tok-me': ME, 'tok-mom': MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
        [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      tasks: new FakeSheet('tasks', [TASK_H, ...tasks]),
      expenses: new FakeSheet('expenses', [EXP_H, ...expenses]),
      notes: new FakeSheet('notes', [NOTE_H, ...notes]),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides: lock ? { LockService: lock.LockService } : {}
  });
  return e;
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
const rows = (e, name = 'tasks') => e.sheets[name].toRecords();
const snap = (e, name = 'tasks') => JSON.stringify(e.sheets[name].values);
const upTask = (rec) => ({ action: 'upsert', sheet: 'tasks', key_field: 'id', record: rec });
const taskRec = (e, id) => rows(e).find((r) => String(r.id) === String(id));

/* ========================================================================== */
describe('B-4 upsert 上鎖', () => {

  test('同一個新 id 幾乎同時送兩次：最後只有一列；擠進來的那個回 busy（佇列會自己重送）', () => {
    const lock = realLock();
    const e = env({ lock });
    const sheet = e.sheets.tasks;
    const orig = sheet.appendRow.bind(sheet);
    let second = null;
    // 第一個請求已經「找不到列」、正要 append 的瞬間，第二個請求進來
    sheet.appendRow = (row) => {
      if (!second) second = post(e, upTask({ id: '900', text: '同一筆', line_id: ME }), 'tok-me');
      return orig(row);
    };
    const first = post(e, upTask({ id: '900', text: '同一筆', line_id: ME }));
    assert.equal(first.success, true);
    assert.deepEqual(second, { error: 'busy' });
    assert.equal(rows(e).filter((r) => String(r.id) === '900').length, 1);
    assert.equal(lock.state.held, false, '寫完要放鎖');
  });

  test('拿不到鎖：回 busy、Sheet 一格都不動', () => {
    const e = env({ tasks: [task('1', ME)] });
    e.lock.busy = true;
    const before = snap(e);
    assert.deepEqual(post(e, upTask({ id: '1', text: '改了', line_id: ME })), { error: 'busy' });
    assert.deepEqual(post(e, { action: 'completeRecurring', sheet: 'tasks', key_field: 'id', record: { id: '1', line_id: ME } }), { error: 'busy' });
    assert.equal(snap(e), before);
  });

  test('寫入中丟例外也會放鎖（不卡死後面每一個寫入）', () => {
    const lock = realLock();
    const e = env({ lock, tasks: [task('1', ME)] });
    e.sheets.tasks.getRange = () => { throw new Error('Sheet 爆了'); };
    assert.throws(() => post(e, upTask({ id: '1', text: 'x', line_id: ME })));
    assert.equal(lock.state.held, false);
  });

  test('completeRecurring 也在鎖裡：生下一期照常、寫完放鎖', () => {
    const lock = realLock();
    const e = env({ lock, tasks: [task('1', ME, { due_date: '2026-10-19', recur_interval: 1, recur_unit: '週' })] });
    const out = post(e, { action: 'completeRecurring', sheet: 'tasks', key_field: 'id', next_id: '2', today: '2026-10-19',
      record: Object.fromEntries(TASK_H.map((h, i) => [h, task('1', ME, { due_date: '2026-10-19', recur_interval: 1, recur_unit: '週' })[i]])) });
    assert.equal(out.spawned, true);
    assert.equal(out.next_due, '2026-10-26');
    assert.ok(lock.state.tries >= 1);
    assert.equal(lock.state.held, false);
  });
});

/* ========================================================================== */
describe('B-5 白板只改自己的', () => {

  const denied = (out, name = '媽媽') => {
    assert.equal(out.error, 'forbidden');
    assert.equal(out.permanent, true, '要標 permanent，前端才不會一直重送');
    assert.equal(out.reason, 'not_owner');
    assert.equal(out.owner_name, name);
  };

  for (const [what, patch] of [
    ['改內容', { text: '我改的' }],
    ['勾完成', { is_completed: 'TRUE' }],
    ['刪除', { del: 'TRUE' }],
    ['從白板拿下來', { board: '' }]
  ]) {
    test('別人的白板任務：' + what + ' → 拒絕、Sheet 不變、寫 logs', () => {
      const e = env({ tasks: [task('1', MOM, { board: 'TRUE' })] });
      const before = snap(e);
      const rec = Object.assign({ id: '1', text: '倒垃圾', line_id: MOM, board: 'TRUE', kind: 'todo' }, patch);
      denied(post(e, upTask(rec)));   // Neil 是管理員：管理員也不例外
      assert.equal(snap(e), before);
      assert.ok(e.transactions.some((t) => t[0] === '同步' && t[1] === '失敗' && /not_owner/.test(t[4]) && t[6] === ME));
    });
  }

  test('把別人沒釘的項目釘上白板 → 拒絕（釘上去也是改別人的東西）', () => {
    const e = env({ tasks: [task('1', MOM)] });
    const before = snap(e);
    denied(post(e, upTask({ id: '1', text: '倒垃圾', line_id: MOM, board: 'TRUE', kind: 'todo' })));
    assert.equal(snap(e), before);
  });

  test('PWA 送上來謊稱 line_id 是自己：照雲端那列的建立者判斷', () => {
    const e = env({ tasks: [task('1', MOM, { board: 'TRUE' })] });
    denied(post(e, upTask({ id: '1', text: '偷改', line_id: ME, board: 'TRUE', kind: 'todo' })));
    assert.equal(taskRec(e, '1').line_id, MOM);
  });

  test('別人的白板週期任務 completeRecurring → 拒絕、不生下一期', () => {
    const e = env({ tasks: [task('1', MOM, { board: 'TRUE', due_date: '2026-10-19', recur_interval: 1, recur_unit: '週' })] });
    const before = snap(e);
    denied(post(e, { action: 'completeRecurring', sheet: 'tasks', key_field: 'id', next_id: '2', today: '2026-10-19',
      record: { id: '1', text: '倒垃圾', line_id: MOM, board: 'TRUE', due_date: '2026-10-19', recur_interval: 1, recur_unit: '週', kind: 'todo' } }));
    assert.equal(snap(e), before);
  });

  test('建立者自己改白板項目：照常寫入', () => {
    const e = env({ tasks: [task('1', MOM, { board: 'TRUE' })] });
    assert.equal(post(e, upTask({ id: '1', text: '媽改的', line_id: MOM, board: 'TRUE', kind: 'todo' }), 'tok-mom').success, true);
    assert.equal(taskRec(e, '1').text, '媽改的');
  });

  test('沒釘白板的別人項目：不管（Neil 2026-10-19：只管白板）', () => {
    const e = env({ tasks: [task('1', MOM)] });
    assert.equal(post(e, upTask({ id: '1', text: 'Neil 幫改', line_id: MOM, board: '', kind: 'todo' })).success, true);
    assert.equal(taskRec(e, '1').text, 'Neil 幫改');
  });

  test('line_id 空白的舊白板項目：誰都能改（Neil 2026-10-19）', () => {
    const e = env({ tasks: [task('1', '', { board: 'TRUE' })] });
    assert.equal(post(e, upTask({ id: '1', text: '有人整理', line_id: '', board: 'TRUE', kind: 'todo' }), 'tok-mom').success, true);
    assert.equal(taskRec(e, '1').text, '有人整理');
  });

  test('新項目（雲端還沒有）直接釘白板：放行', () => {
    const e = env();
    assert.equal(post(e, upTask({ id: '5', text: '新的', line_id: MOM, board: 'TRUE', kind: 'todo' }), 'tok-mom').success, true);
    assert.equal(rows(e).length, 1);
  });

  test('記帳與雜記一樣只限建立者', () => {
    const e = env({
      expenses: [['7', '2026-10-19', 'expense', '飲食', 100, '', '2026-10-19T00:00:00.000Z', MOM, '', '', 'TRUE']],
      notes: [['8', '買牛奶', '2026-10-19T00:00:00.000Z', MOM, '', '', 'TRUE']]
    });
    const exBefore = snap(e, 'expenses'), noteBefore = snap(e, 'notes');
    denied(post(e, { action: 'upsert', sheet: 'expenses', key_field: 'id',
      record: { id: '7', expense_date: '2026-10-19', type: 'expense', category: '飲食', amount: 999, line_id: MOM, board: 'TRUE' } }));
    denied(post(e, { action: 'upsert', sheet: 'notes', key_field: 'id', record: { id: '8', text: '買豆漿', line_id: MOM, board: 'TRUE' } }));
    assert.equal(snap(e, 'expenses'), exBefore);
    assert.equal(snap(e, 'notes'), noteBefore);
  });

  test('拒絕也會放鎖：下一筆照常寫得進去', () => {
    const lock = realLock();
    const e = env({ lock, tasks: [task('1', MOM, { board: 'TRUE' })] });
    denied(post(e, upTask({ id: '1', text: 'x', line_id: MOM, board: 'TRUE', kind: 'todo' })));
    assert.equal(lock.state.held, false);
    assert.equal(post(e, upTask({ id: '2', text: '我的', line_id: ME, kind: 'todo' })).success, true);
  });
});
