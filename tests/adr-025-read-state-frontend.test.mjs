/**
 * ADR-025（前端）— 圖書館閱讀狀態：列表一眼分得出三種、篩選四種、閱讀頁三顆狀態鈕
 *
 * 為什麼有這批測試：
 *  - Neil 的原話：「畫面上沒辦法辨認是否已讀，或是進行中的狀態」。列表要不切篩選就看得出：
 *    未讀小藍點、📖 閱讀中標籤、已讀淡化（D-4）；處理中／失敗的篇沒有閱讀狀態，不加標記
 *  - 篩選四種各帶數量（D-5）；Reading Widget「未讀 N 篇 →」照舊跳未讀
 *  - 開閱讀頁：未讀才改成閱讀中，**已讀不會被改回閱讀中**（D-2）
 *  - 閱讀頁三顆鈕（D-6）：先樂觀更新、送 clipReadState（trigger=write）；失敗或離線要**還原**並講出來，
 *    不能假裝存好了（CLAUDE.md Rule 9）
 *  - 1.0 不出現任何新元素（D-8）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_ui_v2: 'TRUE' };

const clip = (id, o = {}) => Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
  author: 'au' + id, caption: '內文' + id, media_saved: 1, image_ids: '["f1"]', collected_at: '2026-10-19T01:00:00.000Z', read_status: '' }, o);
const MIX = [
  clip('u1'), clip('u2', { kind: 'link', status: 'link', image_ids: '', caption: '' }),
  clip('r1', { read_status: 'reading' }),
  clip('d1', { read_status: 'read' }), clip('d2', { status: 'partial', read_status: 'read' }),
  clip('p1', { status: 'pending' }), clip('f1', { status: 'failed', error: '抓不到' })
];

function env({ v2 = true, clips = MIX, handler = {}, offline = false } = {}) {
  const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {}, fetchImpl: ({ body }) => {
    if (!body) return null;
    if (offline && body.action !== 'readMany') return Promise.reject(new Error('offline'));
    if (body.action === 'readMany' && (body.sheets || []).includes('clips')) return reply({ data: { clips: JSON.parse(JSON.stringify(clips)) }, denied: [] });
    const h = handler[body.action];
    if (h === undefined) return reply({ success: true });
    return reply(typeof h === 'function' ? h(body) : h);
  } });
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    }`);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}"; window.scrollTo = function(){};`);
  e.raw('roster = ' + JSON.stringify([USER]));
  e.raw('clipsData = ' + JSON.stringify(clips));
  const el = (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action).map((c) => c.body);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
const status = (e, id) => e.read('clipsData.find(function (c) { return c.id === ' + JSON.stringify(id) + '; }).read_status');
/** 列表裡某篇卡片的整段 HTML（到下一張卡片為止） */
function card(html, id) {
  const at = html.indexOf(`openClip('${id}')`);
  assert.ok(at !== -1, '列表有 ' + id);
  const start = html.lastIndexOf('<div class="clip-item', at);
  const next = html.indexOf('<div class="clip-item', at);
  return html.slice(start, next === -1 ? undefined : next);
}

/* ========================================================================== */
describe('列表標記（D-4）', () => {
  test('未讀小藍點、閱讀中「📖 閱讀中」、已讀淡化；三種互不混用', () => {
    const { e, el } = env();
    e.call('renderClips');
    const html = el('clipList').innerHTML;
    for (const id of ['u1', 'u2']) {
      const c = card(html, id);
      assert.match(c, /clip-dot/); assert.doesNotMatch(c, /閱讀中|clip-done/);
    }
    const r = card(html, 'r1');
    assert.match(r, /📖 閱讀中/); assert.doesNotMatch(r, /clip-dot|clip-done/);
    for (const id of ['d1', 'd2']) {
      const c = card(html, id);
      assert.match(c, /class="clip-item[^"]*clip-done/); assert.doesNotMatch(c, /clip-dot|閱讀中/);
    }
  });

  test('處理中／失敗的篇沒有閱讀狀態標記（收齊才算）；收藏狀態標籤照舊', () => {
    const { e, el } = env();
    e.call('renderClips');
    const html = el('clipList').innerHTML;
    const p = card(html, 'p1'), f = card(html, 'f1');
    for (const c of [p, f]) assert.doesNotMatch(c, /clip-dot|閱讀中|clip-done/);
    assert.match(p, /處理中/);
    assert.match(f, /失敗/);
  });
});

