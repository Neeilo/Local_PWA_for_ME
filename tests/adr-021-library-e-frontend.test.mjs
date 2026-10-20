/**
 * ADR-021 PR-E（前端）— 圖書館：筆記、AI 整理、只存連結、全部／未讀、加網址（D-10～D-13）
 *
 * 為什麼有這批測試：
 *  - 筆記存檔帶 revision；被拒（另一台已更新）→ 講出來、雲端新版顯示、**使用者打的字留在框裡**；
 *    再按一次儲存才用新版的 revision 蓋過去（是使用者決定，不是程式猜）（EXP-03）
 *  - 打字中途畫面重畫（例如按重新整理）不能吃掉打到一半的字
 *  - AI 整理：按了才跑；重做、捨棄要確認；失敗講是哪一家
 *  - 只存連結：列表與閱讀頁講清楚沒有原文、給「回原站閱讀」
 *  - 2.0 的雜記頁不再有「收藏」分段；圖書館的標題是「圖書館」
 *  - 1.0 不動（D-20）：閱讀頁沒有筆記與 AI、沒有加網址、沒有未讀篩選
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_notes: 'TRUE', feat_clips: 'TRUE', feat_ui_v2: 'TRUE' };
const P1 = 'https://www.instagram.com/p/AAA111/';

const clip = (o = {}) => Object.assign({ id: 'c1', line_id: ME, url: P1, kind: 'post', status: 'done', author: 'someone', caption: '原文第一行\n第二行',
  media_saved: 1, image_ids: '["f1"]', collected_at: '2026-10-19T01:00:00.000Z', note: '舊筆記', note_revision: 12, read_status: '' }, o);
const LINK = clip({ id: 'k1', kind: 'link', status: 'link', url: 'https://www.example.com/a/b', author: '', caption: '', image_ids: '', note: '', note_revision: '' });

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
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/* ========================================================================== */
describe('筆記（D-10、EXP-03）', () => {
  test('閱讀頁有筆記框（帶雲端的筆記）；存檔送 clipNote＋手上的 revision＋trigger', async () => {
    const { e, el } = env({ handler: { clipNote: { success: true, revision: 13, note_updated_at: '2026-10-20T02:00:00.000Z' } } });
    e.call('openClip', 'c1');
    assert.match(el('clipReader').innerHTML, /id="clipNoteInput"[^>]*>舊筆記<\/textarea>/);
    e.call('clipNoteInput', '新的想法');
    await e.callRaw('saveClipNote');
    const s = sent(e, 'clipNote')[0];
    assert.deepEqual([s.id, s.note, s.revision, s.trigger], ['c1', '新的想法', 12, 'write']);
    assert.equal(e.read('clipsData[0].note_revision'), 13);
    assert.match(el('clipReader').innerHTML, />新的想法<\/textarea>/);
    assert.ok(e.toasts.some((t) => /筆記已存/.test(t)));
  });

  test('被拒（另一台已更新）：講出來、顯示雲端新版、打的字留在框裡；再按一次用新版 revision 存', async () => {
    let n = 0;
    const { e, el } = env({ handler: { clipNote: (b) => (++n === 1
      ? { error: 'conflict', note: 'PC 寫的', revision: 13, note_updated_at: '2026-10-20T02:00:00.000Z' }
      : { success: true, revision: b.revision + 1, note_updated_at: '2026-10-20T02:05:00.000Z' }) } });
    e.call('openClip', 'c1');
    e.call('clipNoteInput', '手機寫的');
    await e.callRaw('saveClipNote');
    assert.ok(e.toasts.some((t) => /另一台已更新/.test(t)));
    const html = el('clipReader').innerHTML;
    assert.match(html, /另一台已更新/);
    assert.match(html, /PC 寫的/);
    assert.match(html, />手機寫的<\/textarea>/, '你打的字還在框裡');
    await e.callRaw('saveClipNote');
    const s = sent(e, 'clipNote');
    assert.deepEqual([s[1].note, s[1].revision], ['手機寫的', 13]);
    assert.doesNotMatch(el('clipReader').innerHTML, /另一台已更新/);
  });

  test('打到一半畫面重畫（重新整理收藏）：打的字不見', async () => {
    const { e, el } = env();
    e.call('openClip', 'c1');
    e.call('clipNoteInput', '打到一半');
    await e.callRaw('loadClips', 'manual');
    assert.match(el('clipReader').innerHTML, />打到一半<\/textarea>/);
  });

  test('存不上去（連線）：講出來、字還在；換一篇就不帶過去', async () => {
    const { e, el } = env({ handler: { clipNote: { error: 'busy' } } });
    e.call('openClip', 'c1');
    e.call('clipNoteInput', '還沒存');
    await e.callRaw('saveClipNote');
    assert.ok(e.toasts.some((t) => /沒有存到/.test(t)));
    assert.match(el('clipReader').innerHTML, />還沒存<\/textarea>/);
    e.call('openClip', 'k1');
    assert.doesNotMatch(el('clipReader').innerHTML, /還沒存/);
  });

  test('「初始化」還沒補欄：講要去初始化', async () => {
    const { e } = env({ handler: { clipNote: { error: 'not_ready' } } });
    e.call('openClip', 'c1');
    await e.callRaw('saveClipNote');
    assert.ok(e.toasts.some((t) => /初始化/.test(t)));
  });
});

