/**
 * ADR-009 §四 — 週期任務完成後接手下一期
 *
 * 主題是一個 ADR 沒寫、但不處理就會出事的地方：**重複打勾會不會生出兩列。**
 *
 * 解法不需要新欄位：生出下一期的同時把週期設定搬到新的那一列、從原列清掉。
 * 原列從此不是週期任務，再怎麼打勾都不會再生。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const SECRET = 'test-cloud-secret';
const ME = 'Uneil';
const TODAY = '2026-09-16';

const HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id',
                 'del', 'archive', 'board', 'due_date', 'recur_interval', 'recur_unit', 'notified'];

function row(o) { return HEADERS.map(h => (o[h] === undefined ? '' : o[h])); }

function env(rows) {
  const tasks = new FakeSheet('tasks', [HEADERS.slice(), ...rows.map(row)]);
  const users = new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'],
    [ME, 'Neil', 'TRUE', 'TRUE']
  ]);
  const e = loadCodeGs({ sheets: { tasks, line_users: users }, properties: { CLOUD_SECRET: SECRET } });
  return { tasks, e };
}

function complete(e, record, nextId) {
  const body = {
    secret: SECRET, line_id: ME, sheet: 'tasks', action: 'completeRecurring',
    record, key_field: 'id', today: TODAY, next_id: nextId
  };
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}

/* ========================================================================== */
describe('完成一期，接手下一期', () => {

  const monthly = {
    id: '1', text: '繳水費', line_id: ME, priority: 'M',
    due_date: '2026-09-05', recur_interval: '1', recur_unit: '月'
  };

  test('原列標完成，另外長出下一期', () => {
    const { tasks, e } = env([monthly]);

    const out = complete(e, monthly, '2');

    assert.equal(out.spawned, true);
    assert.equal(out.next_due, '2026-10-05', '以原訂到期日推算，不是完成當下');

    const recs = tasks.toRecords();
    assert.equal(recs.length, 2);
    assert.equal(recs[0].is_completed, 'TRUE');
    assert.equal(recs[1].due_date, '2026-10-05');
    assert.equal(recs[1].is_completed, '', '新的一期當然還沒完成');
    assert.equal(recs[1].text, '繳水費', '內容跟著接手');
  });

  test('⚠️ 週期設定搬到新列，原列不再是週期任務', () => {
    const { tasks, e } = env([monthly]);
    complete(e, monthly, '2');

    const recs = tasks.toRecords();
    assert.equal(recs[0].recur_interval, '', '原列交出週期');
    assert.equal(recs[0].recur_unit, '');
    assert.equal(recs[1].recur_interval, '1', '週期跟著「還沒做的那一期」走');
    assert.equal(recs[1].recur_unit, '月');
  });

  test('⚠️ 取消打勾再重新打勾，不會再生出一列', () => {
    const { tasks, e } = env([monthly]);
    complete(e, monthly, '2');

    // 使用者取消打勾又重新打勾：送上來的是原列此刻的樣子（週期已經交出去了）
    const afterFirst = tasks.toRecords()[0];
    const out = complete(e, afterFirst, '3');

    assert.equal(out.spawned, false, '原列已經不是週期任務了');
    assert.equal(out.reason, 'not_recurring');
    assert.equal(tasks.toRecords().length, 2, '還是兩列，沒有第三列');
  });

  test('新的一期 notified 為空，所以到期時會照常通知', () => {
    const { tasks, e } = env([Object.assign({}, monthly, { notified: 'TRUE' })]);
    complete(e, monthly, '2');

    assert.equal(tasks.toRecords()[1].notified, '', '不需要任何重置邏輯');
  });

  test('新的一期不帶 del，就算原列是墓碑也一樣', () => {
    const { tasks, e } = env([Object.assign({}, monthly, { del: 'TRUE' })]);
    complete(e, Object.assign({}, monthly, { del: 'TRUE' }), '2');

    assert.equal(tasks.toRecords()[1].del, '', '下一期是新的一件事，不繼承刪除狀態');
  });

  test('擱置很久的週期任務只生出一期，不是一串過期的', () => {
    const stale = Object.assign({}, monthly, { due_date: '2026-01-05' });
    const { tasks, e } = env([stale]);

    const out = complete(e, stale, '2');

    assert.equal(out.next_due, '2026-10-05');
    assert.equal(tasks.toRecords().length, 2);
  });
});

/* ========================================================================== */
describe('不是週期任務的情況', () => {

  test('沒設週期就是一般完成，不硬生下一期', () => {
    const plain = { id: '1', text: '一次性的', line_id: ME, due_date: '2026-09-16' };
    const { tasks, e } = env([plain]);

    const out = complete(e, Object.assign({}, plain, { is_completed: 'TRUE' }), '2');

    assert.equal(out.spawned, false);
    assert.equal(tasks.toRecords().length, 1);
    assert.equal(tasks.toRecords()[0].is_completed, 'TRUE');
  });

  test('週期單位不認得也不硬生（刻意不開放小時）', () => {
    const hourly = { id: '1', text: 'x', line_id: ME, due_date: '2026-09-16', recur_interval: '1', recur_unit: '小時' };
    const { tasks, e } = env([hourly]);

    assert.equal(complete(e, hourly, '2').spawned, false);
    assert.equal(tasks.toRecords().length, 1);
  });

  test('走的是同一套閘門：不在白名單的人做不了這件事', () => {
    const { tasks, e } = env([{ id: '1', text: 'x', line_id: ME, due_date: '2026-09-16', recur_interval: '1', recur_unit: '月' }]);

    const body = {
      secret: SECRET, line_id: 'Ustranger', sheet: 'tasks', action: 'completeRecurring',
      record: { id: '1' }, key_field: 'id', today: TODAY
    };
    const out = JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);

    assert.equal(out.error, 'not_on_whitelist');
    assert.equal(tasks.toRecords().length, 1);
  });
});
