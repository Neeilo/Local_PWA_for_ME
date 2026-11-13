/**
 * ADR-027 PR-A（前端）— 圖書館 Threads：來源小標籤、「串文可能不完整」、⚙️ 圖書館設定、成本卡分開顯示（只在 2.0）
 *
 * 盯的事：
 *   - 列表與閱讀頁加來源小標籤（IG／Threads）；只存連結的不加；1.0 一個都不出現
 *   - 閱讀頁「串文可能不完整」只在有標記的 Threads 篇出現
 *   - ⚙️ 圖書館設定：只有 2.0 管理者看得到；點開摺疊才讀（clipSettings、trigger=manual）；
 *     開關送 clipSettingsSet（trigger=write），雲端存好才變；「本月超過上限仍繼續抓」會付費，先確認、取消就不送
 *   - 成本卡：IG／Threads 分開的用量；暫停與 Threads 成功率低於 80% 要提示
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_clips: 'TRUE', feat_notes: 'TRUE', feat_ui_v2: 'TRUE' };
const clip = (id, extra = {}) => Object.assign({ id, line_id: ME, url: 'https://www.instagram.com/p/' + id + '/', kind: 'post', status: 'done',
  caption: '內文 ' + id, author: 'a', collected_at: '2026-11-13T01:00:00.000Z', read_status: 'read', category: '', error: '' }, extra);
const CLIPS = [
  clip('ig1'),
  clip('th1', { kind: 'threads', url: 'https://www.threads.com/@demo.user/post/TAAA111' }),
  clip('th2', { kind: 'threads', url: 'https://www.threads.com/@demo.user/post/TBBB222', error: '串文可能不完整' }),
  clip('ln1', { kind: 'link', status: 'link', url: 'https://example.com/x' })
];
const SETTINGS = { ig_images: true, ig_videos: true, threads_images: true, threads_videos: false, force_month: '' };
const GATE = { month: '2026-11', usd: 1.2, account_usd: 1.2, threads_usd: 0.5, ig_usd: 0.7, cap: 3, over: false, forced: false, paused: false };

function env({ ui = 'v2', handler = {}, user = USER, confirmAnswer = true } = {}) {
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
  e.raw('roster = ' + JSON.stringify([user]));
  e.call('applyModules', [{ module_id: 'library', name: 'l', category: '知識', icon: '•', enabled: true, sort: 1 }]);
  e.raw(`clipCats = []; clipsData = ${JSON.stringify(CLIPS)};`);
  e.el = (id) => e.read(`(__els[${JSON.stringify(id)}] || {}).innerHTML || ''`);
  e.hidden = (id) => e.read(`!!(__els[${JSON.stringify(id)}] || {}).hidden`);
  return e;
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

describe('來源小標籤與「串文可能不完整」（D-5、D-6）', () => {
  test('列表：IG／Threads 各自標，只存連結的不標', () => {
    const e = env();
    e.call('renderClips');
    const items = e.el('clipList').split('class="clip-item');
    const tagOf = (id) => (items.find((h) => h.includes(`openClip('${id}')`)) || '').match(/clip-src">([^<]+)</);
    assert.equal(tagOf('ig1')[1], 'IG');
    assert.equal(tagOf('th1')[1], 'Threads');
    assert.equal(tagOf('ln1'), null);
  });

  test('閱讀頁：有標記的 Threads 才顯示「串文可能不完整」', () => {
    const e = env({ handler: { clipRead: { success: true } } });
    e.call('openClip', 'th2');
    assert.match(e.el('clipReader'), /串文可能不完整/);
    assert.match(e.el('clipReader'), /clip-src">Threads/);
    e.call('openClip', 'th1');
    assert.doesNotMatch(e.el('clipReader'), /串文可能不完整/);
  });

  test('1.0：標籤與提示都不出現', () => {
    const e = env({ ui: 'v1' });
    e.call('renderClips');
    assert.doesNotMatch(e.el('clipList'), /clip-src/);
    e.raw('clipOpenId = "th2"');
    e.call('renderClips');
    assert.doesNotMatch(e.el('clipReader'), /串文可能不完整|clip-src/);
  });
});

describe('⚙️ 圖書館設定（管理者、2.0）', () => {
  test('2.0 才有；閱讀頁打開時收起來；存圖片／影片開關只有管理者（ADR-028 起非管理者也看得到卡片，只有「我的關注」）', () => {
    const e = env();
    e.call('renderClips');
    assert.equal(e.hidden('clipCfgCard'), false);
    e.raw('clipOpenId = "ig1"');
    e.call('renderClips');
    assert.equal(e.hidden('clipCfgCard'), true);
    const nonAdmin = env({ user: Object.assign({}, USER, { is_admin: '' }) });
    nonAdmin.raw(`clipCfg = ${JSON.stringify({ success: true, settings: SETTINGS, gate: GATE })}`);
    nonAdmin.call('renderClips');
    assert.equal(nonAdmin.hidden('clipCfgCard'), false);
    assert.doesNotMatch(nonAdmin.el('clipCfgBody'), /IG 存圖片|本月超過上限/);
    assert.match(nonAdmin.el('clipCfgBody'), /我的關注/);
    const v1 = env({ ui: 'v1' });
    v1.call('renderClips');
    assert.equal(v1.hidden('clipCfgCard'), true);
  });

  test('點開摺疊才讀（clipSettings、trigger=manual）；畫出四個開關、本月用量與續抓開關', async () => {
    const e = env({ handler: { clipSettings: { success: true, settings: SETTINGS, gate: GATE } } });
    e.call('renderClips');
    assert.equal(sent(e, 'clipSettings').length, 0, '不進冷開機');
    e.call('toggleFold', 'clipCfg');
    await settle();
    const s = sent(e, 'clipSettings');
    assert.equal(s.length, 1);
    assert.equal(s[0].body.trigger, 'manual');
    const h = e.el('clipCfgBody');
    for (const l of ['IG 存圖片', 'IG 存影片（Reels）', 'Threads 存圖片', 'Threads 存影片', '本月超過上限仍繼續抓']) assert.ok(h.includes(l), l);
    assert.match(h, /IG 約 US\$0\.70、Threads 約 US\$0\.50/);
    assert.match(h, /setClipCfg\('threads_videos', true\)">不存/);
  });

  test('切開關：送 clipSettingsSet（trigger=write），雲端存好才變', async () => {
    const next = Object.assign({}, SETTINGS, { threads_videos: true });
    const e = env({ handler: { clipSettingsSet: (b) => ({ success: true, settings: next, gate: GATE, echo: b }) } });
    e.raw(`clipCfg = ${JSON.stringify({ success: true, settings: SETTINGS, gate: GATE })}`);
    const ok = await e.call('setClipCfg', 'threads_videos', true);
    assert.equal(ok, true);
    const s = sent(e, 'clipSettingsSet')[0].body;
    assert.deepEqual([s.key, s.value, s.trigger], ['threads_videos', true, 'write']);
    assert.match(e.el('clipCfgBody'), /setClipCfg\('threads_videos', false\)">✅ 存/);
  });

  test('存不進去：畫面不變、講出原因', async () => {
    const e = env({ handler: { clipSettingsSet: { error: 'save_failed' } } });
    e.raw(`clipCfg = ${JSON.stringify({ success: true, settings: SETTINGS, gate: GATE })}`);
    assert.equal(await e.call('setClipCfg', 'ig_images', false), false);
    assert.equal(e.read('clipCfg.settings.ig_images'), true);
    assert.match(e.read('__toasts.join("|")'), /雲端存不進去/);
  });

  test('本月強制續抓會付費：先確認；取消就不送', async () => {
    const e = env({ confirmAnswer: false, handler: { clipSettingsSet: { success: true, settings: SETTINGS, gate: GATE } } });
    assert.equal(await e.call('setClipCfg', 'force', true), false);
    assert.equal(sent(e, 'clipSettingsSet').length, 0);
    assert.match(e.read('__confirms.join("|")'), /Apify 費用/);
    const off = env({ confirmAnswer: false, handler: { clipSettingsSet: { success: true, settings: SETTINGS, gate: GATE } } });
    await off.call('setClipCfg', 'force', false);
    assert.equal(sent(off, 'clipSettingsSet').length, 1, '關掉不用確認');
  });

  test('達上限：設定卡講明 IG 與 Threads 都暫停', () => {
    const e = env();
    e.raw(`clipCfg = ${JSON.stringify({ success: true, settings: SETTINGS, gate: Object.assign({}, GATE, { usd: 3.1, over: true, paused: true }) })}`);
    e.call('renderClips');
    assert.match(e.el('clipCfgBody'), /IG 與 Threads 收藏都暫停/);
  });
});

describe('💸 成本卡：IG／Threads 分開（只在 2.0）', () => {
  const U = { usd: 1.2, at: '2026-11-13T00:00:00Z', error: '', done: 3, total: 3, rate: 1, threads_done: 1, threads_total: 3, threads_rate: 0.333 };

  test('分開顯示用量；Threads 成功率低於 80% 要提示；暫停要提示', () => {
    const e = env();
    const h = e.call('clipsUsageHtml', Object.assign({}, U, { gate: GATE }));
    assert.match(h, /IG 約 US\$0\.70・Threads 約 US\$0\.50/);
    assert.match(h, /Threads 近 3 天成功率低於 80%/);
    const paused = e.call('clipsUsageHtml', Object.assign({}, U, { gate: Object.assign({}, GATE, { paused: true }) }));
    assert.match(paused, /IG 與 Threads 收藏都暫停/);
  });

  test('1.0 的系統設定卡照舊（不加 IG／Threads 分開那段）', () => {
    const e = env({ ui: 'v1' });
    assert.doesNotMatch(e.call('clipsUsageHtml', Object.assign({}, U, { gate: GATE })), /Threads/);
  });
});
