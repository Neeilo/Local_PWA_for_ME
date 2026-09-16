/**
 * ADR-009 §一.4 — 兩段式封存的測試
 *
 * 這是整個 ADR 裡唯一一個會**永久刪除資料**的流程，所以測的重點全在「什麼時候
 * 不該刪」：讀不到雲端時不刪、使用者沒確認時不刪、鍵算不出來時不刪。
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
describe('前端：什麼時候不該刪', () => {

  /** 假雲端：GET tombstones 回一批，POST 一律成功 */
  function archiveEnv({ tombstones = {}, getFails = false, confirmAnswer = true } = {}) {
    const e = loadFrontend({
      fetchImpl: ({ url }) => {
        if (/only=tombstones/.test(url)) {
          if (getFails) return { json: () => Promise.reject(new Error('offline')) };
          const m = /[?&]sheet=([^&]+)/.exec(url);
          const sheet = decodeURIComponent(m[1]);
          const rows = tombstones[sheet] || [];
          return { json: () => Promise.resolve({ data: rows, keys: rows.map(r => String(r.id || '')) }) };
        }
        if (/sheet=/.test(url)) return { json: () => Promise.resolve({ data: [] }) };
        return { json: () => Promise.resolve({ success: true, deleted: 1 }) };
      }
    });
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');
    e.set('confirm', () => confirmAnswer);
    return e;
  }

  const purges = (e) => e.calls.filter(c => c.body && c.body.action === 'archivePurge');

  test('讀不到雲端就什麼都不做——絕不用猜的去刪', async () => {
    const e = archiveEnv({ getFails: true });
    await e.callRaw('archiveTombstones');

    assert.equal(purges(e).length, 0);
    assert.ok(e.toasts.some(t => t.includes('讀不到雲端')));
  });

  test('⚠️ 使用者沒按確認就不刪——這是「不先斬後奏」那道鎖', async () => {
    const e = archiveEnv({
      tombstones: { notes: [{ id: '7', text: '刪掉的' }] },
      confirmAnswer: false
    });
    await e.callRaw('archiveTombstones');

    assert.equal(purges(e).length, 0, '檔案沒確定到手，雲端那一份就不能消失');
    assert.ok(e.toasts.some(t => t.includes('原封不動')));
  });

  test('確認之後才送 archivePurge，而且只送有墓碑的那幾張表', async () => {
    const e = archiveEnv({
      tombstones: { notes: [{ id: '7', text: 'a' }], tasks: [{ id: '8', text: 'b' }] }
    });
    await e.callRaw('archiveTombstones');

    const p = purges(e);
    assert.equal(p.length, 2, '沒有墓碑的分頁不必打擾它');
    assert.deepEqual(p.map(c => c.body.sheet).sort(), ['notes', 'tasks']);
    p.forEach(c => assert.ok(c.body.keys.length > 0, '不可以送空清單'));
  });

  test('沒有任何墓碑時，連下載都不做', async () => {
    const e = archiveEnv({ tombstones: {} });
    await e.callRaw('archiveTombstones');

    assert.equal(purges(e).length, 0);
    assert.ok(e.toasts.some(t => t.includes('沒有已刪除的資料')));
  });

  test('還沒選身份就不封存', async () => {
    const e = archiveEnv({ tombstones: { notes: [{ id: '7' }] } });
    e.raw('myLineId = ""');
    await e.callRaw('archiveTombstones');

    assert.equal(purges(e).length, 0);
  });

  test('刪除發生在下載之後，順序不可以反過來', async () => {
    const order = [];
    const e = loadFrontend({
      fetchImpl: ({ url, body }) => {
        if (/only=tombstones/.test(url)) {
          const m = /[?&]sheet=([^&]+)/.exec(url);
          const sheet = decodeURIComponent(m[1]);
          const rows = sheet === 'notes' ? [{ id: '7', text: 'a' }] : [];
          return { json: () => Promise.resolve({ data: rows, keys: rows.map(r => r.id) }) };
        }
        if (body && body.action === 'archivePurge') { order.push('purge'); return { json: () => Promise.resolve({ success: true, deleted: 1 }) }; }
        if (/sheet=/.test(url)) return { json: () => Promise.resolve({ data: [] }) };
        return { json: () => Promise.resolve({ success: true }) };
      }
    });
    e.raw('myLineId = "' + ME + '"; localOnly = false; outbox = []');
    e.raw('state = EMPTY_STATE()');
    e.set('confirm', () => { order.push('confirm'); return true; });
    e.set('URL', { createObjectURL: () => { order.push('download'); return 'blob:x'; }, revokeObjectURL() {} });

    await e.callRaw('archiveTombstones');

    assert.deepEqual(order, ['download', 'confirm', 'purge'],
      '標記 → 匯出 → 確認 → 刪除，一步都不能提前');
  });
});
