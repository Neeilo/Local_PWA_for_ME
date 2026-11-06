/**
 * ADR-026 PR-2（D-8）：logs 補齊
 *
 * 原則：logs 記「改變狀態或對外送出」，performance 記讀取與速度。
 * 為什麼有這批測試：
 *  - 以前 PWA 的新增／編輯／刪除只有「清除重複列」時才留 logs，事後查「誰在什麼時候改了這筆」查不到
 *  - 設定類（首頁排版、給自己的一段話、email）、圖書館閱讀狀態／分類／筆記成功都沒記
 *  - LINE 回覆失敗只進 console：使用者沒收到回覆，Sheet 上看不出來
 *  - 每一筆都要帶 user_id；只記表名、id、動作＋短摘要，**不複製整筆內容**（摘要有長度上限、自我提醒不存全文、email 不寫地址）
 *  - logs 寫入失敗不能讓寫入本身變失敗（ADR-006 §D）
 *  - 讀取類（clipRead 開頁）維持不記
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const FEATS = ['feat_expense', 'feat_tasks', 'feat_notes', 'feat_clips'];
const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board', 'due_date', 'kind'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del', 'archive', 'board'];
const NOTE_H = ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board'];
const CLIP_H = ['id', 'line_id', 'url', 'status', 'caption', 'del', 'updated_at', 'read_status', 'last_read_at', 'category',
  'note', 'note_revision', 'note_updated_at'];
const clipRow = (id, o = {}) => {
  const r = Object.assign({ id, line_id: ME, url: 'u' + id, status: 'done', caption: '內文', del: '', note_revision: 0 }, o);
  return CLIP_H.map((h) => (r[h] === undefined ? '' : r[h]));
};

function env({ tasks = [], clips = [], overrides = {} } = {}) {
  return loadCodeGs({
    tokens: { 'tok-me': ME, 'tok-mom': MOM },
    extraFiles: ['widgets.gs'],
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'email', 'updated_at'].concat(FEATS),
        [ME, 'Neil', 'TRUE', 'TRUE', '', ''].concat(FEATS.map(() => 'TRUE')),
        [MOM, '媽媽', 'TRUE', '', '', ''].concat(FEATS.map(() => 'TRUE'))
      ]),
      tasks: new FakeSheet('tasks', [TASK_H, ...tasks]),
      expenses: new FakeSheet('expenses', [EXP_H]),
      notes: new FakeSheet('notes', [NOTE_H]),
      self_notes: new FakeSheet('self_notes', [['line_id', 'text', 'updated_at']]),
      widget_config: new FakeSheet('widget_config', [['line_id', 'widget_order', 'widget_hidden', 'widget_pinned', 'apps_pinned', 'apps_hidden',
        'weather_county', 'weather_district', 'stock_pins', 'updated_at']]),
      _clip_categories: new FakeSheet('_clip_categories', [['name', 'emoji', 'sort', 'is_active'], ['工作', '💼', 10, 'TRUE']]),
      clips: new FakeSheet('clips', [CLIP_H, ...clips]),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides
  });
}
const post = (e, body, tok = 'tok-me') =>
  JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'write' }, body)) } }).body);
const up = (sheet, record) => ({ action: 'upsert', sheet, key_field: 'id', record });
/** [來源, 狀態, input, result, detail, target_row, user_id] */
const tx = (e, re) => e.transactions.filter((t) => re.test(String(t[2])));

