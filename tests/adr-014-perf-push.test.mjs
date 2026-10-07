/**
 * ADR-014 PR-C — 效能全量化（T8）× 管理員手動推播（T9）
 *
 * 盯的事：
 *   - 守門：index.html 每一個 cloudPost 都帶 trigger（只有不經驗證的 pairClaim／renewStart 例外）
 *   - 未驗證請求不寫 performance；每小時彙總一列，被打 1000 次也只有一列、次數對
 *   - bad_token 一小時超過 50 → 管理員 boot 拿得到警示（大頭貼紅點）
 *   - 切區耗時記成 zone，搭下一個請求送，不多打請求；被打斷的那段不記
 *   - pushPreview／pushSend 只限管理者；文字由後端組；記帳內容（含金額）不會出現；
 *     快到期清單只列在這個群組交代的或釘在白板上的；額度 API 失敗不擋推送
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';
import { loadFrontend } from './fake-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const ME = 'Uneil';
const MOM = 'Umom';
const TOK_ME = 'tok-neil-device';
const TOK_MOM = 'tok-mom-device';
const GROUP = 'Cfamily';
const HOUR = 3600000;
const TODAY = '2026-10-07';

const TASK_H = ['id', 'text', 'is_completed', 'created_at', 'priority', 'line_id', 'del', 'archive', 'board',
  'due_date', 'recur_interval', 'recur_unit', 'notified', 'origin_chat'];
const GROUP_H = ['group_id', 'name', 'is_active', 'cmd_expense', 'cmd_tasks', 'cmd_query', 'joined_at', 'left_at',
  'created_at', 'updated_at', 'notify_due'];
const row = (H, o) => H.map((h) => (o[h] === undefined ? '' : o[h]));

function env({ tasks = [], notes = [], expenses = [], groups = null, overrides = {}, properties = {} } = {}) {
  return loadCodeGs({
    cache: true,
    extraFiles: ['line-router.gs', 'sheet-guide.gs'],
    tokens: { [TOK_ME]: ME, [TOK_MOM]: MOM },
    properties,
    overrides,
    sheets: {
      line_users: new FakeSheet('line_users', [
        ['line_id', 'display_name', 'is_active', 'is_admin'],
        [ME, 'Neil', 'TRUE', 'TRUE'],
        [MOM, '裕仁', 'TRUE', '']
      ]),
      tasks: new FakeSheet('tasks', [TASK_H].concat(tasks.map((t) => row(TASK_H, t)))),
      notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del', 'board']].concat(
        notes.map((n) => [n.id, n.text, '', ME, n.del || '', n.board || '']))),
      expenses: new FakeSheet('expenses', [['id', 'expense_date', 'type', 'category', 'amount', 'note', 'line_id', 'del', 'board']].concat(
        expenses.map((x) => [x.id, TODAY, 'expense', '飲食', x.amount, x.note || '', ME, '', x.board || '']))),
      logs: new FakeSheet('logs', [['id']]),
      line_groups: new FakeSheet('line_groups', [GROUP_H].concat((groups || [{}]).map((g) => row(GROUP_H,
        Object.assign({ group_id: GROUP, name: '家族', is_active: 'TRUE', cmd_expense: 'TRUE', cmd_tasks: 'TRUE', cmd_query: 'TRUE' }, g)))))
    }
  });
}
const post = (e, body) => JSON.parse(e.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body);
const perfRows = (e) => (e.sheets.performance ? e.sheets.performance.toRecords() : []);

/* ========================================================================== */
describe('T8-1 守門：每一個雲端動作都帶 trigger', () => {

  /** 找出每個 cloudPost( 的整段引數（括號配對，跨行也抓得到） */
  function callSites(src) {
    const out = [];
    const re = /cloudPost\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (src.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue;
      let depth = 1, i = m.index + m[0].length;
      for (; i < src.length && depth; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; }
      out.push(src.slice(m.index + m[0].length, i - 1));
    }
    return out;
  }
  const UNAUTH = /action:'(pairClaim|renewStart)'/;

  test('除了 pairClaim／renewStart，每個 cloudPost 的引數裡都寫明 trigger', () => {
    const sites = callSites(HTML);
    assert.ok(sites.length >= 25, '應該找得到所有呼叫點（找到 ' + sites.length + ' 個）');
    const missing = sites.filter((a) => !UNAUTH.test(a) && !/\btrigger\b/.test(a));
    assert.deepEqual(missing, [], '新增任何雲端動作必須帶 trigger（CLAUDE.md）');
  });

  test('pairClaim／renewStart 確實沒有通過驗證，所以不帶也合理', () => {
    const sites = callSites(HTML).filter((a) => UNAUTH.test(a));
    assert.equal(sites.length, 2);
  });

  test('CLAUDE.md 寫進了這條規則', () => {
    assert.match(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), /新增任何雲端動作必須帶 trigger/);
  });

  test('輪詢不再抽樣：前端沒有 PERF_POLL_SAMPLE、後端沒有 perf_sample 條件', () => {
    assert.doesNotMatch(HTML, /PERF_POLL_SAMPLE|perf_sample/);
    assert.doesNotMatch(readFileSync(join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), /body\.perf_sample/);
  });
});

