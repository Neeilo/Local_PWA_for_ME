/**
 * ADR-024 PR-A（前端）— 閱讀頁「📝 文字辨識（免費）」（D-1、D-8）
 *
 * 為什麼有這批測試：
 *  - 按了才跑、一次一篇；請求帶 trigger（效能可觀測性，ADR-014）
 *  - 結果是獨立的「圖片文字」區塊（不混進 AI 整理）；重跑前要確認會取代；捨棄要確認
 *  - 只在有圖片的篇出現：只存連結、沒有圖的篇看不到按鈕
 *  - 失敗講清楚原因，舊結果照樣顯示（後端也沒動它）
 *  - 1.0 不動
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_ui_v2: 'TRUE' };
const clip = (o = {}) => Object.assign({ id: 'c1', line_id: ME, url: 'https://www.instagram.com/p/AAA111/', kind: 'post', status: 'done', author: 'someone',
  caption: '', media_saved: 2, image_ids: '["f1","f2"]', collected_at: '2026-10-19T01:00:00.000Z', note: '', note_revision: 0, read_status: '' }, o);
const LINK = clip({ id: 'k1', kind: 'link', status: 'link', url: 'https://www.example.com/a', image_ids: '', media_saved: 0 });

function env({ v2 = true, clips = [clip(), LINK], handler = {} } = {}) {
  const e = loadFrontend({ storage: v2 ? { 'personal-os-ui': 'v2' } : {}, fetchImpl: ({ body }) => {
    if (!body) return null;
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

/* ========================================================================== */
describe('📝 文字辨識（D-1）', () => {
  test('有圖的篇：看得到「📝 文字辨識（免費）」；按了送 clipOcr＋trigger，結果在獨立的「圖片文字」區塊', async () => {
    const { e, el } = env({ handler: { clipOcr: { success: true, ocr_output: '## 01.jpg\n提示詞全文', ocr_at: '2026-11-04T02:00:00.000Z' } } });
    e.call('openClip', 'c1');
    assert.match(el('clipReader').innerHTML, /📝 文字辨識（免費）/);
    assert.doesNotMatch(el('clipReader').innerHTML, /圖片文字<\/b>/, '還沒跑就沒有結果區塊');
    await e.callRaw('runClipOcr');
    const s = sent(e, 'clipOcr')[0];
    assert.deepEqual([s.id, s.trigger, s.discard], ['c1', 'write', undefined]);
    const html = el('clipReader').innerHTML;
    assert.match(html, /<b>📝 圖片文字<\/b>/);
    assert.match(html, /提示詞全文/);
    assert.equal(e.read('clipsData[0].ocr_output'), '## 01.jpg\n提示詞全文');
    assert.doesNotMatch(html.split('✨ AI 整理')[1] || '', /提示詞全文/, '不混進 AI 整理區塊');
  });

  test('只存連結、沒有圖的篇：沒有文字辨識按鈕', () => {
    const { e, el } = env({ clips: [clip({ id: 'c2', image_ids: '[]', media_saved: 0 }), LINK] });
    e.call('openClip', 'k1');
    assert.doesNotMatch(el('clipReader').innerHTML, /文字辨識/);
    e.call('openClip', 'c2');
    assert.doesNotMatch(el('clipReader').innerHTML, /文字辨識/);
  });

  test('已經有結果：重跑要確認（取消就不送）；捨棄要確認，成功後區塊消失', async () => {
    const { e, el } = env({ clips: [clip({ ocr_output: '舊的辨識', ocr_at: '2026-11-01T00:00:00.000Z' })] });
    e.call('openClip', 'c1');
    assert.match(el('clipReader').innerHTML, /舊的辨識/);
    e.raw('confirm = function(){ return false; }');
    await e.callRaw('runClipOcr');
    await e.callRaw('discardClipOcr');
    assert.equal(sent(e, 'clipOcr').length, 0, '取消就不送');
    e.raw('confirm = function(){ return true; }');
    await e.callRaw('discardClipOcr');
    const d = sent(e, 'clipOcr')[0];
    assert.deepEqual([d.discard, d.trigger], [true, 'write']);
    assert.doesNotMatch(el('clipReader').innerHTML, /舊的辨識/);
  });

  test('失敗：講原因，舊結果照樣顯示', async () => {
    const { e, el } = env({ clips: [clip({ ocr_output: '舊的辨識' })], handler: { clipOcr: { error: 'ocr_failed', reason: 'HTTP 403（轉文件）' } } });
    e.raw('confirm = function(){ return true; }');
    e.call('openClip', 'c1');
    await e.callRaw('runClipOcr');
    assert.ok(e.toasts.some((t) => /文字辨識失敗.*HTTP 403/.test(t)));
    assert.match(el('clipReader').innerHTML, /舊的辨識/);
  });

  test('not_ready：請管理者「初始化」', async () => {
    const { e } = env({ handler: { clipOcr: { error: 'not_ready' } } });
    e.call('openClip', 'c1');
    await e.callRaw('runClipOcr');
    assert.ok(e.toasts.some((t) => /初始化/.test(t)));
  });

  test('辨識中：按鈕禁用，連按兩次只送一次', async () => {
    let release;
    const { e, el } = env({ handler: { clipOcr: () => new Promise((r) => { release = () => r({ success: true, ocr_output: 'x', ocr_at: '' }); }) } });
    e.call('openClip', 'c1');
    const p1 = e.callRaw('runClipOcr');
    await new Promise((r) => setImmediate(r));
    assert.match(el('clipReader').innerHTML, /辨識中…/);
    await e.callRaw('runClipOcr');
    release && release();
    await p1;
    assert.equal(sent(e, 'clipOcr').length, 1);
  });
});

describe('1.0 不動', () => {
  test('1.0 閱讀頁沒有文字辨識', () => {
    const { e, el } = env({ v2: false, clips: [clip({ ocr_output: '辨識結果' })] });
    e.call('openClip', 'c1');
    assert.doesNotMatch(el('clipReader').innerHTML, /文字辨識|圖片文字/);
  });
});
