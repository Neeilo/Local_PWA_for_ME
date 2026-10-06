/**
 * 首頁「系統設定」卡片（管理員，2026-10-06 Neil 要求）
 *
 * 盯的事：
 *   - 只有管理者能看、能改；每一筆改動寫 logs（source「設定」）；非管理者被擋也留 logs
 *   - 群組：只收 is_active／cmd_* 四個欄、只收真假值；改了 LINE 的三道門立刻跟著變
 *   - 分類：只收 is_active／color／targets／aliases／sort；不能改名；新增會擋重複與掛錯地方；
 *     改完清快取，App 與 LINE 不必等 5 分鐘；回傳最新的 ⚠️ 自檢
 *   - 導覽：跟寫 _guide 的是同一份函式
 *   - 一般 read／upsert 仍然碰不到這幾張表
 *   - 前端：非管理者看不到卡片；按了分頁才抓；分期分頁用手上的計畫列，不另外發請求
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at', 'created_at', 'updated_at'];
const CFG_H = ['kind', 'name', 'parent', 'targets', 'aliases', 'color', 'sort', 'is_active'];

function env() {
  const replies = [];
  const e = loadCodeGs({
    cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { 'tok-me': ME, 'tok-mom': MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE'].concat(FEATS.map(() => 'TRUE')),
        [MOM, '媽媽', 'TRUE', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      line_groups: new FakeSheet('line_groups', [GROUP_H,
        ['Cfam', '家族', '', 'TRUE', 'TRUE', 'TRUE', '2026-10-01T00:00:00.000Z', '', '', '']]),
      expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'subcategory', 'targets', 'amount', 'note', 'created_at', 'line_id', 'del']]),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides: { lineReply_: (_t, m) => { replies.push(typeof m === 'object' ? m.text : String(m)); } }
  });
  e.replies = replies;
  return e;
}
const post = (e, body, tok = 'tok-me') => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok }, body)) } }).body);
const say = (e, userId, text) => {
  e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'group', groupId: 'Cfam', userId }, message: { type: 'text', text } });
  return e.replies[e.replies.length - 1];
};
const cfgRows = (e) => e.ss.getSheetByName('_expense_config').toRecords();

/* ========================================================================== */
describe('只有管理者', () => {

  for (const body of [{ action: 'adminView', what: 'groups' }, { action: 'groupSet', group_id: 'Cfam', field: 'is_active', value: true },
    { action: 'configSet', key: { kind: 'category', name: '飲食' }, field: 'is_active', value: false },
    { action: 'configAdd', record: { kind: 'category', name: '寵物' } }]) {
    test(body.action + '：非管理者 → forbidden、什麼都不改、寫 logs', () => {
      const e = env();
      const before = JSON.stringify(e.sheets.line_groups.values);
      assert.equal(post(e, body, 'tok-mom').error, 'forbidden');
      assert.equal(JSON.stringify(e.sheets.line_groups.values), before);
      assert.ok(e.transactions.some((t) => t[0] === '設定' && t[1] === '失敗' && t[6] === MOM));
    });
  }

  test('一般 read／upsert 仍然碰不到 line_groups 與 _expense_config', () => {
    const e = env();
    assert.equal(post(e, { action: 'read', sheet: 'line_groups' }).error, 'sheet_not_readable');
    assert.equal(post(e, { action: 'upsert', sheet: 'line_groups', record: { group_id: 'x' } }).error, 'sheet_not_writable');
    assert.equal(post(e, { action: 'upsert', sheet: '_expense_config', record: { kind: 'x' } }).error, 'sheet_not_writable');
  });
});