/* ========================================================================== */
describe('AI 整理（D-11）', () => {
  test('還沒整理：只有「✨ AI 整理」鈕；按了才送 clipAi，結果顯示「（由 XXX 彙整）」與 📋 複製', async () => {
    const { e, el } = env({ handler: { clipAi: { success: true, ai_output: '重點一', ai_provider: 'Claude', ai_at: '2026-10-20T02:00:00.000Z' } } });
    e.call('openClip', 'c1');
    assert.match(el('clipReader').innerHTML, /✨ AI 整理<\/button>/);
    assert.equal(sent(e, 'clipAi').length, 0, '按了才跑');
    await e.callRaw('runClipAi');
    assert.deepEqual([sent(e, 'clipAi')[0].id, sent(e, 'clipAi')[0].trigger], ['c1', 'write']);
    const html = el('clipReader').innerHTML;
    assert.match(html, /重點一/);
    assert.match(html, /（由 Claude 彙整）/);
    assert.match(html, /📋 複製/);
    assert.match(html, /舊筆記/, '筆記一塊、AI 整理另一塊，筆記不被蓋掉');
  });

  test('重做要確認；不確認就不送', async () => {
    const { e } = env({ clips: [clip({ ai_output: '上一份', ai_provider: 'Gemini' })] });
    e.call('openClip', 'c1');
    e.raw('confirm = function(){ return false; }');
    await e.callRaw('runClipAi');
    assert.equal(sent(e, 'clipAi').length, 0);
  });

  test('捨棄要確認，送 discard:true，畫面回到「✨ AI 整理」', async () => {
    const { e, el } = env({ clips: [clip({ ai_output: '上一份', ai_provider: 'Gemini' })] });
    e.call('openClip', 'c1');
    await e.callRaw('discardClipAi');
    assert.equal(sent(e, 'clipAi')[0].discard, true);
    assert.doesNotMatch(el('clipReader').innerHTML, /上一份/);
  });

  test('AI 失敗：講是哪一家、原因；舊的結果留著', async () => {
    const { e, el } = env({ clips: [clip({ ai_output: '上一份', ai_provider: 'Gemini' })],
      handler: { clipAi: { error: 'ai_failed', label: 'Claude', reason: 'HTTP 429・額度用完' } } });
    e.call('openClip', 'c1');
    await e.callRaw('runClipAi');
    assert.ok(e.toasts.some((t) => /Claude/.test(t) && /額度用完/.test(t)));
    assert.match(el('clipReader').innerHTML, /上一份/);
  });
});

