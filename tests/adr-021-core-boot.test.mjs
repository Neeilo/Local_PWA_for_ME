/**
 * ADR-021 PR-B（後端）— 2.0 開機只讀核心層（D-1）、Widget 摘要、taskDone、clipRead（D-13）
 *
 * 為什麼有這批測試：
 *  - 10/19 冷開機 P50 9.6 秒，boot 整張讀 tasks／notes／expenses。2.0 開機只讀「首頁要的」：
 *    身份、名單、模組登記、一段話、各 Widget 的摘要——notes／expenses 不整張讀（只讀 board 一欄找白板項目）
 *  - Widget 各自失敗（EXP-01）：一個摘要丟例外，其他摘要與開機照常
 *  - 首頁勾完成要雲端確認（taskDone）：判斷都用雲端那列，白板只有建立者能勾、提醒不能勾、總開關照擋
 *  - 開閱讀頁即已讀（clipRead）：只有收藏擁有者能寫；clips 加的兩欄在最右邊
 *  - 1.0 的 boot 一個字都不變（既有測試守著；這裡再釘「沒帶 core 就是原本的回應」）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes', 'feat_clips'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'archive', 'board'];
const NOTE_H = ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board'];

function task(id, owner, extra = {}) {
  const r = { id, text: '任務' + id, is_completed: '', created_at: '2026-10-01T00:00:00.000Z', priority: 'M', line_id: owner,
    del: '', archive: '', board: '', due_date: '', recur_interval: '', recur_unit: '', notified: '', origin_chat: '', kind: 'todo' };
  return TASK_H.map((h) => (h in extra ? extra[h] : r[h]));
}

function clipsSheet(rows = []) {
  return new FakeSheet('clips', [['id', 'line_id', 'url', 'status', 'author', 'caption', 'del', 'updated_at', 'read_status', 'last_read_at'], ...rows]);
}

function env({ tasks = [], expenses = [], notes = [], clips = null, feats = FEATS, opts = {} } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
      [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map((f) => (feats.includes(f) ? 'TRUE' : ''))),
      [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
    ]),
    tasks: new FakeSheet('tasks', [TASK_H, ...tasks]),
    expenses: new FakeSheet('expenses', [EXP_H, ...expenses]),
    notes: new FakeSheet('notes', [NOTE_H, ...notes]),
    logs: new FakeSheet('logs', [['id']])
  };
  if (clips) sheets.clips = clips;
  return loadCodeGs(Object.assign({ tokens: { 'tok-me': ME, 'tok-mom': MOM }, sheets }, opts));
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const core = (e, tok) => post(e, { action: 'boot', core: true, trigger: 'cold' }, tok);
const rows = (e, name = 'tasks') => e.sheets[name].toRecords();

/** 數每張表被整張讀（getDataRange）幾次 */
function spyFullReads(e) {
  const counts = {};
  Object.values(e.sheets).forEach((sh) => {
    const orig = sh.getDataRange.bind(sh);
    sh.getDataRange = () => { counts[sh.name] = (counts[sh.name] || 0) + 1; return orig(); };
  });
  return counts;
}

