/**
 * ADR-020 RD-2 — 收藏搜集器：PWA 雜記頁「📚 收藏」
 *
 * 盯的事（對照交棒頁 RD-2 驗收＋Neil 2026-10-16 的兩個裁示）：
 *   - 雜記頁頁首分段「✏️ 雜記｜📚 收藏」；沒有 feat_clips 不顯示分段；底部導覽不動
 *   - **開機與輪詢都不讀 clips**（Neil：先不載入）：點開「📚 收藏」才打 readMany(['clips'])
 *   - 列表：failed／partial 置頂＋紅色標籤＋「重跑」；其餘新的在上；pending 顯示「處理中」；縮圖、作者、前兩行、收藏日、張數
 *   - 紅點：**點開過才亮**（Neil：這次開 App 後讀過收藏、裡面有 failed／partial，雜記導覽格才亮）
 *   - 閱讀頁：圖片照順序、全文保留換行、開啟原文、時間、Reels 標「影片未保存」；圖片載不出來退回「在 Drive 開啟」
 *   - 刪除（確認後）、重跑：走 clipDelete／clipRetry，帶 trigger
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const json = (v) => ({ json: () => Promise.resolve(v) });
const P1 = 'https://www.instagram.com/p/AAA111/';

function clip(o = {}) {
  return Object.assign({
    id: 'c1', line_id: ME, url: P1, shortcode: 'AAA111', kind: 'post', status: 'done', attempts: 1, error: '',
    author: 'someone', posted_at: '2026-10-01T03:04:05.000Z', caption: '第一行\n第二行\n第三行不該出現在卡片',
    media_expected: 3, media_saved: 3, image_ids: '["f1","f2","f3"]', drive_folder_id: 'fd1',
    collected_at: '2026-10-16T02:00:00.000Z', last_collected_at: '2026-10-16T02:00:00.000Z', del: ''
  }, o);
}

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function env({ clips = [clip()], feat = 'TRUE' } = {}) {
  const els = {};
  const e = loadFrontend({
    fetchImpl: ({ body }) => {
      if (!body) return null;
      if (body.action === 'readMany' && (body.sheets || []).includes('clips')) {
        return json(feat === 'TRUE' ? { data: { clips }, denied: [] } : { data: {}, denied: ['clips'] });
      }
      if (body.action === 'boot') {
        return json({ session: { status: 'ok', line_id: ME, device_id: 'd' }, line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', feat_notes: 'TRUE', feat_clips: feat }],
          data: { tasks: [], notes: [], expenses: [] }, denied: [] });
      }
      if (body.action === 'readMany') return json({ data: { tasks: [], notes: [], expenses: [] }, denied: [] });
      return json({ success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "t"; localOnly = false; outbox = []; gateMode = null');
  e.raw('state = EMPTY_STATE()');
  e.raw('roster = [{ line_id: "' + ME + '", display_name: "Neil", is_active: "TRUE", feat_notes: "TRUE", feat_clips: "' + feat + '" }]');
  e.raw('applyIdentity = function(){}');
  e.set('document', Object.assign({}, e.context.document, {
    getElementById: (id) => (els[id] = els[id] || { id, value: '', innerHTML: '', hidden: false, textContent: '', style: {}, dataset: {}, setAttribute() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelectorAll: () => [] })
  }));
  e.els = els;
  return e;
}
const bodies = (e) => e.calls.map((c) => c.body).filter(Boolean);
const clipReads = (e) => bodies(e).filter((b) => b.action === 'readMany' && (b.sheets || []).includes('clips'));

/* ========================================================================== */
describe('讀取時機：開機與輪詢都不帶 clips（Neil 2026-10-16：先不載入）', () => {

  test('開機、輪詢都不讀 clips', async () => {
    const e = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    await e.callRaw('timedPull', 'poll');
    await settle();
    assert.equal(clipReads(e).length, 0);
    assert.ok(!e.read('DATA_SHEETS').includes('clips'));
  });

  test('點開「📚 收藏」才打 readMany([clips])，帶 trigger；再點一次不重打（手動重新整理才重讀）', async () => {
    const e = env();
    await e.callRaw('pickNoteSeg', 'clips');
    await settle();
    assert.equal(clipReads(e).length, 1);
    assert.deepEqual(clipReads(e)[0].sheets, ['clips']);
    assert.equal(clipReads(e)[0].trigger, 'manual');
    await e.callRaw('pickNoteSeg', 'notes');
    await e.callRaw('pickNoteSeg', 'clips');
    await settle();
    assert.equal(clipReads(e).length, 1);
    await e.callRaw('loadClips', 'manual');
    await settle();
    assert.equal(clipReads(e).length, 2);
  });

  test('沒有 feat_clips：不顯示分段', () => {
    const e = env({ feat: '' });
    e.call('renderNoteSeg');
    assert.equal(e.els.noteSeg.hidden, true);
    const ok = env();
    ok.call('renderNoteSeg');
    assert.equal(ok.els.noteSeg.hidden, false);
  });

  test('成員與權限多一個「📚 收藏」開關（feat_clips）', () => {
    const e = env();
    assert.equal(e.read("FEATURE_LABEL['feat_clips']"), '📚 收藏');
    assert.ok(e.read('FEATURE_KEYS').includes('feat_clips'));
  });
});

