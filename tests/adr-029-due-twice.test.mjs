/**
 * ADR-029 — 到期提醒一天兩輪：07:00 主推＋16:00 補推（修訂 ADR-019 的「每天 9 點後第一輪」）
 *
 * 為什麼有這批測試：多一輪最怕的是「同一件事被推兩次」與「循環提醒被翻兩次」。
 * 盯的事（交棒頁驗收）：
 *   - 06:59 不跑；07:00 後跑第一輪；同一天 07:xx 再跑不重複；16:00 後跑第二輪；跨日重置
 *   - 排程延遲：07:00 那輪拖到 16:00 之後才跑 → 當天只跑一次，不連跑兩次
 *   - 07:00 推過的不再推；07:00 之後新增且到期的，16:00 會推（notified 規則不變，ADR-009）
 *   - 循環提醒一天只翻一次
 *   - ⏰ 明天：改到期日、清 notified → 隔天 07:00 那輪重推
 *   - 程式裡給人看的「9 點」都改成 07:00／16:00
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const FEATS = ['feat_tasks', 'feat_notes'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];
const TODAY = '2026-11-16';                     // 星期一
const taskRow = (o) => TASK_H.map((h) => (o[h] === undefined ? '' : o[h]));
/** 台北時間 → Date（台北＝UTC+8） */
const TPE = (day, h, m = 0) => new Date(Date.parse(day + 'T00:00:00Z') + (h - 8) * 3600000 + m * 60000);

function env(tasks = []) {
  return loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS), [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE']]),
      tasks: new FakeSheet('tasks', [TASK_H.slice()].concat(tasks.map(taskRow))),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }
  });
}
const tasksOf = (e) => e.sheets.tasks.toRecords();

/* ========================================================================== */
describe('排程時段（純函式 schedulerDue_）', () => {
  const e = env();
  const rule = e.read('schedulerJobs_().filter(function (j) { return j.name === "dueCheck"; })[0].rule');
  const due = (now, last) => e.call('schedulerDue_', rule, now.getTime(), last == null ? {} : { last: last.getTime() });

  test('登記成 07:00＋16:00 兩個時段（與 Gmail 同時段）', () => {
    assert.deepEqual(rule, { kind: 'daily_hours', hours: [7, 16] });
    assert.deepEqual(e.read('DUE_CHECK_HOURS'), e.read('GMAIL_CONTROLLER_HOURS'));
  });

  test('06:59 不跑；07:00 後跑；同一天 07:xx 不重複；16:00 後再跑；16:xx 不重複；跨日 07:00 又跑', () => {
    const yesterday = TPE('2026-11-15', 16, 5);
    assert.equal(due(TPE(TODAY, 6, 59), yesterday), false);
    assert.equal(due(TPE(TODAY, 7, 0), yesterday), true);
    assert.equal(due(TPE(TODAY, 7, 40), TPE(TODAY, 7, 5)), false);
    assert.equal(due(TPE(TODAY, 15, 59), TPE(TODAY, 7, 5)), false);
    assert.equal(due(TPE(TODAY, 16, 0), TPE(TODAY, 7, 5)), true);
    assert.equal(due(TPE(TODAY, 16, 30), TPE(TODAY, 16, 5)), false);
    assert.equal(due(TPE('2026-11-17', 7, 2), TPE(TODAY, 16, 5)), true);
  });

  test('排程延遲：07:00 那輪拖到 16:00 之後才跑 → 當天只跑一次', () => {
    const yesterday = TPE('2026-11-15', 16, 5);
    assert.equal(due(TPE(TODAY, 16, 10), yesterday), true);
    assert.equal(due(TPE(TODAY, 16, 15), TPE(TODAY, 16, 10)), false, '剛跑過就不連跑');
  });
});

/* ========================================================================== */
describe('不重複推、循環提醒一天只翻一次', () => {
  test('07:00 推過的，16:00 不再推；07:00 之後新增且今天到期的，16:00 會推', () => {
    const e = env([{ id: 'a', text: '早上就有的', line_id: ME, due_date: TODAY, kind: 'todo' }]);
    e.call('checkDueReminders', TODAY);
    assert.equal(e.pushes.length, 1);
    assert.match(JSON.stringify(e.pushes[0].text), /早上就有的/);
    e.sheets.tasks.values.push(taskRow({ id: 'b', text: '下午才加的', line_id: ME, due_date: TODAY, kind: 'todo' }));
    e.call('checkDueReminders', TODAY);
    assert.equal(e.pushes.length, 2);
    const second = JSON.stringify(e.pushes[1].text);
    assert.match(second, /下午才加的/);
    assert.doesNotMatch(second, /早上就有的/);
    e.call('checkDueReminders', TODAY);
    assert.equal(e.pushes.length, 2, '沒有新的就什麼都不推');
  });

  test('循環提醒：同一天跑兩輪只翻一次', () => {
    const e = env([{ id: 'r', text: '每週倒垃圾', line_id: ME, due_date: '2026-11-09', recur_interval: 1, recur_unit: '週', kind: 'reminder', notified: 'TRUE' }]);
    e.call('checkDueReminders', TODAY);
    const after1 = tasksOf(e)[0].due_date;
    e.call('checkDueReminders', TODAY);
    assert.equal(tasksOf(e)[0].due_date, after1, '第二輪不再翻');
    assert.equal(after1 >= TODAY, true);
  });

  test('⏰ 明天：到期日改成明天、清 notified → 今天 16:00 不推，明天 07:00 那輪推', () => {
    const tomorrow = '2026-11-17';
    const e = env([{ id: 'a', text: '延到明天的', line_id: ME, due_date: tomorrow, kind: 'todo', notified: '' }]);
    // 卡片按 ⏰ 明天之後：due_date＝明天、notified 清空（line-router.gs handleDueCardPostback_，規則不變）
    const before = e.pushes.length;
    e.call('checkDueReminders', tomorrow);
    assert.equal(e.pushes.length, before + 1, '明天那一輪推');
  });
});

/* ========================================================================== */
describe('給人看的時間：9 點都改成 07:00／16:00', () => {
  const src = ['apps-script/Code.gs', 'apps-script/line-router.gs', 'apps-script/scheduler.gs', 'index.html']
    .map((f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8')).join('\n');

  test('到期提醒相關的文字不再寫「9 點」', () => {
    const lines = src.split('\n').filter((l) => /9 點|九點/.test(l) && /到期|提醒|翻頁|封存|明天/.test(l));
    assert.deepEqual(lines, []);
  });

  test('排程登記表的說明寫兩個時段', () => {
    const e = env();
    assert.match(e.read('schedulerJobs_().filter(function (j) { return j.name === "dueCheck"; })[0].when'), /7、16 點/);
  });
});
