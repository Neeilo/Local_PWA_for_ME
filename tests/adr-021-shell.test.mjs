/**
 * ADR-021 PR-A2（後端）— feat_ui_v2 權限欄
 *
 * 為什麼有這批測試：
 *  - 2.0 先只開管理者（D-20）。「初始化」補欄時，**這一次才新增**才替管理者打勾，
 *    之後誰的勾都不動——比照 feat_gmail／feat_clips，重跑初始化不能把 Neil 關掉的人又打開
 *  - 註冊（第一位）會把 LINE_USERS_FEATURES 全開，2.0 也在裡面
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

function env(rows) {
  return loadCodeGs({
    sheets: { line_users: new FakeSheet('line_users', rows), logs: new FakeSheet('logs', [['id']]) },
    extraFiles: ['line-router.gs']
  });
}
const users = (e) => e.sheets.line_users.toRecords();

describe('feat_ui_v2', () => {

  test('登記在功能矩陣裡（註冊、建表、成員與權限都看這份）', () => {
    const e = env([['line_id']]);
    assert.ok(e.read('LINE_USERS_FEATURES').includes('feat_ui_v2'));
  });

  test('初始化：第一次補欄只替管理者打勾', () => {
    const e = env([['line_id', 'display_name', 'is_active', 'is_admin'], ['Uneil', 'Neil', 'TRUE', 'TRUE'], ['Umom', '媽媽', 'TRUE', '']]);
    const r = e.call('installUiV2Feature_');
    assert.match(r.text, /預設只開管理者 1 人/);
    const by = Object.fromEntries(users(e).map((u) => [u.line_id, u.feat_ui_v2]));
    assert.deepEqual(by, { Uneil: 'TRUE', Umom: '' });
  });

  test('欄位已經在：一個勾都不動（管理者關掉的不會被打開）', () => {
    const e = env([['line_id', 'is_admin', 'feat_ui_v2'], ['Uneil', 'TRUE', 'FALSE']]);
    e.call('installUiV2Feature_');
    assert.equal(users(e)[0].feat_ui_v2, 'FALSE');
  });

  test('「初始化」的步驟裡有它', () => {
    const e = env([['line_id']]);
    assert.ok(e.read('initSteps_().map(function(s){ return s.label; })').some((l) => /2\.0/.test(l)));
  });
});
