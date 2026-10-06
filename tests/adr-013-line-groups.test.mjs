/**
 * ADR-013 PR-C — LINE 群組入口（T5）× Quick Reply 記帳（T6）
 *
 * 盯的事：
 *   - 群組指令三道門依序：群組啟用 → 群組開放這類指令 → 發話者本人白名單＋功能權限
 *   - 未註冊者收到友善指路；1 對 1 的行為不變
 *   - 群組裡的閒聊（不是指令）不回、不寫 logs
 *   - join → 待審列（cmd_* 預設全開）；重複 join 不重複、保留設定；leave → left_at；1 分鐘內秒退標 ⚠️
 *   - 「記帳/金額」→ 大類按鈕 →（有細項）細項＋略過 → 記下；postback 一樣過門；同一個 nonce 只記一次
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const STRANGER = 'Ustranger';
const GROUP = 'Cfamily';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'subcategory', 'targets', 'amount', 'note', 'created_at', 'line_id', 'del'];

function roster(momExpense = 'TRUE') {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
    [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
    [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map((f) => (f === 'feat_expense' ? momExpense : 'TRUE')))
  ]);
}
const groupRow = (o = {}) => {
  const r = Object.assign({ group_id: GROUP, name: '家族', is_active: 'TRUE', cmd_expense: 'TRUE', cmd_tasks: 'TRUE', cmd_query: 'TRUE',
    joined_at: '2026-10-01T00:00:00.000Z', left_at: '', created_at: '2026-10-01T00:00:00.000Z', updated_at: '' }, o);
  return GROUP_H.map((h) => r[h]);
};

function env({ groups = [groupRow()], users = roster(), noGroupSheet = false, properties = {}, overrides = {} } = {}) {
  const replies = [];
  const sheets = {
    line_users: users,
    expenses: new FakeSheet('expenses', [EXP_H]),
    tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id']]),
    logs: new FakeSheet('logs', [['id']])
  };
  if (!noGroupSheet) sheets.line_groups = new FakeSheet('line_groups', [GROUP_H].concat(groups));
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs'], properties, sheets,
    overrides: Object.assign({ lineReply_: (_t, msg) => { replies.push(msg); } }, overrides)
  });
  e.replies = replies;
  e.last = () => replies[replies.length - 1];
  e.lastText = () => { const m = replies[replies.length - 1]; return m && typeof m === 'object' ? m.text : String(m || ''); };
  return e;
}
const src = (userId, type = 'group') => (type === 'user' ? { type, userId } : { type, groupId: GROUP, userId });
function say(e, userId, text, type = 'group') {
  const before = e.replies.length;
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: src(userId, type), message: { type: 'text', text } });
  return e.replies.length > before ? e.lastText() : null;
}
function tap(e, userId, data, type = 'group') {
  e.call('handleLineEvent_', { type: 'postback', replyToken: 'rt', source: src(userId, type), postback: { data } });
  return e.last();
}
const rows = (e) => e.sheets.expenses.toRecords();
const groups = (e) => e.ss.getSheetByName('line_groups').toRecords();

/* ========================================================================== */
describe('群組三道門（D-13）', () => {

  test('全開的群組＋已註冊、有權限的人 → 記得進去，歸屬是發話者', () => {
    const e = env();
    assert.match(say(e, MOM, '記帳/120/外食/晚餐'), /已記錄支出/);
    assert.deepEqual([rows(e)[0].category, rows(e)[0].subcategory, rows(e)[0].line_id], ['飲食', '外食', MOM]);
  });

  test('第一道：群組還沒啟用（is_active 空白）→ 擋下、不寫入、寫 logs', () => {
    const e = env({ groups: [groupRow({ is_active: '' })] });
    assert.match(say(e, ME, '記帳/120/外食'), /這個群組還沒啟用 Neil OS/);
    assert.equal(rows(e).length, 0);
    assert.ok(e.transactions.some((t) => t[0] === '群組' && /還沒啟用/.test(t[3])));
  });

  test('第一道：已離開（left_at 有值）視同停用', () => {
    const e = env({ groups: [groupRow({ left_at: '2026-10-05T00:00:00.000Z' })] });
    assert.match(say(e, ME, '記帳/120/外食'), /還沒啟用/);
  });

  test('第二道：群組沒開放這類指令（cmd_tasks 關）→ 擋任務，記帳照常', () => {
    const e = env({ groups: [groupRow({ cmd_tasks: '' })] });
    assert.match(say(e, ME, '任務/買牛奶'), /這個群組沒有開放「任務」/);
    assert.equal(e.sheets.tasks.toRecords().length, 0);
    assert.match(say(e, ME, '記帳/50/外食'), /已記錄支出/);
  });

  test('「查/」照 cmd_query；「分類」照 cmd_expense', () => {
    const e = env({ groups: [groupRow({ cmd_query: '', cmd_expense: '' })] });
    assert.match(say(e, ME, '查/這個月花多少'), /沒有開放「查詢」/);
    assert.match(say(e, ME, '分類'), /沒有開放「記帳」/);
  });

  test('第三道：未註冊的人 → 友善指路去私訊註冊，不是冷冰冰的沒有權限', () => {
    const e = env();
    const reply = say(e, STRANGER, '記帳/120/外食');
    assert.match(reply, /你還沒註冊 Neil OS，私訊我傳 whoami 就能開始/);
    assert.equal(rows(e).length, 0);
  });

  test('第三道：已註冊但沒有記帳權限 → 擋下（功能權限照舊）', () => {
    const e = env({ users: roster('') });
    assert.match(say(e, MOM, '記帳/120/外食'), /沒有「記帳」功能的權限/);
    assert.equal(rows(e).length, 0);
  });

  test('第三道：取不到 userId（電腦版 LINE）→ 講清楚原因', () => {
    const e = env();
    assert.match(say(e, '', '記帳/120/外食'), /取不到你的 userId/);
  });

  test('三道門的順序：群組沒啟用時，連陌生人都只看到「群組沒啟用」（不洩漏名單狀態）', () => {
    const e = env({ groups: [groupRow({ is_active: '' })] });
    assert.match(say(e, STRANGER, '記帳/120/外食'), /群組還沒啟用/);
  });

  test('群組裡的閒聊（不是指令）→ 不回、不寫 logs', () => {
    const e = env();
    for (const t of ['今天晚餐吃什麼', '記帳', '哈哈 1/2', '沒有/這個前綴']) assert.equal(say(e, ME, t), null, t);
    assert.equal(e.transactions.length, 0);
  });

  test('whoami 在所有門之前；配對在群組照樣拒絕；初始化只限一對一', () => {
    const e = env({ groups: [groupRow({ is_active: '' })] });
    assert.match(say(e, STRANGER, 'whoami'), /groupId/);
    assert.match(say(e, ME, '配對'), /只能在跟 bot 的一對一聊天室傳/);
    assert.match(say(e, ME, '初始化'), /只能在跟 bot 的一對一聊天室用/);
    assert.equal(e.ss.getSheetByName('_expense_config'), null, '初始化沒有被執行');
  });

  test('功能上線前就加入的群組（沒有紀錄）：第一次下指令補一列待審，回「還沒啟用」', () => {
    const e = env({ noGroupSheet: true });
    assert.match(say(e, ME, '記帳/120/外食'), /還沒啟用/);
    const g = groups(e);
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].group_id, g[0].is_active, g[0].cmd_expense, g[0].cmd_tasks, g[0].cmd_query], [GROUP, '', 'TRUE', 'TRUE', 'TRUE']);
  });

  test('1 對 1 行為不變：不看 line_groups（就算有一個停用的群組也一樣）', () => {
    const e = env({ groups: [groupRow({ is_active: '' })] });
    assert.match(say(e, ME, '記帳/120/外食', 'user'), /已記錄支出/);
    assert.match(say(e, ME, '亂打/123', 'user'), /沒有這個前綴/, '1 對 1 打錯前綴照樣回提示');
  });
});

