/**
 * ADR-018 PR-B（A-1～A-4）— 待辦／提醒分家：後端與 LINE
 *
 * 盯的事（為什麼）：
 *   - kind 由「初始化」補欄並歸類：有週期→提醒、其餘→待辦；可重複、不覆蓋已設的值（A-2）
 *   - 週期提醒跟著時間走：9 點排程先推播、再翻頁，翻頁清 notified；單次提醒過期不動，
 *     過期 30 天以上才設 del 走既有封存流程（A-3；Neil 2026-10-13：月底沿用既有算法，接受漂移）
 *   - 待辦的週期照舊跟著完成走（ADR-009），排程不碰
 *   - 提醒不能標完成：upsert 把完成改回空白（不回錯誤，免得前端佇列卡死）、completeRecurring 拒絕
 *   - 舊版 App 不知道 kind：送上來的 record 沒有 kind 時保留雲端的值，不能被洗成待辦
 *   - LINE「提醒/內容」→ 日期 → 重複（不重複／每週／每月／每年）；只有建立者按得動、按一次（A-4）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const GROUP = 'Cfamily';
const TODAY = '2026-10-13';            // 星期二
const TOK_ME = 'tok-neil';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
  'created_at', 'updated_at', 'notify_due'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];

const taskRow = (o, headers = TASK_H) => headers.map((h) => (o[h] === undefined ? '' : o[h]));

function env({ tasks = [], taskHeaders = TASK_H, pushImpl = null } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], pushImpl,
    tokens: { [TOK_ME]: ME },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
        [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      tasks: new FakeSheet('tasks', [taskHeaders.slice()].concat(tasks.map((t) => taskRow(t, taskHeaders)))),
      expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del']]),
      notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']]),
      line_groups: new FakeSheet('line_groups', [GROUP_H, GROUP_H.map((h) => ({ group_id: GROUP, name: '家族' }[h] ||
        (['is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'notify_due'].includes(h) ? 'TRUE' : '')))]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    },
    overrides: { lineReply_: (_t, msg) => { replies.push(msg); }, lineTodayKey_: () => TODAY }
  });
  e.replies = replies;
  e.last = () => replies[replies.length - 1];
  e.lastText = () => { const m = e.last(); return m && typeof m === 'object' ? m.text : String(m || ''); };
  return e;
}
const tasksOf = (e) => e.sheets.tasks.toRecords();
const byId = (e, id) => tasksOf(e).find((t) => String(t.id) === String(id));
/** logTransaction_ 收到的 (source, status, input, result, …)，轉成 logs 列的形狀 */
const logsOf = (e) => e.transactions.map((t) => ({ source: t[0], status: t[1], input: t[2], result: t[3] }));

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK_ME }, body)) } }).body);
}
const src = (userId, type = 'user') => (type === 'user' ? { type, userId } : { type, groupId: GROUP, userId });
function say(e, userId, text, type = 'user') {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: src(userId, type), message: { type: 'text', text } });
  return e.replies.length > before ? e.last() : null;
}
function tap(e, userId, data, type = 'user', params) {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'postback', replyToken: 'rt', source: src(userId, type),
    postback: params ? { data, params } : { data } });
  return e.replies.length > before ? e.last() : null;
}
const actionsOf = (msg) => Array.from((msg && msg.quickReply && msg.quickReply.items) || [], (i) => i.action);
const btn = (msg, re) => actionsOf(msg).find((a) => re.test(a.label));
const textOf = (m) => (m && typeof m === 'object' ? m.text : String(m || ''));

