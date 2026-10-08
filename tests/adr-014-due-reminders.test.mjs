/**
 * ADR-014 PR-A — 到期提醒（T1 排程修復、T2 推播依來源、T3 LINE 任務兩段式日期）
 *
 * 盯的事：
 *   - 「初始化」重複跑不累積觸發器；新欄位補得上、不重複；回覆列出觸發器
 *   - 觸發器呼叫時帶的是事件物件，不是日期——不可以被當成「今天」
 *   - 到期檢查每次都留紀錄（含 0 筆）：logs 一列＋performance 一列（trigger=schedule）
 *   - 路由：origin_chat 空白 → 個人；群組門檻全過 → 群組；任一不過 → 退回個人並註明原因
 *   - 推群組失敗 → 不標 notified、不改推個人
 *   - 群組建立的任務帶 origin_chat；一對一留白；PWA 寫不掉、也改不了它
 *   - Quick Reply：日期以「今天（台北）」換算；只有建立者按得動；同一 nonce 只生效一次
 *   - 日期解析與 5 分鐘等待
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const GROUP = 'Cfamily';
const TODAY = '2026-10-07';            // 星期三
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
  'created_at', 'updated_at', 'notify_due'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat'];

const taskRow = (o) => TASK_H.map((h) => (o[h] === undefined ? '' : o[h]));
const groupRow = (o = {}) => {
  const r = Object.assign({ group_id: GROUP, name: '家族', is_active: 'TRUE', cmd_expense: 'TRUE', cmd_tasks: 'TRUE',
    cmd_query: 'TRUE', joined_at: '2026-10-01T00:00:00.000Z', left_at: '', created_at: '', updated_at: '', notify_due: 'TRUE' }, o);
  return GROUP_H.map((h) => r[h]);
};
function roster(momTasks = 'TRUE') {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
    [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
    [MOM, '裕仁', 'TRUE', ''].concat(FEATS.map((f) => (f === 'feat_tasks' ? momTasks : 'TRUE')))
  ]);
}

/** 一個載入 Code.gs＋line-router.gs＋sheet-guide.gs 的完整環境 */
function env({ tasks = [], groups = [groupRow()], taskHeaders = TASK_H, users = roster(), pushImpl = null,
  noGroupSheet = false, overrides = {}, extraSheets = {}, realToday = false } = {}) {
  const replies = [];
  const sheets = Object.assign({
    line_users: users,
    tasks: new FakeSheet('tasks', [taskHeaders.slice()].concat(tasks.map(taskRow))),
    expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'subcategory', 'targets', 'amount',
      'note', 'created_at', 'line_id', 'del']]),
    logs: new FakeSheet('logs', [['id']])
  }, extraSheets);
  if (!noGroupSheet) sheets.line_groups = new FakeSheet('line_groups', [GROUP_H].concat(groups));
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], sheets, pushImpl,
    overrides: Object.assign({ lineReply_: (_t, msg) => { replies.push(msg); } },
      realToday ? {} : { lineTodayKey_: () => TODAY }, overrides)
  });
  e.replies = replies;
  e.last = () => replies[replies.length - 1];
  e.lastText = () => { const m = e.last(); return m && typeof m === 'object' ? m.text : String(m || ''); };
  return e;
}
const tasksOf = (e) => e.sheets.tasks.toRecords();
const perfRows = (e) => (e.ss.getSheetByName('performance') ? e.ss.getSheetByName('performance').toRecords() : []);

const src = (userId, type = 'group') => (type === 'user' ? { type, userId } : { type, groupId: GROUP, userId });
function say(e, userId, text, type = 'group') {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: src(userId, type), message: { type: 'text', text } });
  return e.replies.length > before ? e.lastText() : null;
}
function tap(e, userId, data, type = 'group', params) {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'postback', replyToken: 'rt', source: src(userId, type),
    postback: params ? { data, params } : { data } });
  return e.replies.length > before ? e.lastText() : null;
}
/** 最後一則回覆裡的 Quick Reply 動作 */
const actionsOf = (msg) => Array.from((msg && msg.quickReply && msg.quickReply.items) || [], (i) => i.action);
const btn = (msg, re) => actionsOf(msg).find((a) => re.test(a.label));

