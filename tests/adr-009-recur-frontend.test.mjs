/**
 * ADR-009 §四 — 前端的週期欄位與打勾流程
 *
 * 重點是「下一期的日期算法只留在後端一份」這條界線有沒有守住：前端打勾時
 * 走 completeRecurring 把判斷交給後端，自己不重算日期。兩份實作遲早漂移，
 * 而漂移的那天沒有人會收到通知——它只會安靜地算錯日期。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';

/** 讓 getElementById 依 id 回傳可控的值 */
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

function env(fetchImpl) {
  const e = loadFrontend(fetchImpl ? { fetchImpl } : {});
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  return e;
}

const writes = (e) => e.calls.filter(c => c.body && c.body.action);

/* ========================================================================== */
describe('新增週期任務', () => {

  test('到期日與週期一起送上去', () => {
    const e = env();
    withFields(e, { taskInput: '繳水費', newTaskDue: '2026-10-05', newTaskRecurN: '1', newTaskRecurUnit: '月' });

    e.call('addTask');

    const w = writes(e);
    assert.equal(w.length, 1);
    assert.equal(w[0].body.record.due_date, '2026-10-05');
    assert.equal(w[0].body.record.recur_interval, '1');
    assert.equal(w[0].body.record.recur_unit, '月');
  });

  test('只填週期沒填到期日就擋下來——週期無從算起', () => {
    const e = env();
    withFields(e, { taskInput: '繳水費', newTaskDue: '', newTaskRecurN: '1', newTaskRecurUnit: '月' });

    e.call('addTask');

    assert.equal(writes(e).length, 0, '安靜忽略比擋下來更糟');
    assert.ok(e.toasts.some(t => t.includes('要先有到期日')));
    assert.equal(e.read('state.tasks.length'), 0);
  });

  test('沒選單位時週期欄位留空，不會被塞預設值', () => {
    const e = env();
    withFields(e, { taskInput: '一次性的', newTaskDue: '2026-10-05', newTaskRecurN: '3', newTaskRecurUnit: '' });

    e.call('addTask');

    const rec = writes(e)[0].body.record;
    assert.equal(rec.due_date, '2026-10-05', '只有到期日、沒有週期，是合理的組合');
    assert.equal(rec.recur_interval, '');
    assert.equal(rec.recur_unit, '');
  });

  test('選了單位沒填數字就當 1', () => {
    const e = env();
    withFields(e, { taskInput: 'x', newTaskDue: '2026-10-05', newTaskRecurN: '', newTaskRecurUnit: '週' });

    e.call('addTask');

    assert.equal(writes(e)[0].body.record.recur_interval, '1');
  });
});

/* ========================================================================== */
describe('打勾：週期任務走後端，前端不重算日期', () => {

  function seeded(e, extra) {
    e.raw('state.tasks = [' + JSON.stringify(Object.assign({
      id: 1, txt: '繳水費', done: false, ts: 1757000000000, priority: 'M', line_id: ME,
      due: '2026-10-05', recurN: '1', recurUnit: '月'
    }, extra)) + ']');
  }

  test('週期任務打勾 → completeRecurring', () => {
    const e = env();
    seeded(e);

    e.call('toggleTask', 1);

    const w = writes(e);
    assert.equal(w.length, 1);
    assert.equal(w[0].body.action, 'completeRecurring',
      '下一期的日期算法只留在後端一份，前端不重算');
    assert.equal(w[0].body.record.id, '1');
    assert.ok(w[0].body.next_id, '新列的 id 由前端給，沿用全站 Date.now() 慣例');
  });

  test('一般任務打勾 → 普通 upsert', () => {
    const e = env();
    seeded(e, { due: '', recurN: '', recurUnit: '' });

    e.call('toggleTask', 1);

    assert.equal(writes(e)[0].body.action, 'upsert');
  });

  test('取消打勾不會觸發接手下一期', () => {
    const e = env();
    seeded(e, { done: true });

    e.call('toggleTask', 1);          // 從已完成改回未完成

    assert.equal(writes(e)[0].body.action, 'upsert', '取消完成不是「完成一期」');
  });

  test('只有到期日、沒有週期的任務打勾也走普通 upsert', () => {
    const e = env();
    seeded(e, { recurN: '', recurUnit: '' });

    e.call('toggleTask', 1);

    assert.equal(writes(e)[0].body.action, 'upsert');
  });

  test('後端失敗時退回普通送出，至少「完成」不會掉', async () => {
    const e = env(({ body }) => {
      if (body && body.action === 'completeRecurring') {
        return { json: () => Promise.resolve({ error: 'boom' }) };
      }
      return { json: () => Promise.resolve({ success: true, data: [] }) };
    });
    e.raw('state.tasks = [{id:1, txt:"x", done:false, ts:1, priority:"M", line_id:"' + ME +
      '", due:"2026-10-05", recurN:"1", recurUnit:"月"}]');

    e.call('toggleTask', 1);
    for (let i = 0; i < 20 && writes(e).length < 2; i++) await new Promise(r => setImmediate(r));

    const actions = writes(e).map(c => c.body.action);
    assert.ok(actions.includes('completeRecurring'));
    assert.ok(actions.includes('upsert'), '主要的事實（這一期完成了）不能因為接手失敗而遺失');
  });
});