/* ========================================================================== */
describe('① PWA 新增／編輯／刪除（pwaUpsert_）', () => {

  test('新增、修改、刪除各一筆 logs；來源沿用模組；帶 user_id 與列號', () => {
    const e = env();
    post(e, up('tasks', { id: 't1', text: '倒垃圾', line_id: ME, kind: 'todo' }));
    post(e, up('tasks', { id: 't1', text: '倒垃圾（改）', line_id: ME, kind: 'todo' }));
    post(e, up('tasks', { id: 't1', text: '倒垃圾（改）', line_id: ME, kind: 'todo', del: 'TRUE' }));
    const rows = tx(e, /^PWA upsert tasks id=t1$/);
    assert.deepEqual(rows.map((t) => [t[0], t[1], t[3]]),
      [['任務', '成功', '新增：倒垃圾'], ['任務', '成功', '修改：倒垃圾（改）'], ['任務', '成功', '刪除：倒垃圾（改）']]);
    assert.ok(rows.every((t) => t[6] === ME));
    assert.equal(rows[0][5], 2, '列號');
  });

  test('記帳／收入／雜記分來源；記帳摘要帶金額', () => {
    const e = env();
    post(e, up('expenses', { id: 'x1', type: 'expense', category: '餐飲', amount: 120, note: '午餐', line_id: ME }));
    post(e, up('expenses', { id: 'x2', type: 'income', category: '薪資', amount: 50000, note: '十月', line_id: ME }));
    post(e, up('notes', { id: 'n1', text: '記一下', line_id: ME }));
    assert.deepEqual(tx(e, /^PWA upsert /).map((t) => [t[0], t[3]]),
      [['記帳', '新增：午餐 120'], ['收入', '新增：十月 50000'], ['雜記', '新增：記一下']]);
  });

  test('不複製整筆內容：摘要最多 30 字並壓成一行', () => {
    const e = env();
    const long = '很長的筆記\n第二行'.repeat(20);
    post(e, up('notes', { id: 'n1', text: long, line_id: ME }));
    const r = tx(e, /^PWA upsert notes/)[0];
    assert.ok(r[3].length <= '新增：'.length + 31, r[3]);
    assert.ok(!r[3].includes('\n'));
    assert.equal(r[4], '', 'detail 不放內容');
  });

  test('寫入失敗（例外）也記，並照樣回錯誤給前端', () => {
    const e = env();
    e.sheets.notes.appendRow = () => { throw new Error('Service Spreadsheets timed out'); };
    assert.throws(() => post(e, up('notes', { id: 'n1', text: 'x', line_id: ME })));
    const r = tx(e, /^PWA upsert notes id=n1$/)[0];
    assert.deepEqual([r[0], r[1], r[3]], ['雜記', '失敗', '寫入失敗']);
    assert.match(r[4], /timed out/);
    assert.equal(r[6], ME);
  });

  test('拿不到寫入鎖（busy）：記失敗，前端照樣拿到 busy', () => {
    const e = env();
    e.lock.busy = true;
    assert.equal(post(e, up('tasks', { id: 't9', text: 'x', line_id: ME, kind: 'todo' })).error, 'busy');
    const r = tx(e, /^PWA upsert tasks id=t9$/)[0];
    assert.deepEqual([r[1], r[3]], ['失敗', '寫入失敗']);
    assert.match(r[4], /busy/);
  });

  test('守門自己記過的失敗不重複記（白板不是擁有者）', () => {
    const e = env({ tasks: [TASK_H.map((h) => ({ id: 'b1', text: '白板', line_id: MOM, board: 'TRUE', kind: 'todo' })[h] || '')] });
    const out = post(e, up('tasks', { id: 'b1', text: '偷改', line_id: ME, board: 'TRUE', kind: 'todo' }));
    assert.equal(out.error, 'forbidden');
    assert.equal(e.transactions.filter((t) => /b1/.test(t[2])).length, 1, '只有守門那一筆');
  });
});

/* ========================================================================== */
describe('②～④ 設定類', () => {

  test('widgetConfigSet：成功列出改了哪些欄；失敗也記', () => {
    const e = env();
    post(e, { action: 'widgetConfigSet', config: { order: ['tasks'], pinned: ['tasks'] } });
    post(e, { action: 'widgetConfigSet', config: { weather_county: '火星', weather_district: 'x區' } });
    const rows = tx(e, /^widgetConfigSet$/);
    assert.deepEqual(rows.map((t) => [t[0], t[1], t[3]]),
      [['設定', '成功', '首頁設定：order、pinned'], ['設定', '失敗', '失敗：invalid_location']]);
    assert.ok(rows.every((t) => t[6] === ME));
  });

  test('selfNoteSet：只記字數、不存全文；太長失敗也記', () => {
    const e = env();
    post(e, { action: 'selfNoteSet', text: '今天要早睡，秘密計畫' });
    post(e, { action: 'selfNoteSet', text: 'x'.repeat(400) });
    const rows = tx(e, /^selfNoteSet$/);
    assert.deepEqual(rows.map((t) => [t[1], t[3]]), [['成功', '更新給自己的一段話（10 字）'], ['失敗', '失敗：too_long']]);
    assert.ok(!JSON.stringify(e.transactions).includes('秘密計畫'));
  });

  test('setMyEmail：成功／失敗都記，不寫 email 地址', () => {
    const e = env();
    post(e, { action: 'setMyEmail', email: 'neil@example.com' });
    post(e, { action: 'setMyEmail', email: 'not-an-email' });
    const rows = tx(e, /^setMyEmail$/);
    assert.deepEqual(rows.map((t) => [t[0], t[1], t[3]]), [['設定', '成功', '更新 email'], ['設定', '失敗', '失敗：invalid_email']]);
    assert.ok(!JSON.stringify(e.transactions).includes('neil@example.com'));
  });
});

