/**
 * ADR-009 §四 C5 — 到期檢查與通知的測試
 *
 * 這一批盯兩件容易在背景安靜出錯的事：
 *   1. 推失敗時**不可以**標記 notified——標了就等於這筆從此不再提醒，而使用者
 *      根本不知道有過這件事。寧可明天再推一次。
 *   2. 觸發器重複安裝不可以累積——三個同名觸發器就是一天推三次。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
/** 固定日期：綁死系統時鐘的測試會跟著真實日期漂，某天突然變紅而沒人改過東西 */
const TODAY = '2026-09-16';
const TASK_HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id',
                      'del', 'archive', 'board', 'due_date', 'recur_interval', 'recur_unit', 'notified'];

/** 只給需要的欄位，其餘留空 */
function taskRow(o) {
  return TASK_HEADERS.map((h) => (o[h] === undefined ? '' : o[h]));
}

function envWith(rows, opts = {}) {
  const sheet = new FakeSheet('tasks', [TASK_HEADERS.slice(), ...rows.map(taskRow)]);
  const env = loadCodeGs(Object.assign({ sheets: { tasks: sheet } }, opts));
  return { sheet, env };
}

/* ========================================================================== */
describe('dueRemindersToNotify_ — 挑出該推的那幾筆', () => {

  test('只挑跨進 3 天門檻、還沒推過、沒完成也沒刪的', () => {
    const { env } = envWith([]);
    const records = [
      { id: '1', text: '該推的', due_date: '2026-09-17', line_id: ME },
      { id: '2', text: '還早', due_date: '2026-09-30', line_id: ME },
      { id: '3', text: '推過了', due_date: '2026-09-17', line_id: ME, notified: 'TRUE' },
      { id: '4', text: '已完成', due_date: '2026-09-17', line_id: ME, is_completed: 'TRUE' },
      { id: '5', text: '已刪除', due_date: '2026-09-17', line_id: ME, del: 'TRUE' },
      { id: '6', text: '沒有到期日', line_id: ME },
      { id: '7', text: '逾期的', due_date: '2026-09-01', line_id: ME }
    ];

    const out = env.call('dueRemindersToNotify_', records, '2026-09-16');
    assert.deepEqual(out.map(r => r.id), ['1', '7'], '逾期的也要推——錯過了才更需要知道');
  });

  test('空輸入不會爆', () => {
    const { env } = envWith([]);
    assert.deepEqual(env.call('dueRemindersToNotify_', [], '2026-09-16'), []);
    assert.deepEqual(env.call('dueRemindersToNotify_', null, '2026-09-16'), []);
  });
});

/* ========================================================================== */
describe('dueReminderMessage_ — 通知內容', () => {

  test('寫清楚到期日與還剩幾天，不只說「快到了」', () => {
    const { env } = envWith([]);
    const msg = env.call('dueReminderMessage_', { text: '繳水費', due_date: '2026-09-18' }, '2026-09-16');
    assert.match(msg, /繳水費/);
    assert.match(msg, /2026-09-18/);
    assert.match(msg, /還剩 2 天/);
  });

  test('今天到期與已逾期講法不同', () => {
    const { env } = envWith([]);
    assert.match(env.call('dueReminderMessage_', { text: 'x', due_date: '2026-09-16' }, '2026-09-16'), /今天到期/);
    assert.match(env.call('dueReminderMessage_', { text: 'x', due_date: '2026-09-13' }, '2026-09-16'), /已逾期 3 天/);
  });
});

