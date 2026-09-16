/**
 * ADR-009 §四 週期提醒 — 日期算法的測試
 *
 * 與 Phase 0 同一個紀律：先測再接線。這一段是純函式，沒有任何呼叫端，
 * 所以這裡測到的就是它全部的行為。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs } from './fake-apps-script.mjs';

const env = () => loadCodeGs();

/* ========================================================================== */
describe('nextDueDate_ — 下一期的到期日', () => {

  test('規則是「原訂到期日 + 週期」，不是「完成當下 + 週期」', () => {
    const e = env();
    // 每月 5 號繳費，拖到 20 號才打勾：下一期仍然是下個月 5 號
    assert.equal(e.call('nextDueDate_', '2026-09-05', 1, '月', '2026-09-20'), '2026-10-05');
  });

  test('四種單位都算得對', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2026-09-16', 3, '天', '2026-09-16'), '2026-09-19');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 2, '週', '2026-09-16'), '2026-09-30');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, '月', '2026-09-16'), '2026-10-16');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, '年', '2026-09-16'), '2027-09-16');
  });

  test('算出來仍在過去就持續累加，一次追回到今天之後', () => {
    const e = env();
    // 擱置半年的每月提醒，只生出「下一個未來的那一期」，不是一串過期的
    assert.equal(e.call('nextDueDate_', '2026-03-10', 1, '月', '2026-09-16'), '2026-10-10');
    assert.equal(e.call('nextDueDate_', '2020-01-01', 1, '年', '2026-09-16'), '2027-01-01');
  });

  test('算出來剛好是今天，就是今天（今天不算已過去）', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2026-09-09', 1, '週', '2026-09-16'), '2026-09-16');
  });

  test('⚠️ 月底要夾住，1/31 + 1 個月是 2/28 而不是 3/3', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2026-01-31', 1, '月', '2026-01-31'), '2026-02-28');
    assert.equal(e.call('nextDueDate_', '2026-03-31', 1, '月', '2026-03-31'), '2026-04-30');
  });

  test('閏年：2/29 + 1 年夾成 2/28', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2028-02-29', 1, '年', '2028-02-29'), '2029-02-28');
  });

  test('⚠️ 已知限制：夾住之後會固定下來，月底提醒會漂移到 28 號', () => {
    const e = env();
    // 單次計算是對的：跨過 2 月直接算兩期，仍然回到 3/31
    assert.equal(e.call('nextDueDate_', '2026-01-31', 2, '月', '2026-01-31'), '2026-03-31');

    // 但真實流程是一期一期走，每一期以「上一期的到期日」為基準。
    // 一旦經過 2 月被夾成 28 號，之後就再也回不到 31 號：
    let due = '2026-01-31';
    const seq = [due];
    for (let i = 0; i < 3; i++) { due = e.call('nextDueDate_', due, 1, '月', due); seq.push(due); }
    assert.deepEqual(seq, ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28']);

    // 這一項不是在確認「正確」，是在把缺陷釘住：ADR 說的是「**原訂**到期日 + 週期」，
    // 但資料模型只把上一期的 due_date 傳下去，原訂那個日子在第一次夾值之後就遺失了。
    // 修法需要一個記住原始錨點的欄位（ADR 的欄位清單沒有），屬於 schema 決策，
    // 已列進報告請 Neil 裁決。在那之前，這就是實際行為，不假裝它不存在。
  });

  test('沒設週期、週期不合法、單位不認得，一律回空字串（當一次性項目）', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2026-09-16', '', '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 0, '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026-09-16', -1, '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1.5, '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, '小時', '2026-09-16'), '', '刻意不開放小時');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, '', '2026-09-16'), '');
  });

  test('到期日壞掉或根本不存在那一天，回空字串不硬猜', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '', 1, '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026/09/16', 1, '天', '2026-09-16'), '');
    assert.equal(e.call('nextDueDate_', '2026-02-31', 1, '天', '2026-09-16'), '', '2 月沒有 31 號');
  });

  test('英文單位也吃，Sheet 手打什麼都可能', () => {
    const e = env();
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, 'week', '2026-09-16'), '2026-09-23');
    assert.equal(e.call('nextDueDate_', '2026-09-16', 1, ' 月 ', '2026-09-16'), '2026-10-16', '前後空白要修掉');
  });
});

