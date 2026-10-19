/**
 * ADR-019 PR-5 — 到期 Flex 卡片（C-1～C-6）
 *
 * 為什麼有這批測試：到期推播以前是一筆一則文字，收到後沒有出口（提醒沒有完成，ADR-018 A-2），只能另開 App。
 * 改成卡片輪播＋三顆常駐按鈕之後，盯的事：
 *   - 卡片產生器是純函式：1、12、13 筆（13 → 前 11 張＋「還有 2 件」），一個收件對象一次推播
 *   - 三種任務（待辦／單次提醒／週期提醒）× 三顆按鈕（✅／⏰／📅）的結果
 *   - 只有建立者按得動（C-6）；舊卡片、重複按不動作——同一顆按兩次不可跳兩期
 *   - 群組與個人的回覆文字；每次按都寫 logs；寫入拿 PWA 同一把鎖（PR-4）
 * 按鈕一律從排程真的推出去的卡片上拿 data 來按：產生器跟處理器對不上，這裡就會紅
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const STRANGER = 'Ustranger';
const GROUP = 'Cfamily';
const TODAY = '2026-10-07';            // 星期三
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
  'created_at', 'updated_at', 'notify_due'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat', 'kind'];

const taskRow = (o) => TASK_H.map((h) => (o[h] === undefined ? '' : o[h]));
const todo = (o = {}) => Object.assign({ id: '1', text: '繳管理費', due_date: '2026-10-08', line_id: ME, kind: 'todo' }, o);
const reminder = (o = {}) => Object.assign({ id: '2', text: '看牙醫', due_date: '2026-10-08', line_id: ME, kind: 'reminder' }, o);

function env({ tasks = [], pushImpl = null } = {}) {
  const replies = [];
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], pushImpl,
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
        [MOM, '裕仁', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      line_groups: new FakeSheet('line_groups', [GROUP_H, [GROUP, '家族', 'TRUE', 'TRUE', 'TRUE', 'TRUE',
        '2026-10-01T00:00:00.000Z', '', '', '', 'TRUE']]),
      tasks: new FakeSheet('tasks', [TASK_H.slice()].concat(tasks.map(taskRow))),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides: { lineReply_: (_t, msg) => { replies.push(msg); }, lineTodayKey_: () => TODAY }
  });
  e.replies = replies;
  return e;
}
const tasksOf = (e) => e.sheets.tasks.toRecords();
const taskOf = (e, id) => tasksOf(e).find((t) => String(t.id) === String(id));
const snap = (e) => JSON.stringify(e.sheets.tasks.values);
const bubblesOf = (msg) => msg.contents.contents;
const actionsOf = (bubble) => bubble.footer.contents.map((b) => b.action);

/** 跑 9 點排程，回傳推給 to 的那則輪播裡、內容是 text 的那張卡片的三顆按鈕 { done, tmr, pick } */
function cardFor(e, text, to = ME) {
  if (!e.pushes.length) e.call('checkDueReminders', TODAY);
  const push = e.pushes.find((p) => p.to === to);
  assert.ok(push, '沒有推給 ' + to);
  const bubble = bubblesOf(push.text).find((b) => JSON.stringify(b.body).includes(text));
  assert.ok(bubble, '輪播裡沒有「' + text + '」');
  const [done, tmr, pick] = actionsOf(bubble);
  return { done, tmr, pick };
}
function tap(e, userId, action, { group = false, date = null } = {}) {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'postback', replyToken: 'rt',
    source: group ? { type: 'group', groupId: GROUP, userId } : { type: 'user', userId },
    postback: date ? { data: action.data, params: { date } } : { data: action.data } });
  const m = e.replies.length > before ? e.replies[e.replies.length - 1] : null;
  return m && typeof m === 'object' ? m.text : m;
}

