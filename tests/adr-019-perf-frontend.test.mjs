/**
 * ADR-019 B-3（交棒 PR-2）— request_id：前端
 *
 * 為什麼有這批測試：手機耗時夾在「下一次請求」上傳、寫成獨立一列，原本無法跟 server 那列配對，
 * 開機 7.8 秒裡有多少是「server 外」（網路、GAS 冷啟動）算不出來。
 * 盯的事：
 *   - 每個請求都帶一個 request_id，每次都不一樣；有 crypto.randomUUID 就用，舊裝置退回時間戳＋亂數
 *   - 手機量的那筆帶著**它量的那次請求**的 request_id，與實際發生時間 at
 *     （寫入、開機、輪詢都一樣；被重送的紀錄不換 ID）
 *   - 切區不打請求，沒有 request_id 可配，不帶
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const TOKEN = 'tok-test-device';
const RID = /^[A-Za-z0-9_-]{8,64}$/;   // 跟後端 PERF_REQUEST_ID_RE 同一個形狀

const json = (v) => ({ json: () => Promise.resolve(v) });
const BOOT_OK = {
  session: { status: 'ok', line_id: ME, device_id: 'dev-0' },
  line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: '' }],
  data: { tasks: [], notes: [], expenses: [] },
  denied: []
};

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function env({ offline = () => false } = {}) {
  const e = loadFrontend({
    fetchImpl: ({ body }) => {
      if (offline(body)) return Promise.reject(new Error('offline'));
      if (body.action === 'boot') return json(BOOT_OK);
      if (body.action === 'readMany') return json({ data: { tasks: [], notes: [], expenses: [] }, denied: [] });
      return json({ success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "' + TOKEN + '"; localOnly = false; outbox = []; gateMode = null');
  e.raw('state = EMPTY_STATE()');
  e.raw('applyIdentity = function(){}');
  return e;
}

const pending = (e) => e.read('perfPending');

/* ========================================================================== */
describe('每個請求帶 request_id', () => {

  test('每次都不一樣、形狀跟後端收的一致（舊裝置沒有 crypto：時間戳＋亂數）', async () => {
    const e = env();
    await e.callRaw('cloudPost', { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    await e.callRaw('cloudPost', { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    const ids = e.calls.map((c) => c.body.request_id);
    assert.equal(ids.length, 2);
    ids.forEach((id) => assert.match(id, RID));
    assert.notEqual(ids[0], ids[1]);
  });

  test('有 crypto.randomUUID 就用它', async () => {
    const e = env();
    e.raw('crypto = { randomUUID: function(){ return "11111111-2222-4333-8444-555555555555"; } }');
    await e.callRaw('cloudPost', { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    assert.equal(e.calls[0].body.request_id, '11111111-2222-4333-8444-555555555555');
  });
});

/* ========================================================================== */
describe('手機量的那筆帶它量的那次請求的 ID', () => {

  test('寫入：紀錄帶這次 upsert 的 request_id 與發生時間', async () => {
    const e = env();
    const before = Date.now();
    await e.callRaw('cloudPost', { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '1' }, trigger: 'write' });
    const p = pending(e);
    assert.equal(p.length, 1);
    assert.equal(p[0].request_id, e.calls[0].body.request_id);
    assert.ok(p[0].at >= before && p[0].at <= Date.now());
  });

  test('開機：boot 那筆帶 boot 請求的 ID（不是後面 stock 的）', async () => {
    const e = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    const boot = e.calls.find((c) => c.body.action === 'boot').body;
    const all = pending(e).concat(...e.calls.map((c) => c.body.perf || []));
    const note = all.find((p) => p.action === 'boot');
    assert.ok(note, '開機要記一筆');
    assert.equal(typeof note.request_id, 'string');
    assert.match(note.request_id, RID);
    assert.equal(note.request_id, boot.request_id);
  });

  test('輪詢：pull 那筆帶 readMany 請求的 ID', async () => {
    const e = env();
    await e.callRaw('timedPull', 'poll');
    await settle();
    const read = e.calls.find((c) => c.body.action === 'readMany').body;
    const note = pending(e).find((p) => p.action === 'pull');
    assert.equal(typeof note.request_id, 'string');
    assert.match(note.request_id, RID);
    assert.equal(note.request_id, read.request_id);
  });

  test('搭不上車被退回：重送時 ID 與發生時間不變', async () => {
    let down = true;
    const e = env({ offline: (b) => down && b.action === 'readMany' });
    await e.callRaw('cloudPost', { action: 'upsert', sheet: 'tasks', key_field: 'id', record: { id: '1' }, trigger: 'write' });
    const first = pending(e)[0];
    await e.callRaw('cloudPost', { action: 'readMany', sheets: ['tasks'], trigger: 'poll' }).catch(() => {});
    down = false;
    await e.callRaw('cloudPost', { action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    const carried = e.calls.at(-1).body.perf;
    assert.equal(typeof first.request_id, 'string');
    assert.match(first.request_id, RID);
    assert.equal(carried[0].request_id, first.request_id);
    assert.equal(carried[0].at, first.at);
  });

  test('切區不打請求：紀錄沒有 request_id，只有發生時間', () => {
    const e = env();
    e.callRaw('perfNote', 'zoneSwitch', 'zone', 120);
    const p = pending(e)[0];
    assert.equal(p.request_id, undefined);
    assert.equal(typeof p.at, 'number');
  });
});

/* ========================================================================== */
describe('管理頁效能摘要：server 外的時間', () => {

  test('對得上的那組多一行「雲端外」；對不到的不顯示（不是 0）', () => {
    const e = env();
    const html = e.call('perfSummaryHtml', { success: true, total: 5, days: 7, server: [], line: [], client: [
      { trigger: 'cold', count: 3, p50: 7800, p90: 9000, paired: 2, outside_p50: 2800 },
      { trigger: 'poll', count: 2, p50: 900, p90: 1200, paired: 0, outside_p50: null }
    ] });
    assert.match(html, /雲端外[^<]*對得上 2 筆[^<]*2\.8/);
    assert.equal((html.match(/雲端外/g) || []).length, 1, '輪詢那組對不到，不顯示');
  });
});