/* ========================================================================== */
describe('翻頁規則（純函式 reminderRollPlan_）', () => {

  const plan = (e, rows, today = TODAY) => e.call('reminderRollPlan_', rows, today);
  const rem = (o) => Object.assign({ id: '1', kind: 'reminder', line_id: ME, is_completed: '', del: '' }, o);

  test('週期提醒過期 → 跳到下一個 ≥ 今天的日期；剛好今天到期不動；未來不動', () => {
    const e = env();
    const out = plan(e, [
      rem({ id: 'a', due_date: '2026-10-01', recur_interval: 1, recur_unit: '週' }),
      rem({ id: 'b', due_date: TODAY, recur_interval: 1, recur_unit: '月' }),
      rem({ id: 'c', due_date: '2026-10-20', recur_interval: 1, recur_unit: '月' })
    ]);
    assert.deepEqual(out.map((x) => [x.record.id, x.action, x.due]), [['a', 'roll', '2026-10-15']]);
  });

  test('小月夾月底：1/31 每月 → 2/28；再翻一次沿用既有算法 → 3/28（Neil 接受漂移）', () => {
    const e = env();
    assert.equal(plan(e, [rem({ due_date: '2027-01-31', recur_interval: 1, recur_unit: '月' })], '2027-02-01')[0].due, '2027-02-28');
    assert.equal(plan(e, [rem({ due_date: '2027-02-28', recur_interval: 1, recur_unit: '月' })], '2027-03-01')[0].due, '2027-03-28');
  });

  test('擱置很久一次追到今天之後，不會一期一期慢慢翻', () => {
    const e = env();
    assert.equal(plan(e, [rem({ due_date: '2026-01-05', recur_interval: 1, recur_unit: '月' })])[0].due, '2026-11-05');
  });

  test('單次提醒：過期未滿 30 天不動（前端放「已過」）；滿 30 天 → archive', () => {
    const e = env();
    const out = plan(e, [
      rem({ id: 'x29', due_date: '2026-09-14' }),     // 29 天前
      rem({ id: 'x30', due_date: '2026-09-13' }),     // 30 天前
      rem({ id: 'x90', due_date: '2026-07-01' })
    ]);
    assert.deepEqual(out.map((x) => [x.record.id, x.action]), [['x30', 'archive'], ['x90', 'archive']]);
  });

  test('待辦（含空白 kind）、已刪、沒日期、週期壞掉的提醒：一律不動', () => {
    const e = env();
    const out = plan(e, [
      rem({ id: 't1', kind: 'todo', due_date: '2026-10-01', recur_interval: 1, recur_unit: '週' }),
      rem({ id: 't2', kind: '', due_date: '2026-01-01' }),
      rem({ id: 'd', del: 'TRUE', due_date: '2026-10-01', recur_interval: 1, recur_unit: '週' }),
      rem({ id: 'n', due_date: '' }),
      rem({ id: 'bad', due_date: '2026-10-01', recur_interval: 1, recur_unit: '秒' })
    ]);
    assert.deepEqual(out, []);
  });
});

/* ========================================================================== */
describe('9 點排程：先推播、再翻頁', () => {

  test('過期且沒推過的週期提醒：先推「已逾期」、再翻到下一期並清 notified', () => {
    const e = env({ tasks: [{ id: '1', text: '繳房租', line_id: ME, kind: 'reminder', due_date: '2026-10-05',
      recur_interval: 1, recur_unit: '月' }] });
    const r = e.call('checkDueReminders', TODAY);
    assert.equal(r.notified, 1);
    assert.match(e.pushes[0].text.altText, /繳房租[\s\S]*已逾期 8 天/);
    const t = byId(e, '1');
    assert.equal(t.due_date, '2026-11-05');
    assert.equal(t.notified, '', '翻頁後清掉，下一期進 3 天門檻會再推一次');
    assert.ok(logsOf(e).some((l) => /翻頁 1 筆/.test(l.result)), '紀錄寫出翻了幾筆');
  });

  test('已推過、昨天到期的週期提醒：今天不再推，只翻頁', () => {
    const e = env({ tasks: [{ id: '1', text: '倒垃圾', line_id: ME, kind: 'reminder', due_date: '2026-10-12',
      recur_interval: 1, recur_unit: '週', notified: 'TRUE' }] });
    e.call('checkDueReminders', TODAY);
    assert.equal(e.pushes.length, 0);
    assert.equal(byId(e, '1').due_date, '2026-10-19');
    assert.equal(byId(e, '1').notified, '');
  });

  test('單次提醒過期 31 天 → del；過期 3 天 → 原樣（只推一次，A-1）', () => {
    const e = env({ tasks: [
      { id: 'old', text: '舊的', line_id: ME, kind: 'reminder', due_date: '2026-09-12', notified: 'TRUE' },
      { id: 'new', text: '新的', line_id: ME, kind: 'reminder', due_date: '2026-10-10', notified: 'TRUE' }
    ] });
    e.call('checkDueReminders', TODAY);
    assert.equal(byId(e, 'old').del, 'TRUE');
    assert.equal(byId(e, 'new').del, '');
    assert.equal(byId(e, 'new').due_date, '2026-10-10');
    assert.equal(e.pushes.length, 0);
    assert.ok(logsOf(e).some((l) => /封存 1 筆/.test(l.result)));
  });

  test('週期待辦不歸排程管：過期也不翻（ADR-009：跟著完成走）', () => {
    const e = env({ tasks: [{ id: '1', text: '月報', line_id: ME, kind: 'todo', due_date: '2026-10-01',
      recur_interval: 1, recur_unit: '月', notified: 'TRUE' }] });
    e.call('checkDueReminders', TODAY);
    assert.equal(byId(e, '1').due_date, '2026-10-01');
  });

  test('推播失敗：不翻頁（不然那一期就安靜地被跳過了），明天再試', () => {
    const e = env({ tasks: [{ id: '1', text: '繳房租', line_id: ME, kind: 'reminder', due_date: '2026-10-05',
      recur_interval: 1, recur_unit: '月' }], pushImpl: () => ({ ok: false, code: 500, reason: 'boom' }) });
    e.call('checkDueReminders', TODAY);
    assert.equal(byId(e, '1').due_date, '2026-10-05');
    assert.equal(byId(e, '1').notified, '');
  });
});