/* ========================================================================== */
describe('只存連結（D-12）與加網址', () => {
  test('列表：🔗 只存連結＋網域，不顯示張數', () => {
    const { e, el } = env();
    e.call('renderClips');
    const html = el('clipList').innerHTML;
    assert.match(html, /🔗 只存連結/);
    assert.match(html, /example\.com/);
  });

  test('閱讀頁：「回原站閱讀」、講沒有原文、AI 只讀筆記；沒有重跑', () => {
    const { e, el } = env();
    e.call('openClip', 'k1');
    const html = el('clipReader').innerHTML;
    assert.match(html, /回原站閱讀/);
    assert.match(html, /沒有抓原文/);
    assert.match(html, /AI 只讀你的筆記/);
    assert.doesNotMatch(html, /重跑/);
  });

  test('＋ 加網址：送 clipAdd（trigger=write），成功清空輸入框並重新讀收藏；不是網址講清楚', async () => {
    const { e, el } = env({ handler: { clipAdd: (b) => (/^https?:/.test(b.url) ? { success: true, kind: 'link' } : { error: 'invalid_url', permanent: true }) } });
    e.call('renderClips');
    e.raw('document.getElementById("clipAddUrl").value = "https://example.com/new"');
    await e.callRaw('addClipUrl');
    assert.deepEqual([sent(e, 'clipAdd')[0].url, sent(e, 'clipAdd')[0].trigger], ['https://example.com/new', 'write']);
    assert.equal(el('clipAddUrl').value, '');
    assert.ok(sent(e, 'readMany').length >= 1);
    assert.ok(e.toasts.some((t) => /只存連結/.test(t)));
    e.raw('document.getElementById("clipAddUrl").value = "不是網址"');
    await e.callRaw('addClipUrl');
    assert.ok(e.toasts.some((t) => /網址/.test(t) && /不對|貼完整/.test(t)));
  });
});

/* ========================================================================== */
describe('全部／未讀（D-13）', () => {
  test('未讀＝收齊或只存連結、沒讀過；處理中的不算', () => {
    const { e, el } = env({ clips: [clip({ id: 'a', read_status: 'read' }), clip({ id: 'b' }), clip({ id: 'p', status: 'pending' }), LINK] });
    e.call('pickClipFilter', 'unread');
    const html = el('clipList').innerHTML;
    assert.doesNotMatch(html, /openClip\('a'\)/);
    assert.match(html, /openClip\('b'\)/);
    assert.doesNotMatch(html, /openClip\('p'\)/);
    assert.match(html, /openClip\('k1'\)/);
    assert.match(el('clipFilterSeg').innerHTML, /未讀 2/);
  });

  test('未讀全讀完：講沒有未讀，不是「去 LINE 貼網址」', () => {
    const { e, el } = env({ clips: [clip({ read_status: 'read' })] });
    e.call('pickClipFilter', 'unread');
    assert.match(el('clipList').innerHTML, /沒有未讀/);
  });
});

/* ========================================================================== */
describe('2.0 圖書館 Tab；1.0 不動', () => {
  test('2.0：雜記頁沒有「收藏」分段', () => {
    const { e, el } = env();
    e.call('renderNoteSeg');
    assert.equal(el('noteSeg').hidden, true);
  });

  test('2.0：圖書館的標題是「圖書館」；之後從 Apps 進雜記，回到雜記本身（不是收藏）', async () => {
    const { e, el } = env();
    e.raw('v2Loaded = {notes:true}');
    await e.callRaw('openLibrary');
    assert.equal(el('viewTitle').textContent, '圖書館');
    e.call('goView', 'notes');
    assert.equal(e.read('noteSeg'), 'notes');
    assert.equal(el('clipCards').hidden, true);
    assert.equal(el('viewTitle').textContent, '雜記');
  });

  test('Reading Widget「未讀 N 篇 →」：進圖書館直接切到未讀', async () => {
    const { e } = env();
    await e.callRaw('openLibrary', 'unread');
    assert.equal(e.read('clipFilter'), 'unread');
  });

  test('1.0：閱讀頁沒有筆記與 AI；沒有加網址、沒有未讀篩選；分段照舊', () => {
    const { e, el } = env({ v2: false });
    e.call('renderNoteSeg');
    assert.equal(el('noteSeg').hidden, false);
    e.call('renderClips');
    assert.equal(el('clipAddRow').hidden, true);
    assert.equal(el('clipFilterSeg').hidden, true);
    e.call('openClip', 'c1');
    const html = el('clipReader').innerHTML;
    assert.doesNotMatch(html, /clipNoteInput|AI 整理/);
    assert.match(html, /開啟原文/);
  });
});
