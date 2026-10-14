/**
 * ADR-018 PR-D（B-1、B-2）—「查/」納入雜記與提醒
 *
 * 盯的事（為什麼）：
 *   - 雜記有自己的額度（20 則、近 30 天），不跟任務搶那 30 筆
 *   - 問題帶 [類別]：只放那一類、上限 50、不受 30 天窗口
 *   - **只讀發問者自己的雜記**（白板上別人的也不讀）、沒有 feat_notes 就整段不給（B-2）
 *   - 未來 30 天的提醒另列一段；提醒不再混進「未完成任務」（它沒有「完成」，會永遠掛著）
 *   - 軟刪除的列（del）不送給 AI：任務、記帳、雜記都一樣（readSheet_ 不濾 del，2026-10-14 補）
 *   - 最大上下文字數量得出來（PR 說明要附：三家都要打得過）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';

function dayKey(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function env({ notes = [], tasks = [], expenses = [], momNotes = 'TRUE' } = {}) {
  let prompt = '';
  const replies = [];
  const e = loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs'],
    properties: { GEMINI_API_KEY: 'k' },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks', 'feat_notes'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '', 'TRUE', 'TRUE', momNotes]
      ]),
      notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']].concat(notes)),
      tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'kind', 'due_date', 'recur_interval', 'recur_unit']].concat(tasks)),
      expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'note', 'created_at', 'line_id', 'del']].concat(expenses)),
      logs: new FakeSheet('logs', [['id']])
    },
    overrides: {
      callGemini_: (_k, p) => { prompt = p; return { ok: true, text: '好' }; },
      lineReply_: (_t, msg) => { replies.push(String(msg)); }
    }
  });
  e.ask = (userId, q) => {
    prompt = '';
    e.call('handleLineEvent_', { type: 'message', replyToken: 'rt', source: { type: 'user', userId }, message: { type: 'text', text: '查/' + q } });
    return prompt;
  };
  return e;
}
const note = (id, text, daysAgo, who = ME, del = '') => [String(id), text, dayKey(-daysAgo) + 'T01:00:00.000Z', who, del];

/* ========================================================================== */
describe('雜記（B-1／B-2）', () => {

  test('近 30 天、新的在前、上限 20；31 天前的不放', () => {
    const notes = [];
    for (let i = 0; i < 25; i++) notes.push(note(i, '雜記' + i, i));
    notes.push(note(99, '很舊的', 40));
    const p = env({ notes }).ask(ME, '最近記了什麼');
    assert.match(p, /【近 30 天的雜記】共 25 則，以下列出最新的 20 則/);
    assert.ok(p.includes('雜記0') && p.includes('雜記19') && !p.includes('雜記20'));
    assert.ok(!p.includes('很舊的'));
    assert.ok(p.indexOf('雜記0') < p.indexOf('雜記1'), '新的在前');
  });

  test('問題帶 [類別]：只放那一類、不受 30 天窗口、上限 50；全形括號也收', () => {
    const notes = [note(1, '[文章] 舊文', 200), note(2, '[作品] 新作品', 1), note(3, '[文章] 新文', 2)];
    for (let i = 0; i < 55; i++) notes.push(note(100 + i, '[文章] 第' + i + '篇', 3 + i));
    const p = env({ notes }).ask(ME, '[文章] 存了哪些');
    assert.match(p, /【雜記・只看「文章」這一類，不限日期】共 57 則，以下列出最新的 50 則/);
    assert.ok(p.includes('新文') && !p.includes('新作品'));
    const p2 = env({ notes: [note(1, '[文章] 舊文', 200)] }).ask(ME, '［文章］ 有什麼');
    assert.ok(p2.includes('舊文'), '不受窗口');
  });

  test('只讀發問者自己的：媽媽問，看不到 Neil 的', () => {
    const p = env({ notes: [note(1, 'Neil 的祕密', 1, ME), note(2, '媽媽的菜單', 1, MOM)] }).ask(MOM, '我記了什麼');
    assert.ok(p.includes('媽媽的菜單'));
    assert.ok(!p.includes('Neil 的祕密'));
  });

  test('沒有 feat_notes：整段不給，並講明看不到雜記', () => {
    const p = env({ notes: [note(2, '媽媽的菜單', 1, MOM)], momNotes: '' }).ask(MOM, '我記了什麼');
    assert.ok(!p.includes('媽媽的菜單'));
    assert.ok(!p.includes('雜記】'));
    assert.match(p, /你只看得到以下模組：記帳、任務。/);
  });

  test('雜記不吃任務的 30 筆額度', () => {
    const tasks = [];
    for (let i = 0; i < 30; i++) tasks.push([String(i), '任務' + i, '', '', 'M', ME, '', 'todo', '', '', '']);
    const notes = [];
    for (let i = 0; i < 20; i++) notes.push(note(100 + i, '雜記' + i, 1));
    const p = env({ tasks, notes }).ask(ME, '有什麼');
    assert.ok(p.includes('任務29'), '任務 30 筆照樣全放');
    assert.ok(p.includes('雜記19'), '雜記 20 則照樣全放');
  });
});

