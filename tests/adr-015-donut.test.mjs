/**
 * ADR-015 PR-C：支出雙環圖（T9）
 *
 * 盯的是：
 *   - 外圈每段的角度落在所屬大類的範圍內：同一大類的外圈段加起來恰好等於內圈那一段
 *   - 佔總支出 <3% 的細項在該大類內併成「其他」
 *   - 未細分＝同色半透明；沒有細項的大類外圈整段未細分；內圈因大類太多而合併的「其他」整段未細分
 *   - 同大類的細項深淺交替（以 CSS token 計算，沒有寫死色碼）
 *   - 點內圈大類（或圖例）→ 圖例展開該類細項的名稱與金額；再點收起
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const MK = '2026-10';
const CONFIG = { source: 'sheet', categories: [
  { name: '飲食', color: 'c1', active: true, aliases: [], subs: ['外食', '買菜', '冷凍', '常備食材'], target_group: '', targets: [] },
  { name: '交通', color: 'c2', active: true, aliases: [], subs: ['加油', 'ETC', '保養'], target_group: '', targets: [] },
  { name: '日常用品', color: 'c3', active: true, aliases: [], subs: [], target_group: '', targets: [] }
] };

let seq = 0;
const exp = (category, subcategory, amount) => ({ id: ++seq, date: MK + '-05', type: 'expense', category, subcategory, amount, line_id: 'Uneil', ts: seq });

/** 總支出 10,000：飲食 6,000（外食 4,000、買菜 1,500、冷凍 200＜3%、常備 100＜3%、未細分 200）；交通 2,500；日常 1,500 */
const EXPENSES = [
  exp('飲食', '外食', 4000), exp('飲食', '買菜', 1500), exp('飲食', '冷凍', 200), exp('飲食', '常備食材', 100), exp('飲食', '', 200),
  exp('交通', '加油', 2000), exp('交通', 'ETC', 500),
  exp('日常用品', '', 1500)
];

function env(expenses = EXPENSES) {
  const e = loadFrontend();
  e.callRaw('applyExpenseConfig', e.context.JSON.parse(JSON.stringify(CONFIG)));
  e.raw('state = EMPTY_STATE(); scopeMine = false; donutOpen = null');
  e.raw('state.expenses = ' + JSON.stringify(expenses));
  e.raw('monthKey = function(){ return "' + MK + '"; }');
  e.raw(`__els = {}; document.getElementById = function(id){ return __els[id] || (__els[id] = { innerHTML:'', hidden:false }); }`);
  return e;
}
const outer = (e) => e.read(`donutOuter(categoryBreakdown('${MK}'), c => subBreakdown('${MK}', c, monthTotal('${MK}')))`);

describe('外圈的切法', () => {
  test('同一大類的外圈段加起來＝內圈那一段，而且連續、起點對齊', () => {
    const e = env();
    const rows = e.call('categoryBreakdown', MK);
    const out = outer(e);
    let at = 0;
    for (const r of rows) {
      const mine = out.filter((o) => o.cat === r.cat);
      assert.equal(mine.reduce((n, o) => n + o.amount, 0), r.amount, r.cat);
      assert.equal(mine[0].start, at, r.cat + ' 的起點');
      mine.forEach((o, i) => { if (i) assert.equal(o.start, mine[i - 1].start + mine[i - 1].amount); });
      at += r.amount;
    }
  });

  test('<3% 的細項在大類內併成「其他」；未細分另成一段；順序照設定', () => {
    const e = env();
    const food = outer(e).filter((o) => o.cat === '飲食');
    assert.deepEqual(food.map((o) => [o.name, o.amount, o.unsorted]),
      [['外食', 4000, false], ['買菜', 1500, false], ['其他', 300, false], ['未細分', 200, true]]);
  });

  test('深淺交替：同大類的細項 0、1、0…；未細分不參與交替', () => {
    const e = env();
    const food = outer(e).filter((o) => o.cat === '飲食');
    assert.deepEqual(food.map((o) => o.shade), [0, 1, 0, 0]);
  });

  test('沒有細項的大類：外圈整段未細分', () => {
    const e = env();
    const daily = outer(e).filter((o) => o.cat === '日常用品');
    assert.deepEqual(daily.map((o) => [o.name, o.amount, o.unsorted]), [['未細分', 1500, true]]);
  });

  test('內圈因大類太多而合併的「其他」：外圈整段未細分', () => {
    const e = env();
    const rows = [{ cat: '飲食', amount: 100 }, { cat: '其他', amount: 50 }];
    const out = e.call('donutOuter', rows, () => [{ name: '不該出現', amount: 50, unsorted: false }]);
    assert.deepEqual(out.filter((o) => o.cat === '其他').map((o) => [o.name, o.amount, o.unsorted]), [['未細分', 50, true]]);
  });
});

