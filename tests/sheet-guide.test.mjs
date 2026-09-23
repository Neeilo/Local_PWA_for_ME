/**
 * _guide 導覽分頁（2026-09-23 交棒票）的測試
 *
 * 盯五件事：
 *   1. 重複執行不會生出第二張分頁、也不會越長越多列——它是「產生」出來的，不是累加
 *   2. Neil 手寫的「備註」會活過 refresh，而且是用分頁名稱對，不是用列號對
 *      （分頁一多一少，列號就位移，用列號對就會把備註貼到別人身上）
 *   3. Sheet 與登記表對不上時要標出來：未登記／找不到分頁
 *   4. 觸發器可重複安裝不累積，且跟到期提醒的觸發器互不干擾
 *   5. PWA 寫不進 _guide（任何 action 都一樣）
 *
 * 測的是 apps-script/Code.gs + sheet-guide.gs 本人，兩份載進同一個假環境——
 * 線上 Apps Script 也是這樣共用全域的。
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const SECRET = 'test-cloud-secret';
const ME = 'Uneil';

function whitelist() {
  return new FakeSheet('line_users', [
    ['line_id', 'display_name', 'is_active', 'is_admin'],
    [ME, 'Neil', 'TRUE', 'TRUE']
  ]);
}

/** 一份「跟登記表完全對得上」的試算表（_guide 除外，它由 refresh 自己建） */
function registeredSheets() {
  return {
    tasks: new FakeSheet('tasks', [['id', 'text', 'line_id'], ['1', 'a', ME], ['2', 'b', ME]]),
    expenses: new FakeSheet('expenses', [['id', 'amount'], ['1', 100]]),
    reviews: new FakeSheet('reviews', [['review_date', 'good', 'line_id']]),
    moods: new FakeSheet('moods', [['id', 'level']]),
    notes: new FakeSheet('notes', [['id', 'text']]),
    logs: new FakeSheet('logs', [['id', 'ts', 'source']]),
    line_users: whitelist()
  };
}

function envWith(sheets) {
  return loadCodeGs({ sheets, properties: { CLOUD_SECRET: SECRET }, extraFiles: ['sheet-guide.gs'] });
}

/** _guide 讀回來：第 1 列是說明，第 2 列是表頭，之後每列一張分頁 */
function guideOf(env) {
  const sheet = env.ss.getSheetByName('_guide');
  assert.ok(sheet, '_guide 應該存在');
  const [banner, headers, ...rows] = sheet.values;
  const records = rows.map((row) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = row[i] === undefined ? '' : row[i]; });
    return o;
  });
  return { banner: banner[0], headers, records, byName: (n) => records.find((r) => r['分頁'] === n) };
}

/** 模擬 Neil 在手機上改某一列的備註 */
function writeNote(env, sheetName, note) {
  const sheet = env.ss.getSheetByName('_guide');
  const headers = sheet.values[1];
  const row = sheet.values.findIndex((r, i) => i >= 2 && r[0] === sheetName);
  assert.ok(row >= 2, '找不到 ' + sheetName + ' 那一列');
  sheet.values[row][headers.indexOf('備註')] = note;
}

/* ========================================================================== */
describe('refreshGuide — 產生而不是累加', () => {

  test('_guide 不存在時自動建立，說明列、表頭、每張分頁一列', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    const g = guideOf(env);

    assert.match(g.banner, /refreshGuide\(\)/);
    assert.match(g.banner, /2026-09-23 06:00/);
    assert.match(g.banner, /只有「備註」欄會被保留/);
    assert.deepEqual(g.headers,
      ['分頁', '類別', '用途', '誰寫入', '誰讀取', '主鍵', '相關 ADR', '欄位', '筆數', '狀態', '備註']);
    assert.deepEqual(g.records.map((r) => r['分頁']),
      ['tasks', 'expenses', 'reviews', 'moods', 'notes', 'logs', 'line_users', '_guide']);
  });

  test('重複執行三次：還是只有一張 _guide、列數不變', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    const once = env.ss.getSheetByName('_guide').values.length;
    env.call('refreshGuide');
    env.call('refreshGuide');
    assert.equal(env.ss.getSheets().filter((s) => s.getName() === '_guide').length, 1);
    assert.equal(env.ss.getSheetByName('_guide').values.length, once);
  });

  test('欄位與筆數讀自實際分頁；只寫表頭與筆數，不寫任何資料內容', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    const g = guideOf(env);
    assert.equal(g.byName('tasks')['欄位'], 'id、text、line_id');
    assert.equal(g.byName('tasks')['筆數'], 2);
    assert.equal(g.byName('moods')['筆數'], 0, '只有表頭 = 0 筆');
    const flat = JSON.stringify(env.ss.getSheetByName('_guide').values);
    assert.doesNotMatch(flat, /"a"|"b"/, '資料內容不可以出現在 _guide');
  });

  test('登記表的說明照寫（類別、用途、主鍵）', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    const g = guideOf(env);
    assert.equal(g.byName('tasks')['類別'], '資料');
    assert.equal(g.byName('logs')['類別'], '系統');
    assert.equal(g.byName('line_users')['主鍵'], 'line_id');
    assert.equal(g.byName('tasks')['狀態'], '✅ 正常');
  });
});