/* ========================================================================== */
describe('列表', () => {

  test('排序：failed／partial 置頂，其餘新的在上', () => {
    const e = env();
    const list = [
      clip({ id: 'old', collected_at: '2026-10-01T00:00:00Z' }),
      clip({ id: 'new', collected_at: '2026-10-15T00:00:00Z' }),
      clip({ id: 'bad', status: 'failed', collected_at: '2026-09-01T00:00:00Z' }),
      clip({ id: 'half', status: 'partial', collected_at: '2026-09-20T00:00:00Z' }),
      clip({ id: 'wait', status: 'pending', collected_at: '2026-10-10T00:00:00Z' })
    ];
    assert.deepEqual(e.call('clipsSorted', list).map((c) => c.id), ['half', 'bad', 'new', 'wait', 'old']);
  });

  test('卡片：縮圖（第一張的 Drive 縮圖）、作者、前兩行、收藏日、張數', () => {
    const e = env();
    const html = e.call('clipsListHtml', [clip()]);
    assert.match(html, /drive\.google\.com\/thumbnail\?id=f1&amp;sz=w400|drive\.google\.com\/thumbnail\?id=f1&sz=w400/);
    assert.match(html, /someone/);
    assert.match(html, /第一行/);
    assert.match(html, /第二行/);
    assert.doesNotMatch(html, /第三行/);
    assert.match(html, /10\/16/);
    assert.match(html, /3 張/);
  });

  test('failed／partial：紅色標籤＋「重跑」；pending：「處理中」', () => {
    const e = env();
    const html = e.call('clipsListHtml', [clip({ id: 'x', status: 'failed', error: '第 2 張下載失敗' }), clip({ id: 'y', status: 'pending', image_ids: '[]', media_saved: 0 })]);
    assert.match(html, /clip-bad/);
    assert.match(html, /重跑/);
    assert.match(html, /retryClip\('x'\)/);
    assert.match(html, /處理中/);
  });

  test('內容裡的 HTML 一律跳脫', () => {
    const e = env();
    const html = e.call('clipsListHtml', [clip({ author: '<b>x</b>', caption: '<img src=x onerror=alert(1)>' })]);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>x<\/b>/);
  });

  test('一篇都沒有：給一句提示（怎麼收藏）', () => {
    const html = env().call('clipsListHtml', []);
    assert.match(html, /LINE/);
  });
});

