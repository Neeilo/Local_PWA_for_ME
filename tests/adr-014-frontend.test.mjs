/**
 * ADR-014 PR-A — 前端：PWA 編輯到期日（T4）、origin_chat 原樣保留（T2）
 *
 * 盯的事：
 *   - 改了到期日就清 notified（延後之後要再提醒）；沒改到期日不清
 *   - 週期沒到期日擋下來；清除＝到期日與週期一起清
 *   - 打到一半被輪詢重畫不會被洗掉
 *   - origin_chat：App 原樣帶回；就算舊版 App 沒帶，雲端那格也不會被洗掉（端到端）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const TOK = 'tok-neil';

function withFields(e, values) {
  e.raw('__fields = ' + JSON.stringify(values));
  e.raw(`document.getElementById = function(id){
    const v = __fields[id];
    return { value: v === undefined ? '' : v, addEventListener(){}, dataset:{},
             classList:{add(){},remove(){},toggle(){},contains:()=>false},
             textContent:'', innerHTML:'', hidden:false,
             querySelectorAll:()=>[], querySelector:()=>null };
  }`);
}

function env(task) {
  const e = loadFrontend({});
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  e.raw('state.tasks = [' + JSON.stringify(task) + ']');
  return e;
}
const writes = (e) => e.calls.filter((c) => c.body && c.body.action);
const base = { id: 1, txt: '繳管理費', done: false, ts: 1, priority: 'M', line_id: ME,
  due: '2026-10-08', recurN: '', recurUnit: '', notified: true, origin_chat: 'Cfamily' };

/* ========================================================================== */
describe('T4 PWA 編輯到期日與週期', () => {

  test('改到期日 → 清 notified、送上新日期；origin_chat 原樣帶回', () => {
    const e = env(base);
    e.call('openTaskEdit', 1);
    withFields(e, { editTaskDue: '2026-10-20', editTaskRecurN: '', editTaskRecurUnit: '' });
    e.call('saveTaskEdit');
    const rec = writes(e)[0].body.record;
    assert.equal(rec.due_date, '2026-10-20');
    assert.equal(rec.notified, '', '延後之後要再提醒一次');
    assert.equal(rec.origin_chat, 'Cfamily');
    assert.equal(e.read('editingTaskId'), null);
  });

  test('只改週期、到期日沒動 → notified 不清（不然會重推一次）', () => {
    const e = env(base);
    e.call('openTaskEdit', 1);
    withFields(e, { editTaskDue: '2026-10-08', editTaskRecurN: '1', editTaskRecurUnit: '月' });
    e.call('saveTaskEdit');
    const rec = writes(e)[0].body.record;
    assert.equal(rec.notified, 'TRUE');
    assert.equal(rec.recur_unit, '月');
    assert.equal(rec.recur_interval, '1');
  });

  test('有週期沒到期日 → 擋下來，不送', () => {
    const e = env(Object.assign({}, base, { due: '' }));
    e.call('openTaskEdit', 1);
    withFields(e, { editTaskDue: '', editTaskRecurN: '1', editTaskRecurUnit: '週' });
    e.call('saveTaskEdit');
    assert.equal(writes(e).length, 0);
    assert.ok(e.toasts.some((t) => t.includes('要先有到期日')));
  });

  test('清除 → 到期日與週期一起清', () => {
    const e = env(Object.assign({}, base, { recurN: '1', recurUnit: '月' }));
    e.call('openTaskEdit', 1);
    withFields(e, { editTaskDue: '2026-10-08', editTaskRecurN: '1', editTaskRecurUnit: '月' });
    e.call('saveTaskEdit', true);
    const rec = writes(e)[0].body.record;
    assert.deepEqual([rec.due_date, rec.recur_interval, rec.recur_unit, rec.notified], ['', '', '', '']);
  });

  test('打到一半被輪詢重畫 → 編輯框保留剛打的值', () => {
    const e = env(base);
    e.call('openTaskEdit', 1);
    e.call('noteTaskEdit', 'due', '2026-12-25');
    const html = e.call('taskEditHtml', e.read('state.tasks[0]'));
    assert.match(html, /value="2026-12-25"/);
    e.call('openTaskEdit', 1);                       // 收起再打開＝重新開始
    e.call('openTaskEdit', 1);
    assert.match(e.call('taskEditHtml', e.read('state.tasks[0]')), /value="2026-10-08"/);
  });

  test('taskFromCloud → taskToCloud 一來一回，origin_chat 不掉', () => {
    const e = env(base);
    const t = e.call('taskFromCloud', { id: '5', text: 'x', origin_chat: ' Cfamily ' });
    assert.equal(t.origin_chat, 'Cfamily');
    assert.equal(e.call('taskToCloud', t).origin_chat, 'Cfamily');
  });

  test('系統設定的群組卡有「到期推群組」開關', () => {
    const e = env(base);
    const html = e.call('sysGroupsHtml', { rows: [{ group_id: 'C1', name: '家族', is_active: 'TRUE', notify_due: '' }] });
    assert.match(html, /setGroupFlag\(0,'notify_due'\)/);
  });
});

/* ========================================================================== */
describe('端到端：PWA 改群組任務，雲端的 origin_chat 不會被洗掉', () => {

  const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
    'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat'];
  const users = () => new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks'], [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE']]);

  for (const [label, record] of [
    ['舊版 App（沒有 origin_chat 這個鍵）', { id: '1', text: '改過', line_id: ME, due_date: '2026-10-20' }],
    ['有人亂帶別的群組', { id: '1', text: '改過', line_id: ME, due_date: '2026-10-20', origin_chat: 'Cother' }]
  ]) {
    test(label, () => {
      const tasks = new FakeSheet('tasks', [TASK_H, TASK_H.map((h) =>
        ({ id: '1', text: '原本', line_id: ME, due_date: '2026-10-08', origin_chat: 'Cfamily' })[h] ?? '')]);
      const g = loadCodeGs({ sheets: { tasks, line_users: users() }, tokens: { [TOK]: ME } });
      const out = JSON.parse(g.call('handlePwaSync_', { postData: { contents: JSON.stringify({
        token: TOK, sheet: 'tasks', action: 'upsert', key_field: 'id', record, trigger: 'write' }) } }).body);
      assert.equal(out.success, true);
      const row = tasks.toRecords()[0];
      assert.equal(row.text, '改過');
      assert.equal(row.origin_chat, 'Cfamily');
    });
  }

  test('週期任務完成：下一期也記著同一個群組', () => {
    const tasks = new FakeSheet('tasks', [TASK_H, TASK_H.map((h) =>
      ({ id: '1', text: '繳費', line_id: ME, due_date: '2026-10-08', recur_interval: '1', recur_unit: '月',
         origin_chat: 'Cfamily' })[h] ?? '')]);
    const g = loadCodeGs({ sheets: { tasks, line_users: users() }, tokens: { [TOK]: ME } });
    g.call('handlePwaSync_', { postData: { contents: JSON.stringify({
      token: TOK, sheet: 'tasks', action: 'completeRecurring', key_field: 'id', next_id: '2', today: '2026-10-08',
      record: { id: '1', text: '繳費', line_id: ME, due_date: '2026-10-08', recur_interval: '1', recur_unit: '月' },
      trigger: 'write' }) } });
    assert.deepEqual(tasks.toRecords().map((r) => r.origin_chat), ['Cfamily', 'Cfamily']);
  });
});