/* ========================================================================== */
describe('卡片產生器（純函式）', () => {

  test('1 筆：一張卡、三顆按鈕（✅ postback、⏰ postback、📅 日期選擇器），altText 沿用原本的文字訊息', () => {
    const e = env();
    const rec = todo();
    const msg = e.call('dueCardsMessage_', [rec], TODAY, null);
    assert.equal(msg.type, 'flex');
    assert.equal(msg.contents.type, 'carousel');
    assert.equal(bubblesOf(msg).length, 1);
    const [done, tmr, pick] = actionsOf(bubblesOf(msg)[0]);
    assert.equal(done.type, 'postback'); assert.match(done.label, /處理了/);
    assert.equal(tmr.type, 'postback'); assert.match(tmr.label, /明天/);
    assert.equal(pick.type, 'datetimepicker'); assert.equal(pick.mode, 'date');
    for (const a of [done, tmr, pick]) {
      assert.match(a.data, /dc=1/);
      assert.match(a.data, /t=1/);
      assert.match(a.data, /d=2026-10-08/, 'data 要帶推播當時的 due_date（冪等靠它）');
      assert.ok(a.data.length <= 300, 'LINE postback data 上限 300 字');
    }
    assert.equal(msg.altText, e.call('dueReminderMessage_', rec, TODAY));
    const body = JSON.stringify(bubblesOf(msg)[0].body);
    assert.match(body, /繳管理費/); assert.match(body, /2026-10-08/); assert.match(body, /還剩 1 天/); assert.match(body, /待辦/);
  });

  test('卡片寫明待辦／提醒、是否週期', () => {
    const e = env();
    const body = JSON.stringify(bubblesOf(e.call('dueCardsMessage_', [reminder({ recur_interval: 1, recur_unit: '月' })], TODAY, null))[0].body);
    assert.match(body, /提醒/);
    assert.match(body, /每月/);
  });

  test('12 筆：剛好 12 張，沒有「還有 N 件」', () => {
    const e = env();
    const recs = Array.from({ length: 12 }, (_, i) => todo({ id: String(i + 1), text: '事' + (i + 1) }));
    const b = bubblesOf(e.call('dueCardsMessage_', recs, TODAY, null));
    assert.equal(b.length, 12);
    assert.ok(!JSON.stringify(b).includes('還有'));
  });

  test('13 筆：前 11 張＋最後一張「還有 2 件，請開 App」；altText 寫 13 件', () => {
    const e = env();
    const recs = Array.from({ length: 13 }, (_, i) => todo({ id: String(i + 1), text: '事' + (i + 1) }));
    const msg = e.call('dueCardsMessage_', recs, TODAY, null);
    const b = bubblesOf(msg);
    assert.equal(b.length, 12);
    assert.match(JSON.stringify(b[10].body), /事11/);
    assert.match(JSON.stringify(b[11]), /還有 2 件，請開 App/);
    assert.ok(!b[11].footer, '最後一張沒有按鈕');
    assert.match(msg.altText, /13 件/);
    assert.ok(msg.altText.length <= 400);
  });

  test('推到群組的卡片寫出是誰的', () => {
    const e = env();
    const msg = e.call('dueCardsMessage_', [todo({ line_id: MOM })], TODAY, null);
    assert.ok(!JSON.stringify(msg).includes('👤'), '個人不寫');
    const group = env().read(`dueCardsMessage_([${JSON.stringify(todo({ line_id: MOM }))}], "${TODAY}", function(id){ return id === "${MOM}" ? "裕仁" : ""; })`);
    assert.match(JSON.stringify(bubblesOf(group)[0].body), /👤 裕仁/);
    assert.match(group.altText, /裕仁的任務快到期了/);
  });
});

/* ========================================================================== */
describe('9 點排程：一個收件對象一次推播', () => {

  test('同一人 3 筆到期 → 一則輪播 3 張卡，3 筆都標 notified', () => {
    const e = env({ tasks: [todo({ id: '1' }), todo({ id: '2', text: '交報告' }), reminder({ id: '3' })] });
    e.call('checkDueReminders', TODAY);
    assert.equal(e.pushes.length, 1);
    assert.equal(bubblesOf(e.pushes[0].text).length, 3);
    assert.deepEqual(tasksOf(e).map((t) => t.notified), ['TRUE', 'TRUE', 'TRUE']);
  });

  test('個人與群組各一則', () => {
    const e = env({ tasks: [todo({ id: '1' }), todo({ id: '2', line_id: MOM, origin_chat: GROUP })] });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to).sort(), [GROUP, ME].sort());
  });

  test('推失敗：那個對象的幾筆都不標 notified（明天再推）；別的對象照常', () => {
    const e = env({ tasks: [todo({ id: '1' }), todo({ id: '2' }), todo({ id: '3', line_id: MOM })],
      pushImpl: ({ to }) => (to === ME ? { ok: false, code: 429, reason: 'quota' } : { ok: true, code: 200, reason: '' }) });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(tasksOf(e).map((t) => t.notified), ['', '', 'TRUE']);
    const log = e.transactions.find((t) => /到期檢查/.test(t[2]));
    assert.match(log[4], /推個人失敗/);
  });
});

