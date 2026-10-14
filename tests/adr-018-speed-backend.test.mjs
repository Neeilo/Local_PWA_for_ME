/**
 * ADR-018 PR-A（D-2、D-4、D-6）— 開機加速：後端
 *
 * 為什麼有這批測試：PR-0 量到 boot cold server 中位 7.7 秒，其中股票 3.8 秒、驗證 1.6 秒（auth.device 1.3）。
 * 盯的事：
 *   - 驗證快取 6 小時：6 小時內不重讀 line_devices；**撤銷仍立即生效**（快取被主動清掉）
 *   - 效能紀錄不擋住回應：請求只在指令碼屬性放自己的鍵，不碰 performance；排程 flushPerfQueue 才落地
 *     ・並行的兩個請求各自一個鍵，不互蓋
 *     ・落地的列跟以前直接寫的一模一樣（stages、device_id、line_id 都在）、依時間排序、寫完刪鍵
 *     ・拿不到鎖就跳過、鍵留著下一輪；排隊是空的就一列都不寫
 *     ・屬性放不進去 → 退回直接寫，紀錄不會掉
 *     ・管理員看效能摘要前先 flush，看到的是最新的
 *   - 「初始化」裝好每 10 分鐘的 flushPerfQueue，重複執行不累積
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const HOUR = 3600;

function env(opts = {}) {
  return loadCodeGs(Object.assign({
    cache: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks'],
        [ME, 'Neil', 'TRUE', 'TRUE', 'TRUE', 'TRUE'],
        [MOM, '媽媽', 'TRUE', '', '', 'TRUE']
      ]),
      tasks: new FakeSheet('tasks', [['id', 'text', 'is_completed', 'line_id', 'del'], ['1', '買菜', '', ME, '']]),
      logs: new FakeSheet('logs', [['id', 'ts', 'source', 'status', 'input', 'result', 'detail', 'target_row', 'user_id']])
    }
  }, opts));
}

function post(e, body) {
  return JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
}
const perfRows = (e) => (e.sheets.performance ? e.sheets.performance.toRecords() : []);
const queueKeys = (e) => Object.keys(e.properties).filter((k) => k.indexOf('perfq_') === 0);

/* ========================================================================== */
describe('驗證快取 6 小時（D-2）', () => {

  test('6 小時內：line_devices 被改壞也照樣通過（沒有重讀）；過了 6 小時才重讀', () => {
    const e = env();
    assert.equal(post(e, { token: TOK_MOM, action: 'boot', trigger: 'cold' }).session.status, 'ok');
    // 把媽媽那台的雜湊改掉：還在快取裡就不會發現
    const dev = e.sheets.line_devices;
    dev.values[2][1] = 'changed';
    e.clock.advance(5 * HOUR + 50 * 60);
    assert.equal(post(e, { token: TOK_MOM, action: 'boot', trigger: 'foreground' }).session.status, 'ok', '5 小時 50 分還在快取');
    e.clock.advance(20 * 60);
    assert.equal(post(e, { token: TOK_MOM, action: 'boot', trigger: 'foreground' }).error, 'unknown_token', '過了 6 小時重讀才發現');
  });

  test('撤銷仍立即生效：快取還在也一樣擋下', () => {
    const e = env();
    assert.equal(post(e, { token: TOK_MOM, action: 'boot', trigger: 'cold' }).session.status, 'ok');
    const out = post(e, { token: TOK_ME, action: 'revokeDevice', all_of: MOM, trigger: 'manual' });
    assert.equal(out.success, true);
    e.clock.advance(60);
    assert.equal(post(e, { token: TOK_MOM, action: 'boot', trigger: 'foreground' }).error, 'revoked');
  });
});

