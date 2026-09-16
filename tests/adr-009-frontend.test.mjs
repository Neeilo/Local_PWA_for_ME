/**
 * ADR-009 Phase 2-c — 前端寫入路徑的測試
 *
 * 測的是 index.html 裡真正會跑的那些函式（見 fake-browser.mjs），不是副本。
 *
 * 這一批的重點只有一件事：整包 replaceAll 退場之後，每一次改動有沒有正確地
 * 只送自己那一筆、送不出去的時候有沒有留住、以及刪除有沒有變成**送得出去的**
 * 刪除（硬刪除是送不出去的，那正是刪掉的東西會自己回來的原因）。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';

/** 建好一個「已選身份、雲端會成功」的環境 */
function env(opts = {}) {
  const e = loadFrontend(opts);
  e.set('myLineId', ME);
  e.raw('myLineId = "' + ME + '"');
  e.raw('localOnly = false');
  e.raw('outbox = []');
  return e;
}

/** 取出所有送到雲端的寫入請求 */
function writes(e) {
  return e.calls.filter(c => c.body && c.body.action);
}

/**
 * 等佇列送完。
 *
 * 佇列刻意一次只送一筆、送成了才送下一筆（同一張 Sheet 併發寫入正是這次要根治
 * 的那類問題），所以連續四次刪除在同步的那一瞬間只看得到第一筆送出去。要斷言
 * 全部送完，就得把 microtask 跑完。
 */
