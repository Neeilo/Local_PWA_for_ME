/**
 * ADR-028 PR-B（前端）— 圖書館週報：📊 週報分段、🤖 AI 建議篩選、一鍵標已讀、閱讀頁理由、我的關注（只在 2.0）
 *
 * 盯的事（交棒頁 PR-B 驗收）：
 *   - 週報分段：成功／失敗／空（還沒有週報）／關注空白 四種畫面；手動的標「預覽」；歷史各期可翻
 *   - 「📊 立即產生」：送 clipReportRun（trigger=manual），跑中禁用
 *   - 可略過：預設全勾、取消勾選的不送、二次確認後才送、成功後列表即時更新；取消確認就不送
 *   - 🤖 AI 建議篩選與既有篩選並用、數量正確；篩到 🗑️ 也能一鍵標已讀
 *   - 閱讀頁顯示「🤖 推薦／可略過：理由」
 *   - 我的關注：點開設定才讀（clipFocus）、存檔送 clipFocusSet（trigger=write）
 *   - 1.0 一個都不出現
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: '', feat_clips: 'TRUE', feat_notes: 'TRUE', feat_ui_v2: 'TRUE' };
const clip = (id, extra = {}) => Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
  caption: '標題 ' + id + '\n內文', author: 'a', collected_at: '2026-11-10T01:00:00.000Z', read_status: '', category: '', error: '',
  report_verdict: '', report_reason: '', report_at: '' }, extra);
const AT = '2026-11-13T11:30:00.000Z';
const CLIPS = [
  clip('r1', { report_verdict: 'recommend', report_reason: '實用的流程', report_at: AT, category: '投資' }),
  clip('r2', { report_verdict: 'recommend', report_reason: '舊的好文', report_at: AT }),
  clip('s1', { report_verdict: 'skip', report_reason: '留言領取的引流文', report_at: AT, category: '投資' }),
  clip('s2', { report_verdict: 'skip', report_reason: '和另一篇重複', report_at: AT }),
  clip('s3', { report_verdict: 'skip', report_reason: '已讀過', report_at: AT, read_status: 'read' }),
  clip('n1', { report_verdict: 'normal', report_reason: '普通', report_at: AT })
];
const REPORT = {
  id: 'rep_1', type: 'scheduled', week: '2026-11-13', period_start: '2026-11-06T11:00:00.000Z', period_end: AT, created_at: AT,
  provider: 'Gemini', status: 'ok', error: '', used_focus: false,
  recommended: [{ id: 'r1', group: 'new', reason: '實用的流程' }, { id: 'r2', group: 'old', reason: '舊的好文' }],
  skippable: [{ id: 's1', group: 'new', reason: '留言領取的引流文' }, { id: 's2', group: 'old', reason: '和另一篇重複' }, { id: 's3', group: 'old', reason: '已讀過' }],
  summary: { new_total: 3, new_ig: 2, new_threads: 1, unread: 5, reading: 0, read: 1, unread_delta: -2, categories: {}, recommend: 2, normal: 1, skip: 3, prev_rec_total: 4, prev_rec_read: 1 }
};
const VIEW = { success: true, report: REPORT, history: [{ id: 'rep_1', type: 'scheduled', status: 'ok', created_at: AT }, { id: 'rep_0', type: 'manual', status: 'failed', created_at: '2026-11-12T01:00:00.000Z' }], focus_set: false };

function env({ ui = 'v2', handler = {}, confirmAnswer = true } = {}) {
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
    __toasts = []; toast = function(m){ __toasts.push(m); }; window.scrollTo = function(){};
    __confirms = []; confirm = function(m){ __confirms.push(m); return ${confirmAnswer}; };`);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; myLineId = "${ME}";`);
  e.raw('roster = ' + JSON.stringify([USER]));
  e.call('applyModules', [{ module_id: 'library', name: 'l', category: '知識', icon: '•', enabled: true, sort: 1 }]);
  e.raw(`clipCats = []; clipsData = ${JSON.stringify(CLIPS)};`);
  e.el = (id) => e.read(`(__els[${JSON.stringify(id)}] || {}).innerHTML || ''`);
  e.hidden = (id) => e.read(`!!(__els[${JSON.stringify(id)}] || {}).hidden`);
  e.listIds = () => [...e.el('clipList').matchAll(/class="clip-item[^"]*" onclick="openClip\('([^']+)'\)/g)].map((m) => m[1]);
  return e;
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

describe('📊 週報分段', () => {
  test('切到週報才讀（clipReport、trigger=manual）；列表與設定收起來', async () => {
    const e = env({ handler: { clipReport: VIEW } });
    e.call('renderClips');
    assert.equal(sent(e, 'clipReport').length, 0, '不進冷開機');
    assert.equal(e.hidden('clipReportCard'), true);
    e.call('pickClipPane', 'report');
    await settle();
    assert.equal(sent(e, 'clipReport')[0].body.trigger, 'manual');
    assert.equal(e.hidden('clipReportCard'), false);
    assert.equal(e.hidden('clipListCard'), true);
    assert.equal(e.hidden('clipCfgCard'), true);
  });

  test('成功：數字總覽、推薦分新收／舊庫存（標題＋理由，點了進閱讀頁）、可略過、歷史各期', () => {
    const e = env();
    e.raw(`clipPane = "report"; clipReport = ${JSON.stringify(VIEW)};`);
    e.call('renderClips');
    const h = e.el('clipReportBody');
    assert.match(h, /本週新收 3 篇（IG 2・Threads 1）/);
    assert.match(h, /未讀 5（比上期少 2 篇）/);
    assert.match(h, /上期推薦已讀 1／4/);
    assert.match(h, /⭐ 推薦｜本週新收<\/b><\/div><div class="clip-rep-item" onclick="openClipFromReport\(&quot;r1&quot;\)">[^]*標題 r1[^]*實用的流程/);
    assert.match(h, /⭐ 推薦｜舊庫存[^]*標題 r2/);
    assert.match(h, /🗑️ 可略過（3）/);
    assert.match(h, /全部標為已讀（2）/, '已讀的那篇不算');
    assert.match(h, /11\/12 預覽 ⚠️/, '歷史：手動標預覽、失敗有記號');
  });

  test('關注空白：頂端提示＋前往設定；有設定就不提示', () => {
    const e = env();
    e.raw(`clipPane = "report"; clipReport = ${JSON.stringify(VIEW)};`);
    e.call('renderClips');
    assert.match(e.el('clipReportBody'), /尚未設定關注，推薦僅供參考[^]*openClipFocus\(\)/);
    e.raw('clipReport.focus_set = true');
    e.call('renderClips');
    assert.doesNotMatch(e.el('clipReportBody'), /尚未設定關注/);
  });

  test('失敗的一期顯示原因；還沒有週報有說明；手動的標預覽', () => {
    const e = env();
    const failed = Object.assign({}, VIEW, { report: Object.assign({}, REPORT, { type: 'manual', status: 'failed', error: 'AI 呼叫失敗：HTTP 429', recommended: [], skippable: [] }) });
    e.raw(`clipPane = "report"; clipReport = ${JSON.stringify(failed)};`);
    e.call('renderClips');
    assert.match(e.el('clipReportBody'), /這一期產生失敗：AI 呼叫失敗：HTTP 429/);
    assert.match(e.el('clipReportBody'), /（預覽）/);
    e.raw(`clipReport = ${JSON.stringify({ success: true, report: null, history: [], focus_set: true })}`);
    e.call('renderClips');
    assert.match(e.el('clipReportBody'), /還沒有週報/);
  });

  test('📊 立即產生：送 clipReportRun（trigger=manual），跑中禁用；完成後重讀那一期與收藏', async () => {
    let resolve;
    const e = env({ handler: {
      clipReportRun: () => new Promise((r) => { resolve = () => r({ success: true, report: REPORT }); }),
      clipReport: VIEW, readMany: { success: true, data: { clips: CLIPS } }
    } });
    e.raw('clipPane = "report"');
    const p = e.call('runClipReport');
    await settle();
    assert.match(e.el('clipReportBody'), /disabled>產生中…/);
    assert.equal(sent(e, 'clipReportRun')[0].body.trigger, 'manual');
    resolve();
    await p;
    assert.equal(sent(e, 'clipReport').at(-1).body.id, 'rep_1');
    assert.equal(sent(e, 'readMany').length, 1);
  });
});

describe('一鍵標已讀（D-4）', () => {
  test('週報裡：取消勾選的不送；先確認筆數；成功後列表即時更新', async () => {
    const e = env({ handler: { clipMarkRead: (b) => ({ success: true, changed: b.ids.length, ids: b.ids }) } });
    e.raw(`clipPane = "report"; clipReport = ${JSON.stringify(VIEW)};`);
    e.call('toggleClipSkip', 's2');
    e.call('renderClips');
    assert.match(e.el('clipReportBody'), /全部標為已讀（1）/);
    const ok = await e.call('markClipsRead', ['s1']);
    assert.equal(ok, true);
    assert.deepEqual(sent(e, 'clipMarkRead')[0].body.ids, ['s1']);
    assert.equal(sent(e, 'clipMarkRead')[0].body.trigger, 'write');
    assert.match(e.read('__confirms[0]'), /把 1 篇標為已讀/);
    assert.equal(e.read('clipsData.find(function(c){ return c.id === "s1"; }).read_status'), 'read');
    assert.equal(e.read('clipsData.find(function(c){ return c.id === "s2"; }).read_status'), '', '取消勾選的沒動');
  });

  test('取消確認：不送', async () => {
    const e = env({ confirmAnswer: false, handler: { clipMarkRead: { success: true, ids: [] } } });
    assert.equal(await e.call('markClipsRead', ['s1']), false);
    assert.equal(sent(e, 'clipMarkRead').length, 0);
  });
});

describe('🤖 AI 建議篩選（D-5）', () => {
  test('數量正確；與分類、閱讀狀態篩選並用', () => {
    const e = env();
    e.call('renderClips');
    assert.match(e.el('clipAiSeg'), /⭐ 推薦 2/);
    assert.match(e.el('clipAiSeg'), /🗑️ 可略過 3/);
    e.call('pickClipAiFilter', 'skip');
    assert.deepEqual(e.listIds().sort(), ['s1', 's2', 's3']);
    e.raw('clipCatFilter = "投資"');
    e.call('renderClips');
    assert.deepEqual(e.listIds(), ['s1']);
    e.raw('clipCatFilter = ""; clipFilter = "unread"');
    e.call('renderClips');
    assert.deepEqual(e.listIds().sort(), ['s1', 's2'], '已讀的 s3 被閱讀狀態篩掉');
  });

  test('篩到 🗑️：每篇有勾選框（已讀的沒有）、上面有「全部標為已讀」；取消勾選的不算', () => {
    const e = env();
    e.call('pickClipAiFilter', 'skip');
    assert.match(e.el('clipSkipBar'), /全部標為已讀（2）/);
    assert.equal((e.el('clipList').match(/class="clip-pick"/g) || []).length, 2);
    e.call('toggleClipSkip', 's1');
    assert.match(e.el('clipSkipBar'), /全部標為已讀（1）/);
    assert.match(e.el('clipSkipBar'), /markClipsRead\(\[&quot;s2&quot;\]\)/);
  });

  test('列表小標記', () => {
    const e = env();
    e.call('renderClips');
    assert.match(e.el('clipList'), /⭐ 推薦/);
    assert.match(e.el('clipList'), /🗑️ 可略過/);
  });
});

describe('閱讀頁與我的關注', () => {
  test('閱讀頁顯示「🤖 推薦：理由（11/13 週報）」', () => {
    const e = env({ handler: { clipRead: { success: true } } });
    e.call('openClip', 'r1');
    assert.match(e.el('clipReader'), /🤖 ⭐ 推薦：實用的流程（11\/13 週報）/);
  });

  test('點開設定才讀「我的關注」；存檔送 clipFocusSet（trigger=write）', async () => {
    const e = env({ handler: { clipFocus: { success: true, focus: '', max: 2000 }, clipFocusSet: (b) => ({ success: true, focus: b.focus }) } });
    e.call('renderClips');
    assert.equal(sent(e, 'clipFocus').length, 0);
    e.call('toggleFold', 'clipCfg');
    await settle();
    assert.equal(sent(e, 'clipFocus').length, 1);
    assert.equal(sent(e, 'clipSettings').length, 0, '非管理者不讀管理設定');
    assert.match(e.el('clipCfgBody'), /我的關注[^]*0／2000 字/);
    e.call('clipFocusInput', '只看 AI 自動化');
    assert.equal(await e.call('saveClipFocus'), true);
    const s = sent(e, 'clipFocusSet')[0].body;
    assert.deepEqual([s.focus, s.trigger], ['只看 AI 自動化', 'write']);
  });
});

describe('1.0 不變', () => {
  test('沒有週報分段、AI 篩選、標記、勾選、閱讀頁理由', () => {
    const e = env({ ui: 'v1' });
    e.raw('clipAiFilter = "skip"');
    e.call('renderClips');
    assert.equal(e.hidden('clipPaneSeg'), true);
    assert.equal(e.hidden('clipAiSeg'), true);
    assert.doesNotMatch(e.el('clipList'), /⭐ 推薦|🗑️ 可略過|clip-pick/);
    assert.equal(e.el('clipSkipBar'), '');
    e.raw('clipOpenId = "r1"');
    e.call('renderClips');
    assert.doesNotMatch(e.el('clipReader'), /🤖/);
  });
});
