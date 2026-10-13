/**
 * ADR-009 §三／§四 — 共用白板與到期門檻（ADR-018 起儀表板的「快到期了」分組由「最急兩件」取代）
 *
 * 這一批多了一項別的測試都沒有的東西：**同時載入前後端兩份原始碼，比對到期門檻
 * 是否一致**。門檻在 Apps Script 與瀏覽器各有一份實作（沒有辦法共用），所以改用
 * 測試把兩邊釘在一起——有人改了一邊沒改另一邊就會紅燈。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs } from './fake-apps-script.mjs';

const ME = 'Uneil';
const TODAY = '2026-09-16';

function env() {
  const e = loadFrontend();
  e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
  e.raw('state = EMPTY_STATE()');
  return e;
}

const writes = (e) => e.calls.filter(c => c.body && c.body.action);

/* ========================================================================== */
describe('⚠️ 前後端的到期門檻不可以各走各的', () => {

  // ADR-018：首頁「快到期了」分組退場，改成「最急兩件」（已逾期或 3 天內）。
  // 它跟後端推播的門檻（跨進 3 天內才推）講的是同一件事，所以仍然釘在一起
  test('首頁「最急」的天數＝後端推播的 3 天門檻', () => {
    const back = loadCodeGs().read('DUE_THRESHOLDS').find(t => t.key === 'd3').maxDays;
    assert.equal(env().read('URGENT_DAYS'), back,
      '門檻在兩邊各有一份實作，沒有辦法共用——所以用這一項把它們釘在一起');
  });

  test('天數算法一致：前端 daysUntilUI 與後端 daysUntil_', () => {
    const back = loadCodeGs();
    const front = env();
    const dates = ['2026-09-10', '2026-09-16', '2026-09-17', '2026-09-19', '2026-09-20', '2026-10-16'];
    dates.forEach((d) => {
      assert.equal(front.call('daysUntilUI', d, TODAY), back.call('daysUntil_', d, TODAY), d + ' 的天數在前後端不一致');
    });
  });
});

/* ========================================================================== */
describe('共用白板', () => {

  test('三種來源釘起來的東西都會出現，各自標來源', () => {
    const e = env();
    e.raw('state.tasks    = [{id:1, txt:"買菜", ts:30, board:true, line_id:"' + ME + '"}]');
    e.raw('state.notes    = [{id:2, txt:"靈感", ts:20, board:true, line_id:"Ufamily"}]');
    e.raw('state.expenses = [{id:3, date:"2026-09-16", category:"食", amount:120, ts:10, board:true, line_id:"' + ME + '"}]');

    const items = e.call('boardItems');
    assert.deepEqual(items.map(i => i.kind), ['tasks', 'notes', 'expenses'], '新的在上面');
    assert.equal(items.length, 3);
  });

  test('⚠️ 白板不套「只看我的」——看不到別人釘的東西就失去意義了', () => {
    const e = env();
    e.raw('scopeMine = true');
    e.raw('state.notes = [{id:2, txt:"家人釘的", ts:20, board:true, line_id:"Ufamily"}]');

    assert.equal(e.call('boardItems').length, 1, '這是共用白板，不是我的白板');
  });

  test('沒釘的東西不會出現', () => {
    const e = env();
    e.raw('state.tasks = [{id:1, txt:"沒釘的", ts:1, line_id:"' + ME + '"}]');
    assert.deepEqual(e.call('boardItems'), []);
  });

  test('釘選會送上雲端，不只是本機的裝飾', () => {
    const e = env();
    e.raw('state.notes = [{id:2, txt:"靈感", ts:20, line_id:"' + ME + '"}]');

    e.call('toggleBoard', 'notes', 2);

    const w = writes(e);
    assert.equal(w.length, 1);
    assert.equal(w[0].body.sheet, 'notes');
    assert.equal(w[0].body.record.board, 'TRUE');
  });

  test('再按一次就取下來', () => {
    const e = env();
    e.raw('state.notes = [{id:2, txt:"靈感", ts:20, board:true, line_id:"' + ME + '"}]');

    e.call('toggleBoard', 'notes', 2);

    assert.equal(writes(e)[0].body.record.board, '');
    assert.equal(e.call('boardItems').length, 0);
  });

  test('釘不存在的東西不會爆', () => {
    const e = env();
    e.call('toggleBoard', 'notes', 999);
    assert.equal(writes(e).length, 0);
  });
});

