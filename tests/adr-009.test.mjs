/**
 * ADR-009 Phase 0 — 三個新函式的最小自動化測試
 *
 * ADR-009「待其他環境知道的事 #1」：單筆 upsert／tombstone 過濾／archive 兩段式
 * 流程，這三個函式的最小單元測試要先跑過、報告經 Neil 確認，才准開始接手既有
 * 模組的讀寫路徑重寫。不可以先動工、測試事後補。這份就是那些測試。
 *
 * 測的是 apps-script/Code.gs 本人（見 fake-apps-script.mjs），不是抄出來的副本。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const TASK_HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id'];
const REVIEW_HEADERS = ['review_date', 'good', 'stuck', 'most_important', 'line_id'];
const REVIEW_KEY = ['review_date', 'line_id'];

/** 一張已經有表頭的 tasks 表 */
function taskSheet(rows = []) {
  return new FakeSheet('tasks', [TASK_HEADERS.slice(), ...rows]);
}

function envFor(sheet) {
  const env = loadCodeGs({ sheets: { [sheet.getName()]: sheet } });
  return env;
}

/* ========================================================================== */
describe('upsertRow_ — 單欄鍵（ADR-007／ADR-008 既有行為的回歸）', () => {

  test('鍵不存在時 append，新增一列', () => {
    const sheet = taskSheet();
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, TASK_HEADERS,
      { id: '101', text: '買菜', is_completed: '', created_at: '', priority: 'M', line_id: 'Uneil' }, 'tasks');

    assert.equal(out.updated, false);
    assert.equal(out.cleaned, 0);
    assert.equal(sheet.getLastRow(), 2);
    assert.deepEqual(sheet.toRecords().map(r => r.text), ['買菜']);
  });

  test('鍵已存在時覆蓋同一列，不長出第二列', () => {
    const sheet = taskSheet([['101', '買菜', '', '', 'M', 'Uneil']]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, TASK_HEADERS,
      { id: '101', text: '買菜（改）', is_completed: 'TRUE', created_at: '', priority: 'H', line_id: 'Uneil' }, 'tasks');

    assert.equal(out.updated, true);
    assert.equal(out.row, 2);
    assert.equal(sheet.getLastRow(), 2, '覆蓋不該讓表變長');
    assert.equal(sheet.toRecords()[0].text, '買菜（改）');
    assert.equal(sheet.toRecords()[0].priority, 'H');
  });

  test('Sheet 存數字 id、前端送字串 id，視為同一筆', () => {
    const sheet = taskSheet([[1757000000000, '舊的', '', '', 'M', 'Uneil']]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, TASK_HEADERS,
      { id: '1757000000000', text: '新的', is_completed: '', created_at: '', priority: 'M', line_id: 'Uneil' }, 'tasks');

    assert.equal(out.updated, true, 'id 的型別差異不該製造第二列——那正是重複列的老路');
    assert.equal(sheet.getLastRow(), 2);
    assert.equal(sheet.toRecords()[0].text, '新的');
  });

  test('同鍵多列：覆蓋第一筆、刪掉其餘，並寫進 logs', () => {
    const sheet = taskSheet([
      ['101', '第一筆', '', '', 'M', 'Uneil'],
      ['999', '不相干', '', '', 'M', 'Uneil'],
      ['101', '重複的', '', '', 'M', 'Uneil'],
      ['101', '又一筆重複', '', '', 'M', 'Uneil']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, TASK_HEADERS,
      { id: '101', text: '收斂後', is_completed: '', created_at: '', priority: 'M', line_id: 'Uneil' }, 'tasks');

    assert.equal(out.updated, true);
    assert.equal(out.cleaned, 2);
    assert.equal(out.row, 2, '覆蓋的是第一筆');

    const texts = sheet.toRecords().map(r => r.text);
    assert.deepEqual(texts, ['收斂後', '不相干'], '不相干的那列不能被刪掉或位移吃掉');

    assert.equal(env.transactions.length, 1, '自動清理必須留下記錄，不可靜默刪列');
    assert.match(env.transactions[0][2], /upsert tasks id=101/);
  });

  test('分頁沒有鍵欄時退回 append，且留下 console 不靜默', () => {
    const headers = ['text', 'note'];
    const sheet = new FakeSheet('tasks', [headers.slice()]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, headers, { text: '沒有 id 欄的表' }, 'tasks');

    assert.equal(out.updated, false);
    assert.equal(sheet.getLastRow(), 2);
    assert.ok(env.logs.some(l => l.includes('退回 append') && l.includes('沒有 id 欄')), env.logs.join('\n'));
  });

  test('記錄本身沒有鍵值時退回 append', () => {
    const sheet = taskSheet();
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, TASK_HEADERS, { id: '', text: '無主的一筆' }, 'tasks');

    assert.equal(out.updated, false);
    assert.ok(env.logs.some(l => l.includes('鍵不完整')), env.logs.join('\n'));
  });

  test('key_field=line_id：ADR-008 管理頁那條路徑照舊', () => {
    const headers = ['line_id', 'display_name', 'is_active', 'is_admin'];
    const sheet = new FakeSheet('line_users', [
      headers.slice(),
      ['Uneil', 'Neil', 'TRUE', 'TRUE'],
      ['Ufamily', '家人', '', '']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, headers,
      { line_id: 'Ufamily', display_name: '家人', is_active: 'TRUE', is_admin: '' }, 'line_users', 'line_id');

    assert.equal(out.updated, true);
    assert.equal(out.row, 3);
    assert.equal(sheet.getLastRow(), 3, '核准一個人不該新增一列');
    assert.equal(sheet.toRecords()[1].is_active, 'TRUE');
  });
});

