/**
 * 清理小票的回歸測試（2026-09-24 JHIN code review）
 *
 * 三件事：
 *   1. 配對之後，只送「身份確定前就排好」的那幾筆，不把整份雲端快照重送一遍
 *      （原本測的是 ADR-008 的選身份；ADR-010 把入口換成配對，要守的事沒變）
 *   2. replaceAll 已退場：後端收到要明確拒絕，整張表一個字都不能動
 *   3. logs／line_users 不歸前端管的保護，在 replaceAll 退場後仍然擋得住 archivePurge
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const TOKEN = 'tok-neil';

describe('配對之後的補推（原「選身份之後的補推」，ADR-010 起身份改由配對取得）', () => {
  function cloudWith20Tasks() {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: String(1000 + i), text: '雲端任務 ' + i, is_completed: '', created_at: '2026-09-01T00:00:00Z',
      priority: 'M', line_id: 'Ufamily'
    }));
    return ({ body }) => {
      if (body && body.action === 'pairClaim') {
        return { json: () => Promise.resolve({ success: true, token: 'tok-new', device_id: 'd1', line_id: ME, display_name: 'Neil' }) };
      }
      if (body && body.action === 'read' && body.sheet === 'tasks') return { json: () => Promise.resolve({ data: tasks }) };
      if (body && body.action === 'read' && body.sheet === 'line_users') {
        return { json: () => Promise.resolve({ data: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE' }] }) };
      }
      if (body && body.action === 'read') return { json: () => Promise.resolve({ data: [] }) };
      return null;
    };
  }

  test('只送配對前排好的那一筆，不重送雲端上既有的 20 筆', async () => {
    const e = loadFrontend({ fetchImpl: cloudWith20Tasks() });
    e.raw('myLineId = null; deviceToken = null');
    e.raw('localOnly = true');
    e.raw('state = EMPTY_STATE()');
    e.raw('outbox = []');
    e.call('queueUpsert', 'notes', { id: '77', text: '配對前記的', line_id: '' });
    assert.equal(e.call('pendingCount'), 1, '前提：還沒配對時寫入只排不送');

    // 畫面相關的部分與這裡要驗的無關（假 DOM 也撐不起導覽列重排），換成空函式
    e.raw('applyIdentity = function(){}');
    const ok = await e.callRaw('submitPairCode', '123456');

    assert.equal(ok, true);
    assert.equal(e.read('deviceToken'), 'tok-new');
    assert.equal(e.read('myLineId'), ME, '身份來自配對的回應，不是使用者選的');
    assert.equal(e.localStorage.getItem('personal-os-device-token'), 'tok-new');
    assert.equal(e.read('localOnly'), false, '配對成功就不再是「先在本機用」');

    const writes = e.calls.filter((c) => c.body && c.body.action === 'upsert');
    assert.equal(writes.filter((c) => c.body.sheet === 'tasks').length, 0,
      '雲端既有的任務不該被重送——那是別人的最新版本，重送等於拿快照蓋回去');
    assert.equal(writes.filter((c) => c.body.sheet === 'notes' && c.body.record.id === '77').length, 1,
      '配對前記的那一筆要送出去');
    assert.ok(writes.every((c) => c.body.token === 'tok-new'), '補送要帶上剛拿到的 token');
    assert.equal(e.call('pendingCount'), 0, '佇列要清空');
  });
});

describe('replaceAll 已退場（ADR-009 §一.2）', () => {
  function env() {
    return loadCodeGs({
      tokens: { [TOKEN]: ME },
      sheets: {
        tasks: new FakeSheet('tasks', [['id', 'text', 'line_id'], ['1', '買菜', ME], ['2', '繳費', ME]]),
        logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']]),
        line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin'], [ME, 'Neil', 'TRUE', 'TRUE']])
      }
    });
  }
  function post(e, body) {
    const req = { postData: { contents: JSON.stringify(Object.assign({ token: TOKEN }, body)) } };
    return JSON.parse(e.call('handlePwaSync_', req).body);
  }

  test('對 tasks 送 replaceAll：被拒絕，整張表原封不動', () => {
    const e = env();
    const before = JSON.stringify(e.ss.getSheetByName('tasks').values);
    const out = post(e, { sheet: 'tasks', action: 'replaceAll', headers: ['id', 'text', 'line_id'], records: [] });
    assert.ok(out.error, '要回錯誤，不能回 success');
    assert.notEqual(out.success, true);
    assert.equal(JSON.stringify(e.ss.getSheetByName('tasks').values), before,
      '一個請求就清空整張表，是這個系統破壞力最大的一個動作——它不該還能被觸發');
  });

  test('logs 與 line_users 仍然不能被 archivePurge 動到', () => {
    const e = env();
    for (const sheet of ['logs', 'line_users']) {
      const before = JSON.stringify(e.ss.getSheetByName(sheet).values);
      const out = post(e, { sheet, action: 'archivePurge', key_field: 'id', keys: ['1'] });
      assert.equal(out.error, 'sheet_not_purgeable', sheet + ' 要被擋下');
      assert.equal(JSON.stringify(e.ss.getSheetByName(sheet).values), before);
    }
  });
});