/* ========================================================================== */
describe('T1 排程修復：「初始化」一次裝好所有排程與欄位', () => {

  test('跑三次：到期提醒與 _guide 觸發器各只有一個；回覆列出它們', () => {
    const e = env();
    for (let i = 0; i < 3; i++) say(e, ME, '初始化', 'user');
    const handlers = e.triggers.map((t) => t.handler).sort();
    assert.deepEqual(handlers, ['checkDueReminders', 'checkStockRules', 'fetchStockDaily', 'flushUnauthPerf', 'refreshGuide']);
    assert.match(e.lastText(), /flushUnauthPerf（每小時）/);
    assert.match(e.lastText(), /checkDueReminders/);
    assert.match(e.lastText(), /refreshGuide/);
    assert.doesNotMatch(e.lastText(), /初始化沒有完成/);
  });

  test('新欄位補得上、跑三次也不重複：tasks.origin_chat、line_groups.notify_due', () => {
    const oldGroupH = GROUP_H.filter((h) => h !== 'notify_due');
    const e = env({
      taskHeaders: TASK_H.filter((h) => h !== 'origin_chat'),
      noGroupSheet: true,
      extraSheets: { line_groups: new FakeSheet('line_groups', [oldGroupH]) }
    });
    for (let i = 0; i < 3; i++) say(e, ME, '初始化', 'user');
    const th = e.sheets.tasks.values[0];
    const gh = e.ss.getSheetByName('line_groups').values[0];
    assert.equal(th.filter((h) => h === 'origin_chat').length, 1);
    assert.equal(gh.filter((h) => h === 'notify_due').length, 1);
  });

  test('installAll() 可以在編輯器單獨跑，結果一樣', () => {
    const e = env();
    e.call('installAll');
    e.call('installAll');
    assert.deepEqual(e.triggers.map((t) => t.handler).sort(), ['checkDueReminders', 'checkStockRules', 'fetchStockDaily', 'flushUnauthPerf', 'refreshGuide']);
  });

  test('非管理者不能初始化（不變）', () => {
    const e = env();
    assert.match(say(e, MOM, '初始化', 'user'), /只有管理者/);
    assert.equal(e.triggers.length, 0);
  });
});

/* ========================================================================== */
describe('T1 每次執行都留紀錄', () => {

  test('今天 0 筆也寫一列 logs＋一列 performance（trigger=schedule）', () => {
    const e = env();
    e.call('checkDueReminders', TODAY);
    assert.ok(e.transactions.some((t) => /到期檢查/.test(t[2]) && /0 筆/.test(t[3])), '0 筆也要看得到「有跑過」');
    const p = perfRows(e);
    assert.equal(p.length, 1);
    assert.equal(p[0].action, 'dueCheck');
    assert.equal(p[0].trigger, 'schedule');
    assert.equal(p[0].rows, 0);
    assert.equal(p[0].line_id, '', '排程沒有人，留白');
    assert.ok(typeof p[0].server_ms === 'number');
  });

  test('有符合項目：performance 的 rows＝符合門檻筆數', () => {
    const e = env({ tasks: [
      { id: '1', text: 'a', due_date: '2026-10-08', line_id: ME },
      { id: '2', text: 'b', due_date: '2026-12-08', line_id: ME }
    ] });
    e.call('checkDueReminders', TODAY);
    assert.equal(perfRows(e)[0].rows, 1);
  });

  test('⚠️ 觸發器呼叫時帶事件物件：不可以被當成日期，照樣用今天', () => {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const key = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    const e = env({ tasks: [{ id: '1', text: '今天到期', due_date: key, line_id: ME }] });
    const out = e.call('checkDueReminders', { authMode: 'FULL', triggerUid: '123', year: 2026 });
    assert.equal(out.notified, 1, '以前會把 "[object Object]" 當今天，於是永遠沒有東西到期');
  });

  test('refreshGuide 每次也寫 logs＋performance', () => {
    const e = env();
    e.call('refreshGuide');
    assert.ok(e.transactions.some((t) => /_guide/.test(t[2])));
    assert.ok(perfRows(e).some((p) => p.action === 'guideRefresh' && p.trigger === 'schedule'));
  });
});