/* ========================================================================== */
describe('初始化：補 kind 欄並歸類', () => {

  const OLD_H = TASK_H.filter((h) => h !== 'kind');

  test('有週期→提醒、其餘→待辦；回報「歸為提醒 N 筆」；再跑一次不變、不覆蓋手動改過的', () => {
    const e = env({ taskHeaders: OLD_H, tasks: [
      { id: '1', text: '繳費', recur_interval: 1, recur_unit: '月', due_date: '2026-10-20' },
      { id: '2', text: '買菜' },
      { id: '3', text: '舊週期但已刪', recur_interval: 1, recur_unit: '週', del: 'TRUE' }
    ] });
    const reply = textOf(say(e, ME, '初始化'));
    assert.ok(e.sheets.tasks.values[0].includes('kind'), '補上 kind 欄');
    assert.equal(byId(e, '1').kind, 'reminder');
    assert.equal(byId(e, '2').kind, 'todo');
    assert.match(reply, /歸為提醒 1 筆/, '已刪的不算');

    // 手動改成待辦的週期列，再跑初始化不會被改回提醒
    const rows = e.sheets.tasks.values;
    rows[1][rows[0].indexOf('kind')] = 'todo';
    const again = textOf(say(e, ME, '初始化'));
    assert.equal(byId(e, '1').kind, 'todo');
    assert.doesNotMatch(again, /待辦／提醒歸類/, '沒有新歸類的就不列在回覆（ADR-022 PR-0）');
    assert.match(e.transactions.filter((t) => t[2] === '初始化').pop()[4], /歸為提醒 0 筆/);
  });
});

/* ========================================================================== */
describe('提醒不能標完成（PWA）', () => {

  const REM = { id: '7', text: '繳房租', line_id: ME, kind: 'reminder', due_date: '2026-10-20', recur_interval: 1, recur_unit: '月' };

  test('upsert 帶 is_completed=TRUE：成功但完成被改回空白，留一筆 logs', () => {
    const e = env({ tasks: [REM] });
    const out = post(e, { sheet: 'tasks', action: 'upsert', key_field: 'id', record: Object.assign({}, REM, { is_completed: 'TRUE' }), trigger: 'write' });
    assert.equal(out.success, true, '不回錯誤：前端佇列不會卡住');
    assert.equal(byId(e, '7').is_completed, '');
    assert.ok(logsOf(e).some((l) => /提醒不能標完成/.test(l.result)));
  });

  test('舊版 App 送上來沒有 kind：保留雲端的 reminder，完成照樣被擋', () => {
    const e = env({ tasks: [REM] });
    const rec = Object.assign({}, REM, { is_completed: 'TRUE', text: '繳房租（改）' });
    delete rec.kind;
    post(e, { sheet: 'tasks', action: 'upsert', key_field: 'id', record: rec, trigger: 'write' });
    const t = byId(e, '7');
    assert.equal(t.kind, 'reminder');
    assert.equal(t.text, '繳房租（改）');
    assert.equal(t.is_completed, '');
  });

  test('待辦照常可以完成；PWA 也可以把待辦改成提醒（kind 有帶就照帶的）', () => {
    const e = env({ tasks: [{ id: '8', text: '買菜', line_id: ME, kind: 'todo' }] });
    post(e, { sheet: 'tasks', action: 'upsert', key_field: 'id', record: { id: '8', text: '買菜', line_id: ME, kind: 'todo', is_completed: 'TRUE' }, trigger: 'write' });
    assert.equal(byId(e, '8').is_completed, 'TRUE');
    post(e, { sheet: 'tasks', action: 'upsert', key_field: 'id', record: { id: '8', text: '買菜', line_id: ME, kind: 'reminder' }, trigger: 'write' });
    assert.equal(byId(e, '8').kind, 'reminder');
  });

  test('completeRecurring 只對待辦：提醒 → 拒絕、不生下一期', () => {
    const e = env({ tasks: [REM] });
    const out = post(e, { sheet: 'tasks', action: 'completeRecurring', key_field: 'id', record: Object.assign({}, REM, { is_completed: 'TRUE' }), next_id: '99', today: TODAY, trigger: 'write' });
    assert.equal(out.error, 'reminder_not_completable');
    assert.equal(tasksOf(e).length, 1);
    assert.equal(byId(e, '7').is_completed, '');
  });
});