/* ========================================================================== */
describe('T8-4 未驗證請求每小時彙總一列', () => {

  test('⚠️ 被打 1000 次（錯 token）→ 當下一列都不寫；整點後只多 1 列，次數正確', () => {
    const e = env();
    for (let i = 0; i < 1000; i++) post(e, { action: 'read', sheet: 'tasks', token: 'bad-' + i, trigger: 'poll' });
    assert.equal(perfRows(e).length, 0, '陌生人灌不爆這張表');
    e.call('flushUnauthPerf', Date.now() + HOUR);
    const rows = perfRows(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'unauth');
    assert.equal(rows[0].trigger, 'hourly');
    assert.equal(rows[0].rows, 1000);
    assert.equal(rows[0].sheets, 'bad_token 1000');
    assert.ok(typeof rows[0].server_ms === 'number');
    e.call('flushUnauthPerf', Date.now() + HOUR);
    assert.equal(perfRows(e).length, 1, '同一小時不會寫第二列');
  });

  test('依原因分類：pairClaim、renewStart、bad_token', () => {
    const e = env();
    post(e, { action: 'pairClaim', code: '000000' });
    post(e, { action: 'pairClaim', code: '000001' });
    post(e, { action: 'renewStart', token: 'nope' });
    for (let i = 0; i < 3; i++) post(e, { action: 'readMany', sheets: ['tasks'], token: 'x' });
    post(e, { action: 'session', token: 'nope' });
    e.call('flushUnauthPerf', Date.now() + HOUR);
    assert.equal(perfRows(e)[0].sheets, 'bad_token 4・pairClaim 2・renewStart 1');
    assert.equal(perfRows(e)[0].rows, 7);
  });

  test('通過驗證的請求不算進去', () => {
    const e = env();
    post(e, { action: 'read', sheet: 'tasks', token: TOK_ME, trigger: 'manual' });
    e.call('flushUnauthPerf', Date.now() + HOUR);
    assert.ok(perfRows(e).every((r) => r.action !== 'unauth'));
  });

  test('⚠️ 觸發器呼叫時帶事件物件：當成現在，上一小時的照樣寫出去', () => {
    const e = env();
    e.call('noteUnauth_', 'unknown_token', 12, Date.now() - HOUR);
    assert.deepEqual(e.call('flushUnauthPerf', { triggerUid: 'x', authMode: 'FULL' }), { written: 1 });
    assert.equal(perfRows(e)[0].sheets, 'bad_token 1');
  });

  test('bad_token 一小時超過 50 → 管理員 boot 拿得到 unauth_alert；一般成員沒有', () => {
    const e = env();
    for (let i = 0; i < 51; i++) post(e, { action: 'read', sheet: 'tasks', token: 'bad' });
    e.call('flushUnauthPerf', Date.now() + HOUR);
    assert.equal(post(e, { action: 'boot', token: TOK_ME, trigger: 'cold' }).unauth_alert.bad_token, 51);
    assert.equal(post(e, { action: 'boot', token: TOK_MOM, trigger: 'cold' }).unauth_alert, undefined);
  });

  test('50 次以內不警示', () => {
    const e = env();
    for (let i = 0; i < 50; i++) post(e, { action: 'read', sheet: 'tasks', token: 'bad' });
    e.call('flushUnauthPerf', Date.now() + HOUR);
    assert.equal(post(e, { action: 'boot', token: TOK_ME, trigger: 'cold' }).unauth_alert, undefined);
  });
});