/* ========================================================================== */
describe('boot core：只讀核心層', () => {

  test('身份、名單、模組、一段話照帶；不帶 data（沒有整張 tasks／notes／expenses）', () => {
    const e = env({ tasks: [task('1', ME)], notes: [['n1', '筆記', '', ME, '', '', '']], expenses: [['x1', '2026-10-01', 'expense', '餐飲', 100, '', '', ME, '', '', '']] });
    const b = core(e);
    assert.equal(b.session.status, 'ok');
    assert.equal(b.session.line_id, ME);
    assert.ok(Array.isArray(b.line_users) && b.line_users.length === 2);
    assert.ok(Array.isArray(b.modules));
    assert.equal(typeof b.self_note, 'string');
    assert.equal(b.core, true);
    assert.equal(b.data, undefined);
    assert.equal(b.expense_config, undefined);
  });

  test('notes／expenses 不整張讀（getDataRange 0 次）；只讀 board 那一欄', () => {
    const e = env({ notes: [['n1', '筆記', '', ME, '', '', 'TRUE']], expenses: [['x1', '2026-10-01', 'expense', '餐飲', 100, '', '', ME, '', '', '']] });
    const counts = spyFullReads(e);
    core(e);
    assert.equal(counts.notes || 0, 0);
    assert.equal(counts.expenses || 0, 0);
  });

  test('沒帶 core：原本的 1.0 boot（data 三張表都在）', () => {
    const e = env({ tasks: [task('1', ME)] });
    const b = post(e, { action: 'boot', trigger: 'cold' });
    assert.deepEqual(Object.keys(b.data).sort(), ['expenses', 'notes', 'tasks']);
    assert.equal(b.core, undefined);
    assert.equal(b.widgets, undefined);
  });
});

/* ========================================================================== */
describe('Tasks 摘要', () => {

  test('未完成的任務（待辦＋提醒）都在；已完成的不在，除非釘在白板；刪掉的不在', () => {
    const e = env({ tasks: [
      task('1', ME), task('2', ME, { is_completed: 'TRUE' }), task('3', ME, { is_completed: 'TRUE', board: 'TRUE' }),
      task('4', ME, { del: 'TRUE' }), task('5', MOM, { kind: 'reminder', due_date: '2026-10-20' })
    ] });
    const w = core(e).widgets.tasks;
    assert.deepEqual(w.tasks.map((t) => String(t.id)).sort(), ['1', '3', '5']);
    assert.ok(w.at);
  });

  test('白板：notes／expenses 只帶釘著的列（完整欄位，前端畫得出來）', () => {
    const e = env({
      notes: [['n1', '沒釘', '', ME, '', '', ''], ['n2', '釘了', '', MOM, '', '', 'TRUE'], ['n3', '釘了但刪了', '', ME, 'TRUE', '', 'TRUE']],
      expenses: [['x1', '2026-10-01', 'expense', '餐飲', 100, '午餐', '', ME, '', '', 'TRUE']]
    });
    const w = core(e).widgets.tasks;
    assert.deepEqual(w.board.notes.map((r) => r.id), ['n2']);
    assert.equal(w.board.notes[0].text, '釘了');
    assert.deepEqual(w.board.expenses.map((r) => r.id), ['x1']);
    assert.equal(w.board.expenses[0].note, '午餐');
  });

  test('沒有記帳權限：白板不帶記帳的列', () => {
    const e = env({ feats: ['feat_tasks', 'feat_notes'], expenses: [['x1', '2026-10-01', 'expense', '餐飲', 100, '', '', ME, '', '', 'TRUE']] });
    assert.deepEqual(core(e).widgets.tasks.board.expenses, []);
  });

  test('提醒模組關掉：摘要裡沒有提醒；白板模組關掉：board 全空', () => {
    const reg = new FakeSheet('_module_registry', [['module_id', 'enabled'], ['reminders', 'FALSE'], ['board', 'FALSE']]);
    const e = env({ tasks: [task('1', ME), task('2', ME, { kind: 'reminder', due_date: '2026-10-20' }), task('3', ME, { board: 'TRUE' })],
      notes: [['n1', 'x', '', ME, '', '', 'TRUE']] });
    e.sheets._module_registry = reg;
    const w = core(e).widgets.tasks;
    assert.deepEqual(w.tasks.map((t) => String(t.id)).sort(), ['1', '3']);
    assert.equal(w.tasks.find((t) => String(t.id) === '3').board, '');
    assert.deepEqual(w.board, { notes: [], expenses: [] });
  });

  test('沒有任務權限：不帶 tasks 摘要（Widget 不出現）', () => {
    const e = env({ feats: ['feat_notes'] });
    assert.equal(core(e).widgets.tasks, undefined);
  });
});