/* ========================================================================== */
describe('join／leave（D-14／D-15）', () => {

  const join = (e) => e.call('handleLineEvent_', { type: 'join', replyToken: 'rt', source: { type: 'group', groupId: GROUP } });
  const leave = (e) => e.call('handleLineEvent_', { type: 'leave', source: { type: 'group', groupId: GROUP } });

  test('join → 新增待審列（is_active 空白、cmd_* 全開），回覆教人去打勾', () => {
    const e = env({ noGroupSheet: true });
    join(e);
    const g = groups(e);
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].is_active, g[0].cmd_expense, g[0].cmd_tasks, g[0].cmd_query, g[0].left_at], ['', 'TRUE', 'TRUE', 'TRUE', '']);
    assert.ok(g[0].joined_at);
    assert.match(e.lastText(), /line_groups 分頁.*is_active 打勾/);
  });

  test('重複 join：不重複列、保留原本的啟用與指令設定、清掉 left_at', () => {
    const e = env({ groups: [groupRow({ cmd_tasks: '', left_at: '2026-10-05T00:00:00.000Z' })] });
    join(e);
    const g = groups(e);
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].is_active, g[0].cmd_tasks, g[0].left_at, g[0].name], ['TRUE', '', '', '家族']);
  });

  test('leave → 寫 left_at（＝停用）＋logs', () => {
    const e = env();
    leave(e);
    assert.ok(groups(e)[0].left_at);
    assert.ok(e.transactions.some((t) => t[0] === '加入群組' && t[1] === '成功' && /已離開/.test(t[3])));
    assert.match(say(e, ME, '記帳/120/外食'), /還沒啟用/);
  });

  test('join 後 1 分鐘內就 leave → logs 標 ⚠️ 疑似群組已有其他官方帳號', () => {
    const e = env({ groups: [groupRow({ joined_at: new Date(Date.now() - 30000).toISOString() })] });
    leave(e);
    assert.ok(e.transactions.some((t) => t[1] === '失敗' && /⚠️.*其他官方帳號/.test(t[3])));
  });

  test('超過 1 分鐘才離開 → 一般的離開，不標 ⚠️', () => {
    const e = env({ groups: [groupRow({ joined_at: new Date(Date.now() - 120000).toISOString() })] });
    leave(e);
    assert.ok(!e.transactions.some((t) => /其他官方帳號/.test(t[3])));
  });
});