/* ========================================================================== */
describe('紅點：點開過才亮（Neil 2026-10-16）', () => {

  test('還沒讀過收藏：不亮；讀到 failed／partial 才亮；都好了就熄', async () => {
    const e = env({ clips: [clip({ status: 'partial' })] });
    assert.equal(e.call('clipsAlert'), false, '還沒讀過不知道，不亮');
    await e.callRaw('loadClips', 'manual');
    await settle();
    assert.equal(e.call('clipsAlert'), true);
    e.raw('clipsData = [{ status: "done" }]');
    assert.equal(e.call('clipsAlert'), false);
  });

  test('雜記導覽格帶紅點（其他格不帶）', async () => {
    const e = env({ clips: [clip({ status: 'failed' })] });
    await e.callRaw('loadClips', 'manual');
    await settle();
    e.raw('zone = "productivity"');
    e.call('renderNav');
    const nav = e.els.nav.innerHTML;
    assert.match(nav, /data-view="notes"[^>]*>[\s\S]*?nav-dot/);
    assert.equal((nav.match(/nav-dot/g) || []).length, 1);
  });
});

/* ========================================================================== */
describe('閱讀頁', () => {

  test('圖片照順序、全文保留換行、開啟原文、發文與收藏時間', () => {
    const html = env().call('clipReaderHtml', clip());
    const order = [...html.matchAll(/thumbnail\?id=(f\d)/g)].map((m) => m[1]);
    assert.deepEqual(order, ['f1', 'f2', 'f3']);
    assert.match(html, /clip-caption/);
    assert.match(html, /第一行\n第二行\n第三行不該出現在卡片/);
    assert.match(html, /href="https:\/\/www\.instagram\.com\/p\/AAA111\/"/);
    assert.match(html, /開啟原文/);
    assert.match(html, /2026-10-01 11:04/);
    assert.match(html, /2026-10-16 10:00/);
  });

  test('圖片載不出來 → 退回「在 Drive 開啟」', () => {
    const html = env().call('clipReaderHtml', clip());
    assert.match(html, /onerror="clipImgFallback\(this,'f1'\)"/);
    const fb = env().call('clipDriveLink', 'f1');
    assert.equal(fb, 'https://drive.google.com/file/d/f1/view');
  });

  test('Reels 標「影片未保存」', () => {
    const html = env().call('clipReaderHtml', clip({ kind: 'reel', image_ids: '["c1"]', media_saved: 1 }));
    assert.match(html, /影片未保存/);
  });

  test('有刪除與重跑', () => {
    const html = env().call('clipReaderHtml', clip({ id: 'z' }));
    assert.match(html, /deleteClip\('z'\)/);
    assert.match(html, /retryClip\('z'\)/);
  });
});

/* ========================================================================== */
describe('操作', () => {

  test('重跑：送 clipRetry（帶 trigger），成功後重讀收藏', async () => {
    const e = env();
    await e.callRaw('retryClip', 'c1');
    await settle();
    const r = bodies(e).find((b) => b.action === 'clipRetry');
    assert.equal(r.id, 'c1');
    assert.equal(r.trigger, 'write');
    assert.equal(clipReads(e).length, 1, '成功後重讀');
  });

  test('刪除：確認後送 clipDelete；取消就不送', async () => {
    const e = env();
    e.set('confirm', () => false);
    await e.callRaw('deleteClip', 'c1');
    assert.ok(!bodies(e).some((b) => b.action === 'clipDelete'));
    e.set('confirm', () => true);
    await e.callRaw('deleteClip', 'c1');
    await settle();
    const d = bodies(e).find((b) => b.action === 'clipDelete');
    assert.equal(d.id, 'c1');
    assert.equal(d.trigger, 'write');
  });

  test('雲端回永久拒絕（不是擁有者）：講清楚，不重送', async () => {
    const e = env();
    e.set('fetch', () => Promise.resolve(json({ error: 'forbidden', permanent: true })));
    await e.callRaw('retryClip', 'c1');
    await settle();
    assert.ok(e.toasts.some((t) => /不是你的|只有收藏的人/.test(t)), e.toasts.join('|'));
  });
});

