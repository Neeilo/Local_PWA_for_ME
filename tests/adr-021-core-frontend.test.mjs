/**
 * ADR-021 PR-B（前端）— 2.0 分層載入（D-1）、總覽 Widget、首頁勾完成、開閱讀頁即已讀
 *
 * 為什麼有這批測試：
 *  - 2.0 開機只送 boot core:true，**不讀整張 notes／expenses**（票面驗收第一條）
 *  - 模組的表「這次開 App 第一次點進去」才讀，資料到齊才進畫面；之後再進直接進、背景重讀（Neil 2026-10-19）
 *  - 輪詢只更新畫面上的（Neil 2026-10-19）：停在總覽拿摘要、停在記帳只讀 expenses
 *  - 只讀了幾張表時，沒讀的那幾張要原樣留著（applyCloudData 部分更新），不能被清空
 *  - 一個 Widget 的摘要失敗，只有那一格「連不上・重試」，其他照常（EXP-01）
 *  - 首頁勾完成：雲端回應前「同步中」不能再按；成功才顯示已完成；失敗還原（本來就沒先改）
 *  - 1.0 開閱讀頁不寫已讀（1.0 行為不變），2.0 才寫；1.0 讀到 clips 的新欄照常
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const USER = { line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE', feat_expense: 'TRUE', feat_tasks: 'TRUE',
  feat_notes: 'TRUE', feat_clips: 'TRUE', feat_ui_v2: 'TRUE' };
const cloudTask = (id, extra = {}) => Object.assign({ id: String(id), text: '任務' + id, is_completed: '', created_at: '2026-10-01T00:00:00.000Z',
  priority: 'M', line_id: ME, del: '', board: '', due_date: '', recur_interval: '', recur_unit: '', notified: '', origin_chat: '', kind: 'todo' }, extra);

function coreReply(widgets, user = USER) {
  return { core: true, session: { status: 'ok', line_id: ME, device_id: 'd1' }, line_users: [user], modules: [], self_note: '早安',
    widgets: widgets || { tasks: { tasks: [cloudTask(1)], board: { notes: [], expenses: [] }, at: 'x' }, reading: { unread: 2, last: null } } };
}

function withElements(e) {
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{}, style:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){}, focus(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

/** 2.0（本機選了 v2）、已配對的環境。handler：action → 回應物件（或函式） */
function env({ v2 = true, handler = {}, view = 'overview' } = {}) {
  const e = loadFrontend({
    storage: v2 ? { 'personal-os-ui': 'v2' } : {},
    fetchImpl: ({ body }) => {
      if (!body) return null;
      const key = body.action === 'boot' && body.core ? 'bootCore' : body.action;
      const h = handler[key];
      if (h === undefined) return null;
      return reply(typeof h === 'function' ? h(body) : h);
    }
  });
  const el = withElements(e);
  e.raw(`deviceToken = "tok"; localOnly = false; outbox = []; __view = ${JSON.stringify(view)};
    currentView = function(){ return __view; };
    switchView = function(name){ __view = name; };`);
  e.set('scrollTo', () => {});
  return { e, el };
}
const sent = (e, action) => e.calls.filter((c) => c.body && c.body.action === action);
async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/* ========================================================================== */
describe('開機：2.0 只讀核心層', () => {

  test('送 boot core:true；不讀 tasks／notes／expenses 整張（沒有 readMany）', async () => {
    const { e } = env({ handler: { bootCore: coreReply() } });
    assert.equal(await e.callRaw('runBoot', 'cold'), true);
    const boots = sent(e, 'boot');
    assert.equal(boots.length, 1);
    assert.equal(boots[0].body.core, true);
    assert.equal(sent(e, 'readMany').length, 0);
    assert.equal(e.read('state.notes.length'), 0);
    assert.equal(e.read('selfNote'), '早安');
    assert.equal(e.read('widgets.data.reading.unread'), 2);
  });

  test('1.0：照舊送一般 boot（沒有 core）', async () => {
    const { e } = env({ v2: false, handler: { boot: { session: { status: 'ok', line_id: ME }, line_users: [USER], data: { tasks: [], notes: [], expenses: [] }, denied: [] } } });
    await e.callRaw('runBoot', 'cold');
    assert.equal(sent(e, 'boot')[0].body.core, undefined);
  });

  test('本機選了 2.0、但權限被收回：清掉選擇、改走 1.0 完整開機', async () => {
    const noV2 = Object.assign({}, USER, { feat_ui_v2: '' });
    const { e } = env({ handler: {
      bootCore: coreReply(null, noV2),
      boot: { session: { status: 'ok', line_id: ME }, line_users: [noV2], data: { tasks: [cloudTask(1)], notes: [], expenses: [] }, denied: [] }
    } });
    assert.equal(await e.callRaw('runBoot', 'cold'), true);
    assert.deepEqual(sent(e, 'boot').map((c) => !!c.body.core), [true, false]);
    assert.equal(e.read('localStorage.getItem("personal-os-ui")'), null);
    assert.equal(e.read('state.tasks.length'), 1);
  });

  test('2.0 開機不打報價（進股票頁才打）', async () => {
    const { e } = env({ handler: { bootCore: coreReply() } });
    await e.callRaw('startSession', 'cold');
    await settle();
    assert.equal(sent(e, 'stock').length, 0);
  });
});