/* ========================================================================== */
describe('群組', () => {

  test('adminView groups 回所有群組列', () => {
    const out = post(env(), { action: 'adminView', what: 'groups' });
    assert.deepEqual(out.rows.map((g) => [g.group_id, g.name, g.is_active]), [['Cfam', '家族', '']]);
  });

  test('打勾啟用 → LINE 群組立刻能記帳；關掉 cmd_expense → 立刻擋下；寫 logs', () => {
    const e = env();
    assert.match(say(e, ME, '記帳/120/外食'), /還沒啟用/);
    const on = post(e, { action: 'groupSet', group_id: 'Cfam', field: 'is_active', value: true });
    assert.deepEqual([on.success, on.value], [true, 'TRUE']);
    assert.match(say(e, ME, '記帳/120/外食'), /已記錄支出/);
    post(e, { action: 'groupSet', group_id: 'Cfam', field: 'cmd_expense', value: false });
    assert.match(say(e, ME, '記帳/120/外食'), /沒有開放「記帳」/);
    assert.ok(e.transactions.some((t) => t[0] === '設定' && t[1] === '成功' && /cmd_expense → 關/.test(t[3])));
  });

  test('只收四個欄位、只收真假值；找不到群組', () => {
    const e = env();
    assert.equal(post(e, { action: 'groupSet', group_id: 'Cfam', field: 'name', value: 'x' }).error, 'invalid_field');
    assert.equal(post(e, { action: 'groupSet', group_id: 'Cfam', field: 'is_active', value: 'yes' }).value, '', '不是 true 一律當關');
    assert.equal(post(e, { action: 'groupSet', group_id: 'Cnope', field: 'is_active', value: true }).error, 'group_not_found');
  });
});

/* ========================================================================== */
describe('分類', () => {

  test('adminView config：沒有設定表就建初版；回原始列（含停用）與自檢', () => {
    const e = env();
    const out = post(e, { action: 'adminView', what: 'config' });
    assert.equal(out.rows.filter((r) => r.kind === 'category').length, 8);
    assert.deepEqual(out.warnings, []);
  });

  test('停用一個細項 → 立刻生效（不等 5 分鐘快取）：LINE 打不進去、「分類」看不到', () => {
    const e = env();
    post(e, { action: 'groupSet', group_id: 'Cfam', field: 'is_active', value: true });
    assert.match(say(e, ME, '記帳/120/冷凍'), /已記錄支出/);         // 先讓設定進快取
    const out = post(e, { action: 'configSet', key: { kind: 'sub', name: '冷凍' }, field: 'is_active', value: false });
    assert.equal(out.success, true);
    assert.equal(cfgRows(e).find((r) => r.name === '冷凍').is_active, 'FALSE', '明寫 FALSE（空白在這張表是啟用）');
    assert.match(say(e, ME, '記帳/120/冷凍'), /沒有「冷凍」這個分類/);
    assert.doesNotMatch(say(e, ME, '分類'), /冷凍/);
  });

  test('改大類顏色、對象群組、別名、排序；細項不能改顏色', () => {
    const e = env();
    const set = (key, field, value) => post(e, { action: 'configSet', key, field, value });
    assert.equal(set({ kind: 'category', name: '飲食' }, 'color', 'c8').success, true);
    assert.equal(set({ kind: 'category', name: '飲食' }, 'targets', '家人').success, true);
    assert.equal(set({ kind: 'category', name: '飲食' }, 'aliases', '餐飲,吃飯').success, true);
    assert.equal(set({ kind: 'sub', name: '外食' }, 'sort', 99).success, true);
    const food = cfgRows(e).find((r) => r.name === '飲食');
    assert.deepEqual([food.color, food.targets, food.aliases], ['c8', '家人', '餐飲,吃飯']);
    assert.equal(cfgRows(e).find((r) => r.name === '外食').sort, 99);
    assert.equal(set({ kind: 'sub', name: '外食' }, 'color', 'c1').error, 'invalid_field');
    assert.equal(set({ kind: 'category', name: '飲食' }, 'color', 'red').error, 'invalid_color');
    assert.equal(set({ kind: 'category', name: '飲食' }, 'name', '吃的').error, 'invalid_field', '不能改名');
  });

  test('改出問題（兩個大類同色）→ 存了，但回傳 ⚠️ 讓管理員馬上看到', () => {
    const e = env();
    const out = post(e, { action: 'configSet', key: { kind: 'category', name: '交通' }, field: 'color', value: 'c1' });
    assert.equal(out.success, true);
    assert.ok(out.warnings.some((w) => /顏色都是 c1/.test(w)));
  });

  test('新增大類、細項、對象；擋重複、擋掛在不存在的大類、擋斜線', () => {
    const e = env();
    const add = (record) => post(e, { action: 'configAdd', record });
    assert.equal(add({ kind: 'category', name: '寵物', color: 'c3' }).success, true);
    assert.equal(add({ kind: 'sub', name: '飼料', parent: '寵物' }).success, true);
    assert.equal(add({ kind: 'target', name: '阿伯', parent: '家人' }).success, true);
    const r = cfgRows(e);
    assert.deepEqual(r.filter((x) => ['寵物', '飼料', '阿伯'].includes(x.name)).map((x) => [x.kind, x.parent]),
      [['category', ''], ['sub', '寵物'], ['target', '家人']]);

    assert.equal(add({ kind: 'sub', name: '外食', parent: '寵物' }).error, 'duplicate_name', '細項名稱全表唯一');
    assert.equal(add({ kind: 'category', name: '飲食' }).error, 'duplicate_name');
    assert.equal(add({ kind: 'sub', name: '貓砂', parent: '不存在' }).error, 'parent_not_found');
    assert.equal(add({ kind: 'target', name: '小明' }).error, 'parent_required');
    assert.equal(add({ kind: 'category', name: 'A/B' }).error, 'invalid_name', '斜線會把 LINE 的格式切壞');
    assert.equal(add({ kind: 'category', name: '  ' }).error, 'invalid_name');
    assert.equal(add({ kind: 'oops', name: 'x' }).error, 'invalid_kind');
  });

  test('新增的細項立刻能用（LINE 打細項自動推回大類）', () => {
    const e = env();
    post(e, { action: 'groupSet', group_id: 'Cfam', field: 'is_active', value: true });
    say(e, ME, '分類');                                                // 先讓設定進快取
    post(e, { action: 'configAdd', record: { kind: 'sub', name: '宵夜', parent: '飲食' } });
    assert.match(say(e, ME, '記帳/80/宵夜'), /飲食＞宵夜/);
  });
});