/* ========================================================================== */
describe('Quick Reply 記帳（T6）', () => {

  const items = (msg) => msg.quickReply.items.map((i) => i.action);

  test('「記帳/120」→ 大類按鈕（postback、無狀態：金額與類型都在 data 裡）', () => {
    const e = env();
    say(e, ME, '記帳/120');
    const msg = e.last();
    assert.match(msg.text, /選一個分類/);
    const acts = items(msg);
    assert.deepEqual(acts.map((a) => a.label), ['飲食', '交通', '日常用品', '家庭', '醫療', '娛樂', '其他', '教育']);
    assert.ok(acts.every((a) => a.type === 'postback' && /qr=1/.test(a.data) && /a=120/.test(a.data) && /n=\w+/.test(a.data)));
    assert.equal(rows(e).length, 0, '還沒選分類，不寫入');
  });

  test('大類有細項 → 細項按鈕＋略過；選了細項 → 記下，格式同打字記帳', () => {
    const e = env();
    say(e, ME, '記帳/120');
    const food = items(e.last()).find((a) => a.label === '飲食');
    const step2 = tap(e, ME, food.data);
    assert.deepEqual(items(step2).map((a) => a.label), ['外食', '買菜', '冷凍', '常備食材', '略過']);
    // LINE 官方上限：postback data 300 字、標籤 20 字（中文 URL 編碼一個字佔 9 個字元，要量）
    for (const a of items(step2).concat(items(e.replies[e.replies.length - 2]))) {
      assert.ok(a.data.length <= 300, a.label + ' 的 data 有 ' + a.data.length + ' 字');
      assert.ok(a.label.length <= 20);
    }
    const out = tap(e, ME, items(step2).find((a) => a.label === '外食').data);
    assert.match(out, /✅ 已記錄支出\n-\$120　飲食＞外食/);
    assert.deepEqual([rows(e)[0].category, rows(e)[0].subcategory, rows(e)[0].line_id], ['飲食', '外食', ME]);
  });

  test('略過細項 → 記成未細分', () => {
    const e = env();
    say(e, ME, '記帳/120');
    const step2 = tap(e, ME, items(e.last()).find((a) => a.label === '飲食').data);
    tap(e, ME, items(step2).find((a) => a.label === '略過').data);
    assert.equal(rows(e)[0].subcategory, '');
  });

  test('大類沒有細項 → 點了直接記', () => {
    const e = env();
    say(e, ME, '收入/50000');
    const out = tap(e, ME, items(e.last()).find((a) => a.label === '其他').data);
    assert.match(out, /已記錄收入\n\+\$50,000　其他/);
    assert.equal(rows(e)[0].type, 'income');
  });

  test('⚠️ 同一個 nonce 第二次點 → 「這筆已經記過了」，不會變兩筆帳', () => {
    const e = env();
    say(e, ME, '記帳/300');
    const daily = items(e.last()).find((a) => a.label === '日常用品');
    tap(e, ME, daily.data);
    assert.match(tap(e, ME, daily.data), /這筆已經記過了/);
    assert.equal(rows(e).length, 1);
  });

  test('群組裡別人按到我叫出來的按鈕 → 不記（不然帳會記在按的人名下）', () => {
    const e = env();
    say(e, MOM, '記帳/300');
    const daily = items(e.last()).find((a) => a.label === '日常用品');
    assert.match(tap(e, ME, daily.data), /這組按鈕是別人叫出來的/);
    assert.equal(rows(e).length, 0);
    assert.match(tap(e, MOM, daily.data), /已記錄支出/);
    assert.equal(rows(e)[0].line_id, MOM);
  });

  test('寫入失敗 → nonce 放回去，可以再按一次（不會被誤說「已經記過了」）', () => {
    const e = env();
    say(e, ME, '記帳/300');
    const daily = items(e.last()).find((a) => a.label === '日常用品');
    const keep = e.sheets.expenses;
    delete e.sheets.expenses;
    assert.match(tap(e, ME, daily.data), /寫入失敗/);
    e.sheets.expenses = keep;
    assert.match(tap(e, ME, daily.data), /已記錄支出/);
    assert.equal(rows(e).length, 1);
  });

  test('postback 一樣過三道門：群組停用、cmd_expense 關、未註冊、沒權限都擋', () => {
    const e = env();
    say(e, ME, '記帳/120');
    const data = items(e.last()).find((a) => a.label === '日常用品').data;

    const off = env({ groups: [groupRow({ is_active: '' })] });
    assert.match(tap(off, ME, data), /還沒啟用/);
    const noCmd = env({ groups: [groupRow({ cmd_expense: '' })] });
    assert.match(tap(noCmd, ME, data), /沒有開放「記帳」/);
    const stranger = env();
    assert.match(tap(stranger, STRANGER, data), /還沒註冊/);
    const noFeat = env({ users: roster('') });
    assert.match(tap(noFeat, MOM, data), /沒有「記帳」功能的權限/);
    for (const x of [off, noCmd, stranger, noFeat]) assert.equal(rows(x).length, 0);
  });

  test('1 對 1 的 postback：不在白名單 → 擋下', () => {
    const e = env();
    say(e, ME, '記帳/120', 'user');
    const data = items(e.last()).find((a) => a.label === '日常用品').data;
    assert.match(String(tap(e, STRANGER, data, 'user')), /沒有權限|名單/);
    assert.equal(rows(e).length, 0);
  });

  test('超過 13 個按鈕 → 截斷成 12 個＋「其他」（請打完整格式）', () => {
    const e = env();
    const cfg = [['kind', 'name', 'parent', 'targets', 'aliases', 'color', 'sort', 'is_active']];
    for (let i = 1; i <= 15; i++) cfg.push(['category', '類' + i, '', '', '', 'c' + ((i % 8) + 1), i, '']);
    e.sheets._expense_config = new FakeSheet('_expense_config', cfg);
    say(e, ME, '記帳/120', 'user');
    const acts = items(e.last());
    assert.equal(acts.length, 13);
    assert.equal(acts[12].label, '其他');
    assert.match(tap(e, ME, acts[12].data, 'user'), /請打完整格式/);
  });

  test('分類被停用後才按到舊按鈕 → 講清楚，不寫入', () => {
    const e = env();
    say(e, ME, '記帳/120', 'user');
    const data = items(e.last()).find((a) => a.label === '日常用品').data;
    e.sheets._expense_config.values.forEach((r) => { if (r[1] === '日常用品') r[7] = 'FALSE'; });
    e.cache.evict('adr013_expense_config');
    assert.match(tap(e, ME, data, 'user'), /已經不能用了/);
    assert.equal(rows(e).length, 0);
  });

  test('打字記帳不受影響：「記帳/120/外食」照舊直接記；「記帳/abc」照舊回金額錯誤', () => {
    const e = env();
    assert.match(say(e, ME, '記帳/120/外食', 'user'), /已記錄支出/);
    assert.match(say(e, ME, '記帳/abc', 'user'), /金額要是大於 0 的數字/);
  });
});

/* ========================================================================== */
describe('PWA 碰不到 line_groups', () => {

  test('讀、寫都擋', () => {
    const e = loadCodeGs({ tokens: { 'tok': ME }, sheets: { line_users: roster(), line_groups: new FakeSheet('line_groups', [GROUP_H, groupRow()]) } });
    const post = (b) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: 'tok' }, b)) } }).body);
    assert.equal(post({ action: 'read', sheet: 'line_groups' }).error, 'sheet_not_readable');
    assert.equal(post({ action: 'upsert', sheet: 'line_groups', record: { group_id: 'x' } }).error, 'sheet_not_writable');
  });
});