/* ========================================================================== */
describe('模組第一次點進去才讀', () => {

  const rm = (data) => (body) => ({ data: Object.fromEntries(body.sheets.map((s) => [s, data[s] || []])), denied: [] });

  test('第一次進記帳：Loading → 只讀 expenses → 進畫面；第二次直接進（背景重讀一次）', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), readMany: rm({ expenses: [{ id: '1', expense_date: '2026-10-01', type: 'expense', category: '餐飲', amount: 100 }] }) } });
    await e.callRaw('runBoot', 'cold');
    await e.callRaw('goView', 'expenses');
    const reads = sent(e, 'readMany');
    assert.deepEqual(reads.map((c) => c.body.sheets), [['expenses']]);
    assert.equal(e.read('__view'), 'expenses');
    assert.equal(e.read('state.expenses.length'), 1);
    e.raw('__view = "overview"');
    e.call('goView', 'expenses');
    assert.equal(e.read('__view'), 'expenses', '讀過了：直接進，不等');
    await settle();
    assert.equal(sent(e, 'readMany').length, 2, '背景重讀一次');
  });

  test('讀任務表時要群組名（groups:true），回來就套用；讀記帳不要', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), readMany: (b) => Object.assign({ data: Object.fromEntries(b.sheets.map((x) => [x, []])), denied: [] },
      b.groups ? { group_names: { Cg: '家' } } : {}) } });
    await e.callRaw('runBoot', 'cold');
    await e.callRaw('goView', 'tasks');
    e.raw('__view = "overview"');
    await e.callRaw('goView', 'expenses');
    assert.deepEqual(sent(e, 'readMany').map((c) => !!c.body.groups), [true, false]);
    assert.equal(e.read('groupNames.Cg'), '家');
  });

  test('讀失敗：不進畫面、講出來', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), readMany: { error: 'boom' } } });
    await e.callRaw('runBoot', 'cold');
    assert.equal(await e.callRaw('goView', 'notes'), false);
    assert.equal(e.read('__view'), 'overview');
    assert.ok(e.toasts.some((t) => /連不上/.test(t)));
  });

  test('只讀了 expenses：已經讀好的 tasks 原樣留著（部分更新不清空別張）', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), readMany: rm({ tasks: [cloudTask(7)], expenses: [] }) } });
    await e.callRaw('runBoot', 'cold');
    await e.callRaw('goView', 'tasks');
    assert.equal(e.read('state.tasks.length'), 1);
    e.raw('__view = "overview"');
    await e.callRaw('goView', 'expenses');
    assert.equal(e.read('state.tasks.length'), 1);
  });

  test('1.0 的 goView 不會多讀（資料開機就到齊了）', () => {
    const { e } = env({ v2: false });
    e.raw('roster = ' + JSON.stringify([USER]) + '; myLineId = "' + ME + '"');
    e.call('goView', 'expenses');
    assert.equal(sent(e, 'readMany').length, 0);
  });
});

