/**
 * ADR-012 PR-B — 一趟開機 × 功能權限上雲 × 等待畫面 × 本機快照退場：前端
 *
 * 盯的事：
 *   - boot／readMany 失敗、認證錯誤、回應缺欄位：一律「這次不算數、原地不動」，絕不清空畫面
 *   - 開機與回前景同時觸發只跑一趟
 *   - denied：只清那個模組、丟掉那張表的待送工作並告知；跟「讀取失敗」是兩件事
 *   - 首頁在第一次讀到之前畫骨架，不先說「還沒有資料」
 *   - personal-os-state-v1 不再寫入、開機時刪掉；forgetDevice 連待送佇列一起清
 *   - 前端接真的 Code.gs 走一遍：feat_expense 關掉的人，記帳模組整個消失
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFrontend } from './fake-browser.mjs';
import { loadCodeGs, FakeSheet } from './fake-apps-script.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const ME = 'Uneil';
const TOKEN = 'tok-test-device';

const json = (v) => ({ json: () => Promise.resolve(v) });
const TASK = (id, text) => ({ id, text, is_completed: '', created_at: '2026-09-16T00:00:00.000Z', priority: 'M', line_id: ME });
const EXP = (id, amount) => ({ id, expense_date: '2026-10-01', type: 'expense', category: '餐飲', amount, note: '', created_at: '2026-10-01T00:00:00.000Z', line_id: ME, board: 'TRUE' });
const ALL = (over = {}) => Object.assign({ tasks: [], reviews: [], moods: [], notes: [], expenses: [] }, over);
const BOOT = (over = {}) => Object.assign({
  session: { status: 'ok', line_id: ME, device_id: 'd1' },
  line_users: [{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }],
  data: ALL(), denied: []
}, over);

async function settle(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** handler(body) 回 null 代表「寫入成功」；回 {__reject:true} 代表斷線 */
function env(handler = () => null) {
  const e = loadFrontend({
    fetchImpl: ({ body }) => {
      const out = handler(body || {});
      if (out) return out.__reject ? { json: () => Promise.reject(new Error('offline')) } : json(out);
      return json({ success: true });
    }
  });
  e.raw('myLineId = "' + ME + '"; deviceToken = "' + TOKEN + '"; localOnly = false; outbox = []; gateMode = null');
  e.raw('state = EMPTY_STATE()');
  e.raw('applyIdentity = function(){}; applyZone = function(){ __nav = (typeof __nav === "number" ? __nav : 0) + 1; }');
  return e;
}

/** 讓同一個 id 每次拿到同一個假元素，畫面寫了什麼才查得到 */
function stableDom(e) {
  const els = {};
  const doc = e.context.document;
  const orig = doc.getElementById;
  e.set('document', Object.assign({}, doc, { getElementById: (id) => els[id] || (els[id] = orig(id)) }));
  return els;
}

const withState = (e) => e.raw('state.tasks = [{id:1, txt:"原有的", done:false, ts:1, priority:"M", line_id:"' + ME + '"}]; firstLoadDone = true');