/* ========================================================================== */
describe('T2 推播依來源', () => {

  const due = (o = {}) => Object.assign({ id: '1', text: '繳管理費', due_date: '2026-10-08', line_id: MOM }, o);

  test('origin_chat 空白 → 推建立者個人（現狀不變）', () => {
    const e = env({ tasks: [due()] });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to), [MOM]);
    assert.equal(tasksOf(e)[0].notified, 'TRUE');
  });

  test('群組門檻全過 → 推群組，訊息帶建立者名稱', () => {
    const e = env({ tasks: [due({ origin_chat: GROUP })] });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to), [GROUP]);
    assert.match(e.pushes[0].text, /裕仁的任務快到期了/);
    assert.match(e.pushes[0].text, /繳管理費/);
    assert.equal(tasksOf(e)[0].notified, 'TRUE');
  });

  for (const [label, g, reason] of [
    ['notify_due 關', { notify_due: '' }, /notify_due/],
    ['群組停用', { is_active: '' }, /停用/],
    ['bot 已離開', { left_at: '2026-10-05T00:00:00.000Z' }, /離開/]
  ]) {
    test('退回個人：' + label + '，logs 註明原因', () => {
      const e = env({ tasks: [due({ origin_chat: GROUP })], groups: [groupRow(g)] });
      e.call('checkDueReminders', TODAY);
      assert.deepEqual(e.pushes.map((p) => p.to), [MOM]);
      assert.doesNotMatch(e.pushes[0].text, /的任務快到期了/, '推給本人就不用說是誰的');
      const log = e.transactions.find((t) => /到期檢查/.test(t[2]));
      assert.match(log[4], /退回/);
      assert.match(log[4], reason);
    });
  }

  test('群組不在 line_groups → 退回個人', () => {
    const e = env({ tasks: [due({ origin_chat: 'Cunknown' })] });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to), [MOM]);
  });

  test('白板旗標不影響路由（白板歸白板）', () => {
    const e = env({ tasks: [due({ board: 'TRUE' }), due({ id: '2', board: 'TRUE', origin_chat: GROUP })] });
    e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to), [MOM, GROUP]);
  });

  test('⚠️ 推群組失敗 → 不標 notified、不改推個人（避免同一則推兩邊）', () => {
    const e = env({ tasks: [due({ origin_chat: GROUP })],
      pushImpl: ({ to }) => (to === GROUP ? { ok: false, code: 403, reason: 'not in group' } : { ok: true, code: 200 }) });
    const out = e.call('checkDueReminders', TODAY);
    assert.deepEqual(e.pushes.map((p) => p.to), [GROUP]);
    assert.equal(out.notified, 0);
    assert.equal(tasksOf(e)[0].notified, '');
  });

  test('groupSet 收 notify_due（管理員在 App 上開關）', () => {
    const e = env();
    const caller = { line_id: ME, user: { is_admin: 'TRUE' } };
    const r = e.call('groupSet_', caller, GROUP, 'notify_due', false);
    assert.equal(r.success, true);
    assert.equal(e.ss.getSheetByName('line_groups').toRecords()[0].notify_due, '');
  });

  test('新加入的群組 notify_due 預設空白＝關（推播計費）', () => {
    const e = env({ groups: [] });
    e.call('registerGroup_', { type: 'group', groupId: 'Cnew' }, 'Cnew');
    const g = e.ss.getSheetByName('line_groups').toRecords()[0];
    assert.equal(g.notify_due, '');
    assert.equal(g.cmd_tasks, 'TRUE', 'cmd_* 照舊預設開');
  });
});

/* ========================================================================== */
describe('T2 origin_chat 的來源與保護', () => {

  test('群組內「任務/買電池」→ 任務帶 origin_chat；一對一留白', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    say(e, MOM, '任務/繳費', 'user');
    const [a, b] = tasksOf(e);
    assert.equal(a.origin_chat, GROUP);
    assert.equal(a.line_id, MOM);
    assert.equal(b.origin_chat, '');
  });

  test('⚠️ PWA 編輯群組任務（沒帶或亂帶 origin_chat）→ 雲端那格不變', () => {
    const e = env({ tasks: [{ id: '1', text: 'x', line_id: MOM, origin_chat: GROUP }] });
    const sheet = e.sheets.tasks;
    const headers = e.call('sheetHeaders_', sheet);
    e.call('keepOriginChat_', sheet, headers, { id: '1' });
    const rec = { id: '1', text: '改過', line_id: MOM };
    e.call('upsertRow_', sheet, headers, e.call('keepOriginChat_', sheet, headers, rec), 'tasks', 'id');
    assert.equal(tasksOf(e)[0].origin_chat, GROUP);
    assert.equal(tasksOf(e)[0].text, '改過');

    const forged = e.call('keepOriginChat_', sheet, headers, { id: '1', origin_chat: 'Cother' });
    assert.equal(forged.origin_chat, GROUP, 'PWA 不能改它');
    const fresh = e.call('keepOriginChat_', sheet, headers, { id: '9', origin_chat: 'Cother' });
    assert.equal(fresh.origin_chat, '', 'PWA 新建的任務一律留白');
  });
});

