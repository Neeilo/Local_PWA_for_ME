/**
 * ADR-021 PR-F（後端）— 搜尋（D-5）
 *
 * 為什麼有這批測試（票面驗收）：
 *  - 只搜自己的：搜不到別人的雜記、記帳、任務、收藏；白板例外（釘在白板上的大家都搜得到）
 *  - 照 feat_* 與模組總開關過濾：沒權限、關掉的模組整組不出現（白板關掉＝別人的白板也不出現）
 *  - 已刪除（del）不出現
 *  - 範圍＝任務、提醒、雜記、圖書館（標題／全文／筆記）、記帳備註；郵件、股票不納入
 *  - 多個關鍵字＝全部都要有；不分大小寫；結果依模組分組、新的在前
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-me';
const TOK_MOM = 'tok-mom';
const FEATS = ['feat_tasks', 'feat_notes', 'feat_expense', 'feat_clips', 'feat_stock', 'feat_gmail'];
const USER_H = ['line_id', 'display_name', 'is_active', 'is_admin'].concat(FEATS);
const TASK_H = ['id', 'text', 'priority', 'is_completed', 'line_id', 'kind', 'due_date', 'created_at', 'board', 'del'];
const NOTE_H = ['id', 'text', 'line_id', 'created_at', 'board', 'del'];
const EXP_H = ['id', 'expense_date', 'type', 'category', 'subcategory', 'amount', 'note', 'line_id', 'created_at', 'board', 'del'];
const REG_H = ['module_id', 'name', 'category', 'icon', 'enabled', 'permission', 'load_policy', 'sort'];
const MODS = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'];

function env({ off = [], momFeats = ['TRUE', 'TRUE', 'TRUE', 'TRUE', '', ''] } = {}) {
  const sheets = {
    line_users: new FakeSheet('line_users', [USER_H,
      [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
      [MOM, '媽媽', 'TRUE', ''].concat(momFeats)]),
    tasks: new FakeSheet('tasks', [TASK_H,
      [1, '買牛奶 Milk', 'M', '', ME, 'todo', '', '2026-10-01T00:00:00.000Z', '', ''],
      [2, '媽媽的牛奶清單', 'M', '', MOM, 'todo', '', '2026-10-02T00:00:00.000Z', '', ''],
      [3, '全家牛奶輪流買', 'M', '', MOM, 'todo', '', '2026-10-03T00:00:00.000Z', 'TRUE', ''],
      [4, '刪掉的牛奶', 'M', '', ME, 'todo', '', '2026-10-04T00:00:00.000Z', '', 'TRUE'],
      [5, '繳牛奶費', 'M', '', ME, 'reminder', '2026-10-25', '2026-10-05T00:00:00.000Z', '', '']]),
    notes: new FakeSheet('notes', [NOTE_H,
      [11, '[想法] 牛奶要換品牌', ME, '2026-10-06T00:00:00.000Z', '', ''],
      [12, '媽媽的秘密牛奶筆記', MOM, '2026-10-07T00:00:00.000Z', '', ''],
      [13, '白板：牛奶在冰箱', MOM, '2026-10-08T00:00:00.000Z', 'TRUE', '']]),
    expenses: new FakeSheet('expenses', [EXP_H,
      [21, '2026-10-09', 'expense', '飲食', '', 90, '牛奶兩瓶', ME, '2026-10-09T00:00:00.000Z', '', ''],
      [22, '2026-10-10', 'expense', '飲食', '', 50, '媽媽買的牛奶', MOM, '2026-10-10T00:00:00.000Z', '', '']]),
    logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']]),
    _module_registry: new FakeSheet('_module_registry', [REG_H,
      ...MODS.map((id, i) => [id, id, '', '', off.includes(id) ? 'FALSE' : 'TRUE', '', 'lazy', (i + 1) * 10])])
  };
  const e = loadCodeGs({ cache: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM }, sheets });
  e.call('ensureClipsSheet_');
  const H = e.read('CLIPS_HEADERS');
  const clip = (o) => e.sheets.clips.values.push(H.map((h) => (o[h] == null ? '' : o[h])));
  clip({ id: 'c1', line_id: ME, kind: 'post', status: 'done', caption: '牛奶的十種用法\n內文', note: '', collected_at: '2026-10-11T00:00:00.000Z' });
  clip({ id: 'c2', line_id: ME, kind: 'link', status: 'link', url: 'https://example.com/a', note: '這篇講牛奶', collected_at: '2026-10-12T00:00:00.000Z' });
  clip({ id: 'c3', line_id: MOM, kind: 'post', status: 'done', caption: '媽媽收藏的牛奶文', collected_at: '2026-10-13T00:00:00.000Z' });
  clip({ id: 'c4', line_id: ME, kind: 'post', status: 'done', caption: '刪掉的牛奶收藏', del: 'TRUE', collected_at: '2026-10-14T00:00:00.000Z' });
  return e;
}
const post = (e, body, tok = TOK_ME) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: tok, trigger: 'manual' }, body)) } }).body);
const ids = (r, key) => ((r.groups.find((g) => g.key === key) || {}).items || []).map((x) => String(x.id));
const keys = (r) => r.groups.map((g) => g.key);

/* ========================================================================== */
describe('只搜自己的；白板例外；已刪除不出現', () => {
  test('任務：自己的、別人釘在白板的；別人的與刪掉的不出現。提醒另成一組', () => {
    const r = post(env(), { action: 'search', q: '牛奶' });
    assert.equal(r.success, true);
    assert.deepEqual(ids(r, 'todo'), ['3', '1'], '新的在前');
    assert.deepEqual(ids(r, 'reminder'), ['5']);
  });

  test('雜記：搜不到別人的；別人釘在白板的搜得到', () => {
    const r = post(env(), { action: 'search', q: '牛奶' });
    assert.deepEqual(ids(r, 'notes'), ['13', '11']);
  });

  test('記帳備註：搜不到別人的', () => {
    const r = post(env(), { action: 'search', q: '牛奶' });
    assert.deepEqual(ids(r, 'expenses'), ['21']);
  });

  test('圖書館：全文、筆記都搜；只有自己的、刪掉的不算', () => {
    const r = post(env(), { action: 'search', q: '牛奶' });
    assert.deepEqual(ids(r, 'clips'), ['c2', 'c1']);
  });

  test('媽媽搜：看得到自己的與白板，看不到 Neil 的', () => {
    const r = post(env(), { action: 'search', q: '牛奶' }, TOK_MOM);
    assert.deepEqual(ids(r, 'todo'), ['3', '2']);
    assert.deepEqual(ids(r, 'notes'), ['13', '12']);
    assert.deepEqual(ids(r, 'expenses'), ['22']);
    assert.deepEqual(ids(r, 'clips'), ['c3']);
  });
});

