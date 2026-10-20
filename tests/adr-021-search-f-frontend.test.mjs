/**
 * ADR-021 PR-F（前端）— 搜尋頁（D-5）
 *
 * 為什麼有這批測試：
 *  - 按了才搜（送 action=search＋trigger）；空白不送
 *  - 結果依模組分組、顯示筆數；找不到、失敗都講清楚（不是一片空白）
 *  - 點一下直開該筆：任務／提醒打開那一筆的編輯、記帳載入表單、雜記捲到那一則、圖書館開閱讀頁
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_tasks: 'TRUE', feat_notes: 'TRUE', feat_expense: 'TRUE', feat_clips: 'TRUE', feat_ui_v2: 'TRUE' };
const RESULT = { success: true, q: '牛奶', groups: [
  { key: 'todo', label: '任務', total: 25, items: [{ id: '1', title: '買牛奶', snippet: '買牛奶', date: '2026-10-01' }] },
  { key: 'clips', label: '圖書館', total: 1, items: [{ id: 'c1', title: '牛奶的十種用法', snippet: '牛奶的十種用法 內文', date: '2026-10-11' }] }] };

function env(handler = {}) {
  const e = loadFrontend({ storage: { 'personal-os-ui': 'v2' }, fetchImpl: ({ body }) => {
    if (!body) return null;
    const h = handler[body.action];
    if (h === 'offline') throw new TypeError('Failed to fetch');
    return h === undefined ? null : reply(typeof h === 'function' ? h(body) : h);
  } });
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){}, scrollIntoView(){ __scrolled.push(id); },
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    }; __scrolled = []; __calls = [];`);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}"; window.scrollTo = function(){};`);
  e.raw('roster = ' + JSON.stringify([USER]));
  const el = (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action).map((c) => c.body);

/* ========================================================================== */
describe('按了才搜', () => {
  test('送 action=search＋q＋trigger；結果依模組分組、顯示筆數與「只列最新」', async () => {
    const { e, el } = env({ search: RESULT });
    e.raw('document.getElementById("searchInput").value = "  牛奶 "');
    await e.callRaw('runSearch');
    const s = sent(e, 'search')[0];
    assert.deepEqual([s.q, s.trigger], ['牛奶', 'manual']);
    const html = el('searchResults').innerHTML;
    assert.match(html, /任務[\s\S]*25/);
    assert.match(html, /買牛奶/);
    assert.match(html, /圖書館/);
    assert.match(html, /只列最新 1 筆，共 25 筆/);
    assert.match(html, /openSearchHit\('clips','c1'\)/);
  });

  test('空白不送，講要打字', async () => {
    const { e } = env({ search: RESULT });
    await e.callRaw('runSearch');
    assert.equal(sent(e, 'search').length, 0);
    assert.ok(e.toasts.some((t) => /先打要找的字/.test(t)));
  });

  test('找不到：講找不到「關鍵字」', async () => {
    const { e, el } = env({ search: { success: true, q: '外星人', groups: [] } });
    e.raw('document.getElementById("searchInput").value = "外星人"');
    await e.callRaw('runSearch');
    assert.match(el('searchResults').innerHTML, /找不到「外星人」/);
  });

  test('連不上：講連不上，不是「找不到」', async () => {
    const { e, el } = env({ search: 'offline' });
    e.raw('document.getElementById("searchInput").value = "牛奶"');
    await e.callRaw('runSearch');
    assert.match(el('searchResults').innerHTML, /連不上/);
    assert.doesNotMatch(el('searchResults').innerHTML, /找不到/);
  });
});

/* ========================================================================== */
describe('點一下直開該筆', () => {
  function routed() {
    const { e } = env();
    e.raw(`goView = function(v){ __calls.push('goView:' + v); return Promise.resolve(true); };
      openTaskEdit = function(id){ __calls.push('task:' + id); };
      editExpense = function(id){ __calls.push('expense:' + id); };
      openClipFromWidget = function(id){ __calls.push('clip:' + id); return Promise.resolve(); };
      state = EMPTY_STATE();
      state.tasks = [{ id: 1, text: '買牛奶' }, { id: 5, text: '繳牛奶費', kind: 'reminder' }];
      state.notes = [{ id: 11, txt: '牛奶' }];
      state.expenses = [{ id: 21, note: '牛奶' }];`);
    return e;
  }

  test('任務：進任務頁、打開那一筆的編輯（id 照本機的型別）', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'todo', '1');
    assert.deepEqual(e.read('__calls'), ['goView:tasks', 'task:1']);
  });

  test('提醒：進提醒、打開那一筆', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'reminder', '5');
    assert.deepEqual(e.read('__calls'), ['goView:reminders', 'task:5']);
  });

  test('記帳：進記帳頁、載入表單', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'expenses', '21');
    assert.deepEqual(e.read('__calls'), ['goView:expenses', 'expense:21']);
  });

  test('雜記：進雜記頁、捲到那一則', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'notes', '11');
    assert.deepEqual(e.read('__calls'), ['goView:notes']);
    assert.deepEqual(e.read('__scrolled'), ['note-11']);
  });

  test('圖書館：開閱讀頁（同 Reading Widget 那條路）', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'clips', 'c1');
    assert.deepEqual(e.read('__calls'), ['clip:c1']);
  });

  test('本機找不到那一筆（例如剛被刪掉）：講出來', async () => {
    const e = routed();
    await e.callRaw('openSearchHit', 'todo', '999');
    assert.ok(e.toasts.some((t) => /找不到這一筆/.test(t)));
  });
});