/* ========================================================================== */
describe('Reading 摘要（D-13）', () => {

  test('上次在讀＝最後閱讀時間最新的；未讀＝收齊（done／partial）且沒讀過的；只看自己的、刪掉的不算', () => {
    const clips = clipsSheet([
      ['c1', ME, 'u1', 'done', 'alice', '第一篇\n第二行', '', '', 'read', '2026-10-18T01:00:00.000Z'],
      ['c2', ME, 'u2', 'done', 'bob', '第二篇', '', '', 'read', '2026-10-19T01:00:00.000Z'],
      ['c3', ME, 'u3', 'done', 'carol', '沒讀', '', '', '', ''],
      ['c4', ME, 'u4', 'partial', 'dan', '缺圖沒讀', '', '', '', ''],
      ['c5', ME, 'u5', 'pending', '', '', '', '', '', ''],
      ['c6', ME, 'u6', 'done', 'eve', '刪了', 'TRUE', '', '', ''],
      ['c7', MOM, 'u7', 'done', 'mom', '媽媽的', '', '', '', '']
    ]);
    const w = core(env({ clips })).widgets.reading;
    assert.equal(w.unread, 2);
    assert.equal(w.last.id, 'c2');
    assert.equal(w.last.author, 'bob');
    assert.equal(w.last.title, '第二篇');
  });

  test('從沒讀過：last 是 null', () => {
    const w = core(env({ clips: clipsSheet([['c1', ME, 'u1', 'done', 'a', 'x', '', '', '', '']]) })).widgets.reading;
    assert.equal(w.last, null);
    assert.equal(w.unread, 1);
  });

  test('沒有收藏權限：不帶 reading 摘要', () => {
    const e = env({ feats: ['feat_tasks'], clips: clipsSheet() });
    assert.equal(core(e).widgets.reading, undefined);
  });
});

/* ========================================================================== */
describe('Widget 各自失敗（EXP-01）', () => {

  test('Tasks 摘要丟例外：它回 error，Reading 與開機照常', () => {
    const e = env({ clips: clipsSheet([['c1', ME, 'u1', 'done', 'a', 'x', '', '', '', '']]),
      opts: { overrides: { tasksWidget_: () => { throw new Error('模擬：tasks 讀壞了'); } } } });
    const b = core(e);
    assert.equal(b.session.status, 'ok');
    assert.deepEqual(b.widgets.tasks, { error: 'summary_failed' });
    assert.equal(b.widgets.reading.unread, 1);
  });

  test('action=widgets：輪詢只拿摘要（不帶名單、不帶 session）', () => {
    const e = env({ tasks: [task('1', ME)] });
    const r = post(e, { action: 'widgets', trigger: 'poll' });
    assert.ok(r.widgets.tasks.tasks.length === 1);
    assert.equal(r.line_users, undefined);
    assert.equal(typeof r.self_note, 'string');
  });
});

