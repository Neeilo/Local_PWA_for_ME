/**
 * ADR-021 — 效能紀錄加 ui 欄（Neil 2026-10-19：要分得出 1.0／2.0）
 *
 * 為什麼有這批測試：
 *  - PR-B 的驗收是「2.0 冷開機 P50 不慢於 9.6 秒」。1.0／2.0 共用同一個後端、同一張 performance，
 *    沒有這一欄就只能混在一起算，比不出來
 *  - 標記用「這台裝置選了哪一版」，不是「現在畫的是哪一版」：開機那一趟送出時名單還沒回來，
 *    isV2() 一定是 false——用它標，最重要的那一筆 2.0 冷開機會被記成 v1
 *  - 權限被收回時清掉這台記的 2.0 選擇，標記才不會一直錯
 *  - 欄位只收 v1／v2：它會寫進 Sheet，不能讓任何內容夾帶進來；LINE、排程的列留空
 *  - 舊表沒有 ui 欄：補在最右邊，舊列留空（只加不改）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const TOK = 'tok-neil-device';

function backend() {
  return loadCodeGs({
    cache: true, propsWritable: true, extraFiles: ['line-router.gs', 'sheet-guide.gs'], tokens: { [TOK]: ME },
    sheets: {
      line_users: new FakeSheet('line_users', [['line_id', 'display_name', 'is_active', 'is_admin', 'feat_tasks'], [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE']]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'line_id', 'del']]),
      logs: new FakeSheet('logs', [['id']])
    }
  });
}
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(Object.assign({ token: TOK }, body)) } }).body);
const flushed = (e) => { e.call('flushPerfQueue'); return e.sheets.performance.toRecords(); };

describe('後端：ui 欄', () => {

  test('雲端列記下請求帶的 ui；手機列記下自己的 ui', () => {
    const e = backend();
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', ui: 'v2',
      perf: [{ action: 'boot', trigger: 'cold', client_ms: 8000, ui: 'v2' }, { action: 'pull', trigger: 'poll', client_ms: 900, ui: 'v1' }] });
    const rows = flushed(e);
    const server = rows.find((r) => r.action === 'readMany');
    assert.equal(server.ui, 'v2');
    assert.equal(rows.find((r) => r.action === 'boot').ui, 'v2');
    assert.equal(rows.find((r) => r.action === 'pull').ui, 'v1');
  });

  test('不是 v1／v2 一律留空（不讓內容夾帶進 Sheet）；沒帶也留空', () => {
    const e = backend();
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', ui: '=HYPERLINK("x")',
      perf: [{ action: 'boot', trigger: 'cold', client_ms: 8000, ui: 'v3' }] });
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'manual' });
    const rows = flushed(e);
    assert.ok(rows.length >= 3);
    rows.filter((r) => r.action !== 'perfFlush').forEach((r) => assert.equal(r.ui, '', JSON.stringify(r)));
  });

  test('舊表沒有 ui 欄：補在最右邊，舊列留空', () => {
    const e = backend();
    const old = e.read('PERFORMANCE_HEADERS').filter((h) => h !== 'ui');
    e.sheets.performance = new FakeSheet('performance', [old, old.map((h) => (h === 'id' ? '1' : h === 'action' ? 'boot' : ''))]);
    post(e, { action: 'readMany', sheets: ['tasks'], trigger: 'poll', ui: 'v2' });
    e.call('flushPerfQueue');
    const headers = e.sheets.performance.values[0];
    assert.equal(headers[headers.length - 1], 'ui');
    const rows = e.sheets.performance.toRecords();
    assert.equal(rows[0].ui, '', '舊列不動');
    assert.equal(rows.find((r) => r.action === 'readMany').ui, 'v2');
  });
});

describe('前端：每個請求與手機量的耗時都標 ui', () => {

  function front(stored) {
    const e = loadFrontend({ storage: stored ? { 'personal-os-ui': stored } : {} });
    e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false;');
    return e;
  }
  const lastBody = (e) => e.calls[e.calls.length - 1].body;

  test('這台選了 2.0：名單還沒回來（開機那一趟）就標 v2', async () => {
    const e = front('v2');
    e.raw('roster = []');
    await e.call('cloudPost', { action: 'boot', trigger: 'cold' });
    assert.equal(lastBody(e).ui, 'v2');
  });

  test('沒選 2.0：標 v1', async () => {
    const e = front(null);
    await e.call('cloudPost', { action: 'boot', trigger: 'cold' });
    assert.equal(lastBody(e).ui, 'v1');
  });

  test('手機量的耗時（perfNote）記下當下的 ui，搭下一班車上去', async () => {
    const e = front('v2');
    e.call('perfNote', 'boot', 'cold', 8000, 'rid-12345678');
    await e.call('cloudPost', { action: 'readMany', trigger: 'poll' });
    assert.equal(lastBody(e).perf[0].ui, 'v2');
  });

  test('權限被收回：清掉這台記的 2.0，之後標 v1', () => {
    const e = front('v2');
    e.raw('roster = [{line_id:"' + ME + '", display_name:"Neil", is_active:"TRUE", feat_tasks:"TRUE", feat_ui_v2:""}]');
    e.call('forgetV2IfRevoked');
    assert.equal(e.read('localStorage.getItem("personal-os-ui")'), null);
    assert.equal(e.call('uiTag'), 'v1');
  });

  test('名單還沒回來時不清（不知道有沒有權限，不能先當沒有）', () => {
    const e = front('v2');
    e.raw('roster = []');
    e.call('forgetV2IfRevoked');
    assert.equal(e.read('localStorage.getItem("personal-os-ui")'), 'v2');
  });
});