/* ========================================================================== */
describe('upsertRow_ — 複合鍵（ADR-009 §一.5 新能力）', () => {

  test('同一天不同人是兩筆，不互相覆蓋', () => {
    const sheet = new FakeSheet('reviews', [
      REVIEW_HEADERS.slice(),
      ['2026-09-16', 'Neil 的好事', '', '', 'Uneil']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, REVIEW_HEADERS,
      { review_date: '2026-09-16', good: '家人的好事', stuck: '', most_important: '', line_id: 'Ufamily' },
      'reviews', REVIEW_KEY);

    assert.equal(out.updated, false, '不同人同一天必須是新的一列');
    assert.equal(sheet.getLastRow(), 3);
    assert.deepEqual(sheet.toRecords().map(r => r.good), ['Neil 的好事', '家人的好事']);
  });

  test('同一天同一個人是同一筆，覆蓋既有列', () => {
    const sheet = new FakeSheet('reviews', [
      REVIEW_HEADERS.slice(),
      ['2026-09-16', '舊版', '', '', 'Uneil'],
      ['2026-09-16', '家人的', '', '', 'Ufamily']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, REVIEW_HEADERS,
      { review_date: '2026-09-16', good: '改過的', stuck: '', most_important: '', line_id: 'Uneil' },
      'reviews', REVIEW_KEY);

    assert.equal(out.updated, true);
    assert.equal(sheet.getLastRow(), 3);
    assert.deepEqual(sheet.toRecords().map(r => r.good), ['改過的', '家人的'], '不能動到別人那列');
  });

  test('Sheet 把日期存成 Date 物件時仍然對得上（不是每次都變成 append）', () => {
    const sheet = new FakeSheet('reviews', [
      REVIEW_HEADERS.slice(),
      [new Date(2026, 8, 16), '日期是 Date 物件', '', '', 'Uneil']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, REVIEW_HEADERS,
      { review_date: '2026-09-16', good: '前端送的是字串', stuck: '', most_important: '', line_id: 'Uneil' },
      'reviews', REVIEW_KEY);

    assert.equal(out.updated, true, 'Date 與 YYYY-MM-DD 對不上的話，每次同步都會多一列');
    assert.equal(sheet.getLastRow(), 2);
  });

  test('鍵欄之一是空的就退回 append，不跟別人撞鍵', () => {
    const sheet = new FakeSheet('reviews', [
      REVIEW_HEADERS.slice(),
      ['2026-09-16', '有主的', '', '', 'Uneil']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, REVIEW_HEADERS,
      { review_date: '2026-09-16', good: '沒有 line_id', stuck: '', most_important: '', line_id: '' },
      'reviews', REVIEW_KEY);

    assert.equal(out.updated, false);
    assert.equal(sheet.getLastRow(), 3, '半個鍵不該對上任何人，寧可多一列也不能蓋掉別人');
    assert.equal(sheet.toRecords()[0].good, '有主的');
  });

  test('Sheet 那列的鍵不完整時，也不會被當成匹配', () => {
    const sheet = new FakeSheet('reviews', [
      REVIEW_HEADERS.slice(),
      ['2026-09-16', '沒有作者的舊資料', '', '', '']
    ]);
    const env = envFor(sheet);

    const out = env.call('upsertRow_', sheet, REVIEW_HEADERS,
      { review_date: '2026-09-16', good: '我的', stuck: '', most_important: '', line_id: 'Uneil' },
      'reviews', REVIEW_KEY);

    assert.equal(out.updated, false);
    assert.equal(sheet.getLastRow(), 3);
  });
});

/* ========================================================================== */
describe('墓碑過濾（ADR-009 §一.3）', () => {

  test('del 為真的各種寫法都濾掉，空白與缺欄都保留', () => {
    const env = loadCodeGs();
    const rows = [
      { id: '1', text: '勾選框刪掉的', del: true },
      { id: '2', text: '手打 TRUE 刪掉的', del: 'TRUE' },
      { id: '3', text: '還在的', del: '' },
      { id: '4', text: '沒有 del 欄的舊資料' },
      { id: '5', text: 'del 是 FALSE 的', del: 'FALSE' }
    ];

    const kept = env.call('withoutTombstones_', rows).map(r => r.id);
    assert.deepEqual(kept, ['3', '4', '5']);
  });

  test('空輸入不會爆，回空陣列', () => {
    const env = loadCodeGs();
    assert.deepEqual(env.call('withoutTombstones_', []), []);
    assert.deepEqual(env.call('withoutTombstones_', null), []);
  });

  test('整批都是墓碑時回空陣列，不是回原陣列', () => {
    const env = loadCodeGs();
    const rows = [{ id: '1', del: 'TRUE' }, { id: '2', del: true }];
    assert.deepEqual(env.call('withoutTombstones_', rows), []);
  });
});

/* ========================================================================== */
describe('兩段式封存（ADR-009 §一.4）', () => {

  const ARCHIVE_HEADERS = ['id', 'text', 'del', 'archive'];

  function archiveSheet() {
    return new FakeSheet('notes', [
      ARCHIVE_HEADERS.slice(),
      ['1', '還在用的', '', ''],
      ['2', '刪掉的 A', 'TRUE', ''],
      ['3', '還在用的二號', '', ''],
      ['4', '刪掉的 B', 'TRUE', '']
    ]);
  }

  test('第一段：只撈墓碑列，帶回鍵與列號', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    const found = env.call('tombstoneRows_', sheet, ARCHIVE_HEADERS, 'id');

    assert.deepEqual(found.map(f => f.key), ['2', '4']);
    assert.deepEqual(found.map(f => f.row), [3, 5]);
    assert.equal(found[0].record.text, '刪掉的 A');
  });

  test('第二段：清單是空的就一列都不刪', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    const out = env.call('purgeTombstoneRows_', sheet, ARCHIVE_HEADERS, 'notes', 'id', []);

    assert.equal(out.deleted, 0);
    assert.equal(sheet.getLastRow(), 5, '「沒有東西要刪」與「整張表刪光」不該只差一個空陣列');
    assert.equal(env.transactions.length, 0);
  });

  test('第二段：只刪清單裡的，沒匯出過的墓碑留著', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    const out = env.call('purgeTombstoneRows_', sheet, ARCHIVE_HEADERS, 'notes', 'id', ['2']);

    assert.equal(out.deleted, 1);
    assert.deepEqual(sheet.toRecords().map(r => r.id), ['1', '3', '4']);
    assert.equal(out.skipped, 0);
  });

  test('第二段：清單裡的列中途被取消 del，就放過它', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    // 匯出之後、確認之前，有人把第 4 筆救回來了
    sheet.values[4][2] = '';

    const out = env.call('purgeTombstoneRows_', sheet, ARCHIVE_HEADERS, 'notes', 'id', ['2', '4']);

    assert.equal(out.deleted, 1, '此刻不是墓碑的列一律不動');
    assert.equal(out.skipped, 1);
    assert.deepEqual(sheet.toRecords().map(r => r.id), ['1', '3', '4']);
  });

  test('第二段：一次刪多列時列號不會位移刪錯人', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    const out = env.call('purgeTombstoneRows_', sheet, ARCHIVE_HEADERS, 'notes', 'id', ['2', '4']);

    assert.equal(out.deleted, 2);
    assert.deepEqual(out.rows, [3, 5]);
    assert.deepEqual(sheet.toRecords().map(r => r.text), ['還在用的', '還在用的二號']);
  });

  test('第二段：刪了就要寫 logs', () => {
    const sheet = archiveSheet();
    const env = envFor(sheet);

    env.call('purgeTombstoneRows_', sheet, ARCHIVE_HEADERS, 'notes', 'id', ['2', '4']);

    assert.equal(env.transactions.length, 1);
    assert.match(env.transactions[0][2], /archive notes/);
    assert.match(env.transactions[0][3], /刪除墓碑 2 列/);
  });

  test('第二段：reviews 用複合鍵也刪得準', () => {
    const headers = ['review_date', 'good', 'line_id', 'del'];
    const sheet = new FakeSheet('reviews', [
      headers.slice(),
      ['2026-09-16', 'Neil 的', 'Uneil', 'TRUE'],
      ['2026-09-16', '家人的', 'Ufamily', 'TRUE']
    ]);
    const env = envFor(sheet);

    const out = env.call('purgeTombstoneRows_', sheet, headers, 'reviews',
      ['review_date', 'line_id'], ['2026-09-16|Uneil']);

    assert.equal(out.deleted, 1);
    assert.deepEqual(sheet.toRecords().map(r => r.line_id), ['Ufamily'], '同一天的另一個人不能被連坐');
  });
});

