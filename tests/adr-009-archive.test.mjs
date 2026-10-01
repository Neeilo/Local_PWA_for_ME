/**
 * ADR-009 §一.4 — 兩段式封存的測試
 *
 * 這是整個 ADR 裡唯一一個會**永久刪除資料**的流程，所以測的重點全在「什麼時候
 * 不該刪」：讀不到雲端時不刪、使用者沒確認時不刪、鍵算不出來時不刪。
 *
 * 2026-10-01 起封存改成後端一次做完並寄信（tests/archive-mail.test.mjs）。下面後端的
 * ?only=tombstones／archivePurge 測試保留：AUTH_MODE=dual 期間舊版前端仍可能走那兩扇門。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';

/* ========================================================================== */
describe('後端：?only=tombstones 附上算好的鍵', () => {

  test('鍵由後端算，前端不必自己拼', () => {
    const headers = ['id', 'text', 'line_id', 'del'];
    const sheet = new FakeSheet('notes', [
      headers,
      ['1', '還在的', ME, ''],
      ['2', '刪掉的', ME, 'TRUE']
    ]);
    const env = loadCodeGs({ sheets: { notes: sheet } });

    const out = JSON.parse(env.call('doGet', { parameter: { sheet: 'notes', only: 'tombstones', key_field: 'id' } }).body);

    assert.deepEqual(out.data.map(r => r.id), ['2']);
    assert.deepEqual(out.keys, ['2']);
  });

  test('複合鍵的 reviews 也算得出來', () => {
    const headers = ['review_date', 'good', 'line_id', 'del'];
    const sheet = new FakeSheet('reviews', [
      headers,
      ['2026-09-16', 'x', ME, 'TRUE'],
      ['2026-09-16', 'y', 'Ufamily', 'TRUE']
    ]);
    const env = loadCodeGs({ sheets: { reviews: sheet } });

    const out = JSON.parse(env.call('doGet', {
      parameter: { sheet: 'reviews', only: 'tombstones', key_field: 'review_date,line_id' }
    }).body);

    assert.deepEqual(out.keys, ['2026-09-16|' + ME, '2026-09-16|Ufamily']);
  });

  test('⚠️ Sheet 存 Date 物件時，鍵仍是本地日期而不是 UTC 前一天', () => {
    const headers = ['review_date', 'good', 'line_id', 'del'];
    const sheet = new FakeSheet('reviews', [
      headers,
      [new Date(2026, 8, 16), 'x', ME, 'TRUE']      // 當地 9/16 00:00
    ]);
    const env = loadCodeGs({ sheets: { reviews: sheet } });

    const out = JSON.parse(env.call('doGet', {
      parameter: { sheet: 'reviews', only: 'tombstones', key_field: 'review_date,line_id' }
    }).body);

    assert.deepEqual(out.keys, ['2026-09-16|' + ME],
      '前端自己 slice ISO 字串會在 UTC+8 拿到 09-15，鍵對不上就會安靜地刪不掉');
  });

  test('鍵不完整的列回空字串，讓呼叫端跳過而不是亂刪', () => {
    const headers = ['review_date', 'good', 'line_id', 'del'];
    const sheet = new FakeSheet('reviews', [headers, ['2026-09-16', 'x', '', 'TRUE']]);
    const env = loadCodeGs({ sheets: { reviews: sheet } });

    const out = JSON.parse(env.call('doGet', {
      parameter: { sheet: 'reviews', only: 'tombstones', key_field: 'review_date,line_id' }
    }).body);

    assert.deepEqual(out.keys, ['']);
  });
});

/* ========================================================================== */
/* 前端（2026-10-01 起封存改寄信：一個請求交給後端做完，見 tests/archive-mail.test.mjs）
   這裡守的仍是「什麼時候不該刪」——只是刪除的開關從前端搬到了後端，前端要守的是
   「什麼時候不該按下那個開關」，以及失敗時講得出是哪一步。 */