/* ========================================================================== */
describe('refreshGuide — 備註是唯一會被保留的欄位', () => {

  test('備註活過 refresh；其他欄在 Sheet 上改了會被登記表蓋回去', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    writeNote(env, 'expenses', '醫療備註很敏感');
    const sheet = env.ss.getSheetByName('_guide');
    const headers = sheet.values[1];
    const row = sheet.values.findIndex((r) => r[0] === 'expenses');
    sheet.values[row][headers.indexOf('用途')] = '手改的用途';

    env.call('refreshGuide');
    const g = guideOf(env);
    assert.equal(g.byName('expenses')['備註'], '醫療備註很敏感');
    assert.notEqual(g.byName('expenses')['用途'], '手改的用途');
  });

  test('分頁一多一少導致列位移時，備註仍然跟著分頁名稱走', () => {
    const sheets = registeredSheets();
    // 一張未登記的分頁會排在最後；先把它放進去，讓備註落在它身上
    sheets.etag = new FakeSheet('etag', [['日期', '車號']]);
    const env = envWith(sheets);
    env.call('refreshGuide');
    writeNote(env, 'etag', '舊 eTag，待 grill-me 決定');
    writeNote(env, 'notes', '雜記的備註');

    // 刪掉一張登記過的分頁 → 它仍會出現（標找不到），但新增一張未登記的會插隊
    delete sheets.moods;
    sheets.aaa = new FakeSheet('aaa', [['x']]);
    env.call('refreshGuide');

    const g = guideOf(env);
    assert.equal(g.byName('etag')['備註'], '舊 eTag，待 grill-me 決定');
    assert.equal(g.byName('notes')['備註'], '雜記的備註');
    assert.equal(g.byName('aaa')['備註'], '', '新分頁不可以撿到別人的備註');
  });
});

/* ========================================================================== */
describe('refreshGuide — 自動偵測兩種落差', () => {

  test('Sheet 上有、登記表沒有 → ⚠️ 未登記（名稱不用先知道，自己會冒出來）', () => {
    const sheets = registeredSheets();
    sheets['eTag通行費'] = new FakeSheet('eTag通行費', [['日期', '車號', '通行費'], ['2026-09-11', 'ABC', 30]]);
    const env = envWith(sheets);
    env.call('refreshGuide');
    const r = guideOf(env).byName('eTag通行費');
    assert.ok(r, '未登記的分頁也要列出來');
    assert.equal(r['狀態'], '⚠️ 未登記');
    assert.equal(r['欄位'], '日期、車號、通行費');
    assert.equal(r['筆數'], 1);
  });

  test('登記表有、Sheet 上找不到 → ⚠️ 找不到分頁', () => {
    const sheets = registeredSheets();
    delete sheets.notes;
    const env = envWith(sheets);
    env.call('refreshGuide');
    const r = guideOf(env).byName('notes');
    assert.equal(r['狀態'], '⚠️ 找不到分頁');
    assert.equal(r['筆數'], '', '找不到就不假裝有 0 筆');
  });

  test('_guide 自己不會被標成未登記，欄位寫的是它自己的表頭', () => {
    const env = envWith(registeredSheets());
    env.call('refreshGuide');
    env.call('refreshGuide');
    const r = guideOf(env).byName('_guide');
    assert.equal(r['狀態'], '✅ 正常');
    assert.match(r['欄位'], /^分頁、類別/);
  });
});

/* ========================================================================== */
describe('觸發器 — 可重複安裝，且不碰到期提醒的那一個', () => {

  test('安裝三次只剩一個，並立刻跑一次', () => {
    const env = envWith(registeredSheets());
    env.call('installGuideTrigger');
    env.call('installGuideTrigger');
    env.call('installGuideTrigger');
    assert.equal(env.triggers.filter((t) => t.handler === 'refreshGuide').length, 1);
    assert.ok(env.ss.getSheetByName('_guide'), '安裝時要順便產生一次');
  });

  test('安裝／移除 _guide 觸發器不影響到期提醒，反之亦然', () => {
    const env = envWith(registeredSheets());
    env.call('installAdr009Triggers');
    env.call('installGuideTrigger');
    env.call('uninstallGuideTrigger');
    assert.deepEqual(env.triggers.map((t) => t.handler), ['checkDueReminders']);

    env.call('installGuideTrigger');
    env.call('uninstallAdr009Triggers');
    assert.deepEqual(env.triggers.map((t) => t.handler), ['refreshGuide']);
  });
});

/* ========================================================================== */
describe('寫入保護 — PWA 寫不進 _guide', () => {

  function post(env, body) {
    const e = { postData: { contents: JSON.stringify(Object.assign({ secret: SECRET, line_id: ME }, body)) } };
    return JSON.parse(env.call('handlePwaSync_', e).body);
  }

  for (const action of ['replaceAll', 'upsert', 'append', 'completeRecurring', 'archivePurge']) {
    test(action + ' 被擋下，_guide 一個字都沒變', () => {
      const env = envWith(registeredSheets());
      env.call('refreshGuide');
      const before = JSON.stringify(env.ss.getSheetByName('_guide').values);
      const out = post(env, {
        sheet: '_guide', action, headers: ['分頁'], records: [], record: { '分頁': 'x' }, keys: []
      });
      assert.equal(out.error, 'sheet_not_writable');
      assert.equal(JSON.stringify(env.ss.getSheetByName('_guide').values), before);
    });
  }

  test('其他分頁照常寫得進去（沒有誤擋）', () => {
    const env = envWith(registeredSheets());
    const out = post(env, { sheet: 'notes', action: 'upsert', record: { id: '9', text: 'hi' } });
    assert.equal(out.error, undefined);
    assert.equal(env.ss.getSheetByName('notes').toRecords().length, 1);
  });
});
