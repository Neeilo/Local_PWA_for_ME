/**
 * ADR-021 PR-A1（後端）— 模組登記表＋總開關（D-9 ①）
 *
 * 為什麼有這批測試：
 *  - 總開關是「這個功能上不上線」，對所有人、1.0／2.0 一起生效（Neil 2026-10-19）。
 *    關掉＝連資料都碰不到：不只藏圖示，後端讀、寫、LINE、「查/」、排程都要擋
 *  - 提醒、白板、分期沒有自己一張表，要欄位級擋：關提醒不能連待辦一起消失；
 *    關白板時前端送回來的 board 是空的，不保留雲端原值的話，改一下任務就把白板洗掉了
 *  - 被擋的寫入要回 permanent:true：重送幾次都一樣，留在佇列只會卡死後面每一筆
 *  - 一個模組關掉，其他模組照常（EXP-02）
 *  - 表還沒建（初始化前）＝全開：1.0 的行為一個都不能變
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';      // 管理員
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes', 'feat_clips', 'feat_stock', 'feat_gmail'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'archive', 'board', 'plan_id', 'plan_seq'];
const NOTE_H = ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board'];
const REG_H = ['module_id', 'name', 'category', 'icon', 'enabled', 'permission', 'load_policy', 'sort'];
// costs：成本概況模組（Neil 2026-10-21，tests/cost-module.test.mjs）
const ALL = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library', 'costs'];

function task(id, owner, extra = {}) {
  const r = { id, text: '任務' + id, is_completed: '', created_at: '2026-10-01T00:00:00.000Z', priority: 'M', line_id: owner,
    del: '', archive: '', board: '', due_date: '', recur_interval: '', recur_unit: '', notified: '', origin_chat: '', kind: 'todo' };
  return TASK_H.map((h) => (h in extra ? extra[h] : r[h]));
}
const reminder = (id, owner, extra = {}) => task(id, owner, Object.assign({ kind: 'reminder', due_date: '2026-10-19' }, extra));

/** 登記表：off 裡的模組 enabled=FALSE，其餘 TRUE */
function registry(off = []) {
  return new FakeSheet('_module_registry', [REG_H,
    ...ALL.map((id, i) => [id, id, '', '', off.includes(id) ? 'FALSE' : 'TRUE', '', 'lazy', (i + 1) * 10])]);
}