/* ========================================================================== */
describe('dueBucket_ — 到期區塊分類', () => {

  test('依 1／3／5 三道門檻切出四塊', () => {
    const e = env();
    const today = '2026-09-16';
    assert.equal(e.call('dueBucket_', '2026-09-16', today), 'd1', '今天到期');
    assert.equal(e.call('dueBucket_', '2026-09-17', today), 'd1');
    assert.equal(e.call('dueBucket_', '2026-09-18', today), 'd3');
    assert.equal(e.call('dueBucket_', '2026-09-19', today), 'd3');
    assert.equal(e.call('dueBucket_', '2026-09-20', today), 'd5');
    assert.equal(e.call('dueBucket_', '2026-09-21', today), 'd5');
    assert.equal(e.call('dueBucket_', '2026-09-22', today), 'later', '第 6 天');
    assert.equal(e.call('dueBucket_', '2026-10-16', today), 'later');
  });

  test('已過期獨立一塊，不偽裝成「1 天內」', () => {
    const e = env();
    assert.equal(e.call('dueBucket_', '2026-09-15', '2026-09-16'), 'overdue');
    assert.equal(e.call('dueBucket_', '2026-01-01', '2026-09-16'), 'overdue');
  });

  test('沒設到期日的一般任務不落入任何區塊', () => {
    const e = env();
    assert.equal(e.call('dueBucket_', '', '2026-09-16'), '');
    assert.equal(e.call('dueBucket_', '2026/09/16', '2026-09-16'), '');
  });

  test('跨月跨年不會算錯天數', () => {
    const e = env();
    assert.equal(e.call('dueBucket_', '2027-01-01', '2026-12-31'), 'd1');
    assert.equal(e.call('dueBucket_', '2026-10-01', '2026-09-30'), 'd1');
  });
});

/* ========================================================================== */
describe('shouldNotify_ — 這一列現在該不該推通知', () => {

  const owner = { line_id: 'Uneil' };
  const today = '2026-09-16';
  const rec = (extra) => Object.assign({ due_date: '2026-09-17' }, owner, extra);

  test('跨進 3 天門檻且還沒推過 → 推', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec(), today), true);
    assert.equal(e.call('shouldNotify_', rec({ due_date: '2026-09-19' }), today), true, '第 3 天仍在門檻內');
  });

  test('還沒到門檻 → 不推', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec({ due_date: '2026-09-20' }), today), false);
    assert.equal(e.call('shouldNotify_', rec({ due_date: '2026-12-01' }), today), false);
  });

  test('已過期也要推——錯過了才更需要知道', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec({ due_date: '2026-09-10' }), today), true);
  });

  test('notified 有值就不再推（只推一次）', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec({ notified: 'TRUE' }), today), false);
    assert.equal(e.call('shouldNotify_', rec({ notified: true }), today), false);
  });

  test('已完成、已軟刪除，一律不推', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec({ is_completed: 'TRUE' }), today), false);
    assert.equal(e.call('shouldNotify_', rec({ del: 'TRUE' }), today), false);
  });

  test('沒有 owner 就沒有收件人，不推給錯的人', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', { due_date: '2026-09-17', line_id: '' }, today), false);
    assert.equal(e.call('shouldNotify_', { due_date: '2026-09-17' }, today), false);
  });

  test('沒設到期日的一般任務不會被通知打擾', () => {
    const e = env();
    assert.equal(e.call('shouldNotify_', rec({ due_date: '' }), today), false);
  });

  test('新一期那一列的 notified 天生為空，所以會照常推', () => {
    const e = env();
    // 完成後新增的新列：due_date 換成下一期、notified 沒有值
    const nextDue = e.call('nextDueDate_', '2026-09-16', 1, '天', '2026-09-16');
    assert.equal(nextDue, '2026-09-17');
    assert.equal(e.call('shouldNotify_', rec({ due_date: nextDue }), today), true,
      '不需要任何重置邏輯——這是「新增一列」而非「原地改 due_date」換來的');
  });
});