/* ========================================================================== */
describe('T8-3 切區耗時（trigger=zone）', () => {

  test('雲端收手機送的 zone 紀錄', () => {
    const e = env();
    post(e, { action: 'read', sheet: 'tasks', token: TOK_ME, trigger: 'manual',
      perf: [{ action: 'zoneSwitch', trigger: 'zone', client_ms: 180 }] });
    assert.ok(perfRows(e).some((r) => r.action === 'zoneSwitch' && r.trigger === 'zone' && r.client_ms === 180));
  });

  function front() {
    const e = loadFrontend({});
    e.raw('myLineId = "' + ME + '"; roster = [{line_id:"' + ME + '", is_active:"TRUE"}]; state = EMPTY_STATE(); cloudDenied = []');
    return e;
  }

  test('切區把耗時放進 perfPending，不發任何請求', () => {
    const e = front();
    e.call('homePress', true);
    e.call('switchZone');
    assert.equal(e.calls.length, 0);
    const p = e.read('perfPending');
    assert.equal(p.length, 1);
    assert.equal(p[0].action, 'zoneSwitch');
    assert.equal(p[0].trigger, 'zone');
  });

  test('動畫被下一次點擊打斷的那段不記，只記最後一段', () => {
    const e = front();
    const ts = [];
    e.context.document.documentElement = { setAttribute() {} };
    e.context.document.startViewTransition = (cb) => {
      let resolve; const finished = new Promise((r) => { resolve = r; });
      const t = { cb, resolve, finished, skipTransition() { cb(); resolve(); } };
      ts.push(t); return t;
    };
    e.call('switchZone');
    e.call('switchZone');
    ts[1].cb(); ts[1].resolve();
    return new Promise((r) => setImmediate(r)).then(() => {
      assert.equal(e.read('perfPending').filter((p) => p.trigger === 'zone').length, 1);
    });
  });
});