describe('前端：什麼時候不該送出封存', () => {

  function archiveEnv({ reply = { success: true, total: 3, deleted: 3 }, confirmAnswer = true, admin = true, fail = false } = {}) {
    const alerts = [];
    const e = loadFrontend({
      fetchImpl: ({ body }) => {
        if (body && body.action === 'archiveMail') {
          return fail ? { json: () => Promise.reject(new Error('offline')) } : { json: () => Promise.resolve(reply) };
        }
        return { json: () => Promise.resolve({ data: [] }) };
      }
    });
    e.raw('myLineId = "' + ME + '"; deviceToken = "t"; localOnly = false; outbox = []; state = EMPTY_STATE()');
    e.raw('roster = [{ line_id: "' + ME + '", is_active: "TRUE", is_admin: "' + (admin ? 'TRUE' : '') + '" }]');
    e.set('confirm', () => confirmAnswer);
    e.set('alert', (m) => { alerts.push(String(m)); });
    e.alerts = alerts;
    return e;
  }
  const sends = (e) => e.calls.filter((c) => c.body && c.body.action === 'archiveMail');

  test('⚠️ 使用者沒按確認就不送——這是「不先斬後奏」那道鎖', async () => {
    const e = archiveEnv({ confirmAnswer: false });
    await e.callRaw('archiveTombstones');
    assert.equal(sends(e).length, 0);
    assert.ok(e.toasts.some((t) => t.includes('原封不動')));
  });

  test('非管理者不送（按鈕也不該出現）', async () => {
    const e = archiveEnv({ admin: false });
    await e.callRaw('archiveTombstones');
    assert.equal(sends(e).length, 0);
  });

  test('還沒配對就不送', async () => {
    const e = archiveEnv();
    e.raw('myLineId = ""');
    await e.callRaw('archiveTombstones');
    assert.equal(sends(e).length, 0);
  });

  test('確認之後只送一個請求，不再逐張分頁各自刪；也不再下載檔案', async () => {
    const e = archiveEnv();
    let downloads = 0;
    e.set('URL', { createObjectURL: () => { downloads++; return 'blob:x'; }, revokeObjectURL() {} });
    await e.callRaw('archiveTombstones');
    assert.equal(sends(e).length, 1);
    assert.equal(e.calls.filter((c) => c.body && /archivePurge|readTombstones/.test(c.body.action)).length, 0);
    assert.equal(downloads, 0, '備份改走信箱');
    assert.ok(e.toasts.some((t) => t.includes('已寄出備份並刪除 3 筆')));
  });

  test('失敗時講得出是哪一步、原因是什麼', async () => {
    const e = archiveEnv({ reply: { error: 'archive_failed', stage: 'mail', message: '沒有任何啟用中的管理者填了 email' } });
    await e.callRaw('archiveTombstones');
    assert.equal(e.alerts.length, 1);
    assert.match(e.alerts[0], /階段：寄信/);
    assert.match(e.alerts[0], /填了 email/);
    assert.match(e.alerts[0], /沒有任何變動/);
  });

  test('刪到一半失敗：告訴使用者信已寄出、已補回幾筆', async () => {
    const e = archiveEnv({ reply: { error: 'archive_failed', stage: 'delete', message: 'timed out', mailed: true, rolled_back: true, restored: 2 } });
    await e.callRaw('archiveTombstones');
    assert.match(e.alerts[0], /階段：刪除/);
    assert.match(e.alerts[0], /已寄出/);
    assert.match(e.alerts[0], /2 筆已經補回/);
    assert.doesNotMatch(e.alerts[0], /沒有任何變動/, '刪過又補回，不能說沒動過');
  });

  test('⚠️ 沒收到回應：不能說「沒有變動」——雲端可能已經做完了', async () => {
    const e = archiveEnv({ fail: true });
    await e.callRaw('archiveTombstones');
    assert.match(e.alerts[0], /不確定是否已完成/);
    assert.doesNotMatch(e.alerts[0], /沒有任何變動/);
  });

  test('沒有任何墓碑：說清楚，不當成錯誤', async () => {
    const e = archiveEnv({ reply: { success: true, total: 0, deleted: 0 } });
    await e.callRaw('archiveTombstones');
    assert.equal(e.alerts.length, 0);
    assert.ok(e.toasts.some((t) => t.includes('沒有已刪除的資料')));
  });
});