/* ========================================================================== */
describe('⚠️ boot 失敗不可以清空畫面', () => {

  const failures = {
    '斷線': () => ({ __reject: true }),
    '回應缺 data': () => ({ session: { status: 'ok', line_id: ME }, line_users: [] }),
    '回應缺 line_users': () => ({ session: { status: 'ok', line_id: ME }, data: ALL() }),
    'data 缺一張表': () => BOOT({ data: { tasks: [], reviews: [], moods: [], notes: [] } }),
    '系統錯誤（白名單讀不到）': () => ({ error: 'whitelist_unavailable' })
  };
  for (const [name, reply] of Object.entries(failures)) {
    test(name + ' → 原地不動、連線異常、不算一次成功', async () => {
      const e = env((b) => (b.action === 'boot' ? reply() : null));
      withState(e);
      const ok = await e.callRaw('startSession', 'cold');
      assert.equal(ok, false);
      assert.equal(e.read('state.tasks.length'), 1, '讀不到不等於雲端是空的');
      assert.equal(e.read('cloudOnline'), false);
      assert.equal(e.read('gateMode'), null, '不是認證問題就不開蓋版');
      assert.equal(e.read('perfPending.length'), 0, '失敗不記耗時');
    });
  }

  test('token_expired → 續期畫面，畫面原地不動', async () => {
    const e = env((b) => {
      if (b.action === 'boot') return { error: 'token_expired' };
      if (b.action === 'renewStart') return { success: true, code: '123456', oa_id: '', expires_in: 600 };
      return null;
    });
    withState(e);
    await e.callRaw('startSession', 'cold');
    await settle();
    assert.equal(e.read('gateMode'), 'renew');
    assert.equal(e.read('state.tasks.length'), 1);
  });

  test('readMany 失敗（輪詢）也一樣原地不動', async () => {
    const e = env((b) => (b.action === 'readMany' ? { __reject: true } : null));
    withState(e);
    assert.equal(await e.callRaw('pullFromCloud'), false);
    assert.equal(e.read('state.tasks.length'), 1);
  });
});

/* ========================================================================== */
describe('boot 成功：身份 → 名單 → 資料 → 補送', () => {

  test('一個請求套齊：身份、名單、資料；待送的接著送出去', async () => {
    const e = env((b) => (b.action === 'boot'
      ? BOOT({ session: { status: 'ok', line_id: ME, device_id: 'd7' }, data: ALL({ tasks: [TASK('3', '雲端的')] }) })
      : null));
    e.raw('myLineId = "Uold"');
    e.raw('outbox = [{sheet:"notes", key_field:"id", seq:1, record:{id:"9", text:"排著的"}}]');
    assert.equal(await e.callRaw('startSession', 'cold'), true);
    await settle();
    assert.equal(e.read('myLineId'), ME);
    assert.equal(e.read('myDeviceId'), 'd7');
    assert.equal(e.read('roster.length'), 1);
    assert.equal(e.read('rosterStatus'), 'ok');
    assert.deepEqual(e.read('state.tasks').map((t) => t.txt), ['雲端的']);
    assert.equal(e.read('cloudOnline'), true);
    assert.deepEqual(e.calls.map((c) => c.body.action), ['boot', 'upsert']);
  });

  test('開機與回前景同時觸發：只跑一趟 boot', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const e = loadFrontend({
      fetchImpl: ({ body }) => (body.action === 'boot'
        ? { json: () => gate.then(() => BOOT()) }
        : json({ success: true }))
    });
    e.raw('myLineId = "' + ME + '"; deviceToken = "' + TOKEN + '"; outbox = []; gateMode = null; applyIdentity = function(){}');
    const a = e.callRaw('startSession', 'cold');
    const b = e.callRaw('startSession', 'foreground');
    release();
    await Promise.all([a, b]);
    assert.equal(e.calls.filter((c) => c.body.action === 'boot').length, 1);
  });

  test('回前景走 boot（重新確認身份與名單）；輪詢與手動刷新走 readMany（不含名單）', async () => {
    const e = env((b) => (b.action === 'boot' ? BOOT() : b.action === 'readMany' ? { data: ALL(), denied: [] } : null));
    await e.callRaw('startSession', 'foreground');
    await e.callRaw('manualRefresh');
    e.call('pollTick');
    await settle();
    const acts = e.calls.map((c) => c.body.action + ':' + (c.body.trigger || '-'));
    assert.deepEqual(acts, ['boot:foreground', 'readMany:manual', 'readMany:poll']);
    for (const c of e.calls.filter((x) => x.body.action === 'readMany')) {
      assert.deepEqual(c.body.sheets, ['tasks', 'reviews', 'moods', 'notes', 'expenses']);
    }
  });
});