/* ========================================================================== */
describe('T9 管理員手動推播', () => {

  const DUE = '2026-10-09';
  const seed = () => ({
    tasks: [
      { id: '1', text: '群組交代的：繳管理費', line_id: MOM, due_date: DUE, origin_chat: GROUP },
      { id: '2', text: '私人的：兆豐卡結帳', line_id: ME, due_date: DUE },
      { id: '3', text: '釘在白板：買電池', line_id: ME, board: 'TRUE', due_date: DUE },
      { id: '4', text: '已完成的白板', line_id: ME, board: 'TRUE', is_completed: 'TRUE' },
      { id: '5', text: '刪掉的白板', line_id: ME, board: 'TRUE', del: 'TRUE' },
      { id: '6', text: '別的群組交代的', line_id: MOM, due_date: DUE, origin_chat: 'Cother' }
    ],
    notes: [{ id: '7', text: '週末烤肉', board: 'TRUE' }],
    expenses: [{ id: '8', amount: 4321, note: '釘著的帳', board: 'TRUE' }]
  });
  const req = (o) => Object.assign({ token: TOK_ME, group_id: GROUP, kind: 'board', today: TODAY, trigger: 'manual' }, o);

  test('非管理者：pushPreview／pushSend 都 forbidden，並寫 logs（來源「推播」）', () => {
    const e = env(seed());
    for (const action of ['pushPreview', 'pushSend']) {
      assert.equal(post(e, req({ action, token: TOK_MOM })).error, 'forbidden');
    }
    assert.equal(e.pushes.length, 0);
    assert.ok(e.transactions.filter((t) => t[0] === '推播' && t[1] === '失敗').length >= 2);
  });

  test('白板摘要：任務＋雜記，不含已完成、已刪除；⚠️ 記帳（含金額）不出現', () => {
    const e = env(seed());
    const r = post(e, req({ action: 'pushPreview' }));
    assert.equal(r.success, true);
    assert.match(r.text, /買電池/);
    assert.match(r.text, /週末烤肉/);
    assert.doesNotMatch(r.text, /已完成的白板|刪掉的白板/);
    assert.doesNotMatch(r.text, /4321|釘著的帳/);
  });

  test('快到期清單：只列這個群組交代的或白板上的；⚠️ 私人任務與別的群組不出現', () => {
    const e = env(seed());
    const r = post(e, req({ action: 'pushPreview', kind: 'due' }));
    assert.match(r.text, /繳管理費/);
    assert.match(r.text, /買電池/);
    assert.doesNotMatch(r.text, /兆豐卡/);
    assert.doesNotMatch(r.text, /別的群組/);
    assert.match(r.text, /還剩 2 天/);
  });

  test('⚠️ 文字由後端組：pushSend 不採用前端送來的 text（白板／快到期）', () => {
    const e = env(seed());
    post(e, req({ action: 'pushSend', text: '假的內容 NT$ 99999' }));
    assert.equal(e.pushes.length, 1);
    assert.equal(e.pushes[0].to, GROUP);
    assert.doesNotMatch(e.pushes[0].text, /假的內容/);
    assert.match(e.pushes[0].text, /買電池/);
    assert.ok(e.transactions.some((t) => t[0] === '推播' && t[1] === '成功' && /白板摘要→家族/.test(t[2])));
  });

  test('自訂文字：原樣送；空白、超過 500 字擋下', () => {
    const e = env(seed());
    assert.equal(post(e, req({ action: 'pushSend', kind: 'custom', text: '  晚上七點吃飯  ' })).success, true);
    assert.equal(e.pushes[0].text, '晚上七點吃飯');
    assert.equal(post(e, req({ action: 'pushPreview', kind: 'custom', text: '   ' })).error, 'empty');
    assert.equal(post(e, req({ action: 'pushPreview', kind: 'custom', text: 'x'.repeat(501) })).error, 'too_long');
    assert.equal(post(e, req({ action: 'pushPreview', kind: 'expense' })).error, 'invalid_kind', '沒有記帳這一種');
  });

  test('只推得到啟用中、bot 還在的群組', () => {
    for (const g of [{ is_active: '' }, { left_at: '2026-10-05T00:00:00Z' }]) {
      const e = env(Object.assign(seed(), { groups: [g] }));
      assert.equal(post(e, req({ action: 'pushSend' })).error, 'group_inactive');
      assert.equal(e.pushes.length, 0);
    }
    assert.equal(post(env(seed()), req({ action: 'pushPreview', group_id: 'Cnope' })).error, 'group_not_found');
  });

  test('沒東西可推 → nothing_to_send', () => {
    const e = env({});
    assert.equal(post(e, req({ action: 'pushPreview' })).error, 'nothing_to_send');
    assert.equal(post(e, req({ action: 'pushPreview', kind: 'due' })).error, 'nothing_to_send');
  });

  test('預覽：人數＝會用掉幾則、本月額度與已用量（LINE API）', () => {
    const urls = [];
    const fetch = (url) => {
      urls.push(url);
      const body = /members\/count/.test(url) ? { count: 4 } : /quota\/consumption/.test(url) ? { totalUsage: 37 } : { type: 'limited', value: 200 };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
    };
    const e = env(Object.assign(seed(), { properties: { LINE_CHANNEL_ACCESS_TOKEN: 't' }, overrides: { UrlFetchApp: { fetch } } }));
    const r = post(e, req({ action: 'pushPreview' }));
    assert.equal(r.cost, 4);
    assert.deepEqual(r.quota, { limit: 200, used: 37 });
    assert.ok(urls.some((u) => u.endsWith('/group/' + GROUP + '/members/count')));
  });

  test('⚠️ 額度 API 失敗：預覽寫查不到，但照樣推得出去', () => {
    const fetch = () => { throw new Error('timeout'); };
    const e = env(Object.assign(seed(), { properties: { LINE_CHANNEL_ACCESS_TOKEN: 't' }, overrides: { UrlFetchApp: { fetch } } }));
    const r = post(e, req({ action: 'pushPreview' }));
    assert.equal(r.success, true);
    assert.equal(r.quota, null);
    assert.equal(r.cost, null);
    assert.equal(post(e, req({ action: 'pushSend' })).success, true);
  });

  test('推播失敗：回 push_failed、logs 記失敗', () => {
    const e = loadCodeGs({ cache: true, extraFiles: ['line-router.gs'], tokens: { [TOK_ME]: ME },
      pushImpl: () => ({ ok: false, code: 429, reason: 'quota' }), sheets: env(seed()).sheets });
    assert.equal(post(e, req({ action: 'pushSend' })).error, 'push_failed');
    assert.ok(e.transactions.some((t) => t[0] === '推播' && t[1] === '失敗'));
  });

  test('LOG 頁有「推播」篩選鈕', () => {
    assert.match(HTML, /const LOG_SOURCES = \[[^\]]*'推播'/);
  });
});