/* ========================================================================== */
describe('taskDone：首頁勾完成，雲端確認', () => {

  const done = (e, id, tok) => post(e, { action: 'taskDone', id, today: '2026-10-19', next_id: '9001', trigger: 'write' }, tok);

  test('一般待辦：標完成', () => {
    const e = env({ tasks: [task('1', ME)] });
    assert.equal(done(e, '1').success, true);
    assert.equal(rows(e)[0].is_completed, 'TRUE');
  });

  test('週期待辦：生下一期（跟任務頁打勾同一條路）', () => {
    const e = env({ tasks: [task('1', ME, { due_date: '2026-10-19', recur_interval: 1, recur_unit: 'week' })] });
    const r = done(e, '1');
    assert.equal(r.spawned, true);
    assert.equal(rows(e).length, 2);
    assert.equal(rows(e).find((t) => String(t.id) === '9001').is_completed, '');
  });

  test('提醒不能勾（永久拒絕）；找不到的、刪掉的永久拒絕', () => {
    const e = env({ tasks: [task('1', ME, { kind: 'reminder', due_date: '2026-10-19' }), task('2', ME, { del: 'TRUE' })] });
    const before = JSON.stringify(e.sheets.tasks.values);
    assert.deepEqual([done(e, '1').error, done(e, '1').permanent], ['reminder_not_completable', true]);
    assert.equal(done(e, '2').permanent, true);
    assert.equal(done(e, 'nope').permanent, true);
    assert.equal(JSON.stringify(e.sheets.tasks.values), before);
  });

  test('別人的白板項目：永久拒絕（not_owner）；別人沒釘白板的照樣能勾（跟任務頁一樣）', () => {
    const e = env({ tasks: [task('1', MOM, { board: 'TRUE' }), task('2', MOM)] });
    const r = done(e, '1');
    assert.equal(r.reason, 'not_owner');
    assert.equal(r.permanent, true);
    assert.equal(done(e, '2').success, true);
  });

  test('任務模組關掉：module_off；沒有任務權限：forbidden', () => {
    const e = env({ tasks: [task('1', ME)] });
    e.sheets._module_registry = new FakeSheet('_module_registry', [['module_id', 'enabled'], ['tasks', 'FALSE']]);
    assert.equal(done(e, '1').reason, 'module_off');
    const e2 = env({ feats: ['feat_notes'], tasks: [task('1', ME)] });
    assert.equal(done(e2, '1').error, 'forbidden');
  });

  test('拿不到鎖：busy（可重試，不是永久拒絕）', () => {
    const e = env({ tasks: [task('1', ME)] });
    e.lock.busy = true;
    const r = done(e, '1');
    assert.equal(r.error, 'busy');
    assert.equal(r.permanent, undefined);
  });
});

/* ========================================================================== */
describe('clipRead：開閱讀頁即已讀', () => {

  test('擁有者：read_status=read、last_read_at 寫上時間', () => {
    const e = env({ clips: clipsSheet([['c1', ME, 'u1', 'done', 'a', 'x', '', '', '', '']]) });
    assert.equal(post(e, { action: 'clipRead', id: 'c1', trigger: 'write' }).success, true);
    const r = rows(e, 'clips')[0];
    assert.equal(r.read_status, 'read');
    assert.match(String(r.last_read_at), /^\d{4}-\d{2}-\d{2}T/);
  });

  test('不是擁有者：永久拒絕、不動', () => {
    const e = env({ clips: clipsSheet([['c1', MOM, 'u1', 'done', 'a', 'x', '', '', '', '']]) });
    const r = post(e, { action: 'clipRead', id: 'c1', trigger: 'write' });
    assert.equal(r.permanent, true);
    assert.equal(rows(e, 'clips')[0].read_status, '');
  });

  test('clips 的兩個新欄在表頭清單最後面（「初始化」補在最右邊，1.0 不受影響）', () => {
    const e = env();
    const h = e.read('CLIPS_HEADERS');
    const at = h.indexOf('video_saved');
    assert.deepEqual(h.slice(at + 1, at + 3), ['read_status', 'last_read_at']);
    // PR-E 的筆記與 AI 欄接在它們後面，一樣只加在最右邊
    assert.deepEqual(h.slice(at + 3), ['note', 'note_revision', 'note_updated_at', 'ai_output', 'ai_provider', 'ai_at']);
  });
});

/* ========================================================================== */
describe('readMany groups:true（2.0 進任務頁補群組名）', () => {
  test('帶 groups:true 且讀了 tasks：回 group_names；沒帶（1.0）就不回', () => {
    const e = env({ tasks: [task('1', ME)] });
    assert.ok('group_names' in post(e, { action: 'readMany', sheets: ['tasks'], groups: true, trigger: 'manual' }));
    assert.ok(!('group_names' in post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'manual' })));
  });
});