/* ========================================================================== */
describe('checkDueReminders — 背景跑的那一支', () => {

  test('推成功才標記 notified', () => {
    const { sheet, env } = envWith([
      { id: '1', text: '該推的', due_date: '2026-09-16', line_id: ME }
    ]);

    const out = env.call('checkDueReminders', TODAY);

    assert.equal(out.notified, 1);
    assert.equal(env.pushes.length, 1);
    assert.equal(env.pushes[0].to, ME, '通知送給該筆任務的 owner');
    assert.equal(sheet.toRecords()[0].notified, 'TRUE');
  });

  test('⚠️ 推失敗時不標記——否則這筆從此不再提醒，而使用者不知道', () => {
    const { sheet, env } = envWith(
      [{ id: '1', text: '該推的', due_date: '2026-09-16', line_id: ME }],
      { pushImpl: () => ({ ok: false, code: 429, reason: 'quota' }) }
    );

    const out = env.call('checkDueReminders', TODAY);

    assert.equal(out.notified, 0);
    assert.equal(sheet.toRecords()[0].notified, '', '寧可明天再推一次，也不要安靜地漏掉');
    assert.equal(out.matched, 1, '它確實符合門檻，只是沒推成');
  });

  test('推失敗會寫進 logs，不是只留在執行記錄裡', () => {
    const { env } = envWith(
      [{ id: '1', text: '該推的', due_date: '2026-09-16', line_id: ME }],
      { pushImpl: () => ({ ok: false, code: 0, reason: 'offline' }) }
    );

    env.call('checkDueReminders', TODAY);

    assert.equal(env.transactions.length, 1);
    assert.match(env.transactions[0][4], /1 筆推播失敗/);
  });

  test('標記 notified 走 upsert，不會多長一列', () => {
    const { sheet, env } = envWith([
      { id: '1', text: 'a', due_date: '2026-09-16', line_id: ME },
      { id: '2', text: 'b', due_date: '2026-09-16', line_id: ME }
    ]);

    env.call('checkDueReminders', TODAY);

    assert.equal(sheet.getLastRow(), 3, '兩筆資料＋表頭，標記不該讓表變長');
    assert.deepEqual(sheet.toRecords().map(r => r.notified), ['TRUE', 'TRUE']);
  });

  test('沒有 due_date 欄時只回報，不亂動資料', () => {
    const headers = ['id', 'text', 'line_id'];
    const sheet = new FakeSheet('tasks', [headers, ['1', '舊資料', ME]]);
    const env = loadCodeGs({ sheets: { tasks: sheet } });

    const out = env.call('checkDueReminders', TODAY);

    assert.equal(out.reason, 'no_due_date_column');
    assert.equal(env.pushes.length, 0);
    assert.ok(env.logs.some(l => l.includes('ensureAdr009Columns')), '要告訴人怎麼修');
  });

  test('分頁不存在或只有表頭都安靜收場', () => {
    const noSheet = loadCodeGs({ sheets: {} });
    assert.equal(noSheet.call('checkDueReminders', TODAY).notified, 0);

    const { env } = envWith([]);
    assert.equal(env.call('checkDueReminders', TODAY).notified, 0);
    assert.equal(env.pushes.length, 0);
  });

  test('沒有 owner 的那筆不會被推給別人', () => {
    const { env } = envWith([
      { id: '1', text: '沒有歸屬', due_date: '2026-09-16', line_id: '' }
    ]);
    env.call('checkDueReminders', TODAY);
    assert.equal(env.pushes.length, 0, '沒有收件人就沒有通知，硬推會推給錯的人');
  });
});

/* ========================================================================== */
describe('觸發器安裝（待其他環境知道的事 #5）', () => {

  test('建立一個每日觸發器', () => {
    const { env } = envWith([]);
    const out = env.call('installAdr009Triggers');

    assert.equal(env.triggers.length, 1);
    assert.equal(env.triggers[0].handler, 'checkDueReminders');
    assert.equal(env.triggers[0].days, 1);
    assert.equal(out.hour, 9, '到期提醒在半夜推沒有意義');
  });

  test('⚠️ 重複執行不會累積——三個同名觸發器就是一天推三次', () => {
    const { env } = envWith([]);
    env.call('installAdr009Triggers');
    env.call('installAdr009Triggers');
    const out = env.call('installAdr009Triggers');

    assert.equal(env.triggers.length, 1);
    assert.equal(out.removed, 1, '每次都先把同名的舊觸發器刪掉');
  });

  test('有乾淨的關法', () => {
    const { env } = envWith([]);
    env.call('installAdr009Triggers');
    const out = env.call('uninstallAdr009Triggers');

    assert.equal(out.removed, 1);
    assert.equal(env.triggers.length, 0);
  });

  test('沒有觸發器時移除也不會爆', () => {
    const { env } = envWith([]);
    assert.equal(env.call('uninstallAdr009Triggers').removed, 0);
  });
});