function env({ off = null, tasks = [], expenses = [], notes = [], extra = {}, opts = {} } = {}) {
  const sheets = Object.assign({
    line_users: new FakeSheet('line_users', [
      ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
      [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
      [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
    ]),
    tasks: new FakeSheet('tasks', [TASK_H, ...tasks]),
    expenses: new FakeSheet('expenses', [EXP_H, ...expenses]),
    notes: new FakeSheet('notes', [NOTE_H, ...notes]),
    logs: new FakeSheet('logs', [['id']])
  }, extra);
  if (off) sheets._module_registry = registry(off);
  return loadCodeGs(Object.assign({ tokens: { 'tok-me': ME, 'tok-mom': MOM }, sheets }, opts));
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
const rows = (e, name = 'tasks') => e.sheets[name].toRecords();
const snap = (e, name = 'tasks') => JSON.stringify(e.sheets[name].values);
const boot = (e, tok = 'tok-me') => post(e, { action: 'boot', trigger: 'cold' }, tok);

/* ========================================================================== */
describe('沒有登記表（初始化前）：全開，行為不變', () => {

  test('boot 照常帶三張表；附上全部模組、全部 enabled', () => {
    const e = env({ tasks: [task('1', ME), reminder('2', ME)] });
    const b = boot(e);
    assert.deepEqual(b.denied, []);
    assert.equal(b.data.tasks.length, 2, '提醒照常在');
    assert.deepEqual(b.modules.map((m) => m.module_id), ALL);
    assert.ok(b.modules.every((m) => m.enabled === true));
  });

  test('登記表少了某一列：那個模組當作開（不是關）', () => {
    const e = env({ extra: { _module_registry: new FakeSheet('_module_registry', [REG_H, ['expenses', '記帳', '', '', 'TRUE', '', '', 10]]) },
      tasks: [reminder('2', ME)] });
    const b = boot(e);
    assert.equal(b.data.tasks.length, 1);
    assert.ok(b.modules.find((m) => m.module_id === 'reminders').enabled);
  });

  test('權限欄只登記給人看：在表上改 permission 不會放寬誰能用', () => {
    const reg = registry([]);
    const e = env({ extra: { _module_registry: reg } });
    e.sheets.line_users.values[2][FEATS.indexOf('feat_expense') + 4] = '';     // 媽媽沒有記帳
    reg.values[1][REG_H.indexOf('permission')] = '';                         // 有人把 expenses 的權限欄清空
    assert.deepEqual(boot(e, 'tok-mom').denied, ['expenses']);
  });
});

/* ========================================================================== */
describe('有自己一張表的模組：關掉 → 讀寫永久拒絕；其他模組照常（EXP-02）', () => {

  test('記帳關掉：boot 的 denied 有 expenses，任務照常', () => {
    const e = env({ off: ['expenses'], tasks: [task('1', ME)] });
    const b = boot(e);
    assert.deepEqual(b.denied, ['expenses']);
    assert.equal(b.data.tasks.length, 1);
    assert.equal(b.modules.find((m) => m.module_id === 'expenses').enabled, false);
  });

  test('記帳關掉：upsert 回 permanent、Sheet 一格不動、留 logs；任務寫入照常', () => {
    const e = env({ off: ['expenses'] });
    const before = snap(e, 'expenses');
    const r = post(e, { action: 'upsert', sheet: 'expenses', key_field: 'id', record: { id: '9', amount: 100, line_id: ME } });
    assert.deepEqual(r, { error: 'forbidden', permanent: true, reason: 'module_off', module: 'expenses' });
    assert.equal(snap(e, 'expenses'), before);
    assert.ok(e.transactions.some((t) => /module_off｜expenses/.test(t[4])));
    const ok = post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '10', text: '照常', line_id: ME, kind: 'todo' } });
    assert.equal(ok.success, true);
  });

  test('記帳關掉：read 也擋', () => {
    const e = env({ off: ['expenses'] });
    assert.equal(post(e, { action: 'read', sheet: 'expenses', trigger: 'manual' }).error, 'forbidden');
  });

  test('記帳關掉：LINE「記帳/」也擋，Sheet 不動', () => {
    const e = env({ off: ['expenses'], opts: { extraFiles: ['line-router.gs'] } });
    const before = snap(e, 'expenses');
    const reply = e.call('routeLineMessage_', '記帳/100/餐飲', ME, '');
    assert.match(reply, /「記帳」目前停用中/, '不是叫人去開權限');
    assert.equal(snap(e, 'expenses'), before);
  });

  test('圖書館關掉：clips 讀不到、重跑／刪除永久拒絕', () => {
    const clips = new FakeSheet('clips', [['id', 'line_id', 'url', 'status', 'del'], ['c1', ME, 'https://www.instagram.com/p/x/', 'done', '']]);
    const e = env({ off: ['library'], extra: { clips } });
    const r = post(e, { action: 'readMany', sheets: ['clips'], trigger: 'poll' });
    assert.deepEqual(r.denied, ['clips']);
    const del = post(e, { action: 'clipDelete', id: 'c1' });
    assert.equal(del.permanent, true);
  });

  test('排程總管：模組關掉，它的工作不跑；其他照跑', () => {
    const ran = [];
    const jobs = [
      { name: 'gmail', module: 'mail', rule: { kind: 'always' }, run: () => { ran.push('gmail'); } },
      { name: 'guide', rule: { kind: 'always' }, run: () => { ran.push('guide'); } }
    ];
    const e = env({ off: ['mail'], opts: { propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
      overrides: { schedulerJobs_: () => jobs, schedulerClock_: () => 0 } } });
    e.call('runScheduler', Date.UTC(2026, 9, 19, 2, 0));
    assert.deepEqual(ran, ['guide']);
  });

  test('登記表上掛模組的工作都對得上真的模組 id', () => {
    const e = env({ opts: { extraFiles: ['line-router.gs', 'sheet-guide.gs'] } });
    const owned = e.read('schedulerJobs_().filter(function(j){ return j.module; }).map(function(j){ return [j.name, j.module]; })');
    assert.deepEqual(owned, [['stockRules', 'stocks'], ['dueCheck', 'tasks'], ['gmail', 'mail'], ['stockDaily', 'stocks'],
      ['clips', 'library'], ['apifyUsage', 'library']]);
  });
});