/* ========================================================================== */
describe('導覽', () => {

  test('adminView guide 跟 refreshGuide 寫進 Sheet 的列一模一樣（同一份函式）', () => {
    const e = env();
    const view = post(e, { action: 'adminView', what: 'guide' });
    e.call('refreshGuide');
    const sheet = e.ss.getSheetByName('_guide').values.slice(2);
    assert.deepEqual(view.rows.map((r) => r[0]), sheet.map((r) => r[0]));
    assert.deepEqual(view.headers, e.ss.getSheetByName('_guide').values[1]);
  });
});

/* ========================================================================== */
describe('前端卡片', () => {

  function fe(isAdmin, respond = () => ({ success: true, rows: [] })) {
    const sent = [];
    const e = loadFrontend({ fetchImpl: ({ body }) => { sent.push(body); return { json: () => Promise.resolve(respond(body)) }; } });
    const made = {};
    const orig = e.context.document.getElementById;
    const get = (id) => made[id] || (made[id] = orig(id));
    e.set('document', Object.assign({}, e.context.document, { getElementById: get }));
    const els = new Proxy(made, { get: (_t, id) => get(id) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; syncFromCloud = function(){}');
    e.raw('roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"' + (isAdmin ? 'TRUE' : '') + '"}]; rosterStatus = "ok"');
    return { e, els, sent };
  }

  test('非管理者看不到；管理者看得到，而且還沒按分頁之前不發任何請求', () => {
    const a = fe(false);
    a.e.call('renderSysCard');
    assert.equal(a.els.sysCard.hidden, true);
    const b = fe(true);
    b.e.call('renderSysCard');
    assert.equal(b.els.sysCard.hidden, false);
    assert.equal(b.sent.length, 0, '按了才抓');
  });

  test('群組分頁：顯示群組與開關；按「啟用」送 groupSet', async () => {
    const { e, els, sent } = fe(true, (b) => (b.action === 'adminView'
      ? { success: true, rows: [{ group_id: 'Cfam', name: '家族', is_active: '', cmd_expense: 'TRUE', cmd_tasks: '', cmd_query: 'TRUE', left_at: '' }] }
      : { success: true, value: 'TRUE' }));
    await e.callRaw('openSysTab', 'groups');
    assert.match(els.sysBody.innerHTML, /家族/);
    assert.match(els.sysBody.innerHTML, /待審/);
    await e.callRaw('setGroupFlag', 0, 'is_active');
    const g = sent.find((b) => b.action === 'groupSet');
    assert.deepEqual([g.group_id, g.field, g.value], ['Cfam', 'is_active', true]);
    assert.match(els.sysBody.innerHTML, /啟用中/);
  });

  test('分類分頁：顯示 ⚠️ 自檢；新增送 configAdd；錯誤講人話', async () => {
    const { e, els, sent } = fe(true, (b) => (b.action === 'adminView'
      ? { success: true, rows: [{ kind: 'category', name: '飲食', parent: '', color: 'c1', targets: '', aliases: '', sort: 10, is_active: '' }], warnings: ['細項「外食」重複'] }
      : { error: 'duplicate_name' }));
    await e.callRaw('openSysTab', 'config');
    assert.match(els.sysBody.innerHTML, /⚠️ 細項「外食」重複/);
    assert.match(els.sysBody.innerHTML, /✅ 啟用中/);
    els.sysAddKind.value = 'sub'; els.sysAddName.value = '外食'; els.sysAddParent.value = '飲食'; els.sysAddColor.value = '';
    await e.callRaw('addConfigItem');
    assert.deepEqual(sent.find((b) => b.action === 'configAdd').record, { kind: 'sub', name: '外食', parent: '飲食', color: '' });
    assert.ok(e.toasts.some((t) => /名稱重複了/.test(t)));
  });

  test('分期分頁：用手上的計畫列，不另外發請求；進行中的才有結束／刪除', async () => {
    const { e, els, sent } = fe(true);
    e.raw('installmentPlans = [{plan_id:"P1", status:"active", total:23800, periods:12, category:"其他", card:"國泰"},' +
      '{plan_id:"P2", status:"ended", total:6000, periods:3, category:"教育"}]');
    await e.callRaw('openSysTab', 'plans');
    assert.equal(sent.length, 0);
    assert.match(els.sysBody.innerHTML, /進行中・12 期・國泰/);
    assert.match(els.sysBody.innerHTML, /已結束/);
    assert.equal((els.sysBody.innerHTML.match(/結束計畫/g) || []).length, 1);
  });

  test('導覽分頁：⚠️ 狀態另外標出來', async () => {
    const { e, els } = fe(true, () => ({ success: true, headers: ['分頁', '類別', '用途', '誰寫入', '誰讀取', '主鍵', '相關 ADR', '欄位', '筆數', '狀態', '備註'],
      rows: [['_expense_config', '系統', '記帳分類', '', '', '', '', '', 28, '⚠️ 細項「外食」重複', ''], ['tasks', '資料', '任務', '', '', '', '', '', 3, '✅ 正常', '']] }));
    await e.callRaw('openSysTab', 'guide');
    assert.match(els.sysBody.innerHTML, /sys-warn[^>]*>⚠️ 細項「外食」重複/);
    assert.equal((els.sysBody.innerHTML.match(/sys-warn/g) || []).length, 1, '✅ 正常的不標');
  });

  test('讀不到時講清楚，按分頁可重試', async () => {
    const { e, els } = fe(true, () => ({ error: 'forbidden' }));
    await e.callRaw('openSysTab', 'groups');
    assert.match(els.sysBody.innerHTML, /讀不到（forbidden）/);
  });
});