/* ========================================================================== */
describe('輪詢只更新畫面上的', () => {

  test('停在總覽：action=widgets，不讀任何整張表', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), widgets: { widgets: coreReply().widgets, self_note: '' } } });
    await e.callRaw('runBoot', 'cold');
    await settle();
    const before = sent(e, 'widgets').length;          // PR-C：開機後另外要財務（一趟 widgets only:[finance]）
    await e.callRaw('timedPull', 'poll');
    const polls = sent(e, 'widgets').slice(before);
    assert.equal(polls.length, 1);
    assert.equal(polls[0].body.trigger, 'poll');
    assert.ok(!polls[0].body.only.includes('stocks'), '股票走報價，不在 widgets 裡');
    assert.equal(sent(e, 'readMany').length, 0);
  });

  test('停在記帳（讀過了）：只讀 expenses', async () => {
    const { e } = env({ handler: { bootCore: coreReply(), readMany: (b) => ({ data: Object.fromEntries(b.sheets.map((s) => [s, []])), denied: [] }) } });
    await e.callRaw('runBoot', 'cold');
    await e.callRaw('goView', 'expenses');
    await settle();
    const before = sent(e, 'readMany').length;
    await e.callRaw('timedPull', 'poll');
    const last = sent(e, 'readMany').slice(before);
    assert.deepEqual(last.map((c) => [c.body.sheets, c.body.trigger]), [[['expenses'], 'poll']]);
  });

  test('停在 Apps：不打任何請求', async () => {
    const { e } = env({ handler: { bootCore: coreReply() }, view: 'apps' });
    await e.callRaw('runBoot', 'cold');
    const before = e.calls.length;
    await e.callRaw('timedPull', 'poll');
    assert.equal(e.calls.length, before);
  });
});

/* ========================================================================== */
describe('Widget 各自失敗（EXP-01）', () => {

  test('Tasks 摘要失敗：只有任務那一格「連不上・重試」，閱讀照常畫', async () => {
    const { e, el } = env({ handler: { bootCore: coreReply({ tasks: { error: 'summary_failed' }, reading: { unread: 3, last: null } }) } });
    await e.callRaw('runBoot', 'cold');
    e.call('renderOverview');
    assert.match(el('wTasks').innerHTML, /連不上・重試/);
    assert.doesNotMatch(el('wReading').innerHTML, /連不上/);
    assert.match(el('wReading').innerHTML, /未讀 3 篇/);
  });

  test('摘要沒帶（沒權限／總開關關掉）：那一格不出現', async () => {
    const { e, el } = env({ handler: { bootCore: coreReply({ tasks: { tasks: [], board: { notes: [], expenses: [] } } }) } });
    await e.callRaw('runBoot', 'cold');
    e.call('renderOverview');
    assert.equal(el('wReading').hidden, true);
    assert.equal(el('wTasks').hidden, false);
  });

  test('有資料：顯示「更新 HH:MM」', async () => {
    const { e, el } = env({ handler: { bootCore: coreReply() } });
    await e.callRaw('runBoot', 'cold');
    e.call('renderOverview');
    assert.match(el('wTasks').innerHTML, /更新 \d\d:\d\d/);
  });
});