/* ========================================================================== */
describe('提醒（tasks 裡 kind=reminder）：欄位級擋', () => {

  test('boot／readMany：提醒不見、待辦還在', () => {
    const e = env({ off: ['reminders'], tasks: [task('1', ME), reminder('2', ME)] });
    assert.deepEqual(boot(e).data.tasks.map((t) => String(t.id)), ['1']);
    assert.deepEqual(post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll' }).data.tasks.map((t) => String(t.id)), ['1']);
  });

  test('新增提醒 → 永久拒絕；改既有提醒（舊版 App 不帶 kind）→ 也拒絕；改待辦照常', () => {
    const e = env({ off: ['reminders'], tasks: [task('1', ME), reminder('2', ME)] });
    const before = snap(e);
    const add = post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '3', text: '繳房租', line_id: ME, kind: 'reminder' } });
    assert.equal(add.reason, 'module_off');
    assert.equal(add.module, 'reminders');
    const edit = post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '2', text: '改了', line_id: ME } });
    assert.equal(edit.reason, 'module_off');
    assert.equal(snap(e), before);
    const todo = post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '1', text: '待辦改了', line_id: ME, kind: 'todo' } });
    assert.equal(todo.success, true);
  });

  test('到期檢查：提醒不推、不翻頁；到期的待辦照推', () => {
    const e = env({ off: ['reminders'], tasks: [
      task('1', ME, { due_date: '2026-10-19' }),
      reminder('2', ME, { due_date: '2026-10-19' }),
      reminder('3', ME, { due_date: '2026-10-01', recur_interval: 1, recur_unit: 'month' })
    ], opts: { extraFiles: ['line-router.gs'] } });
    e.call('checkDueReminders', '2026-10-19');
    const pushed = JSON.stringify(e.pushes);
    assert.match(pushed, /任務1/);
    assert.doesNotMatch(pushed, /任務2/);
    const r3 = rows(e).find((r) => String(r.id) === '3');
    assert.equal(r3.due_date, '2026-10-01', '關掉的模組的資料不翻頁');
  });

  test('LINE「提醒/」擋下、Sheet 不動；「任務/」照常', () => {
    const e = env({ off: ['reminders'], opts: { extraFiles: ['line-router.gs'], cache: true } });
    const before = snap(e);
    assert.match(e.call('routeLineMessage_', '提醒/繳房租', ME, ''), /提醒」目前停用中/);
    assert.equal(snap(e), before);
    e.call('routeLineMessage_', '任務/倒垃圾', ME, '');
    assert.equal(rows(e).length, 1);
  });

  test('LINE 到期卡片按到提醒 → 不動作', () => {
    const e = env({ off: ['reminders'], tasks: [reminder('2', ME, { due_date: '2026-10-19' })], opts: { extraFiles: ['line-router.gs'] } });
    const before = snap(e);
    const reply = e.call('dueCardStep_', { t: '2', a: 'tmr', d: '2026-10-19' }, {}, false, ME, '到期卡片');
    assert.match(reply, /停用中/);
    assert.equal(snap(e), before);
  });

  test('「查/」：提醒不進 AI 的資料', () => {
    const e = env({ off: ['reminders'], tasks: [task('1', ME), reminder('2', ME)], opts: { extraFiles: ['line-router.gs'] } });
    const ctx = e.call('buildQueryContext_', ME, '我有什麼提醒');
    assert.doesNotMatch(JSON.stringify(ctx), /任務2/);
  });
});

/* ========================================================================== */
describe('白板（board 欄）：欄位級擋', () => {

  test('讀回來的列一律不在白板上', () => {
    const e = env({ off: ['board'], tasks: [task('1', ME, { board: 'TRUE' })], notes: [['n1', '筆記', '2026-10-01', ME, '', '', 'TRUE']] });
    const b = boot(e);
    assert.equal(b.data.tasks[0].board, '');
    assert.equal(b.data.notes[0].board, '');
    assert.equal(rows(e)[0].board, 'TRUE', '雲端原值不動');
  });

  test('寫入保留雲端原值：改任務文字不會把白板洗掉；想釘上去也不會成功', () => {
    const e = env({ off: ['board'], tasks: [task('1', ME, { board: 'TRUE' }), task('2', ME)] });
    post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '1', text: '改字', line_id: ME, kind: 'todo', board: '' } });
    post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '2', text: '任務2', line_id: ME, kind: 'todo', board: 'TRUE' } });
    post(e, { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '3', text: '新的', line_id: ME, kind: 'todo', board: 'TRUE' } });
    const by = Object.fromEntries(rows(e).map((r) => [String(r.id), r]));
    assert.equal(by['1'].text, '改字');
    assert.equal(by['1'].board, 'TRUE');
    assert.equal(by['2'].board, '');
    assert.equal(by['3'].board, '');
  });

  test('推播「白板摘要」擋下；「快到期清單」不再因為釘白板而列入', () => {
    const e = env({ off: ['board'], tasks: [task('1', ME, { board: 'TRUE', due_date: '2026-10-19' })] });
    assert.equal(e.call('pushText_', 'board', 'Cgroup', '', '2026-10-19').error, 'module_off');
    assert.equal(e.call('pushText_', 'due', 'Cgroup', '', '2026-10-19').error, 'nothing_to_send');
  });
});

