/**
 * ADR-022 PR-0 — LINE「初始化」回覆瘦身
 *
 * 為什麼：Neil 2026-10-20 回報回覆太長、而且過時（列 ADR 編號、舊排程描述），手機要滑好幾頁才看完，
 * 真正要他動手的 ⚠️ 反而被淹沒。初始化「做的事」不變，只改回覆：
 *   - 第一行結論；只列「這次有變」與「要處理」的；沒變的一句帶過
 *   - 排程只列排程總管登記表，一行一個
 *   - 完整明細照樣寫 logs，回覆結尾提示「明細見 LOG」
 *   - 回覆不含 ADR 編號（歷史留在 Notion，不放進每天看的訊息）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const EXP_HEADERS = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del',
  'subcategory', 'targets', 'plan_id', 'plan_seq'];

function env({ properties = { APIFY_TOKEN: 't', WEATHER_API: 'k' }, overrides = {}, sheets = {} } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    properties,
    sheets: Object.assign({
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE'))]),
      expenses: new FakeSheet('expenses', [EXP_HEADERS]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'line_id']]),
      notes: new FakeSheet('notes', [['id', 'text', 'line_id']]),
      reviews: new FakeSheet('reviews', [['review_date', 'line_id']]),
      moods: new FakeSheet('moods', [['id', 'level', 'line_id']]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }, sheets),
    overrides: Object.assign({ lineReply_: (_t, text) => { replies.push(String(text)); } }, overrides)
  });
  e.replies = replies;
  return e;
}

function init(e) {
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId: ME }, message: { type: 'text', text: '初始化' } });
  return e.replies.pop();
}
const initLog = (e) => e.transactions.filter((t) => t[2] === '初始化').pop();

describe('初始化回覆：一個畫面看完', () => {

  test('全部已齊備：只有結論＋其餘一句＋排程＋明細提示（行數釘在排程數＋4 以內）', () => {
    const e = env();
    init(e);                                    // 第一次會建表、補欄
    const reply = init(e);                      // 第二次全部已齊備
    const jobs = e.read('schedulerJobList_()');
    const lines = reply.split('\n');
    assert.equal(lines[0], '✅ 初始化完成，全部正常');
    assert.match(reply, /\n其餘 \d+ 項已齊備\n/);
    for (const j of jobs) assert.ok(lines.includes('・' + j), '排程一行一個：' + j);
    assert.equal(lines[lines.length - 1], '📄 明細見 LOG（可重複執行，已做過的不會重做）');
    assert.ok(lines.length <= jobs.length + 4, '行數 ' + lines.length + '：\n' + reply);
  });

  test('回覆不含 ADR 編號、也不含舊式逐步明細', () => {
    const e = env();
    for (const reply of [init(e), init(e)]) {
      assert.doesNotMatch(reply, /ADR-/);
      assert.doesNotMatch(reply, /RD-HF/);
    }
  });

  test('步驟名稱不帶 ADR 編號（之後加步驟照這個結構註冊）', () => {
    const e = env();
    for (const s of e.read('initSteps_().map(function (s) { return s.label; })')) assert.doesNotMatch(s, /ADR-|RD-/);
  });

  test('第一次跑：有補欄／新建的步驟列出來，結論仍是全部正常', () => {
    const e = env();
    const reply = init(e);
    assert.match(reply, /^✅ 初始化完成，全部正常\n/);
    assert.match(reply, /🆕 欄位\n　tasks 補上：/);
    assert.match(reply, /🆕 股票\n　建立 stock_trades/);
    assert.doesNotMatch(reply, /記帳分類/, 'expenses 已齊備、沒有要遷移的，這一步沒變就不列');
  });

  test('要 Neil 動手的項目會列出，結論寫「N 項要處理」', () => {
    const e = env({ properties: {} });          // 沒設 APIFY_TOKEN、WEATHER_API
    init(e);
    const reply = init(e);
    const m = /^⚠️ 初始化完成，(\d+) 項要處理\n/.exec(reply);
    assert.ok(m, reply);
    const warnItems = reply.split('\n').filter((l) => /^⚠️ /.test(l)).length - 1;   // 扣掉第一行
    assert.equal(Number(m[1]), warnItems, reply);
    assert.match(reply, /⚠️ 收藏搜集器：還沒設 APIFY_TOKEN/);
    assert.match(reply, /⚠️ 總覽 Widget 設定表：還沒設 WEATHER_API/);
    assert.doesNotMatch(reply, /clips 已存在/, '同一步裡沒問題的明細不列');
  });

  test('某步失敗：標出停在哪一步、沒執行的步驟一行帶過，不說「完成」', () => {
    const e = env({ overrides: { installAdr013: () => { throw new Error('Sheet 暫時無法存取'); } } });
    const reply = init(e);
    assert.match(reply, /^🛑 初始化沒有完成，停在「記帳分類」\n/);
    assert.match(reply, /❌ 記帳分類：Sheet 暫時無法存取/);
    assert.match(reply, /⏭️ 沒有執行：股票、Gmail 控制員、.*排程總管/);
    assert.doesNotMatch(reply, /初始化完成/);
    assert.equal(e.lock.held, false);
  });

  test('完整明細照樣寫進 logs（回覆沒列的也在）', () => {
    const e = env();
    init(e);
    init(e);
    const log = initLog(e);
    assert.equal(log[1], '成功');
    assert.match(log[4], /記帳分類/);
    assert.match(log[4], /欄位已齊備/);
    assert.match(log[4], /改了 0 列/);
    assert.match(log[4], /runScheduler/);
  });

  test('還有舊的各自觸發器：換掉算「這次有變」，回覆講換了幾個', () => {
    const e = env();
    init(e);
    e.triggers.push({ handler: e.read('schedulerOldHandlers_()[0]') });
    const reply = init(e);
    assert.match(reply, /^✅ 初始化完成，全部正常\n/);
    assert.match(reply, /🆕 排程總管：換掉舊觸發器 1 個；只留一個觸發器 runScheduler/);
    assert.deepEqual(e.triggers.map((t) => t.handler), ['runScheduler']);
  });

  test('觸發器異常（重複）算一項要處理', () => {
    const e = env({ overrides: { installScheduler_: () => ({ removed: 0, old: 0 }) } });
    e.triggers.push({ handler: 'runScheduler' }, { handler: 'runScheduler' });
    const reply = init(e);
    assert.match(reply, /^⚠️ 初始化完成，1 項要處理/);
    assert.match(reply, /⚠️ 觸發器：runScheduler（每 5 分鐘，排程總管） ×2/);
  });
});