/* ========================================================================== */
describe('denied：明確沒權限，跟讀取失敗是兩件事', () => {

  test('只清被拒的模組，其他照常；導覽重排；featureAllowed 立刻反映', async () => {
    const e = env((b) => (b.action === 'readMany'
      ? { data: ALL({ tasks: [TASK('1', '任務在')] }), denied: ['expenses'] }
      : null));
    e.raw('state.expenses = [{id:5, date:"2026-10-01", type:"expense", category:"餐飲", amount:100, ts:1}]');
    e.raw('roster = [{line_id:"' + ME + '", is_active:"TRUE"}]');
    assert.equal(await e.callRaw('pullFromCloud'), true, 'denied 不是失敗');
    assert.equal(e.read('state.expenses.length'), 0);
    assert.deepEqual(e.read('state.tasks').map((t) => t.txt), ['任務在']);
    assert.equal(e.call('featureAllowed', 'expenses'), false);
    assert.equal(e.call('featureAllowed', 'tasks'), true);
    assert.equal(e.read('__nav'), 1, '導覽要重排一次');

    // 權限回來了（下一輪沒有 denied）
    e.set('fetch', () => Promise.resolve(json({ data: ALL(), denied: [] })));
    await e.callRaw('pullFromCloud');
    assert.equal(e.call('featureAllowed', 'expenses'), true);
  });

  test('待送佇列裡那張表的工作丟掉並告知；別張表的照送', async () => {
    const e = env((b) => (b.action === 'readMany' ? { data: ALL(), denied: ['expenses'] } : null));
    e.raw(`outbox = [
      {sheet:"expenses", key_field:"id", seq:1, record:{id:"1", amount:1}},
      {sheet:"expenses", key_field:"id", seq:2, record:{id:"2", amount:2}},
      {sheet:"notes", key_field:"id", seq:3, record:{id:"3", text:"留著"}}]`);
    await e.callRaw('pullFromCloud');
    assert.deepEqual(e.read('outbox').map((j) => j.sheet), ['notes']);
    assert.ok(e.toasts.some((t) => /沒有「.*記帳」的權限，2 筆/.test(t)), e.toasts.join('｜'));
    assert.equal(JSON.parse(e.localStorage.getItem('personal-os-outbox-v1')).length, 1, 'localStorage 那份也要同步');
  });

  test('寫入被擋（forbidden）：那筆從佇列拿掉並告知，不卡住後面的', async () => {
    const e = env((b) => (b.action === 'upsert' && b.sheet === 'expenses' ? { error: 'forbidden', sheet: 'expenses' } : null));
    e.raw(`outbox = [
      {sheet:"expenses", key_field:"id", seq:1, record:{id:"1", amount:1}},
      {sheet:"notes", key_field:"id", seq:2, record:{id:"3", text:"後面這筆"}}]`);
    await e.callRaw('flushOutbox');
    await settle();
    assert.equal(e.read('outbox.length'), 0);
    assert.deepEqual(e.calls.map((c) => c.body.sheet), ['expenses', 'notes']);
    assert.ok(e.toasts.some((t) => /沒有「.*記帳」的權限/.test(t)));
  });

  test('一般寫入失敗（不是 forbidden）照舊留在佇列等下次', async () => {
    const e = env((b) => (b.action === 'upsert' ? { error: 'sheet_not_found' } : null));
    e.raw('outbox = [{sheet:"notes", key_field:"id", seq:1, record:{id:"3", text:"x"}}]');
    await e.callRaw('flushOutbox');
    assert.equal(e.read('outbox.length'), 1);
  });
});