describe('畫出來的樣子', () => {
  test('未細分半透明；細項用 color-mix 混卡片底色（先寫純色當備援）；沒有寫死色碼', () => {
    const e = env();
    const svg = e.read(`donutSVG(categoryBreakdown('${MK}'), monthTotal('${MK}'), donutOuter(categoryBreakdown('${MK}'), c => subBreakdown('${MK}', c, monthTotal('${MK}'))))`);
    assert.match(svg, /style="stroke:var\(--c1\);stroke-opacity:\.35"/, '飲食的未細分');
    assert.match(svg, /style="stroke:var\(--c1\);stroke:color-mix\(in srgb, var\(--c1\) 85%, var\(--card\)\)"/);
    assert.match(svg, /style="stroke:var\(--c1\);stroke:color-mix\(in srgb, var\(--c1\) 55%, var\(--card\)\)"/);
    assert.doesNotMatch(svg, /#[0-9a-f]{6}/i);
    assert.match(svg, /<title>飲食＞外食 4,000<\/title>/, '每一段都有 hover 說明');
    assert.match(svg, /onclick="toggleDonutCat\('飲食'\)"/);
  });

  test('外圈弧長按金額：外食 4,000／10,000 的弧長＝外圈周長 × 0.4 − 2px 間隙', () => {
    const e = env();
    const svg = e.read(`donutSVG(categoryBreakdown('${MK}'), monthTotal('${MK}'), donutOuter(categoryBreakdown('${MK}'), c => subBreakdown('${MK}', c, monthTotal('${MK}'))))`);
    const C2 = 2 * Math.PI * 62;
    assert.ok(svg.includes(`stroke-dasharray="${(C2 * 0.4 - 2).toFixed(2)} `), '外食那一段');
    // 買菜接在外食後面：起點＝周長 × 0.4（dashoffset 是負的起點）
    assert.match(svg, new RegExp(`stroke-dasharray="${(C2 * 0.15 - 2).toFixed(2)} [^"]+"\\s+stroke-dashoffset="${(-C2 * 0.4).toFixed(2)}"`));
  });

  test('中心數字維持本月總支出', () => {
    const e = env();
    e.call('renderDashExpense');
    assert.match(e.read('__els.dashExpense.innerHTML'), /<text class="donut-center"[^>]*>10,000<\/text>/);
  });
});

describe('點內圈或圖例：展開細項（名稱＋金額），再點收起', () => {
  test('展開飲食 → 圖例列出四段的名稱與金額；再點收起', () => {
    const e = env();
    e.call('renderDashExpense');
    assert.doesNotMatch(e.read('__els.dashExpense.innerHTML'), /lg-sub/);
    e.call('toggleDonutCat', '飲食');
    const html = e.read('__els.dashExpense.innerHTML');
    for (const [name, amt] of [['外食', '4,000'], ['買菜', '1,500'], ['其他', '300'], ['未細分', '200']]) {
      assert.match(html, new RegExp(`<span class="lg-name">${name}</span>\\s*<span class="lg-val">${amt}</span>`), name);
    }
    assert.match(html, /aria-expanded="true"/);
    e.call('toggleDonutCat', '飲食');
    assert.doesNotMatch(e.read('__els.dashExpense.innerHTML'), /lg-sub/);
  });

  test('一次只展開一個大類；展開中的大類這個月不見了就收起', () => {
    const e = env();
    e.call('toggleDonutCat', '飲食');
    e.call('toggleDonutCat', '交通');
    const html = e.read('__els.dashExpense.innerHTML');
    assert.match(html, /<span class="lg-name">加油<\/span>/);
    assert.doesNotMatch(html, /<span class="lg-name">外食<\/span>/, '圖例只展開交通');
    e.raw('state.expenses = state.expenses.filter(x => x.category !== "交通")');
    e.call('renderDashExpense');
    assert.equal(e.read('donutOpen'), null);
  });
});