/* ========================================================================== */
describe('三種任務 × 三顆按鈕', () => {

  test('待辦 ✅ → 勾完成（個人回「✅ 已處理」）', () => {
    const e = env({ tasks: [todo()] });
    assert.equal(tap(e, ME, cardFor(e, '繳管理費').done), '✅ 已處理');
    assert.equal(taskOf(e, '1').is_completed, 'TRUE');
  });

  test('週期待辦 ✅ → 照 ADR-009 生下一期，週期交給新的那列', () => {
    const e = env({ tasks: [todo({ recur_interval: 1, recur_unit: '月' })] });
    assert.match(tap(e, ME, cardFor(e, '繳管理費').done), /✅ 已處理，下次 11\/8/);
    const rows = tasksOf(e);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].is_completed, 'TRUE');
    assert.equal(rows[0].recur_unit, '');
    assert.equal(rows[1].due_date, '2026-11-08');
    assert.equal(rows[1].recur_unit, '月');
    assert.equal(rows[1].notified, '');
  });

  test('單次提醒 ✅ → 標已處理（is_completed），不再推', () => {
    const e = env({ tasks: [reminder()] });
    assert.equal(tap(e, ME, cardFor(e, '看牙醫').done), '✅ 已處理');
    assert.equal(taskOf(e, '2').is_completed, 'TRUE');
    assert.equal(e.call('shouldNotify_', taskOf(e, '2'), TODAY), false);
  });

  test('週期提醒 ✅ → 跳下一期、清 notified', () => {
    const e = env({ tasks: [reminder({ recur_interval: 1, recur_unit: '週' })] });
    assert.match(tap(e, ME, cardFor(e, '看牙醫').done), /下次 10\/15/);
    const r = taskOf(e, '2');
    assert.equal(r.due_date, '2026-10-15');
    assert.equal(r.notified, '');
    assert.equal(r.is_completed, '');
  });

  for (const [label, rec] of [['待辦', todo()], ['單次提醒', reminder({ id: '1', text: '繳管理費' })],
    ['週期提醒', reminder({ id: '1', text: '繳管理費', recur_interval: 1, recur_unit: '週' })]]) {
    test(label + ' ⏰ → 到期日改成台北明天、清 notified', () => {
      const e = env({ tasks: [rec] });
      assert.equal(tap(e, ME, cardFor(e, '繳管理費').tmr), '⏰ 明天再提醒');
      assert.equal(taskOf(e, '1').due_date, '2026-10-08');
      assert.equal(taskOf(e, '1').notified, '');
    });

    test(label + ' 📅 → 改成選的日期（過去的也收）、清 notified', () => {
      const e = env({ tasks: [rec] });
      assert.match(tap(e, ME, cardFor(e, '繳管理費').pick, { date: '2026-10-01' }), /📅 改到 10\/1/);
      assert.equal(taskOf(e, '1').due_date, '2026-10-01');
      assert.equal(taskOf(e, '1').notified, '');
    });
  }

  test('⏰ 之後隔天 9 點會再推（notified 已清）', () => {
    const e = env({ tasks: [todo({ due_date: '2026-10-07' })] });
    tap(e, ME, cardFor(e, '繳管理費').tmr);
    e.pushes.length = 0;
    e.call('checkDueReminders', '2026-10-08');
    assert.equal(e.pushes.length, 1);
  });
});