/* ========================================================================== */
describe('LINE「提醒/內容」三段式', () => {

  test('建立 kind=reminder → 日期按鈕（沒有「不設日期」）→ 重複按鈕 → 每月', () => {
    const e = env();
    const first = say(e, ME, '提醒/繳房租');
    const row = tasksOf(e)[0];
    assert.equal(row.kind, 'reminder');
    assert.equal(row.text, '繳房租');
    assert.match(textOf(first), /🔔/);
    assert.ok(btn(first, /^\+7/), '日期按鈕沿用任務的 +1/+3/+7/+10/+30');
    assert.ok(!btn(first, /不設日期/), '提醒一定要有日期');

    const second = tap(e, ME, btn(first, /^\+7/).data);
    assert.equal(byId(e, row.id).due_date, '2026-10-20');
    assert.deepEqual(actionsOf(second).map((a) => a.label), ['不重複', '每週', '每月', '每年']);

    const third = tap(e, ME, btn(second, /^每月$/).data);
    assert.equal(byId(e, row.id).recur_interval, 1);
    assert.equal(byId(e, row.id).recur_unit, '月');
    assert.match(textOf(third), /每月/);
  });

  test('重複按鈕：同一組只生效一次；別人按不動', () => {
    const e = env();
    const first = say(e, ME, '提醒/繳房租', 'group');
    const second = tap(e, ME, btn(first, /^\+1/).data, 'group');
    const weekly = btn(second, /^每週$/).data;
    assert.match(textOf(tap(e, MOM, weekly, 'group')), /別人/);
    tap(e, ME, weekly, 'group');
    const id = tasksOf(e)[0].id;
    assert.equal(byId(e, id).recur_unit, '週');
    assert.match(textOf(tap(e, ME, btn(second, /^每年$/).data, 'group')), /已經設過/);
    assert.equal(byId(e, id).recur_unit, '週', '第二次按不會改掉');
    assert.equal(byId(e, id).origin_chat, GROUP, '推播路由沿用 origin_chat');
  });

  test('不重複：週期欄留白', () => {
    const e = env();
    const first = say(e, ME, '提醒/看牙醫');
    const second = tap(e, ME, btn(first, /^\+3/).data);
    tap(e, ME, btn(second, /^不重複$/).data);
    const t = tasksOf(e)[0];
    assert.equal(t.recur_unit, '');
    assert.equal(t.recur_interval, '');
  });

  test('✏️ 自己輸入日期之後，也接著問重複', () => {
    const e = env();
    const first = say(e, ME, '提醒/換濾心');
    tap(e, ME, btn(first, /自己輸入/).data);
    const reply = say(e, ME, '1101');
    assert.equal(tasksOf(e)[0].due_date, '2026-11-01');
    assert.ok(btn(reply, /^每年$/));
  });

  test('「任務/」照舊：kind=todo、有「不設日期」、設完日期不問重複', () => {
    const e = env();
    const first = say(e, ME, '任務/買菜');
    assert.equal(tasksOf(e)[0].kind, 'todo');
    assert.ok(btn(first, /不設日期/));
    const second = tap(e, ME, btn(first, /^\+1/).data);
    assert.equal(actionsOf(second).length, 0);
  });

  test('「提醒/」後面沒內容：回格式提示', () => {
    const e = env();
    assert.match(textOf(say(e, ME, '提醒/')), /提醒\/內容/);
    assert.equal(tasksOf(e).length, 0);
  });
});