/* ========================================================================== */
/* RD-HF1：Reels 影片、管理員頁的 Apify 用量                                      */
/* ========================================================================== */
describe('RD-HF1 閱讀頁：Reels 依 video_saved 顯示', () => {

  test('video_saved＝TRUE：「影片已保存（在 Drive 開啟）」，連到這篇的資料夾', () => {
    const html = env().call('clipReaderHtml', clip({ kind: 'reel', image_ids: '["c1"]', media_saved: 1, video_saved: 'TRUE', drive_folder_id: 'fdX' }));
    assert.match(html, /影片已保存/);
    assert.match(html, /href="https:\/\/drive\.google\.com\/drive\/folders\/fdX"[^>]*>在 Drive 開啟/);
    assert.doesNotMatch(html, /影片未保存/);
  });

  test('沒存到：「影片未保存」；過大：講是太大', () => {
    assert.match(env().call('clipReaderHtml', clip({ kind: 'reel', video_saved: '' })), /影片未保存/);
    assert.match(env().call('clipReaderHtml', clip({ kind: 'reel', video_saved: '', error: '影片過大未保存' })), /影片過大未保存/);
  });

  test('貼文不顯示影片那一行', () => {
    assert.doesNotMatch(env().call('clipReaderHtml', clip()), /影片/);
  });
});

describe('RD-HF1 管理員頁：Apify 本月金額＋近 3 天成功率', () => {
  const U = { usd: 0.1534, at: '2026-10-16T01:00:00.000Z', checked_at: '2026-10-16T01:00:00.000Z', error: '', done: 9, total: 10, rate: 0.9 };

  test('一行：金額、更新時間（台北）、成功率；正常不變紅', () => {
    const html = env().call('clipsUsageHtml', U);
    assert.match(html, /Apify 本月 US\$0\.15/);
    assert.match(html, /10-16 09:00/);
    assert.match(html, /近 3 天收藏成功 9／10（90%）/);
    assert.doesNotMatch(html, /sys-warn/);
  });

  test('超過 US$3 變紅；成功率低於 80% 變紅；沒有收藏不算低', () => {
    assert.match(env().call('clipsUsageHtml', Object.assign({}, U, { usd: 3.01 })), /sys-warn/);
    assert.doesNotMatch(env().call('clipsUsageHtml', Object.assign({}, U, { usd: 3 })), /sys-warn/);
    assert.match(env().call('clipsUsageHtml', Object.assign({}, U, { done: 7, rate: 0.7 })), /sys-warn/);
    assert.doesNotMatch(env().call('clipsUsageHtml', Object.assign({}, U, { done: 0, total: 0, rate: null })), /sys-warn/);
  });

  test('讀不到金額：講讀不到＋原因；沒有資料（還沒跑過）就不顯示', () => {
    assert.match(env().call('clipsUsageHtml', Object.assign({}, U, { usd: null, at: '', error: 'HTTP 401' })), /讀不到[\s\S]*HTTP 401/);
    assert.equal(env().call('clipsUsageHtml', null), '');
  });

  test('開機帶的 clips_usage 收進來、畫在系統設定卡', async () => {
    const e = env();
    e.set('fetch', ({}, init) => Promise.resolve(json({ session: { status: 'ok', line_id: ME, device_id: 'd', is_admin: true },
      line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_clips: 'TRUE' }],
      data: { tasks: [], notes: [], expenses: [] }, denied: [], clips_usage: U })));
    await e.callRaw('runBoot', 'cold');
    await settle();
    assert.equal(e.read('clipsUsage && clipsUsage.usd'), 0.1534);
    e.callRaw('renderSysCard');
    assert.match(e.els.sysClipsUsage.innerHTML, /Apify 本月 US\$0\.15/);
  });
});
