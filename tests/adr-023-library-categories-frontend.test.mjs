/**
 * ADR-023 PR-E（前端）— 圖書館分類：閱讀頁一排按鈕、列表篩選（D-7、D-8，只在 2.0）
 *
 * 盯的事：
 *   - 閱讀頁一排分類按鈕（只列啟用中的），點一下即存（clipCategory、trigger=write）；再點一次取消
 *   - 存不上去：還原畫面並講出來（不假裝存好）
 *   - 停用的分類不出現在按鈕，但已歸類的篇照樣顯示原名
 *   - 列表篩選：全部／各分類／未分類；跟「未讀」可以疊加
 *   - 搜尋結果顯示分類；1.0 一個都不出現
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_clips: 'TRUE', feat_notes: 'TRUE', feat_ui_v2: 'TRUE' };
const CATS = [{ name: '舊分類', icon: '🗂', sort: 5, active: false }, { name: 'AI 提示詞', icon: '🤖', sort: 10, active: true },
  { name: '投資', icon: '📈', sort: 50, active: true }];
const clip = (id, extra = {}) => Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
  caption: '內文 ' + id, author: 'a', collected_at: '2026-10-19T01:00:00.000Z', read_status: 'read', category: '' }, extra);
const CLIPS = [clip('c1', { category: '投資' }), clip('c2', { category: '舊分類' }), clip('c3'), clip('c4', { read_status: '', category: '投資' })];

function env({ ui = 'v2', handler = {} } = {}) {
  const e = loadFrontend({ storage: { 'personal-os-ui': ui }, fetchImpl: ({ body }) => {
    if (!body) return null;
    const h = handler[body.action];
    return h === undefined ? null : reply(typeof h === 'function' ? h(body) : h);
  } });
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){}, querySelectorAll:()=>[], querySelector:()=>null });
    };
    __toasts = []; toast = function(m){ __toasts.push(m); }; window.scrollTo = function(){};`);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}";`);
  e.raw('roster = ' + JSON.stringify([USER]));
  e.call('applyModules', [{ module_id: 'library', name: 'l', category: '知識', icon: '•', enabled: true, sort: 1 }]);
  e.load = (cats = CATS, clips = CLIPS) => e.raw(`clipCats = ${JSON.stringify(cats)}; clipsData = ${JSON.stringify(clips)};`);
  e.el = (id) => e.read(`(__els[${JSON.stringify(id)}] || {}).innerHTML || ''`);
  e.listIds = () => [...e.el('clipList').matchAll(/openClip\('([^']+)'\)/g)].map((m) => m[1]);
  return e;
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

describe('清單跟著 readMany(clips) 一起來', () => {
  test('loadClips 存下 clip_categories', async () => {
    const e = env({ handler: { readMany: { success: true, data: { clips: CLIPS }, clip_categories: CATS } } });
    await e.call('loadClips', 'manual');
    assert.deepEqual(e.read('clipCats.map(function(c){ return c.name; })'), ['舊分類', 'AI 提示詞', '投資']);
  });
});

describe('閱讀頁：一排分類按鈕（D-7）', () => {

  test('只列啟用中的分類；目前的那個標 sel', () => {
    const e = env();
    e.load();
    e.call('openClip', 'c1');
    const h = e.el('clipReader');
    assert.match(h, /🤖 AI 提示詞/);
    assert.match(h, /class="cat-btn sel"[^>]*>📈 投資/);
    assert.doesNotMatch(h, /🗂 舊分類/, '停用的不是可選的按鈕');
  });

  test('已歸到停用分類的篇：照樣顯示原名（不可點）', () => {
    const e = env();
    e.load();
    e.call('openClip', 'c2');
    assert.match(e.el('clipReader'), /aria-disabled="true">🗂 舊分類/);
  });

  test('點一下 → 存雲端（trigger=write）；再點一次已選的 → 送 "" 取消', async () => {
    const e = env({ handler: { clipCategory: (b) => ({ success: true, category: b.category }), clipRead: { success: true } } });
    e.load();
    e.call('openClip', 'c3');
    await e.call('setClipCategory', 'c3', 'AI 提示詞');
    await e.call('setClipCategory', 'c3', 'AI 提示詞');
    const s = sent(e, 'clipCategory');
    assert.deepEqual(s.map((c) => [c.body.id, c.body.category, c.body.trigger]), [['c3', 'AI 提示詞', 'write'], ['c3', '', 'write']]);
    assert.equal(e.read('clipsData.filter(function(c){ return c.id === "c3"; })[0].category'), '');
  });

  test('存不上去：畫面還原、講出來', async () => {
    const e = env({ handler: { clipCategory: { error: 'invalid_category', permanent: true }, clipRead: { success: true } } });
    e.load();
    await e.call('setClipCategory', 'c1', 'AI 提示詞');
    assert.equal(e.read('clipsData[0].category'), '投資');
    assert.match(e.read('__toasts.join("|")'), /已停用或不存在/);
  });
});

describe('列表篩選（D-7）', () => {

  test('全部／各分類／未分類；停用但有篇在用的也列', () => {
    const e = env();
    e.load();
    e.call('renderClips');
    const seg = e.el('clipCatSeg');
    assert.match(seg, /全部.*🗂 舊分類.*🤖 AI 提示詞.*📈 投資.*未分類/s);
    e.call('pickClipCatFilter', '投資');
    assert.deepEqual(e.listIds().sort(), ['c1', 'c4']);
    e.call('pickClipCatFilter', '__none__');
    assert.deepEqual(e.listIds(), ['c3']);
    e.call('pickClipCatFilter', '');
    assert.equal(e.listIds().length, 4);
  });

  test('跟「未讀」疊加：未讀＋投資 → 只有 c4', () => {
    const e = env();
    e.load();
    e.call('pickClipFilter', 'unread');
    e.call('pickClipCatFilter', '投資');
    assert.deepEqual(e.listIds(), ['c4']);
  });

  test('列表項目帶分類標籤', () => {
    const e = env();
    e.load();
    e.call('renderClips');
    assert.match(e.el('clipList'), /clip-tag">📈 投資/);
  });
});

describe('搜尋結果顯示分類', () => {
  test('有 tag 的命中後面接分類', () => {
    const e = env();
    e.load();
    e.raw(`searchState = { result: { q: 'x', groups: [{ key: 'clips', label: '圖書館', total: 1, items: [{ id: 'c1', title: 't', date: '2026-10-19', tag: '投資' }] }] } };`);
    e.call('renderSearch');
    assert.match(e.el('searchResults'), /2026-10-19・📈 投資/);
  });
});

describe('1.0 不受影響（D-20）', () => {
  test('1.0：沒有分類按鈕、沒有篩選列、列表沒有分類標籤', () => {
    const e = env({ ui: 'v1' });
    e.load();
    e.call('openClip', 'c1');
    assert.doesNotMatch(e.el('clipReader'), /分類|cat-btn/);
    e.call('closeClip');
    assert.equal(e.read('__els.clipCatSeg.hidden'), true);
    assert.doesNotMatch(e.el('clipList'), /📈 投資/);
  });
});