/* ========================================================================== */
describe('欄位安裝 ensureAdr009Columns（待其他環境知道的事 #7）', () => {

  test('缺的補在最右邊，既有欄位與資料一個都不動', () => {
    const sheet = new FakeSheet('notes', [
      ['id', 'text', 'created_at', 'line_id'],
      ['1', '既有資料', '2026-09-01', 'Uneil']
    ]);
    const env = loadCodeGs({ sheets: { notes: sheet } });

    const summary = env.call('ensureAdr009Columns');

    assert.deepEqual(summary.notes.added, ['del', 'archive', 'board']);
    assert.deepEqual(sheet.values[0], ['id', 'text', 'created_at', 'line_id', 'del', 'archive', 'board']);
    assert.deepEqual(sheet.values[1], ['1', '既有資料', '2026-09-01', 'Uneil'], '資料列不該被碰到');
  });

  test('重複執行不會再變動（可以放心多按幾次）', () => {
    const sheet = new FakeSheet('moods', [['id', 'mood_date', 'level', 'note', 'line_id']]);
    const env = loadCodeGs({ sheets: { moods: sheet } });

    env.call('ensureAdr009Columns');
    const afterFirst = sheet.values[0].slice();
    const summary = env.call('ensureAdr009Columns');

    assert.deepEqual(summary.moods.added, []);
    assert.deepEqual(sheet.values[0], afterFirst);
  });

  test('已經有部分欄位時只補缺的那幾個', () => {
    const sheet = new FakeSheet('tasks', [
      ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del']
    ]);
    const env = loadCodeGs({ sheets: { tasks: sheet } });

    const summary = env.call('ensureAdr009Columns');

    assert.deepEqual(summary.tasks.added, ['archive', 'board', 'due_date', 'recur_interval', 'recur_unit', 'notified']);
    assert.equal(sheet.values[0].filter(h => h === 'del').length, 1, 'del 不該被補第二次');
  });

  test('分頁不存在就略過，不會建一張空表', () => {
    const env = loadCodeGs({ sheets: {} });

    const summary = env.call('ensureAdr009Columns');

    assert.equal(summary.tasks.reason, 'sheet_missing');
    assert.deepEqual(Object.keys(env.ss.sheets), [], '不該無中生有建表——表頭對不上會讓下次 replaceAll 出事');
  });

  test('連表頭都沒有的分頁只回報、不硬寫', () => {
    const sheet = new FakeSheet('notes', []);
    const env = loadCodeGs({ sheets: { notes: sheet } });

    const summary = env.call('ensureAdr009Columns');

    assert.equal(summary.notes.reason, 'no_header');
    assert.equal(sheet.getLastRow(), 0);
    assert.ok(env.logs.some(l => l.includes('連表頭都沒有')), env.logs.join('\n'));
  });
});