/* ========================================================================== */
describe('等待畫面（D-5）', () => {

  test('第一次讀到之前：首頁畫骨架，不說「還沒有支出紀錄」；讀到之後才出現空狀態', async () => {
    const e = env((b) => (b.action === 'boot' ? BOOT() : null));
    const els = stableDom(e);
    e.call('renderDashboard');
    assert.match(els.dashExpense.innerHTML, /skel/);
    assert.match(els.dashTasks.innerHTML, /skel/);
    assert.match(els.boardList.innerHTML, /skel/);
    assert.doesNotMatch(els.dashExpense.innerHTML, /還沒有支出紀錄/);

    await e.callRaw('startSession', 'cold');
    e.call('renderDashboard');
    assert.match(els.dashExpense.innerHTML, /還沒有支出紀錄/, '真的讀到了、而且是空的，才講空');
  });

  test('沒有配對（先在本機用）：不等雲端，首頁照常畫本機的東西，不會永遠卡在骨架', () => {
    const e = env();
    const els = stableDom(e);
    e.raw('deviceToken = null; localOnly = true');
    e.call('renderDashboard');
    assert.doesNotMatch(els.dashTasks.innerHTML, /skel/);
    assert.match(els.dashTasks.innerHTML, /目前沒有進行中的任務/);
  });

  test('讀取失敗時骨架留著（連線橫幅會講原因），不改成「沒有資料」', async () => {
    const e = env((b) => (b.action === 'boot' ? { __reject: true } : null));
    const els = stableDom(e);
    await e.callRaw('startSession', 'cold');
    e.call('renderDashboard');
    assert.match(els.dashExpense.innerHTML, /skel/);
  });

  test('進度條：開機、回前景、手動刷新會出現；輪詢不出現；結束後收起', async () => {
    const e = env((b) => (b.action === 'boot' ? BOOT() : b.action === 'readMany' ? { data: ALL(), denied: [] } : null));
    const els = stableDom(e);
    e.raw('var __starts = 0; var __ps = progressStart; progressStart = function(){ __starts++; __ps(); }');
    await e.callRaw('startSession', 'cold');
    assert.equal(e.read('__starts'), 1);
    assert.equal(els.bootProgress.hidden, true, '資料到齊就收起');
    e.call('pollTick');
    await settle();
    assert.equal(e.read('__starts'), 1, '背景更新不該打擾人');
    await e.callRaw('manualRefresh');
    assert.equal(e.read('__starts'), 2);
    await e.callRaw('startSession', 'foreground');
    assert.equal(e.read('__starts'), 3);
  });

  test('節奏常數：預估秒數另寫一個、超過 10 秒改講「比平常慢」', () => {
    const e = env();
    assert.equal(typeof e.read('BOOT_EXPECTED_MS'), 'number');
    assert.equal(e.read('BOOT_SLOW_MS'), 10000);
    assert.match(HTML, /比平常慢，仍在等雲端回應…/);
  });

  test('進度條與骨架只用 CSS 變數，不寫死色碼', () => {
    const css = HTML.match(/\.boot-progress[\s\S]*?@keyframes skel-pulse[^}]*}[^}]*}/)[0];
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/);
    assert.match(css, /var\(--accent\)/);
  });
});