async function drain(e, max = 50) {
  for (let i = 0; i < max && e.call('pendingCount') > 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/* ========================================================================== */
describe('待送佇列的三條規則', () => {

  test('同一張表同一個鍵只排一筆——連按五次不該送五次', () => {
    const e = env();
    const job = (text, seq) => ({ sheet: 'tasks', key_field: 'id', seq, record: { id: '1', text } });

    let list = [];
    list = e.call('outboxAdd', list, job('第一次', 1));
    list = e.call('outboxAdd', list, job('第二次', 2));
    list = e.call('outboxAdd', list, job('第三次', 3));

    assert.equal(list.length, 1, '同鍵只留一筆');
    assert.equal(list[0].record.text, '第三次', '最後一次編輯才是真相');
  });

  test('不同鍵、不同表各自排隊，順序保持', () => {
    const e = env();
    let list = [];
    list = e.call('outboxAdd', list, { sheet: 'tasks', key_field: 'id', seq: 1, record: { id: '1' } });
    list = e.call('outboxAdd', list, { sheet: 'tasks', key_field: 'id', seq: 2, record: { id: '2' } });
    list = e.call('outboxAdd', list, { sheet: 'notes', key_field: 'id', seq: 3, record: { id: '1' } });

    assert.equal(list.length, 3, '同 id 但不同表是兩件事');
    assert.deepEqual(list.map(j => j.seq), [1, 2, 3]);
  });

  test('⚠️ 送出期間又被改過的那一筆不能被連坐刪掉', () => {
    const e = env();
    const sent = { sheet: 'tasks', key_field: 'id', seq: 1, record: { id: '1', text: '舊的' } };
    const newer = { sheet: 'tasks', key_field: 'id', seq: 2, record: { id: '1', text: '新的' } };

    let list = e.call('outboxAdd', [], sent);
    list = e.call('outboxAdd', list, newer);          // 送出去的期間使用者又改了
    const after = e.call('outboxRemove', list, sent); // 舊的那次回報成功

    assert.equal(after.length, 1, '新的那筆還沒送，不能跟著被移除');
    assert.equal(after[0].record.text, '新的');
  });

  test('複合鍵的 reviews 認得出同一筆與不同人', () => {
    const e = env();
    const mk = (line_id, seq) => ({
      sheet: 'reviews', key_field: ['review_date', 'line_id'], seq,
      record: { review_date: '2026-09-16', line_id, good: 'x' }
    });
    let list = e.call('outboxAdd', [], mk(ME, 1));
    list = e.call('outboxAdd', list, mk('Ufamily', 2));
    assert.equal(list.length, 2, '同一天不同人是兩筆');

    list = e.call('outboxAdd', list, mk(ME, 3));
    assert.equal(list.length, 2, '同一天同一人是同一筆');
  });
});

/* ========================================================================== */
describe('每一次改動只送自己那一筆', () => {

  test('新增任務只送一筆 upsert，不是整張表', () => {
    const e = env();
    e.raw('state = EMPTY_STATE()');
    e.raw('document.getElementById = () => ({ value:"買菜", addEventListener(){}, classList:{add(){},remove(){},toggle(){}}, dataset:{}, textContent:"", innerHTML:"" })');

    e.call('addTask');

    const w = writes(e);
    assert.equal(w.length, 1, '一次新增就該只有一次寫入');
    assert.equal(w[0].body.action, 'upsert');
    assert.equal(w[0].body.sheet, 'tasks');
    assert.equal(w[0].body.record.text, '買菜');
    assert.equal(w[0].body.line_id, ME, 'line_id 要一起送，後端靠它查白名單');
  });

  test('沒有任何一次寫入是 replaceAll', () => {
    const e = env();
    e.raw('state = EMPTY_STATE()');
    e.raw('document.getElementById = () => ({ value:"測試", addEventListener(){}, classList:{add(){},remove(){},toggle(){}}, dataset:{}, textContent:"", innerHTML:"" })');

    e.call('addTask');
    e.call('addNote');

    assert.equal(writes(e).filter(c => c.body.action === 'replaceAll').length, 0,
      'replaceAll 是 DATA-01 的根因，這次要讓它徹底退場');
  });
});

/* ========================================================================== */
describe('刪除變成「送得出去的刪除」', () => {

  function seededTask(e) {
    e.raw('state = EMPTY_STATE()');
    e.raw('state.tasks = [{id:1, txt:"要刪的", done:false, ts:1757000000000, priority:"M", line_id:"' + ME + '"}]');
  }

  test('刪除送的是 del=TRUE 的 upsert，不是消失', () => {
    const e = env();
    seededTask(e);

    e.call('delTask', 1);

    const w = writes(e);
    assert.equal(w.length, 1);
    assert.equal(w[0].body.action, 'upsert');
    assert.equal(w[0].body.record.del, 'TRUE',
      '硬刪除送不出去——其他裝置的快照裡它還在，下次同步又會長回來');
    assert.equal(w[0].body.record.id, '1');
  });

  test('本機列表同時移除，畫面不會留著已刪的東西', () => {
    const e = env();
    seededTask(e);
    e.call('delTask', 1);
    assert.equal(e.read('state.tasks.length'), 0);
  });

  test('刪不存在的 id 不會爆、也不會亂送東西', () => {
    const e = env();
    seededTask(e);
    e.call('delTask', 999);
    assert.equal(writes(e).length, 0);
    assert.equal(e.read('state.tasks.length'), 1);
  });

  test('四個模組的刪除都改成軟刪除', async () => {
    const e = env();
    e.raw('state = EMPTY_STATE()');
    e.raw('state.tasks    = [{id:1, txt:"t", ts:1, priority:"M", line_id:"' + ME + '"}]');
    e.raw('state.moods    = [{id:2, level:3, note:"m", ts:1, line_id:"' + ME + '"}]');
    e.raw('state.notes    = [{id:3, txt:"n", ts:1, line_id:"' + ME + '"}]');
    e.raw('state.expenses = [{id:4, date:"2026-09-16", type:"expense", category:"其他", amount:1, note:"", ts:1, line_id:"' + ME + '"}]');

    e.call('delTask', 1); e.call('delMood', 2); e.call('delNote', 3); e.call('delExpense', 4);
    await drain(e);

    const w = writes(e);
    assert.equal(w.length, 4);
    assert.deepEqual(w.map(c => c.body.sheet), ['tasks', 'moods', 'notes', 'expenses']);
    w.forEach(c => assert.equal(c.body.record.del, 'TRUE', c.body.sheet + ' 沒有走軟刪除'));
  });
});

/* ========================================================================== */
describe('送不出去的時候', () => {

  test('雲端失敗時那一筆留在佇列裡，不會就這樣消失', async () => {
    const e = loadFrontend({ fetchImpl: () => ({ json: () => Promise.resolve({ error: 'offline' }) }) });
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');

    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: '在捷運上打的' }, 'id');

    assert.equal(e.call('pendingCount'), 1, '沒送成就要留著，回到地面才補得回去');
  });

  test('成功之後才從佇列移除', async () => {
    const e = loadFrontend();
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');

    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: 'ok' }, 'id');

    assert.equal(e.call('pendingCount'), 0);
  });

  test('佇列寫進 localStorage，關掉 App 也還在', async () => {
    const e = loadFrontend({ fetchImpl: () => ({ json: () => Promise.resolve({ error: 'offline' }) }) });
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');

    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: '沒送成的' }, 'id');

    const saved = JSON.parse(e.localStorage.getItem('personal-os-outbox-v1'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].record.text, '沒送成的');
  });

  test('還沒選身份就只排不送——logs 不該被一整排「被拒絕」淹掉', async () => {
    const e = loadFrontend();
    e.raw('myLineId = ""; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');

    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: '還沒選身份' }, 'id');

    assert.equal(writes(e).length, 0, '沒有身份就不該發出請求');
    assert.equal(e.call('pendingCount'), 1, '但東西要留著，選完身份會補送');
  });
});