/* ========================================================================== */
describe('分期：plan* 動作與計畫表', () => {

  test('plan* 一律永久拒絕；boot 不帶計畫；記帳照常', () => {
    const inst = new FakeSheet('installments', [['plan_id', 'status'], ['p1', 'active']]);
    const e = env({ off: ['plans'], expenses: [['1', '2026-10-01', 'expense', '餐飲', 1200, '', '', ME, '', '', '', '', '']], extra: { installments: inst } });
    const before = snap(e, 'expenses');
    for (const action of ['planCreate', 'planDelete', 'planEnd', 'planAdjust']) {
      const r = post(e, { action, expense_id: '1', plan_id: 'p1', periods: 3 });
      assert.equal(r.reason, 'module_off', action);
      assert.equal(r.permanent, true, action);
    }
    assert.equal(snap(e, 'expenses'), before);
    const b = boot(e);
    assert.equal(b.installments, undefined);
    assert.equal(b.data.expenses.length, 1);
  });
});

/* ========================================================================== */
describe('moduleSet（總開關）與初始化', () => {

  test('非管理者改不了', () => {
    const e = env({ off: [] });
    assert.equal(post(e, { action: 'moduleSet', module_id: 'expenses', enabled: false, trigger: 'manual' }, 'tok-mom').error, 'forbidden');
    assert.equal(rows(e, '_module_registry')[0].enabled, 'TRUE');
  });

  test('管理者關掉 → 立刻生效（不等快取）；再打開 → 回來', () => {
    const e = env({ off: [], tasks: [reminder('2', ME)], opts: { cache: true } });
    assert.equal(boot(e).data.tasks.length, 1);       // 先讀一次，快取裡是「全開」
    const r = post(e, { action: 'moduleSet', module_id: 'reminders', enabled: false, trigger: 'manual' });
    assert.equal(r.success, true);
    assert.equal(r.modules.find((m) => m.module_id === 'reminders').enabled, false);
    assert.equal(boot(e).data.tasks.length, 0);
    post(e, { action: 'moduleSet', module_id: 'reminders', enabled: true, trigger: 'manual' });
    assert.equal(boot(e).data.tasks.length, 1);
  });

  test('不認得的模組 → unknown_module', () => {
    const e = env({ off: [] });
    assert.equal(post(e, { action: 'moduleSet', module_id: 'diary', enabled: false, trigger: 'manual' }).error, 'unknown_module');
  });

  test('初始化：建表＋每個模組一列；再跑一次不重複、管理者關掉的不會被打開', () => {
    const e = env();
    e.call('ensureModuleRegistry_');
    assert.deepEqual(rows(e, '_module_registry').map((r) => r.module_id), ALL);
    assert.ok(rows(e, '_module_registry').every((r) => r.enabled === 'TRUE'));
    e.sheets._module_registry.values[1][REG_H.indexOf('enabled')] = 'FALSE';
    const again = e.call('ensureModuleRegistry_');
    assert.deepEqual(again.added, []);
    assert.equal(rows(e, '_module_registry').length, ALL.length);
    assert.equal(rows(e, '_module_registry')[0].enabled, 'FALSE');
  });

  test('「初始化」的步驟裡有模組登記表', () => {
    const e = env({ opts: { extraFiles: ['line-router.gs'] } });
    assert.ok(e.read('initSteps_().map(function(s){ return s.label; })').some((l) => /模組登記表/.test(l)));
  });

  test('_guide 有登記這張表', () => {
    const e = env({ opts: { extraFiles: ['sheet-guide.gs'] } });
    assert.ok(e.read('guideRegistry_().map(function(g){ return g.sheet; })').includes('_module_registry'));
  });

  test('PWA 不能直接讀寫登記表（只走 boot 與 moduleSet）', () => {
    const e = env({ off: [] });
    assert.equal(post(e, { action: 'read', sheet: '_module_registry', trigger: 'manual' }).error, 'sheet_not_readable');
    assert.equal(post(e, { action: 'upsert', sheet: '_module_registry', key_field: 'module_id', record: { module_id: 'tasks', enabled: 'FALSE' } }).error, 'sheet_not_writable');
  });
});
