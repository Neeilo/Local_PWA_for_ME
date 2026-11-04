/**
 * ADR-024 PR-B（前端）— 閱讀頁「🤖 AI 辨識」（D-1、D-6）
 *
 * 為什麼有這批測試：
 *  - 會花錢：按鈕旁要寫「會產生 AI 費用」，按了才跑；請求帶 trigger
 *  - 跟「📝 文字辨識」並排、各自狀態：跑 AI 辨識時文字辨識照樣按得了（反之亦然）
 *  - 結果是獨立的「AI 看圖」區塊，末尾「（由 XXX 辨識）」；重跑、捨棄要確認
 *  - 失敗講是哪一家；沒 key 指到設定頁
 *  - 成本卡的各功能列認得 clip_vision
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
describe('🤖 AI 辨識（D-1、D-6）', () => {
  test('與文字辨識並排；旁邊寫會產生 AI 費用；按了送 clipVision＋trigger，結果在「AI 看圖」區塊、標由哪一家辨識', async () => {
    const { e, el } = env({ handler: { clipVision: { success: true, vision_output: '## 01.jpg\n表格轉文字', vision_provider: 'Claude', vision_at: '2026-11-04T02:00:00.000Z' } } });
    e.call('openClip', 'c1');
    const before = el('clipReader').innerHTML;
    assert.match(before, /📝 文字辨識（免費）[\s\S]*🤖 AI 辨識/);
    assert.match(before, /會產生 AI 費用/);
    await e.callRaw('runClipVision');
    const s = sent(e, 'clipVision')[0];
    assert.deepEqual([s.id, s.trigger, s.discard], ['c1', 'write', undefined]);
    const html = el('clipReader').innerHTML;
    assert.match(html, /<b>🤖 AI 看圖<\/b>/);
    assert.match(html, /表格轉文字/);
    assert.match(html, /（由 Claude 辨識）/);
    assert.equal(e.read('clipsData[0].vision_provider'), 'Claude');
  });

  test('各自狀態：AI 辨識跑著時，文字辨識照樣能按（只禁用自己那顆）', async () => {
    let release;
    const { e, el } = env({ handler: {
      clipVision: () => new Promise((r) => { release = () => r({ success: true, vision_output: 'v', vision_provider: 'Gemini', vision_at: '' }); }),
      clipOcr: { success: true, ocr_output: 'o', ocr_at: '' } } });
    e.call('openClip', 'c1');
    const p = e.callRaw('runClipVision');
    await new Promise((r) => setImmediate(r));
    const html = el('clipReader').innerHTML;
    assert.match(html, /<button[^>]*disabled[^>]*>AI 辨識中…<\/button>/);
    assert.match(html, /<button[^>]*onclick="runClipOcr\(\)"\s*>📝 文字辨識（免費）<\/button>/, '文字辨識那顆沒被禁用');
    await e.callRaw('runClipOcr');
    await e.callRaw('runClipVision');
    release && release();
    await p;
    assert.equal(sent(e, 'clipOcr').length, 1);
    assert.equal(sent(e, 'clipVision').length, 1, '跑中再按不重送');
  });

  test('已有結果：重跑要確認；捨棄要確認且只清 AI 看圖', async () => {
    const { e, el } = env({ clips: [clip({ vision_output: '舊的看圖', vision_provider: 'Gemini', ocr_output: '圖片文字在' })] });
    e.call('openClip', 'c1');
    e.raw('confirm = function(){ return false; }');
    await e.callRaw('runClipVision');
    await e.callRaw('discardClipVision');
    assert.equal(sent(e, 'clipVision').length, 0);
    e.raw('confirm = function(){ return true; }');
    await e.callRaw('discardClipVision');
    assert.equal(sent(e, 'clipVision')[0].discard, true);
    const html = el('clipReader').innerHTML;
    assert.doesNotMatch(html, /舊的看圖/);
    assert.match(html, /圖片文字在/);
  });

  test('失敗講哪一家；沒 key 指到設定頁', async () => {
    const { e } = env({ handler: { clipVision: (b) => (b.n ? null : { error: 'ai_failed', label: 'OpenAI', reason: 'HTTP 429・呼叫太頻繁' }) } });
    e.call('openClip', 'c1');
    await e.callRaw('runClipVision');
    assert.ok(e.toasts.some((t) => /OpenAI 辨識失敗.*HTTP 429/.test(t)));
    const { e: e2 } = env({ handler: { clipVision: { error: 'no_key' } } });
    e2.call('openClip', 'c1');
    await e2.callRaw('runClipVision');
    assert.ok(e2.toasts.some((t) => /AI 供應商/.test(t)));
  });

  test('成本卡的各功能列認得 clip_vision', () => {
    const { e } = env();
    const html = e.call('costSummaryHtml', { success: true, by_feature: [{ feature: 'clip_vision', usd: 0.01 }], total_usd: 0.01 });
    assert.match(html, /收藏 AI 辨識/);
  });
});

describe('1.0 不動', () => {
  test('1.0 閱讀頁沒有 AI 辨識', () => {
    const { e, el } = env({ v2: false, clips: [clip({ vision_output: '看圖結果' })] });
    e.call('openClip', 'c1');
    assert.doesNotMatch(el('clipReader').innerHTML, /AI 辨識|AI 看圖/);
  });
});