/* ========================================================================== */
describe('效能紀錄排隊（D-4：不擋住回應）', () => {

  test('請求不碰 performance：只放一個自己的鍵；flush 後才落地，內容跟直接寫的一樣', () => {
    const e = env({ propsWritable: true });
    post(e, { token: TOK_ME, action: 'boot', trigger: 'cold', perf: [{ action: 'boot', trigger: 'cold', client_ms: 4200 }] });
    assert.equal(perfRows(e).length, 0, '回應前沒寫 Sheet');
    assert.equal(queueKeys(e).length, 1);

    const out = e.call('flushPerfQueue');
    assert.equal(out.written, 2, 'server 一列＋手機一列');
    const rows = perfRows(e);
    const boot = rows.find((r) => r.action === 'boot' && r.server_ms !== '');
    assert.equal(boot.trigger, 'cold');
    assert.equal(boot.line_id, ME);
    assert.ok(JSON.parse(boot.stages).auth >= 0, 'stages 照樣寫');
    assert.ok(rows.some((r) => r.client_ms === 4200));
    assert.equal(queueKeys(e).length, 0, '寫完刪鍵');
    assert.ok(rows.some((r) => r.action === 'perfFlush' && r.trigger === 'schedule' && r.rows === 2), '排程自己也記一列');
  });

  test('並行的請求各自一個鍵，不互蓋；落地依時間排序', () => {
    const e = env({ propsWritable: true });
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    post(e, { token: TOK_MOM, action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks'], trigger: 'manual' });
    assert.equal(queueKeys(e).length, 3);
    e.call('flushPerfQueue');
    const rows = perfRows(e).filter((r) => r.action === 'readMany');
    assert.equal(rows.length, 3);
    const ids = rows.map((r) => Number(r.id));
    assert.deepEqual(ids, ids.slice().sort((a, b) => a - b));
    assert.deepEqual(rows.map((r) => r.line_id).sort(), [ME, ME, MOM].sort());
  });

  test('拿不到鎖：跳過、鍵留著，下一輪再寫', () => {
    const e = env({ propsWritable: true });
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    e.lock.busy = true;
    assert.deepEqual(e.call('flushPerfQueue'), { written: 0, reason: 'busy' });
    assert.equal(queueKeys(e).length, 1);
    e.lock.busy = false;
    assert.equal(e.call('flushPerfQueue').written, 1);
  });

  test('排隊是空的：一列都不寫（連排程自己那列也不寫）', () => {
    const e = env({ propsWritable: true });
    assert.deepEqual(e.call('flushPerfQueue'), { written: 0 });
    assert.equal(perfRows(e).length, 0);
  });

  test('別的指令碼屬性（API key 之類）不會被當成排隊、也不會被刪', () => {
    const e = env({ propsWritable: true, properties: { GEMINI_API_KEY: 'k', LINE_OA_ID: '@x' } });
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    e.call('flushPerfQueue');
    assert.equal(e.properties.GEMINI_API_KEY, 'k');
    assert.equal(e.properties.LINE_OA_ID, '@x');
  });

  test('屬性放不進去（額度滿、唯讀）：退回直接寫，紀錄不掉', () => {
    const e = env();                         // 預設唯讀
    post(e, { token: TOK_ME, action: 'readMany', sheets: ['tasks'], trigger: 'poll' });
    assert.equal(perfRows(e).filter((r) => r.action === 'readMany').length, 1);
  });

  test('管理員看效能摘要前先 flush：剛排隊的也算進去', () => {
    const e = env({ propsWritable: true });
    post(e, { token: TOK_ME, action: 'boot', trigger: 'cold' });
    const s = post(e, { token: TOK_ME, action: 'perfSummary', trigger: 'manual' });
    assert.equal(s.server.find((g) => g.action === 'boot').count, 1);
    assert.equal(queueKeys(e).length, 1, '只剩摘要自己這次的');
  });

  test('「初始化」裝好每 10 分鐘的 flushPerfQueue；跑兩次也只有一個', () => {
    const e = env();
    e.call('installPerfQueueTrigger');
    e.call('installPerfQueueTrigger');
    const t = e.triggers.filter((x) => x.handler === 'flushPerfQueue');
    assert.equal(t.length, 1);
    assert.equal(t[0].everyMinutes, 10);
  });
});
