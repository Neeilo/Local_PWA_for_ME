/**
 * DATA-05 — 雲端日期欄讀回前端時少一天
 *
 * Sheet 會把前端送上去的 '2026-10-01' 轉成日期格子，讀回來時被 JSON 化成 UTC：
 * 台灣的 10/1 變成 '2026-09-30T16:00:00.000Z'。直接切前 10 個字就少一天。
 * 平常只差一天、多半還在同一個月，不容易發現；月初那天記的帳會整筆掉到上個月，
 * 「本月」看不見（2026-10-01 Neil 實測：電腦記 100 元，兩台刷新後都不見，Sheet 上還在）。
 *
 * 時區釘成 Asia/Taipei：Sheet 的時區是台北，使用者的裝置也是；CI 跑在 UTC 的話，
 * 這個 bug 根本不會出現，測試會在不該綠的時候綠。
 */
process.env.TZ = 'Asia/Taipei';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
// Sheet 存的是台北 2026-10-01 00:00，讀回來長這樣
const OCT1_FROM_SHEET = '2026-09-30T16:00:00.000Z';

function env(sheets) {
  const e = loadFrontend({
    fetchImpl: ({ body }) => (body && body.action === 'read'
      ? { json: () => Promise.resolve({ data: sheets[body.sheet] || [] }) }
      : null)
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "t"; localOnly = false; outbox = []; state = EMPTY_STATE()');
  return e;
}

describe('雲端日期欄換回本地日期', () => {

  test('前提：時區真的是台北（否則下面的測試沒有意義）', () => {
    assert.equal(new Date(OCT1_FROM_SHEET).getDate(), 1);
  });

  test('localDateKey：UTC ISO → 本地日期；YYYY-MM-DD 原樣；空值與壞值不炸', () => {
    const e = loadFrontend();
    assert.equal(e.call('localDateKey', OCT1_FROM_SHEET), '2026-10-01');
    assert.equal(e.call('localDateKey', '2026-10-01'), '2026-10-01');
    assert.equal(e.call('localDateKey', ''), '');
    assert.equal(e.call('localDateKey', null), '');
    assert.equal(e.call('localDateKey', 'not-a-date'), 'not-a-date');
  });

  test('⚠️ 月初記的帳，pull 回來仍在本月，不會掉到上個月', async () => {
    const e = env({ expenses: [{ id: '1', expense_date: OCT1_FROM_SHEET, type: 'expense', category: '餐飲', amount: 100, line_id: ME }] });
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('state.expenses[0].date'), '2026-10-01');
    assert.equal(e.call('expensesOfMonth', '2026-10').length, 1, '10 月要看得到這筆');
    assert.equal(e.call('expensesOfMonth', '2026-09').length, 0, '不該跑到 9 月');
  });

  test('任務到期日也一樣不少一天（到期提醒的區塊靠它分）', async () => {
    const e = env({ tasks: [{ id: '1', text: '繳費', is_completed: '', created_at: '2026-09-01T00:00:00Z', priority: 'M', line_id: ME, due_date: OCT1_FROM_SHEET }] });
    await e.callRaw('pullFromCloud');
    assert.equal(e.read('state.tasks[0].due'), '2026-10-01');
  });
});