/* ========================================================================== */
describe('提醒（B-1）', () => {

  test('未來 30 天的提醒另列、依日期；31 天後與已過的不放；提醒不混進未完成任務', () => {
    const tasks = [
      ['1', '繳房租', '', '', 'M', ME, '', 'reminder', dayKey(5), '1', '月'],
      ['2', '換濾心', '', '', 'M', ME, '', 'reminder', dayKey(2), '', ''],
      ['3', '年度健檢', '', '', 'M', ME, '', 'reminder', dayKey(40), '', ''],
      ['4', '看牙醫', '', '', 'M', ME, '', 'reminder', dayKey(-3), '', ''],
      ['5', '買菜', '', '', 'M', ME, '', 'todo', '', '', '']
    ];
    const p = env({ tasks }).ask(ME, '最近要繳什麼');
    const block = p.slice(p.indexOf('【未來 30 天的提醒】'));
    assert.ok(block.indexOf('換濾心') < block.indexOf('繳房租'), '近的在前');
    assert.match(block, new RegExp(dayKey(5) + ' 繳房租（每 1月）'));
    assert.ok(!p.includes('年度健檢') && !p.includes('看牙醫'));
    const open = p.slice(p.indexOf('【未完成任務】'), p.indexOf('【未來 30 天的提醒】'));
    assert.ok(open.includes('買菜') && !open.includes('繳房租'), '提醒不在未完成任務裡');
  });
});

/* ========================================================================== */
describe('軟刪除不送給 AI', () => {

  test('任務、記帳、雜記標了 del 的都不進 prompt', () => {
    const p = env({
      tasks: [['1', '刪掉的任務', '', '', 'M', ME, 'TRUE', 'todo', '', '', ''], ['2', '留著的任務', '', '', 'M', ME, '', 'todo', '', '', '']],
      expenses: [['10', dayKey(-1), 'expense', '飲食', 999, '', '', ME, 'TRUE'], ['11', dayKey(-1), 'expense', '飲食', 120, '', '', ME, '']],
      notes: [note(1, '刪掉的雜記', 1, ME, 'TRUE'), note(2, '留著的雜記', 1)]
    }).ask(ME, '有什麼');
    assert.ok(!p.includes('刪掉的任務') && p.includes('留著的任務'));
    assert.ok(!p.includes('刪掉的雜記') && p.includes('留著的雜記'));
    assert.match(p, /支出合計 120 元（1 筆）/);
    assert.ok(!/1,119|999/.test(p));
  });
});

/* ========================================================================== */
describe('記帳彙總只算到今天／本月底（2026-10-14 Neil 回報：「查/10月份開支」比 App 多）', () => {

  test('分期的未來各期（下個月起）不算進本月與近 30 天；本月稍後的仍算進本月', () => {
    const p = env({ expenses: [
      ['1', dayKey(0), 'expense', '飲食', 100, '', '', ME, ''],
      ['2', dayKey(40), 'expense', '教育', 22700, '分期', '', ME, ''],
      ['3', dayKey(400), 'expense', '教育', 22700, '分期', '', ME, '']
    ] }).ask(ME, '這個月花多少');
    const month = p.slice(p.indexOf('▍本月'), p.indexOf('▍近 30 天'));
    const win = p.slice(p.indexOf('▍近 30 天'));
    assert.match(month, /支出合計 100 元（1 筆）/);
    assert.match(win, /支出合計 100 元（1 筆）/);
  });
});

/* ========================================================================== */
describe('最大上下文（PR 說明要附的數字）', () => {

  test('滿載（任務 30＋已完成 5＋提醒 30＋[類別] 雜記 50，每則 100 字）也在 20,000 字以內', () => {
    const long = (s) => (s + '・').repeat(40).slice(0, 100);
    const tasks = [];
    for (let i = 0; i < 40; i++) tasks.push([String(i), long('任務' + i), '', '', 'M', ME, '', 'todo', '', '', '']);
    for (let i = 0; i < 10; i++) tasks.push(['d' + i, long('完成' + i), 'TRUE', dayKey(-1) + 'T01:00:00.000Z', 'M', ME, '', 'todo', '', '', '']);
    for (let i = 0; i < 30; i++) tasks.push(['r' + i, long('提醒' + i), '', '', 'M', ME, '', 'reminder', dayKey(i % 30), '1', '月']);
    const notes = [];
    for (let i = 0; i < 60; i++) notes.push(note(100 + i, '[文章] ' + long('雜記' + i), i));
    const p = env({ tasks, notes }).ask(ME, '[文章] 全部整理一下');
    console.log('最大上下文字數：' + p.length);
    assert.ok(p.length < 20000, '實際 ' + p.length + ' 字');
  });
});