/* ========================================================================== */
describe('首頁勾完成：雲端確認後才算', () => {

  function doneEnv(answer) {
    let resolve;
    const pending = new Promise((r) => { resolve = r; });
    const { e, el } = env({ handler: { bootCore: coreReply() } });
    e.set('fetch', (url, opts) => {
      const body = JSON.parse(opts.body);
      e.calls.push({ body });
      if (body.action === 'taskDone') return pending.then(() => reply(answer));
      return Promise.resolve(reply(body.action === 'boot' ? coreReply() : { success: true }));
    });
    return { e, el, resolve };
  }

  test('回應前：同步中、不能再按、還沒劃掉；成功後才劃掉', async () => {
    const { e, el, resolve } = doneEnv({ success: true, spawned: false });
    await e.callRaw('runBoot', 'cold');
    const p = e.callRaw('widgetDone', 1);
    e.call('renderTasksWidget');
    assert.match(el('wTasks').innerHTML, /同步中/);
    assert.doesNotMatch(el('wTasks').innerHTML, /w-task done/);
    assert.equal(await e.callRaw('widgetDone', 1), false, '同步中再按不會再送');
    resolve();
    assert.equal(await p, true);
    assert.equal(e.calls.filter((c) => c.body.action === 'taskDone').length, 1);
    assert.match(el('wTasks').innerHTML, /w-task done/);
    assert.doesNotMatch(el('wTasks').innerHTML, /同步中/);
  });

  test('送出的內容：id、today、next_id、trigger=write', async () => {
    const { e, resolve } = doneEnv({ success: true });
    await e.callRaw('runBoot', 'cold');
    const p = e.callRaw('widgetDone', 1);
    resolve(); await p;
    const b = e.calls.find((c) => c.body.action === 'taskDone').body;
    assert.equal(b.id, '1');
    assert.equal(b.trigger, 'write');
    assert.match(b.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(b.next_id);
  });

  test('被拒（別人的白板）：還原、講是誰維護', async () => {
    const { e, el, resolve } = doneEnv({ error: 'forbidden', permanent: true, reason: 'not_owner', owner_name: '媽媽' });
    await e.callRaw('runBoot', 'cold');
    const p = e.callRaw('widgetDone', 1);
    resolve();
    assert.equal(await p, false);
    assert.doesNotMatch(el('wTasks').innerHTML, /w-task done/);
    assert.ok(e.toasts.some((t) => /媽媽 維護/.test(t)));
  });
});

/* ========================================================================== */
describe('開閱讀頁即已讀（D-13）', () => {

  test('2.0 開一篇：送 clipRead（trigger=write），本機那篇標已讀', async () => {
    const { e } = env({ handler: { clipRead: { success: true } } });
    e.raw('roster = ' + JSON.stringify([USER]) + '; myLineId = "' + ME + '"; clipsData = [{id:"c1", line_id:"' + ME + '", status:"done"}]');
    e.call('openClip', 'c1');
    await settle();
    const r = sent(e, 'clipRead');
    assert.equal(r.length, 1);
    assert.deepEqual([r[0].body.id, r[0].body.trigger], ['c1', 'write']);
    assert.equal(e.read('clipsData[0].read_status'), 'read');
  });

  test('1.0 開一篇：不寫已讀（1.0 行為不變）', async () => {
    const { e } = env({ v2: false });
    e.raw('roster = ' + JSON.stringify([USER]) + '; myLineId = "' + ME + '"; clipsData = [{id:"c1", line_id:"' + ME + '", status:"done"}]');
    e.call('openClip', 'c1');
    await settle();
    assert.equal(sent(e, 'clipRead').length, 0);
  });

  test('1.0 讀到 clips 的新欄位（read_status、last_read_at）：列表照常畫', () => {
    const { e } = env({ v2: false });
    const html = e.call('clipsListHtml', [{ id: 'c1', line_id: ME, status: 'done', author: 'alice', caption: '內容', read_status: 'read', last_read_at: '2026-10-19T01:00:00.000Z' }]);
    assert.match(html, /alice/);
  });
});