/* ========================================================================== */
describe('T3 LINE「任務/」兩段式日期', () => {

  test('建立後回 Quick Reply：+1/+3/+7/+10/+30（台北今天換算，含星期）＋選日期／自己輸入／不設', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const msg = e.last();
    assert.match(msg.text, /已新增任務/);
    assert.match(msg.text, /要設到期日嗎/);
    const labels = actionsOf(msg).map((a) => a.label);
    assert.deepEqual(labels.slice(0, 5), ['+1 10/8 四', '+3 10/10 六', '+7 10/14 三', '+10 10/17 六', '+30 11/6 五']);
    assert.ok(labels.includes('📅 選日期') && labels.includes('✏️ 自己輸入') && labels.includes('不設日期'));
    assert.ok(labels.every((l) => l.length <= 20));
    const pick = btn(msg, /選日期/);
    assert.equal(pick.type, 'datetimepicker');
    assert.equal(pick.mode, 'date');
    assert.equal(pick.initial, '2026-10-08');
    assert.equal(pick.min, '2026-10-07');
    assert.ok(actionsOf(msg).every((a) => a.data.length <= 300), 'LINE postback data 上限 300 字');
  });

  test('「今天」用台北時區算（lineTodayKey_ 傳 Asia/Taipei 給 formatDate）', () => {
    const seen = [];
    // 指令碼時區故意設成 UTC：要證明用的是寫死的台北，不是跟著專案設定走
    const e = env({ realToday: true, overrides: { Session: { getScriptTimeZone: () => 'UTC' },
      Utilities: { formatDate: (_d, tz, f) => { seen.push([tz, f]); return '2026-10-07'; } } } });
    assert.equal(e.call('lineTodayKey_'), '2026-10-07');
    assert.deepEqual(seen, [['Asia/Taipei', 'yyyy-MM-dd']]);
  });

  test('按 +7 → 寫入 due_date、清 notified，回「✅ 到期日 10/14（三）」', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const prompt = e.last();
    e.sheets.tasks.values[1][TASK_H.indexOf('notified')] = 'TRUE';   // 之前推過（例如原本有日期）
    const reply = tap(e, MOM, btn(prompt, /^\+7/).data);
    assert.match(reply, /✅ 到期日 10\/14（三）/);
    assert.equal(tasksOf(e)[0].due_date, '2026-10-14');
    assert.equal(tasksOf(e)[0].notified, '');
  });

  test('📅 選日期 → 用 postback params.date', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const reply = tap(e, MOM, btn(e.last(), /選日期/).data, 'group', { date: '2026-11-20' });
    assert.match(reply, /11\/20/);
    assert.equal(tasksOf(e)[0].due_date, '2026-11-20');
  });

  test('不設日期 → 回「之後可以在 App 補」，不寫 due_date', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    assert.match(tap(e, MOM, btn(e.last(), /不設日期/).data), /之後可以在 App 補/);
    assert.equal(tasksOf(e)[0].due_date, '');
  });

  test('⚠️ 建立者以外的人按不動', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const data = btn(e.last(), /^\+1/).data;
    assert.match(tap(e, ME, data), /別人/);
    assert.equal(tasksOf(e)[0].due_date, '');
  });

  test('⚠️ 按鈕資料寫「是我」但任務是別人的 → 寫入層再擋一次', () => {
    const e = env({ tasks: [{ id: '1', text: '媽媽的任務', line_id: MOM }] });
    assert.match(tap(e, ME, 'td=1&t=1&u=' + ME + '&n=forged&d=1'), /別人建的/);
    assert.equal(tasksOf(e)[0].due_date, '');
  });

  test('⚠️ 同一個 nonce 只生效一次', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const msg = e.last();
    tap(e, MOM, btn(msg, /^\+1/).data);
    assert.match(tap(e, MOM, btn(msg, /^\+30/).data), /已經設過/);
    assert.equal(tasksOf(e)[0].due_date, '2026-10-08');
  });

  test('postback 一樣過門：群組停用、cmd_tasks 關、沒有任務權限都擋', () => {
    for (const [g, users, re] of [
      [groupRow({ is_active: '' }), roster(), /還沒啟用/],
      [groupRow({ cmd_tasks: '' }), roster(), /沒有開放「任務」/],
      [groupRow(), roster(''), /沒有「任務」功能的權限/]
    ]) {
      const e = env({ groups: [g], users, tasks: [{ id: '1', text: 'x', line_id: MOM }] });
      const data = 'td=1&t=1&u=' + MOM + '&n=abc&d=1';
      assert.match(tap(e, MOM, data), re);
      assert.equal(tasksOf(e)[0].due_date, '');
    }
  });

  test('一對一的任務也有日期按鈕，建立者按得動', () => {
    const e = env();
    say(e, MOM, '任務/繳費', 'user');
    assert.match(tap(e, MOM, btn(e.last(), /^\+3/).data, 'user'), /10\/10/);
  });
});