/* ========================================================================== */
describe('篩選（D-5）', () => {
  test('全部／未讀／閱讀中／已讀，各帶數量（只算收齊或只存連結的）', () => {
    const { e, el } = env();
    e.call('renderClips');
    const seg = el('clipFilterSeg').innerHTML;
    assert.match(seg, /全部/);
    assert.match(seg, /未讀 2/);
    assert.match(seg, /閱讀中 1/);
    assert.match(seg, /已讀 2/);
  });

  test('各自只列該狀態；切「全部」全部列出', () => {
    const { e, el } = env();
    const ids = () => [...el('clipList').innerHTML.matchAll(/openClip\('([^']+)'\)/g)].map((m) => m[1]).sort();
    e.call('pickClipFilter', 'unread');  assert.deepEqual(ids(), ['u1', 'u2']);
    e.call('pickClipFilter', 'reading'); assert.deepEqual(ids(), ['r1']);
    e.call('pickClipFilter', 'read');    assert.deepEqual(ids(), ['d1', 'd2']);
    e.call('pickClipFilter', 'all');     assert.equal(ids().length, MIX.length);
    e.call('pickClipFilter', 'bogus');   assert.equal(e.read('clipFilter'), 'all');
  });

  test('空清單各自一句（不是「去 LINE 貼網址」）', () => {
    const { e, el } = env({ clips: [clip('p1', { status: 'pending' })] });
    e.call('pickClipFilter', 'unread');  assert.match(el('clipList').innerHTML, /沒有未讀/);
    e.call('pickClipFilter', 'reading'); assert.match(el('clipList').innerHTML, /沒有閱讀中/);
    e.call('pickClipFilter', 'read');    assert.match(el('clipList').innerHTML, /還沒有讀完/);
  });

  test('Reading Widget「未讀 N 篇 →」照舊跳未讀', async () => {
    const { e } = env();
    await e.callRaw('openLibrary', 'unread');
    assert.equal(e.read('clipFilter'), 'unread');
  });
});

/* ========================================================================== */
describe('開閱讀頁（D-2）', () => {
  test('未讀 → 閱讀中（閱讀頁一打開就亮「📖 閱讀中」）；仍送 clipRead', async () => {
    const { e, el } = env({ handler: { clipRead: { success: true } } });
    e.call('openClip', 'u1');
    assert.equal(status(e, 'u1'), 'reading');
    assert.match(el('clipReader').innerHTML, /<button class="sel"[^>]*>📖 閱讀中</);
    await settle();
    assert.equal(sent(e, 'clipRead').length, 1);
  });

  test('已讀再打開：仍是已讀（不被改回閱讀中）；閱讀中維持', async () => {
    const { e } = env();
    e.call('openClip', 'd1');
    e.call('openClip', 'r1');
    await settle();
    assert.equal(status(e, 'd1'), 'read');
    assert.equal(status(e, 'r1'), 'reading');
  });
});

/* ========================================================================== */
describe('閱讀頁三顆狀態鈕（D-6）', () => {
  test('三顆都在、目前狀態高亮；只存連結的篇也有', () => {
    const { e, el } = env();
    e.call('openClip', 'd1');
    const html = el('clipReader').innerHTML;
    assert.match(html, />未讀</);
    assert.match(html, />📖 閱讀中</);
    assert.match(html, /<button class="sel"[^>]*>✅ 已讀</);
    e.call('openClip', 'u2');
    assert.match(el('clipReader').innerHTML, /setClipReadState\("u2", 'read'\)|setClipReadState\(&quot;u2&quot;, 'read'\)/);
  });

  test('點了先改畫面、送 clipReadState（state、trigger=write）；成功就留著', async () => {
    const { e, el } = env({ handler: { clipReadState: (b) => ({ success: true, state: b.state }) } });
    e.call('openClip', 'r1');
    const p = e.callRaw('setClipReadState', 'r1', 'read');
    assert.equal(status(e, 'r1'), 'read', '樂觀更新');
    assert.equal(await p, true);
    const s = sent(e, 'clipReadState');
    assert.equal(s.length, 1);
    assert.deepEqual([s[0].id, s[0].state, s[0].trigger], ['r1', 'read', 'write']);
    assert.match(el('clipReader').innerHTML, /<button class="sel"[^>]*>✅ 已讀</);
  });

  test('可以改回未讀（state 送空字串）', async () => {
    const { e } = env();
    e.call('openClip', 'd1');
    assert.equal(await e.callRaw('setClipReadState', 'd1', ''), true);
    assert.equal(sent(e, 'clipReadState')[0].state, '');
    assert.equal(status(e, 'd1'), '');
  });

  test('雲端拒絕：還原原本狀態並提示', async () => {
    const { e } = env({ handler: { clipReadState: { error: 'forbidden', permanent: true } } });
    e.call('openClip', 'd1');
    assert.equal(await e.callRaw('setClipReadState', 'd1', 'reading'), false);
    assert.equal(status(e, 'd1'), 'read');
    assert.ok(e.toasts.some((t) => /不是你的收藏/.test(t)));
  });

  test('離線：還原並講連不上，不假裝存好', async () => {
    const { e } = env({ offline: true });
    e.raw('clipOpenId = "r1"');
    assert.equal(await e.callRaw('setClipReadState', 'r1', 'read'), false);
    assert.equal(status(e, 'r1'), 'reading');
    assert.ok(e.toasts.some((t) => /連不上/.test(t)));
  });

  test('點目前的狀態：什麼都不送', async () => {
    const { e } = env();
    assert.equal(await e.callRaw('setClipReadState', 'd1', 'read'), true);
    assert.equal(sent(e, 'clipReadState').length, 0);
  });
});

/* ========================================================================== */
describe('1.0 不動（D-8）', () => {
  test('列表沒有藍點／閱讀中／淡化；閱讀頁沒有狀態鈕；開一篇不送 clipRead', async () => {
    const { e, el } = env({ v2: false });
    e.call('renderClips');
    assert.doesNotMatch(el('clipList').innerHTML, /clip-dot|閱讀中|clip-done/);
    assert.equal(el('clipFilterSeg').hidden, true);
    e.call('openClip', 'u1');
    assert.doesNotMatch(el('clipReader').innerHTML, /setClipReadState|clip-state-row/);
    await settle();
    assert.equal(sent(e, 'clipRead').length, 0);
    assert.equal(status(e, 'u1'), '');
  });
});