/* ========================================================================== */
describe('本機快照退場（D-8）', () => {

  test('程式裡不再有任何寫入 personal-os-state-v1 的地方；開機時刪掉', () => {
    assert.doesNotMatch(HTML, /localStorage\.setItem\(\s*STORAGE_KEY/);
    const init = HTML.slice(HTML.indexOf('(function init(){'));
    assert.match(init, /localStorage\.removeItem\(STORAGE_KEY\)/);
    assert.equal(typeof loadFrontend().context.save, 'undefined', 'save() 變成空殼之後要整支拿掉');
  });

  test('開機、新增、輪詢之後，localStorage 裡都不會出現快照', async () => {
    const e = env((b) => (b.action === 'boot' ? BOOT({ data: ALL({ tasks: [TASK('1', 'a')] }) })
      : b.action === 'readMany' ? { data: ALL(), denied: [] } : null));
    await e.callRaw('startSession', 'cold');
    e.raw('renderTasks = function(){}');
    e.set('document', Object.assign({}, e.context.document, { getElementById: () => ({ value: '新的任務', addEventListener() {}, classList: { add() {}, remove() {} } }) }));
    e.call('addTask');
    e.call('pollTick');
    await settle();
    assert.equal(e.localStorage.getItem('personal-os-state-v1'), null);
    assert.ok(e.localStorage.getItem('personal-os-outbox-v1') !== null, '待送佇列照舊存著');
  });

  test('forgetDevice：待送佇列（記憶體與 localStorage）與畫面上的資料一起清掉', () => {
    const e = env();
    e.raw('openAuthGate = function(){}');
    withState(e);
    e.raw('outbox = [{sheet:"notes", key_field:"id", seq:1, record:{id:"1"}}]; persistOutbox(); cloudDenied = ["expenses"]');
    e.call('forgetDevice', 'revoked');
    assert.equal(e.read('outbox.length'), 0);
    assert.equal(e.localStorage.getItem('personal-os-outbox-v1'), '[]');
    assert.equal(e.read('state.tasks.length'), 0);
    assert.deepEqual(e.read('cloudDenied'), []);
    assert.equal(e.read('firstLoadDone'), false, '重新配對之後要重新等雲端讀到，才可以說「沒有資料」');
  });
});

/* ========================================================================== */
describe('前端接真的 Code.gs：feat_expense 關掉的人', () => {

  test('記帳整個消失：資料、導覽、白板都沒有；其他模組照常', async () => {
    const back = loadCodeGs({
      cache: true,
      tokens: { [TOKEN]: ME },
      sheets: {
        line_users: new FakeSheet('line_users', [
          ['line_id', 'display_name', 'is_active', 'is_admin', 'feat_expense', 'feat_tasks', 'feat_review', 'feat_notes', 'feat_mood', 'feat_log'],
          [ME, 'Neil', 'TRUE', '', '', 'TRUE', 'TRUE', 'TRUE', 'TRUE', 'TRUE']
        ]),
        tasks: new FakeSheet('tasks', [Object.keys(TASK('1', 'x')).concat(['board']), Object.values(TASK('1', '釘著的任務')).concat(['TRUE'])]),
        expenses: new FakeSheet('expenses', [Object.keys(EXP('1', 1)), Object.values(EXP('8', 500))]),
        reviews: new FakeSheet('reviews', [['review_date', 'good', 'stuck', 'most_important', 'line_id', 'del']]),
        moods: new FakeSheet('moods', [['id', 'mood_date', 'level', 'note', 'line_id', 'del']]),
        notes: new FakeSheet('notes', [['id', 'text', 'created_at', 'line_id', 'del']])
      }
    });
    const front = loadFrontend({
      fetchImpl: ({ body }) => json(JSON.parse(back.call('handlePwaSync_', { postData: { contents: JSON.stringify(body) } }).body))
    });
    front.raw('deviceToken = "' + TOKEN + '"; myLineId = null; outbox = []; gateMode = null');
    front.raw('applyIdentity = function(){}; applyZone = function(){}');

    assert.equal(await front.callRaw('startSession', 'cold'), true);
    assert.equal(front.read('myLineId'), ME);
    assert.equal(front.read('state.expenses.length'), 0, '那張表根本沒送到手機上');
    assert.deepEqual(front.read('cloudDenied'), ['expenses']);
    assert.equal(front.call('featureAllowed', 'expenses'), false);
    assert.deepEqual(front.call('boardItems').map((i) => i.kind), ['tasks'], '白板自然只看得到有權限的模組');

    // 繞過畫面直接送一筆記帳：雲端擋下
    const r = await front.callRaw('cloudPost', { action: 'upsert', sheet: 'expenses', key_field: 'id', record: { id: '9', amount: 1, line_id: ME } });
    assert.equal(r.error, 'forbidden');
    assert.equal(back.sheets.expenses.values.length, 2, '表沒被寫入');
  });
});