/* ========================================================================== */
describe('T3 日期解析（純函式）', () => {
  const e = env();
  const p = (s) => e.call('parseTaskDateInput_', s, TODAY);

  test('1015、10/15、全形、含年份', () => {
    assert.equal(p('1015'), '2026-10-15');
    assert.equal(p('10/15'), '2026-10-15');
    assert.equal(p('１０／１５'), '2026-10-15');
    assert.equal(p('１０１５'), '2026-10-15');
    assert.equal(p('2026/10/15'), '2026-10-15');
    assert.equal(p(' 10/15 '), '2026-10-15');
  });

  test('今年已過 → 明年；今天就是今天', () => {
    assert.equal(p('0301'), '2027-03-01');
    assert.equal(p('10/7'), '2026-10-07');
    assert.equal(p('10/6'), '2027-10-06');
  });

  test('看不懂：不存在的日期、亂打的字', () => {
    for (const s of ['0230', 'abc', '13/01', '', '10/15/2026', '2026/2/30', '101', '10155']) {
      assert.equal(p(s), '', s);
    }
  });
});

/* ========================================================================== */
describe('T3 ✏️ 自己輸入＝5 分鐘等待', () => {

  function waiting(type = 'group') {
    const e = env();
    say(e, MOM, '任務/買電池', type);
    const reply = tap(e, MOM, btn(e.last(), /自己輸入/).data, type);
    assert.match(reply, /請回覆日期/);
    return e;
  }

  test('同人同聊天室打日期 → 寫入、清除等待', () => {
    const e = waiting();
    assert.match(say(e, MOM, '1015'), /✅ 到期日 10\/15（四）/);
    assert.equal(tasksOf(e)[0].due_date, '2026-10-15');
    assert.equal(say(e, MOM, '1020'), null, '等待清掉了，群組裡的數字又只是聊天');
  });

  test('一對一一樣能用', () => {
    const e = waiting('user');
    assert.match(say(e, MOM, '10/20', 'user'), /10\/20/);
    assert.equal(tasksOf(e)[0].due_date, '2026-10-20');
  });

  test('中途打「記帳/120/飲食」→ 取消等待，記帳照常成功', () => {
    const e = waiting();
    assert.match(say(e, MOM, '記帳/120/飲食'), /已記錄支出/);
    assert.equal(e.sheets.expenses.toRecords().length, 1);
    assert.equal(say(e, MOM, '1015'), null, '等待已取消');
    assert.equal(tasksOf(e)[0].due_date, '');
  });

  test('⚠️ 群組裡別人打 1015 不被採用', () => {
    const e = waiting();
    assert.equal(say(e, ME, '1015'), null);
    assert.equal(tasksOf(e)[0].due_date, '');
    assert.match(say(e, MOM, '1016'), /10\/16/, '建立者的等待還在');
  });

  test('看不懂 → 提示一次、繼續等；再看不懂就不插嘴', () => {
    const e = waiting();
    assert.match(say(e, MOM, '晚點再說'), /1015/);
    assert.equal(say(e, MOM, '哈哈'), null);
    assert.match(say(e, MOM, '10/18'), /10\/18/);
  });

  test('⚠️ 逾時（5 分鐘）後不再解讀', () => {
    const e = waiting();
    e.clock.advance(301);
    assert.equal(say(e, MOM, '1015'), null);
    assert.equal(tasksOf(e)[0].due_date, '');
  });

  test('等待中按了其他日期鈕也一樣只生效一次', () => {
    const e = env();
    say(e, MOM, '任務/買電池');
    const msg = e.last();
    tap(e, MOM, btn(msg, /自己輸入/).data);
    say(e, MOM, '1015');
    assert.match(tap(e, MOM, btn(msg, /^\+1/).data), /已經設過/);
    assert.equal(tasksOf(e)[0].due_date, '2026-10-15');
  });

  test('任務被刪了才回日期 → 講清楚，不寫', () => {
    const e = waiting();
    e.sheets.tasks.values[1][TASK_H.indexOf('del')] = 'TRUE';
    assert.match(say(e, MOM, '1015'), /找不到/);
  });
});