/* ========================================================================== */
describe('照權限與模組總開關過濾', () => {
  test('沒權限的模組整組不出現（媽媽沒有 feat_clips 時沒有圖書館組）', () => {
    const r = post(env({ momFeats: ['TRUE', 'TRUE', 'TRUE', '', '', ''] }), { action: 'search', q: '牛奶' }, TOK_MOM);
    assert.ok(!keys(r).includes('clips'));
    assert.ok(keys(r).includes('notes'));
  });

  test('總開關關掉雜記、提醒、圖書館：那幾組不出現', () => {
    const r = post(env({ off: ['notes', 'reminders', 'library'] }), { action: 'search', q: '牛奶' });
    assert.deepEqual(keys(r).sort(), ['expenses', 'todo']);
  });

  test('白板關掉：別人的白板也不出現', () => {
    const r = post(env({ off: ['board'] }), { action: 'search', q: '牛奶' });
    assert.deepEqual(ids(r, 'todo'), ['1']);
    assert.deepEqual(ids(r, 'notes'), ['11']);
  });

  test('郵件、股票不納入；沒命中的組不出現', () => {
    const r = post(env(), { action: 'search', q: '十種用法' });
    assert.deepEqual(keys(r), ['clips']);
  });
});

/* ========================================================================== */
describe('比對規則', () => {
  test('多個關鍵字＝全部都要有；不分大小寫', () => {
    const e = env();
    assert.deepEqual(ids(post(e, { action: 'search', q: 'milk' }), 'todo'), ['1']);
    assert.deepEqual(ids(post(e, { action: 'search', q: '牛奶  品牌' }), 'notes'), ['11']);
    assert.deepEqual(keys(post(e, { action: 'search', q: '牛奶 不存在的字' })), []);
  });

  test('每一筆帶摘錄（命中那一段）與日期；圖書館的標題是內文第一行', () => {
    const r = post(env(), { action: 'search', q: '十種' });
    const hit = r.groups[0].items[0];
    assert.equal(hit.title, '牛奶的十種用法');
    assert.match(hit.snippet, /十種/);
    assert.equal(hit.date, '2026-10-11');
  });

  test('空白或太長：講清楚、不讀表', () => {
    const e = env();
    assert.equal(post(e, { action: 'search', q: '   ' }).error, 'empty_query');
    assert.equal(post(e, { action: 'search', q: 'x'.repeat(51) }).error, 'too_long');
  });
});
