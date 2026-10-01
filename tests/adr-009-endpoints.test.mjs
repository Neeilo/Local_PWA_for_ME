/**
 * ADR-009 Phase 2-b — 後端端點接線的測試
 *
 * 前兩批測的是還沒接線的純函式；這一批是第一次真的接上讀取與 doPost（ADR-010 起讀取也走 POST），
 * 所以測的重點從「算得對不對」變成「接得對不對」：墓碑有沒有真的被擋在出口、
 * 舊版前端會不會被改名弄壞、封存第二段有沒有守住那兩道鎖。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

// ADR-010 關門後，PWA 的每個請求都帶裝置 token；身份由後端從 token 換出來
const TOKEN = 'tok-neil';
const STRANGER_TOKEN = 'tok-stranger';     // 有裝置，但人不在白名單上
const ME = 'Uneil';

const TASK_HEADERS = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive'];

/** 一張放行 Uneil 的白名單 */
function whitelist() {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'],
    [ME, 'Neil', 'TRUE', 'TRUE']
  ]);
}

function tasksSheet(rows = []) {
  return new FakeSheet('tasks', [TASK_HEADERS.slice(), ...rows]);
}

/** 建好一個能通過裝置與白名單兩道門的環境 */
function envWith(sheets) {
  return loadCodeGs({
    sheets: Object.assign({ line_users: whitelist() }, sheets),
    tokens: { [TOKEN]: ME, [STRANGER_TOKEN]: 'Ustranger' }
  });
}

/** doPost 的 body 包裝。預設帶會過閘門的 token */
function post(env, body, token = TOKEN) {
  const e = { postData: { contents: JSON.stringify(Object.assign({ token }, body)) } };
  return env.call('handlePwaSync_', e);
}

/** 讀取：原本走 doGet，ADR-010 關門後改走 POST read／readTombstones，回應形狀不變 */
function get(env, params) {
  const action = params.only === 'tombstones' ? 'readTombstones' : 'read';
  return JSON.parse(post(env, { action, sheet: params.sheet, key_field: params.key_field }).body);
}

/* ========================================================================== */
describe('讀取 — 墓碑擋在唯一的出口', () => {

  test('預設不回傳 del=true 的列', () => {
    const sheet = tasksSheet([
      ['1', '還在的', '', '', 'M', ME, '', ''],
      ['2', '已刪除的', '', '', 'M', ME, 'TRUE', ''],
      ['3', '也還在', '', '', 'M', ME, '', '']
    ]);
    const env = envWith({ tasks: sheet });

    const out = get(env, { sheet: 'tasks' });
    assert.deepEqual(out.data.map(r => r.id), ['1', '3']);
  });

  test('?only=tombstones 反過來只回墓碑（封存第一段要匯出的那批）', () => {
    const sheet = tasksSheet([
      ['1', '還在的', '', '', 'M', ME, '', ''],
      ['2', '已刪除的', '', '', 'M', ME, 'TRUE', '']
    ]);
    const env = envWith({ tasks: sheet });

    const out = get(env, { sheet: 'tasks', only: 'tombstones' });
    assert.deepEqual(out.data.map(r => r.id), ['2']);
    assert.equal(out.data[0].text, '已刪除的');
  });

  test('沒有 del 欄的舊分頁照常全回，不會整張變空', () => {
    const headers = ['id', 'text', 'line_id'];
    const sheet = new FakeSheet('notes', [headers, ['1', '舊資料', ME], ['2', '舊資料二', ME]]);
    const env = envWith({ notes: sheet });

    const out = get(env, { sheet: 'notes' });
    assert.equal(out.data.length, 2, '欄位還沒安裝就把資料藏光，看起來會像資料全毀');
  });

  test('分頁不存在、只有表頭，行為與改版前一致', () => {
    const env = envWith({ tasks: tasksSheet() });
    assert.deepEqual(get(env, { sheet: 'tasks' }).data, []);
    assert.equal(get(env, { sheet: '不存在' }).error, 'sheet_not_found');
  });

  test('整張都是墓碑就回空陣列，不是回整張', () => {
    const sheet = tasksSheet([
      ['1', 'a', '', '', 'M', ME, 'TRUE', ''],
      ['2', 'b', '', '', 'M', ME, true, '']
    ]);
    const env = envWith({ tasks: sheet });
    assert.deepEqual(get(env, { sheet: 'tasks' }).data, []);
  });
});