/* ========================================================================== */
describe('只有建立者、冪等、群組回覆、鎖、logs', () => {

  test('別人按：回「這筆由 裕仁 維護，請他處理 🙏」，資料不變、寫 logs', () => {
    const e = env({ tasks: [todo({ line_id: MOM, origin_chat: GROUP })] });
    const card = cardFor(e, '繳管理費', GROUP);
    const before = snap(e);
    for (const a of [card.done, card.tmr]) assert.equal(tap(e, ME, a, { group: true }), '這筆由 裕仁 維護，請他處理 🙏');
    assert.equal(tap(e, ME, card.pick, { group: true, date: '2026-12-01' }), '這筆由 裕仁 維護，請他處理 🙏');
    assert.equal(snap(e), before);
    assert.ok(e.transactions.some((t) => t[0] === '任務' && t[1] === '失敗' && /不是建立者/.test(t[3]) && t[6] === ME));
  });

  test('建立者在群組按 ✅：群組回「✅ 裕仁 已處理：內容」', () => {
    const e = env({ tasks: [todo({ line_id: MOM, origin_chat: GROUP })] });
    assert.equal(tap(e, MOM, cardFor(e, '繳管理費', GROUP).done, { group: true }), '✅ 裕仁 已處理：繳管理費');
  });

  test('建立者在群組按 ⏰／📅：回覆帶名字與內容', () => {
    const e = env({ tasks: [todo({ line_id: MOM, origin_chat: GROUP })] });
    const card = cardFor(e, '繳管理費', GROUP);
    assert.equal(tap(e, MOM, card.tmr, { group: true }), '⏰ 裕仁 改成明天再提醒：繳管理費');
    const e2 = env({ tasks: [todo({ line_id: MOM, origin_chat: GROUP })] });
    assert.match(tap(e2, MOM, cardFor(e2, '繳管理費', GROUP).pick, { group: true, date: '2026-10-20' }), /^📅 裕仁 改到 10\/20.*：繳管理費$/);
  });

  test('週期提醒的 ✅ 按兩次：只跳一期，第二次回「已經更新過」', () => {
    const e = env({ tasks: [reminder({ recur_interval: 1, recur_unit: '週' })] });
    const card = cardFor(e, '看牙醫');
    tap(e, ME, card.done);
    const after = snap(e);
    assert.match(tap(e, ME, card.done), /這筆已經更新過（目前：10\/15.*到期）/);
    assert.equal(snap(e), after);
    assert.equal(taskOf(e, '2').due_date, '2026-10-15');
  });

  test('舊卡片：在 App 改過日期之後再按 ⏰ → 不動作（不蓋掉 App 改的）', () => {
    const e = env({ tasks: [todo()] });
    const card = cardFor(e, '繳管理費');
    e.sheets.tasks.values[1][TASK_H.indexOf('due_date')] = '2026-10-30';
    const before = snap(e);
    assert.match(tap(e, ME, card.tmr), /已經更新過（目前：10\/30/);
    assert.equal(snap(e), before);
  });

  test('已完成、已刪：不動作', () => {
    const e = env({ tasks: [todo()] });
    const card = cardFor(e, '繳管理費');
    tap(e, ME, card.done);
    assert.match(tap(e, ME, card.tmr), /已經更新過（目前：已完成）/);
    const e2 = env({ tasks: [todo()] });
    const card2 = cardFor(e2, '繳管理費');
    e2.sheets.tasks.values[1][TASK_H.indexOf('del')] = 'TRUE';
    assert.match(tap(e2, ME, card2.done), /刪掉了/);
  });

  test('拿不到寫入鎖：回「有點忙」、資料不變（PR-4 同一把鎖）', () => {
    const e = env({ tasks: [todo()] });
    const card = cardFor(e, '繳管理費');
    e.lock.busy = true;
    const before = snap(e);
    assert.match(tap(e, ME, card.done), /有點忙/);
    assert.equal(snap(e), before);
  });

  test('每次按都寫 logs（成功也寫）', () => {
    const e = env({ tasks: [todo()] });
    tap(e, ME, cardFor(e, '繳管理費').tmr);
    assert.ok(e.transactions.some((t) => t[0] === '任務' && t[1] === '成功' && /到期卡片/.test(t[2]) && /2026-10-08/.test(t[3])));
  });

  test('不在白名單的人在一對一按：被擋、資料不變', () => {
    const e = env({ tasks: [todo()] });
    const card = cardFor(e, '繳管理費');
    const before = snap(e);
    assert.ok(tap(e, STRANGER, card.done));
    assert.equal(snap(e), before);
  });
});

/* ========================================================================== */
describe('前端：已處理的單次提醒收起', () => {

  test('提醒清單與首頁「深入」都不顯示 done 的提醒', () => {
    const e = loadFrontend();
    e.raw(`__els = {}; document.getElementById = function(id){ return __els[id] || (__els[id] = { id, innerHTML:'', textContent:'', hidden:false,
      classList:{add(){},remove(){},toggle(){},contains:()=>false}, setAttribute(){}, querySelectorAll:()=>[] }); }`);
    e.raw(`state.tasks = [
      {id:1, txt:'看牙醫（已處理）', kind:'reminder', done:true, due:'2026-10-08', ts:1, line_id:''},
      {id:2, txt:'繳房租', kind:'reminder', done:false, due:'2026-10-09', ts:2, line_id:''}]`);
    e.call('renderReminders');
    const html = e.read(`__els.reminderList.innerHTML + (__els.reminderPast ? __els.reminderPast.innerHTML : '')`);
    assert.ok(!html.includes('已處理'));
    assert.ok(html.includes('繳房租'));
    assert.deepEqual(e.read('homeTaskLists().reminders.map(t=>t.id)'), [2]);
  });
});
