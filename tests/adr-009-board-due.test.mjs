/**
 * ADR-009 §三／§四 — 共用白板與儀表板到期區塊
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

  test('兩份原始碼裡的門檻數字必須一致', () => {
    const back = loadCodeGs().read('DUE_THRESHOLDS').map(t => t.maxDays);
    const front = env().read('DUE_THRESHOLDS_UI').map(t => t.max);

    assert.deepEqual(front, back,
      '門檻在兩邊各有一份實作，沒有辦法共用——所以用這一項把它們釘在一起');
  });

  test('分類結果也必須一致，不只是數字長得一樣', () => {
    const back = loadCodeGs();
    const front = env();
    const dates = ['2026-09-10', '2026-09-16', '2026-09-17', '2026-09-18',
                   '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-10-16'];

    dates.forEach((d) => {
      assert.equal(front.call('dueBucketUI', d, TODAY), back.call('dueBucket_', d, TODAY),
        d + ' 的分類在前後端不一致');
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

/* ========================================================================== */
describe('到期區塊', () => {

  function tasks(list) {
    return list.map((o, i) => Object.assign({ id: i + 1, txt: 't' + i, ts: i, line_id: ME }, o));
  }

  test('⚠️ 已逾期獨立一塊，而且排最前面', () => {
    const e = env();
    const g = e.call('dueGroups', tasks([
      { due: '2026-09-22' },     // later
      { due: '2026-09-10' },     // overdue
      { due: '2026-09-17' }      // d1
    ]), TODAY);

    assert.deepEqual(g.map(x => x.key), ['overdue', 'd1', 'later'],
      '最急的東西放最下面沒有道理');
    assert.equal(g[0].label, '已逾期');
  });

  test('空的區塊不會佔版面', () => {
    const e = env();
    const g = e.call('dueGroups', tasks([{ due: '2026-09-17' }]), TODAY);
    assert.deepEqual(g.map(x => x.key), ['d1']);
  });

  test('已完成、已刪除、沒到期日的都不列入', () => {
    const e = env();
    const g = e.call('dueGroups', tasks([
      { due: '2026-09-17', done: true },
      { due: '2026-09-17', del: true },
      { due: '' },
      { due: '2026-09-17' }
    ]), TODAY);

    assert.equal(g.length, 1);
    assert.equal(g[0].items.length, 1);
  });

  test('四塊門檻切得對，第 6 天落在「更久以後」', () => {
    const e = env();
    const g = e.call('dueGroups', tasks([
      { due: '2026-09-17' }, { due: '2026-09-19' },
      { due: '2026-09-21' }, { due: '2026-09-22' }
    ]), TODAY);

    assert.deepEqual(g.map(x => x.key), ['d1', 'd3', 'd5', 'later']);
  });

  test('空清單不會爆', () => {
    const e = env();
    assert.deepEqual(e.call('dueGroups', [], TODAY), []);
    assert.deepEqual(e.call('dueGroups', null, TODAY), []);
  });
});