/* ========================================================================== */
describe('doPost — upsert', () => {

  test("action:'upsert' 走單列 upsert", () => {
    const sheet = tasksSheet([['1', '舊的', '', '', 'M', ME, '', '']]);
    const env = envWith({ tasks: sheet });

    const out = JSON.parse(post(env, {
      sheet: 'tasks', action: 'upsert',
      record: { id: '1', text: '新的', is_completed: '', created_at: '', priority: 'H', line_id: ME }
    }).body);

    assert.equal(out.updated, true);
    assert.equal(sheet.getLastRow(), 2, '覆蓋不該長出第二列');
    assert.equal(sheet.toRecords()[0].text, '新的');
  });

  test("舊名 action:'append' 已退場（ADR-010 關門）：拒絕，一列都不寫", () => {
    // 原本收它是為了還沒更新的舊版前端；那些前端沒有裝置 token，關門後根本進不來
    const sheet = tasksSheet();
    const env = envWith({ tasks: sheet });

    const out = JSON.parse(post(env, {
      sheet: 'tasks', action: 'append',
      record: { id: '9', text: '舊版送上來的', line_id: ME }
    }).body);

    assert.equal(out.error, 'unknown_action');
    assert.equal(sheet.getLastRow(), 1);
  });

  test('reviews 用複合鍵：同一天不同人不會互相覆蓋', () => {
    const headers = ['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del'];
    const sheet = new FakeSheet('reviews', [headers, ['2026-09-16', 'Neil 的', '', '', ME, '']]);
    const env = envWith({ reviews: sheet });

    post(env, {
      sheet: 'reviews', action: 'upsert', key_field: ['review_date', 'line_id'],
      record: { review_date: '2026-09-16', good: '家人的', stuck: '', most_important: '', line_id: 'Ufamily' }
    });

    assert.equal(sheet.getLastRow(), 3);
    assert.deepEqual(sheet.toRecords().map(r => r.good), ['Neil 的', '家人的']);
  });

  test('軟刪除就是一次普通的 upsert，把 del 寫成 TRUE', () => {
    const sheet = tasksSheet([['1', '要刪的', '', '', 'M', ME, '', '']]);
    const env = envWith({ tasks: sheet });

    post(env, {
      sheet: 'tasks', action: 'upsert',
      record: { id: '1', text: '要刪的', is_completed: '', created_at: '', priority: 'M', line_id: ME, del: 'TRUE' }
    });

    assert.equal(sheet.getLastRow(), 2, '軟刪除不刪列');
    assert.equal(sheet.toRecords()[0].del, 'TRUE');
    // 刪掉之後讀取層就看不到它了
    assert.deepEqual(get(env, { sheet: 'tasks' }).data, []);
  });

  test('兩道門仍然擋得住：沒有 token（含舊的密鑰寫法）、不在白名單', () => {
    const sheet = tasksSheet();
    const env = envWith({ tasks: sheet });

    // 關門前的舊寫法：密鑰＋自稱 line_id。現在沒有 token 就是沒有身份
    const legacy = JSON.parse(env.call('handlePwaSync_', {
      postData: { contents: JSON.stringify({ secret: 'whatever', line_id: ME, sheet: 'tasks', action: 'upsert', record: { id: '1' } }) }
    }).body);
    assert.equal(legacy.error, 'no_token');

    const stranger = JSON.parse(post(env, {
      sheet: 'tasks', action: 'upsert', record: { id: '1', line_id: 'Ustranger' }
    }, STRANGER_TOKEN).body);
    // 拒絕原因刻意分得出來（ADR-008 H-5）：「人被擋」是 inactive，「名單讀不到」
    // 原樣回 whitelist_unavailable——這兩件事的修法完全不同
    assert.equal(stranger.error, 'inactive');
    assert.equal(sheet.getLastRow(), 1, '被擋下來就一列都不該寫進去');
  });
});

/* ========================================================================== */
describe('doPost — 封存第二段 archivePurge', () => {

  function seeded() {
    const sheet = tasksSheet([
      ['1', '還在用的', '', '', 'M', ME, '', ''],
      ['2', '刪掉的 A', '', '', 'M', ME, 'TRUE', ''],
      ['3', '刪掉的 B', '', '', 'M', ME, 'TRUE', '']
    ]);
    return { sheet, env: envWith({ tasks: sheet }) };
  }

  test('只刪匯出清單裡、且此刻仍是墓碑的列', () => {
    const { sheet, env } = seeded();

    const out = JSON.parse(post(env, { sheet: 'tasks', action: 'archivePurge', keys: ['2'] }).body);

    assert.equal(out.success, true);
    assert.equal(out.deleted, 1);
    assert.deepEqual(sheet.toRecords().map(r => r.id), ['1', '3'], '沒匯出過的墓碑要留著');
  });

  test('清單是空的就什麼都不刪——這是「不先斬後奏」的那道鎖', () => {
    const { sheet, env } = seeded();

    const out = JSON.parse(post(env, { sheet: 'tasks', action: 'archivePurge', keys: [] }).body);

    assert.equal(out.deleted, 0);
    assert.equal(sheet.getLastRow(), 4);
  });

  test('keys 根本沒送也一樣什麼都不刪', () => {
    const { sheet, env } = seeded();
    const out = JSON.parse(post(env, { sheet: 'tasks', action: 'archivePurge' }).body);
    assert.equal(out.deleted, 0);
    assert.equal(sheet.getLastRow(), 4);
  });

  test('清單裡的列中途被救回來（取消 del）就放過它', () => {
    const { sheet, env } = seeded();
    sheet.values[2][6] = '';        // 第 2 筆的 del 被取消

    const out = JSON.parse(post(env, { sheet: 'tasks', action: 'archivePurge', keys: ['2', '3'] }).body);

    assert.equal(out.deleted, 1);
    assert.equal(out.skipped, 1);
    assert.deepEqual(sheet.toRecords().map(r => r.id), ['1', '2']);
  });

  test('line_users 與 logs 不歸前端管，拒絕 purge', () => {
    const { env } = seeded();
    const out = JSON.parse(post(env, { sheet: 'line_users', action: 'archivePurge', keys: ['x'] }).body);
    assert.equal(out.error, 'sheet_not_purgeable');
  });

  test('走的是同一套閘門：不在白名單的人刪不了東西', () => {
    const { sheet, env } = seeded();
    const out = JSON.parse(post(env, {
      sheet: 'tasks', action: 'archivePurge', keys: ['2', '3']
    }, STRANGER_TOKEN).body);

    assert.equal(out.error, 'inactive');
    assert.equal(sheet.getLastRow(), 4, '一列都不該被刪');
  });
});