/* ========================================================================== */
describe('T9 前端：先預覽、才推得出去', () => {

  function front(reply) {
    const e = loadFrontend({ fetchImpl: ({ body }) => ({ json: () => Promise.resolve(reply(body) || { success: true }) }) });
    e.raw('myLineId = "' + ME + '"; deviceToken = "t"; roster = [{line_id:"' + ME + '", is_active:"TRUE", is_admin:"TRUE"}]');
    e.raw('pushState.groups = [{group_id:"' + GROUP + '", name:"家族", is_active:"TRUE"}]; pushState.group = "' + GROUP + '"');
    return e;
  }
  const sent = (e, a) => e.calls.filter((c) => c.body && c.body.action === a);

  test('沒預覽就按推送：不送', async () => {
    const e = front(() => null);
    await e.callRaw('sendPush');
    assert.equal(sent(e, 'pushSend').length, 0);
  });

  test('預覽（manual）→ 推送（write）；改了選項，預覽作廢', async () => {
    const e = front((b) => (b.action === 'pushPreview' ? { success: true, text: '📌 白板', group: { id: GROUP, name: '家族' }, cost: 3, quota: null } : null));
    await e.callRaw('previewPush');
    assert.equal(sent(e, 'pushPreview')[0].body.trigger, 'manual');
    assert.ok(e.read('pushState.preview'));
    e.call('setPush', 'kind', 'due');
    assert.equal(e.read('pushState.preview'), null, '改了內容種類就要重新預覽');
    await e.callRaw('previewPush');
    await e.callRaw('sendPush');
    const s = sent(e, 'pushSend');
    assert.equal(s.length, 1);
    assert.equal(s[0].body.trigger, 'write');
    assert.equal(s[0].body.kind, 'due');
  });

  test('額度文字：查得到 / 查不到', () => {
    const e = front(() => null);
    assert.equal(e.call('pushQuotaText', { cost: 4, quota: { used: 37, limit: 200 } }), '這次會用掉 4 則｜本月已用 37 / 200');
    assert.equal(e.call('pushQuotaText', { cost: null, quota: null }), '人數查詢失敗｜額度查詢失敗');
  });

  test('效能卡標題：暴增與筆數用「・」接起來，沒有筆數時不留尾巴', () => {
    const e = front(() => null);
    const els = {};
    const orig = e.context.document.getElementById;
    e.set('document', Object.assign({}, e.context.document, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
    e.raw('unauthAlert = {ts:"2026-10-07T03:00:00.000Z", bad_token: 80}; perfRows = 0');
    e.call('renderPerfCard');
    assert.equal(els.perfCount.textContent, '⚠️ 未驗證請求暴增');
    e.raw('perfRows = 120');
    e.call('renderPerfCard');
    assert.equal(els.perfCount.textContent, '⚠️ 未驗證請求暴增・120 筆');
  });

  test('未驗證請求暴增 → 管理員大頭貼亮紅點', () => {
    const e = front(() => null);
    const dot = { hidden: true };
    const orig = e.context.document.getElementById;
    e.set('document', Object.assign({}, e.context.document, { getElementById: (id) => (id === 'avatarDot' ? dot : orig(id)) }));
    e.call('renderAvatar');
    assert.equal(dot.hidden, true);
    e.raw('unauthAlert = {ts:"2026-10-07T03:00:00.000Z", bad_token: 80}');
    e.call('renderAvatar');
    assert.equal(dot.hidden, false);
  });
});
