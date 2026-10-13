/**
 * ADR-018 PR-B（A-2／A-3）— 待辦／提醒分家：前端
 *
 * 盯的事（為什麼）：
 *   - 任務頁分段「✅ 待辦｜🔔 提醒」：兩邊各列各的，提醒沒有勾選框（A-2）
 *   - 新增表單跟著分段走：選提醒才出現重複、提醒一定要有日期；待辦不帶週期
 *   - 提醒列顯示「下次 10/21（還剩 8 天）・每月」；單次提醒過期收進「已過」（A-3）
 *   - 提醒不能標完成：toggleTask 對提醒沒有作用（後端也擋，見 adr-018-reminders）
 *   - kind 原樣來回：雲端空白的（還沒跑初始化）不被 App 擅自寫成 todo；編輯可以改類型（歸錯的到 App 改）
 *   - 首頁「接下來要做的」只放待辦：那張卡有勾選框
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';

function stableDom(e, values = {}) {
  e.raw('__els = {}; __vals = ' + JSON.stringify(values));
  e.raw(`document.getElementById = function(id){
    if (!__els[id]) __els[id] = { id, value: __vals[id] === undefined ? '' : __vals[id], addEventListener(){}, dataset:{},
      classList:{add(){},remove(){},toggle(){},contains:()=>false}, style:{},
      textContent:'', innerHTML:'', hidden:false, disabled:false, open:false,
      querySelectorAll:()=>[], querySelector:()=>null, appendChild(){}, setAttribute(){} };
    return __els[id];
  }`);
}

function env(values) {
  const e = loadFrontend();
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  stableDom(e, values);
  return e;
}
async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
const writes = (e) => e.calls.filter((c) => c.body && c.body.action).map((c) => c.body);
const html = (e, id) => e.read('__els.' + id + '.innerHTML');

/** 本機的今天 ± n 天（前端 todayKey() 用的是真的時鐘） */
function dayKey(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const md = (key) => Number(key.slice(5, 7)) + '/' + Number(key.slice(8, 10));

function seed(e, tasks) {
  e.raw('state.tasks = ' + JSON.stringify(tasks.map((t, i) => Object.assign({
    id: i + 1, txt: 'x', done: false, ts: 1757000000000 + i, priority: 'M', line_id: ME, kind: 'todo', due: '', recurN: '', recurUnit: ''
  }, t))));
}

/* ========================================================================== */
describe('雲端 ↔ App：kind 原樣來回', () => {

  test('reminder／todo／空白（還沒跑初始化）都原樣帶回去', () => {
    const e = env();
    for (const kind of ['reminder', 'todo', '']) {
      const t = e.call('taskFromCloud', { id: '1', text: 'a', kind });
      assert.equal(e.call('taskToCloud', t).kind, kind);
    }
  });
});

/* ========================================================================== */
describe('分段與清單', () => {

  test('待辦分段只列待辦（空白 kind 算待辦）；提醒分段只列提醒、沒有勾選框', () => {
    const e = env();
    seed(e, [
      { txt: '買菜', kind: 'todo' },
      { txt: '舊資料', kind: '' },
      { txt: '繳房租', kind: 'reminder', due: dayKey(8), recurN: '1', recurUnit: '月' }
    ]);
    e.call('pickTaskSeg', 'todo');
    const todo = html(e, 'taskListOpen');
    assert.ok(todo.includes('買菜') && todo.includes('舊資料'));
    assert.ok(!todo.includes('繳房租'));

    e.call('pickTaskSeg', 'reminder');
    const rem = html(e, 'reminderList');
    assert.ok(rem.includes('繳房租'));
    assert.ok(!rem.includes('買菜'));
    assert.ok(!/type="checkbox"/.test(rem), '提醒沒有勾選框');
  });

  test('提醒列：「下次 M/D（還剩 N 天）・每月」；今天到期寫「今天」；依日期由近到遠', () => {
    const e = env();
    seed(e, [
      { txt: '換濾心', kind: 'reminder', due: dayKey(40) },
      { txt: '繳房租', kind: 'reminder', due: dayKey(8), recurN: '1', recurUnit: '月' },
      { txt: '倒垃圾', kind: 'reminder', due: dayKey(0), recurN: '2', recurUnit: '週' }
    ]);
    e.call('pickTaskSeg', 'reminder');
    const rem = html(e, 'reminderList');
    assert.ok(rem.includes('下次 ' + md(dayKey(8)) + '（還剩 8 天）・每月'), rem);
    assert.ok(rem.includes('今天') && rem.includes('每 2 週'), rem);
    assert.ok(rem.indexOf('倒垃圾') < rem.indexOf('繳房租') && rem.indexOf('繳房租') < rem.indexOf('換濾心'));
  });

  test('單次提醒過期 → 收進「已過」（附天數）；週期提醒過期（排程還沒翻）留在清單', () => {
    const e = env();
    seed(e, [
      { txt: '看牙醫', kind: 'reminder', due: dayKey(-3) },
      { txt: '倒垃圾', kind: 'reminder', due: dayKey(-1), recurN: '1', recurUnit: '週' }
    ]);
    e.call('pickTaskSeg', 'reminder');
    assert.ok(!html(e, 'reminderList').includes('看牙醫'));
    assert.ok(html(e, 'reminderList').includes('倒垃圾'));
    const past = html(e, 'reminderPast');
    assert.ok(past.includes('看牙醫') && past.includes('3 天前'), past);
    assert.equal(e.read('__els.reminderPastCard.hidden'), false);
    assert.equal(e.read('__els.reminderPastCount.textContent'), '1');
  });

  test('沒有已過的：「已過」整塊藏起來', () => {
    const e = env();
    seed(e, [{ txt: '繳房租', kind: 'reminder', due: dayKey(3) }]);
    e.call('pickTaskSeg', 'reminder');
    assert.equal(e.read('__els.reminderPastCard.hidden'), true);
  });

  test('切分段：兩組卡片互相藏起來；新增表單的提示字跟著換', () => {
    const e = env();
    e.call('pickTaskSeg', 'reminder');
    assert.equal(e.read('__els.taskTodoCards.hidden'), true);
    assert.equal(e.read('__els.taskReminderCards.hidden'), false);
    assert.equal(e.read('__els.newTaskRecur.hidden'), false, '選提醒才出現重複');
    assert.equal(e.read('__els.newTaskPrio.hidden'), true);
    assert.match(e.read('__els.taskInput.placeholder'), /提醒/);
    e.call('pickTaskSeg', 'todo');
    assert.equal(e.read('__els.taskTodoCards.hidden'), false);
    assert.equal(e.read('__els.newTaskRecur.hidden'), true);
  });
});

/* ========================================================================== */
describe('新增', () => {

  test('提醒：kind=reminder，日期與重複一起送', () => {
    const e = env({ taskInput: '繳房租', newTaskDue: '2026-10-20', newTaskRecurN: '1', newTaskRecurUnit: '月' });
    e.call('pickTaskSeg', 'reminder');
    e.call('addTask');
    const rec = writes(e)[0].record;
    assert.equal(rec.kind, 'reminder');
    assert.equal(rec.due_date, '2026-10-20');
    assert.equal(rec.recur_unit, '月');
  });

  test('提醒沒有日期：擋下來', () => {
    const e = env({ taskInput: '繳房租', newTaskDue: '' });
    e.call('pickTaskSeg', 'reminder');
    e.call('addTask');
    assert.equal(writes(e).length, 0);
    assert.ok(e.toasts.some((t) => /提醒要有日期/.test(t)));
  });

  test('待辦：kind=todo；重複欄位藏著，就算有殘值也不送週期', () => {
    const e = env({ taskInput: '買菜', newTaskDue: '2026-10-20', newTaskRecurN: '1', newTaskRecurUnit: '月' });
    e.call('pickTaskSeg', 'todo');
    e.call('addTask');
    const rec = writes(e)[0].record;
    assert.equal(rec.kind, 'todo');
    assert.equal(rec.due_date, '2026-10-20');
    assert.equal(rec.recur_unit, '');
    assert.equal(rec.recur_interval, '');
  });
});

/* ========================================================================== */
describe('提醒不能標完成；編輯可以改類型', () => {

  test('toggleTask 對提醒沒有作用、不送任何東西', () => {
    const e = env();
    seed(e, [{ txt: '繳房租', kind: 'reminder', due: dayKey(3), recurN: '1', recurUnit: '月' }]);
    e.call('toggleTask', 1);
    assert.equal(e.read('state.tasks[0].done'), false);
    assert.equal(writes(e).length, 0);
  });

  test('編輯：待辦改成提醒（沒有日期就擋）；提醒改回待辦', async () => {
    const e = env({ editTaskKind: 'reminder', editTaskDue: '' });
    seed(e, [{ txt: '繳房租', kind: '' }]);
    e.call('openTaskEdit', 1);
    e.call('saveTaskEdit');
    assert.equal(writes(e).length, 0);
    assert.ok(e.toasts.some((t) => /提醒要有日期/.test(t)));

    e.raw('__els.editTaskDue.value = "2026-10-20"');
    e.call('saveTaskEdit');
    assert.equal(writes(e)[0].record.kind, 'reminder');
    assert.equal(e.read('state.tasks[0].done'), false);

    e.call('openTaskEdit', 1);
    e.raw('__els.editTaskKind.value = "todo"');
    e.call('saveTaskEdit');
    await settle();                      // 待送佇列一次送一筆，第二筆等第一筆回來才送
    assert.equal(writes(e)[1].record.kind, 'todo');
  });
});

/* ========================================================================== */
describe('首頁', () => {

  test('深入卡：待辦頁有勾選框、只放待辦；提醒頁沒有勾選框（ADR-018 C-1 起取代「接下來要做的」）', () => {
    const e = env();
    seed(e, [{ txt: '買菜', kind: 'todo' }, { txt: '繳房租', kind: 'reminder', due: dayKey(1) }]);
    e.call('renderDeep');
    const todo = html(e, 'deepTodo'), rem = html(e, 'deepReminder');
    assert.ok(todo.includes('買菜') && !todo.includes('繳房租'));
    assert.ok(/type="checkbox"/.test(todo));
    assert.ok(rem.includes('繳房租') && !/type="checkbox"/.test(rem));
  });
});
