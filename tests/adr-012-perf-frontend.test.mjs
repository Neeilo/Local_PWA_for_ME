/**
 * ADR-012 T1（PR-A）— 效能紀錄：前端
 *
 * 盯的事：
 *   - 開 App／回前景／手動刷新／輪詢／寫入，請求上帶對的 trigger
 *   - 手機量的耗時不另外發請求：暫存記憶體，夾在下一個請求裡；送不出去就留著下次再帶
 *   - 輪詢 20 次只取樣 1 次；續期畫面的 session 輪詢一筆都不記
 *   - 讀取失敗不記耗時（那不是「慢」，是「沒讀到」，混進去中位數就不準了）
 *   - 管理員的門檻提醒用 session 順便回的筆數，不另外發請求
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFrontend } from './fake-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ME = 'Uneil';
const TOKEN = 'tok-test-device';
const DATA_SHEETS = ['tasks', 'reviews', 'moods', 'notes', 'expenses'];

const json = (v) => ({ json: () => Promise.resolve(v) });

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** 已配對、雲端照 handler 回應的環境。handler 回 null 代表「寫入成功、讀取空表、session ok」 */
function env(handler = () => null) {
  const e = loadFrontend({
    fetchImpl: ({ body }) => {
      const out = handler(body || {});
      if (out) return out.__reject ? Promise.reject(new Error('offline')) : json(out);
      if (body && body.action === 'session') return json({ status: 'ok', line_id: ME, device_id: 'dev-0' });
      return json(body && body.action === 'read' ? { data: [] } : { success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "' + TOKEN + '"; localOnly = false; outbox = []; gateMode = null');
  e.raw('state = EMPTY_STATE()');
  e.raw('applyIdentity = function(){}');
  return e;
}

const bodies = (e, pred) => e.calls.map((c) => c.body).filter((b) => b && pred(b));
const pending = (e) => e.read('perfPending');

/* ========================================================================== */
describe('請求帶 trigger', () => {

  test('開 App：session、名單、五張表都帶 cold；完成後記一筆 startup', async () => {
    const e = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    const s = bodies(e, (b) => b.action === 'session');
    assert.equal(s.length, 1);
    assert.equal(s[0].trigger, 'cold');
    const reads = bodies(e, (b) => b.action === 'read');
    assert.deepEqual(reads.map((b) => b.sheet).sort(), ['line_users'].concat(DATA_SHEETS).sort());
    assert.ok(reads.every((b) => b.trigger === 'cold'), '每個讀取都帶 cold');

    const p = pending(e);
    assert.equal(p.length, 1);
    assert.equal(p[0].action, 'startup');
    assert.equal(p[0].trigger, 'cold');
    assert.equal(typeof p[0].client_ms, 'number');
  });

  test('init 開機傳 cold、回前景傳 foreground', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const init = html.slice(html.indexOf('(function init(){'));
    assert.match(init, /startSession\('cold'\)/);
    assert.match(init, /startSession\('foreground'\)/);
  });

  test('手動刷新：五張表帶 manual，記一筆 pull/manual', async () => {
    const e = env();
    await e.callRaw('manualRefresh');
    await settle();
    const reads = bodies(e, (b) => b.action === 'read');
    assert.equal(reads.length, 5);
    assert.ok(reads.every((b) => b.trigger === 'manual' && !('perf_sample' in b)));
    assert.deepEqual(pending(e).map((p) => p.action + '/' + p.trigger), ['pull/manual']);
  });

  test('寫入：upsert 帶 write，成功後記一筆 upsert/write', async () => {
    const e = env();
    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: 'x', line_id: ME }, 'id');
    await settle();
    const up = bodies(e, (b) => b.action === 'upsert');
    assert.equal(up.length, 1);
    assert.equal(up[0].trigger, 'write');
    assert.deepEqual(pending(e).map((p) => p.action + '/' + p.trigger), ['upsert/write']);
  });

  test('寫入失敗：不記耗時', async () => {
    const e = env((b) => (b.action === 'upsert' ? { error: 'sheet_not_found' } : null));
    await e.callRaw('queueUpsert', 'tasks', { id: '1', text: 'x', line_id: ME }, 'id');
    await settle();
    assert.equal(pending(e).length, 0);
  });

  test('續期畫面的 session 輪詢：不帶 trigger、不帶 perf', async () => {
    const e = env((b) => (b.action === 'session' ? { status: 'token_expired' } : null));
    e.raw('perfPending = [{action:"startup", trigger:"cold", client_ms: 100}]');
    e.raw('gateMode = "renew"; renew = {code:"123456", until: Date.now() + 600000}');
    await e.callRaw('pollRenewal');
    const s = bodies(e, (b) => b.action === 'session');
    assert.equal(s.length, 1);
    assert.equal('trigger' in s[0], false);
    assert.equal('perf' in s[0], false);
    assert.equal(pending(e).length, 1, '沒帶走就還在');
  });
});

/* ========================================================================== */
describe('輪詢取樣：20 次記 1 次', () => {

  test('20 輪：每輪 5 個讀取都帶 poll；只有第 20 輪帶 perf_sample，也只記一筆', async () => {
    const e = env();
    for (let i = 0; i < 20; i++) {
      await e.callRaw('pollTick');
      await settle();
      // 夾帶的紀錄由下一個請求帶走；這裡把它取回來數，免得被下一輪帶走
    }
    const reads = bodies(e, (b) => b.action === 'read');
    assert.equal(reads.length, 100);
    assert.ok(reads.every((b) => b.trigger === 'poll'));
    const sampled = reads.filter((b) => b.perf_sample === true);
    assert.equal(sampled.length, 5, '只有一輪（五張表）帶 perf_sample');
    assert.deepEqual(reads.slice(95).map((b) => b.perf_sample), [true, true, true, true, true], '是第 20 輪');

    const carried = e.calls.flatMap((c) => (c.body && c.body.perf) || []);
    const all = carried.concat(pending(e));
    assert.deepEqual(all.map((p) => p.action + '/' + p.trigger), ['pull/poll']);
  });

  test('讀取失敗的那輪：不記耗時', async () => {
    const e = env((b) => (b.action === 'read' ? { __reject: true } : null));
    e.raw('perfPollCount = 19');
    await e.callRaw('pollTick');
    await settle();
    assert.equal(pending(e).length, 0);
  });
});

/* ========================================================================== */
describe('夾在下一個請求裡', () => {

  test('有暫存就帶走：body.perf 是那幾筆，暫存清空', async () => {
    const e = env();
    e.raw('perfPending = [{action:"startup", trigger:"cold", client_ms: 1234}]');
    await e.callRaw('cloudPost', { action: 'listDevices' });
    const b = bodies(e, (x) => x.action === 'listDevices')[0];
    assert.deepEqual(b.perf, [{ action: 'startup', trigger: 'cold', client_ms: 1234 }]);
    assert.equal(pending(e).length, 0);
  });

  test('沒有暫存就不帶 perf 欄', async () => {
    const e = env();
    await e.callRaw('cloudPost', { action: 'listDevices' });
    assert.equal('perf' in bodies(e, (x) => x.action === 'listDevices')[0], false);
  });

  for (const action of ['session', 'pairClaim', 'renewStart']) {
    test(action + ' 不帶（它們不經過雲端的驗證，帶了也寫不進去）', async () => {
      const e = env();
      e.raw('perfPending = [{action:"startup", trigger:"cold", client_ms: 1}]');
      await e.callRaw('cloudPost', { action });
      assert.equal('perf' in bodies(e, (x) => x.action === action)[0], false);
      assert.equal(pending(e).length, 1);
    });
  }

  test('送不出去（離線）：放回暫存，下次再帶', async () => {
    let offline = true;
    const e = env(() => (offline ? { __reject: true } : null));
    e.raw('perfPending = [{action:"startup", trigger:"cold", client_ms: 1}]');
    await assert.rejects(e.callRaw('cloudPost', { action: 'listDevices' }));
    assert.equal(pending(e).length, 1, '沒送到就不能丟');
    offline = false;
    await e.callRaw('cloudPost', { action: 'listDevices' });
    assert.equal(pending(e).length, 0);
  });

  test('被認證擋下：雲端不會寫，放回暫存', async () => {
    const e = env((b) => (b.action === 'listDevices' ? { error: 'inactive' } : null));
    e.raw('openAuthGate = function(){}');
    e.raw('perfPending = [{action:"startup", trigger:"cold", client_ms: 1}]');
    await e.callRaw('cloudPost', { action: 'listDevices' });
    assert.equal(pending(e).length, 1);
  });

  test('暫存最多 20 筆，滿了丟最舊的', () => {
    const e = env();
    for (let i = 0; i < 25; i++) e.call('perfNote', 'pull', 'poll', i);
    const p = pending(e);
    assert.equal(p.length, 20);
    assert.equal(p[0].client_ms, 5);
    assert.equal(p[19].client_ms, 24);
  });

  test('暫存只在記憶體：不進 localStorage', async () => {
    const e = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    const dump = JSON.stringify(e.localStorage._dump());
    assert.ok(!dump.includes('client_ms'));
  });
});

/* ========================================================================== */
describe('管理員：門檻提醒與效能頁', () => {

  test('session 回的 perf_rows 記下來；超過 5,000 才提醒，而且只提醒管理員', async () => {
    const e = env((b) => (b.action === 'session' ? { status: 'ok', line_id: ME, device_id: 'dev-0', perf_rows: 5001 } : null));
    e.raw('roster = [{line_id:"' + ME + '", display_name:"Neil", is_active:"TRUE", is_admin:"TRUE"}]');
    await e.callRaw('checkSession', 'cold');
    assert.equal(e.read('perfRows'), 5001);
    assert.equal(e.call('perfAlertNeeded'), true);
    assert.equal(e.read('PERF_ALERT_ROWS'), 5000);

    e.raw('perfRows = 5000');
    assert.equal(e.call('perfAlertNeeded'), false, '剛好 5,000 不提醒');

    e.raw('perfRows = 9999; roster = [{line_id:"' + ME + '", display_name:"Neil", is_active:"TRUE", is_admin:""}]');
    assert.equal(e.call('perfAlertNeeded'), false, '不是管理員不提醒');
  });

  test('開機只為了提醒不多發請求：沒有 perfSummary', async () => {
    const e = env();
    await e.callRaw('startSession', 'cold');
    await settle();
    assert.equal(bodies(e, (b) => b.action === 'perfSummary').length, 0);
  });

  test('刪除 30 天前：先確認；取消就不送', async () => {
    const e = env();
    e.set('confirm', () => false);
    await e.callRaw('purgePerf');
    assert.equal(bodies(e, (b) => b.action === 'perfPurge').length, 0);
  });

  test('刪除 30 天前：確認後送 days=30，筆數跟著更新', async () => {
    const e = env((b) => (b.action === 'perfPurge' ? { success: true, deleted: 7, remaining: 3, days: 30 } : null));
    e.raw('perfRows = 10');
    await e.callRaw('purgePerf');
    const b = bodies(e, (x) => x.action === 'perfPurge');
    assert.equal(b.length, 1);
    assert.equal(b[0].days, 30);
    assert.equal(e.read('perfRows'), 3);
    assert.ok(e.toasts.some((t) => t.includes('7')), '告訴人刪了幾筆');
  });

  test('摘要畫面：p90 寫成「慢的時候」並附說明；各情境用中文名', () => {
    const e = env();
    const html = e.call('perfSummaryHtml', {
      success: true, days: 7, total: 12, oldest: '2026-09-25T00:00:00.000Z',
      client: [{ trigger: 'cold', count: 10, p50: 1800, p90: 4200 }],
      server: [{ action: 'read', count: 2, p50: 300, p90: 900, auth_pct: 40, open_pct: 30, read_pct: 20 }]
    });
    assert.match(html, /慢的時候/);
    assert.match(html, /90% 的請求比這個快/);
    assert.match(html, /開 App/);
    assert.match(html, /1\.8 秒/);
    assert.match(html, /4\.2 秒/);
    assert.match(html, /300 ms/);
    assert.ok(!/p90/.test(html), '畫面上不出現 p90 這個詞');
  });
});
