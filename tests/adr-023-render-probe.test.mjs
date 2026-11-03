/**
 * ADR-023 D-12 觀察 — 首頁重畫頻率量測（只量、不改行為）
 *
 * 為什麼：renderOverview() 每次都用 innerHTML 重建整個 widget 清單，盤中輪詢可能剛好打斷手勢
 * （iOS 上自選股滑不動的嫌疑之一）。要不要改（只重畫有變的 widget、觸控中延後），先拿數字再決定。
 * 盯的事：
 *   - 每分鐘彙整一列 performance：action=render、rows＝這一分鐘重畫幾次、client_ms＝重畫總耗時、
 *     stages＝{ touch：觸控中（或剛放開／捲動 800ms 內）的次數、shown：停在總覽且畫面看得到的次數、trading：盤中 1／否 0 }
 *   - 不另外發請求：搭下一個請求的 body.perf；行為不變（重畫照樣發生、拖曳中照樣不重畫）
 *   - 雲端只收形狀對的 rows（非負整數）與 stages（≤8 個英文小寫鍵、非負數字），夾帶不了內容
 *   - 只在 2.0
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs } from './fake-apps-script.mjs';

function front(ui = 'v2') {
  const e = loadFrontend({ storage: { 'personal-os-ui': ui }, fetchImpl: () => null });
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, innerHTML:'', hidden:false, dataset:{}, style:{}, classList:{add(){},remove(){},toggle(){},contains:()=>false} });
    };
    __now = 1793700000000; Date.now = function(){ return __now; };
    __view = 'overview'; currentView = function(){ return __view; };
    perfPending = [];
    deviceToken = "tok"; myLineId = "Uneil";
    roster = [{ line_id: "Uneil", is_active: "TRUE", is_admin: "TRUE", feat_ui_v2: "TRUE" }];`);
  e.tick = (ms) => e.raw(`__now += ${ms}`);
  e.render = () => e.call('renderOverview');
  e.pending = () => e.read('perfPending.filter(function(p){ return p.action === "render"; })');
  return e;
}

describe('手機端：每分鐘一列（不改行為）', () => {

  test('一分鐘內重畫 3 次 → 過了一分鐘的下一次重畫，前一分鐘彙整成一列', () => {
    const e = front();
    e.render(); e.tick(15000); e.render(); e.tick(15000); e.render();
    assert.equal(e.pending().length, 0, '還沒滿一分鐘不出列');
    e.tick(31000); e.render();
    const [r] = e.pending();
    assert.equal(r.action, 'render');
    assert.equal(r.trigger, 'poll');
    assert.equal(r.rows, 3);
    assert.equal(r.ui, 'v2');
    assert.equal(typeof r.client_ms, 'number');
    assert.deepEqual(Object.keys(r.stages).sort(), ['shown', 'touch', 'trading']);
    assert.equal(r.stages.shown, 3);
  });

  test('觸控中、剛放開 800ms 內、捲動中的重畫算 touch；放開很久之後的不算', () => {
    const e = front();
    e.raw('renderProbeTouch(true)'); e.render();               // 手指按著
    e.raw('renderProbeTouch(false)'); e.tick(500); e.render();  // 剛放開
    e.tick(2000); e.render();                                    // 放開很久
    e.raw('renderProbeScroll()'); e.tick(100); e.render();       // 捲動慣性中
    e.tick(60000); e.render();
    assert.equal(e.pending()[0].stages.touch, 3);
    assert.equal(e.pending()[0].rows, 4);
  });

  test('盤中標 trading=1；不在總覽時的重畫不算 shown', () => {
    const e = front();
    e.raw('widgetsMeta = { trading: true }');
    e.render();
    e.raw("__view = 'stocks'"); e.render();
    e.tick(61000); e.render();
    const [r] = e.pending();
    assert.equal(r.stages.trading, 1);
    assert.equal(r.stages.shown, 1);
  });

  test('沒滿一分鐘但要送請求了：先把累積的那段也帶上（不遺失最後一段）', () => {
    const e = front();
    e.render(); e.render();
    e.tick(20000);
    e.raw('renderProbeFlush(true)');
    assert.equal(e.pending()[0].rows, 2);
    assert.ok(e.pending()[0].stages);
  });

  test('拖曳中不重畫的那次不算（行為不變：照樣 return）', () => {
    const e = front();
    e.raw('widgetDrag = { id: "tasks" }');
    e.render();
    e.raw('widgetDrag = null');
    e.tick(61000); e.render();
    assert.equal(e.pending().length, 0, '第一段沒有真的重畫，不出列');
  });

  test('1.0：不量', () => {
    const e = front('v1');
    e.render(); e.tick(61000); e.render();
    assert.equal(e.pending().length, 0);
  });

  test('搭下一個請求送上去，不另外發請求', async () => {
    const e = front();
    e.render(); e.tick(61000); e.render();
    assert.equal(e.calls.length, 0);
  });
});

describe('雲端：只收形狀對的 rows／stages', () => {
  const g = loadCodeGs({});
  const rows = (list) => g.read(`clientPerfRows_(${JSON.stringify(list)})`);

  test('rows 非負整數、stages 只收英文小寫鍵＋非負數字，寫成 JSON 文字', () => {
    const [r] = rows([{ action: 'render', trigger: 'poll', client_ms: 120, rows: 4, stages: { touch: 2, shown: 4, trading: 1 }, ui: 'v2' }]);
    assert.equal(r.rows, 4);
    assert.deepEqual(JSON.parse(r.stages), { touch: 2, shown: 4, trading: 1 });
  });

  test('夾帶內容進不來：字串值、怪鍵、負數、太多鍵、非整數 rows 一律丟掉該欄（整列照收）', () => {
    const [r] = rows([{ action: 'render', trigger: 'poll', client_ms: 1, rows: 2.5,
      stages: { touch: '<b>', 'x-y': 1, neg: -1, a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1 } }]);
    assert.equal(r.rows, undefined);
    const st = r.stages ? JSON.parse(r.stages) : {};
    assert.ok(!('touch' in st) && !('x-y' in st) && !('neg' in st));
    assert.ok(Object.keys(st).length <= 8);
  });

  test('舊的手機列（沒有 rows／stages）照舊', () => {
    const [r] = rows([{ action: 'zoneSwitch', trigger: 'zone', client_ms: 120 }]);
    assert.equal(r.rows, undefined);
    assert.equal(r.stages, undefined);
  });
});