/* ========================================================================== */
describe('⑤ 圖書館：閱讀狀態／分類／筆記（修訂 ADR-025「不寫 logs」）', () => {

  test('三種動作成功都記（來源「收藏」）；clipRead 開頁照舊不記', () => {
    const e = env({ clips: [clipRow('c1')] });
    post(e, { action: 'clipRead', id: 'c1' });
    assert.equal(e.transactions.length, 0, '開頁屬讀取');
    post(e, { action: 'clipReadState', id: 'c1', state: 'read' });
    post(e, { action: 'clipCategory', id: 'c1', category: '工作' });
    post(e, { action: 'clipNote', id: 'c1', note: '我的心得很長很私密', revision: 0 });
    assert.deepEqual(e.transactions.map((t) => [t[0], t[1], t[2], t[3], t[6]]), [
      ['收藏', '成功', 'clipReadState c1', '閱讀狀態 → 已讀', ME],
      ['收藏', '成功', 'clipCategory c1', '分類 → 工作', ME],
      ['收藏', '成功', 'clipNote c1', '筆記 rev 1（9 字）', ME]
    ]);
    assert.ok(!JSON.stringify(e.transactions).includes('私密'), '筆記內容不進 logs');
  });

  test('失敗也記；函式自己記過的（不是擁有者、筆記衝突）不重複', () => {
    const e = env({ clips: [clipRow('c1'), clipRow('m1', { line_id: MOM })] });
    post(e, { action: 'clipReadState', id: 'c1', state: 'DONE' });
    post(e, { action: 'clipCategory', id: 'c1', category: '不存在' });
    assert.deepEqual(e.transactions.map((t) => [t[1], t[3]]), [['失敗', '失敗：invalid_state'], ['失敗', '失敗：invalid_category']]);
    e.transactions.length = 0;
    post(e, { action: 'clipReadState', id: 'm1', state: 'read' });
    assert.equal(e.transactions.length, 1, '不是擁有者：clipOwnRow_ 已記一筆');
    e.transactions.length = 0;
    post(e, { action: 'clipNote', id: 'c1', note: 'x', revision: 5 });
    assert.equal(e.transactions.length, 1, '筆記衝突：clipNote_ 已記一筆');
    assert.match(e.transactions[0][3], /筆記衝突/);
  });
});

/* ========================================================================== */
describe('⑥ LINE 回覆失敗', () => {

  function lineEnv(res) {
    return loadCodeGs({ extraFiles: ['line-router.gs'], properties: { LINE_CHANNEL_ACCESS_TOKEN: 'tok' },
      overrides: { callApi_: () => { if (res instanceof Error) throw res; return res; } } });
  }
  const response = (code, text) => ({ getResponseCode: () => code, getContentText: () => text });

  test('非 200：記「回覆失敗：HTTP 400」與 LINE 的說明（截短），不記回覆內容', () => {
    const e = lineEnv(response(400, '{"message":"Invalid reply token"}'));
    e.call('lineReply_', 'rt', '你的帳戶餘額 12,345');
    const r = e.transactions.find((t) => t[2] === 'lineReply');
    assert.deepEqual([r[0], r[1], r[3]], ['LINE', '失敗', '回覆失敗：HTTP 400']);
    assert.match(r[4], /Invalid reply token/);
    assert.ok(!JSON.stringify(r).includes('12,345'));
  });

  test('連線失敗也記；200 不記', () => {
    const bad = lineEnv(new Error('Address unavailable'));
    bad.call('lineReply_', 'rt', 'hi');
    assert.match(bad.transactions.find((t) => t[2] === 'lineReply')[3], /連線失敗/);
    const ok = lineEnv(response(200, '{}'));
    ok.call('lineReply_', 'rt', 'hi');
    assert.equal(ok.transactions.filter((t) => t[2] === 'lineReply').length, 0);
  });

  test('事件進行中走 LINE_LOG_QUEUE（回覆之後一次寫）', () => {
    const e = loadCodeGs({ extraFiles: ['line-router.gs'], properties: { LINE_CHANNEL_ACCESS_TOKEN: 'tok' }, realLogs: true,
      sheets: { logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']]) },
      overrides: { callApi_: () => response(500, 'oops') } });
    e.read('LINE_LOG_QUEUE = []');
    e.call('lineReply_', 'rt', 'hi');
    assert.equal(e.sheets.logs.toRecords().length, 0, '還在排隊');
    assert.equal(e.read('LINE_LOG_QUEUE.length'), 1);
    assert.equal(e.read('LINE_LOG_QUEUE[0].source'), 'LINE');
  });
});

/* ========================================================================== */
describe('logs 寫入失敗不影響主流程（ADR-006 §D）', () => {

  test('logTransaction_ 丟例外：upsert、設定、圖書館照樣成功', () => {
    const e = env({ clips: [clipRow('c1')], overrides: { logTransaction_: () => { throw new Error('logs 分頁被刪了'); } } });
    assert.equal(post(e, up('notes', { id: 'n1', text: 'x', line_id: ME })).success, true);
    assert.equal(e.sheets.notes.toRecords().length, 1);
    assert.equal(post(e, { action: 'selfNoteSet', text: 'hi' }).success, true);
    assert.equal(post(e, { action: 'clipReadState', id: 'c1', state: 'reading' }).success, true);
  });
});
