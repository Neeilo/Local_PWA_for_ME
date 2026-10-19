/**
 * ADR-019 PR-4（前端）— B-1 待送佇列滿了停收、B-5 白板只改自己的
 *
 * 為什麼有這批測試：
 *  - B-1：佇列滿 1,000 筆以前是無聲丟最舊——丟的正是最早那幾筆沒送出去的資料。改成停收新的，
 *    這次的編輯不生效（畫面還原），而且要講出來，不讓人以為存好了。同鍵取代不增加筆數，滿了也照常取代
 *  - B-5：雲端回「不是建立者」是永久拒絕。重送幾次都一樣，留在佇列只會卡死後面每一筆
 *    （ADR-018 實作差異 A-2 的教訓）。要移出佇列、還原畫面、提示「這筆由 xx 維護」
 *  - 雲端忙碌（busy，B-4 等鎖逾時）是可重試的：留在佇列，下一輪自己重送
 *  - 別人的白板項目不擺按不動的按鈕（編輯／刪除／勾選／釘選）
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const MOM = 'Umom';

function withElements(e) {
  e.raw(`__els = {};
    document.getElementById = function(id){
      return __els[id] || (__els[id] = { id, value:'', innerHTML:'', textContent:'', hidden:false, disabled:false, dataset:{},
        classList:{add(){},remove(){},toggle(){},contains:()=>false}, addEventListener(){},
        querySelectorAll:()=>[], querySelector:()=>null, setAttribute(){}, removeAttribute(){} });
    }`);
  return (id) => e.read('__els[' + JSON.stringify(id) + '] || {}');
}

const cloudTask = (id, owner, extra = {}) => Object.assign({ id: String(id), text: '倒垃圾', is_completed: '', created_at: '2026-10-01T00:00:00.000Z',
  priority: 'M', line_id: owner, del: '', board: '', due_date: '', recur_interval: '', recur_unit: '', notified: '', origin_chat: '', kind: 'todo' }, extra);

/** 已配對、雲端資料已讀到（cloudTasks）的環境 */
function env({ fetchImpl = null, cloudTasks = [] } = {}) {
  const e = loadFrontend({ fetchImpl });
  const el = withElements(e);
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = [];');
  e.raw('roster = ' + JSON.stringify([{ line_id: ME, display_name: 'Neil', is_active: 'TRUE' }, { line_id: MOM, display_name: '媽媽', is_active: 'TRUE' }]));
  e.call('applyCloudData', { tasks: cloudTasks, notes: [], expenses: [] }, [], {});
  return { e, el };
}
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
const writes = (e) => e.calls.filter((c) => c.body && c.body.action === 'upsert');
const taskTxt = (e, id) => (e.read('state.tasks').find((t) => String(t.id) === String(id)) || {}).txt;
async function settle(e, n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/** 把佇列塞滿（同一張表、不同 id），不送出：localOnly 擋住 flush */
function fillOutbox(e) {
  e.raw(`outbox = Array.from({length: OUTBOX_MAX}, (_, i) => ({sheet:'notes', key_field:'id', seq:i+1, record:{id:'n'+i, text:'離線打的 '+i}}));`);
}

/* ========================================================================== */
describe('B-1 佇列滿了停收', () => {

  test('outboxAdd：滿了回 null（拒收）、原本那 1,000 筆一筆都沒少', () => {
    const { e } = env();
    fillOutbox(e);
    const out = e.read(`outboxAdd(outbox, {sheet:'notes', key_field:'id', seq:9999, record:{id:'new'}})`);
    assert.equal(out, null);
    assert.equal(e.read('outbox.length'), 1000);
    assert.equal(e.read('outbox[0].record.id'), 'n0', '最舊的那筆還在（以前會被丟掉）');
  });

  test('outboxAdd：滿了，同鍵取代照常（不增加筆數，最後一次編輯才是真相）', () => {
    const { e } = env();
    fillOutbox(e);
    const out = e.read(`outboxAdd(outbox, {sheet:'notes', key_field:'id', seq:9999, record:{id:'n5', text:'改過'}})`);
    assert.equal(out.length, 1000);
    assert.equal(out[5].record.text, '改過');
  });

  test('滿了還改既有任務：不排、不送、畫面還原成雲端那份、提示待同步 N 筆請連網', async () => {
    const { e } = env({ cloudTasks: [cloudTask(1, ME, { text: '雲端的內容' })] });
    fillOutbox(e);
    e.raw(`(function(){ const t=state.tasks.find(x=>x.id===1); t.txt='離線改的'; pushTask(t); })()`);
    await settle(e);
    assert.equal(e.read('outbox.length'), 1000);
    assert.ok(!e.read('outbox').some((j) => j.sheet === 'tasks'));
    assert.equal(taskTxt(e, 1), '雲端的內容', '這次的編輯不生效，畫面不能留著假的');
    assert.ok(e.toasts.some((m) => /待同步 1000 筆，請連網/.test(m) && /沒有存/.test(m)));
  });

  test('滿了還新增：新的那筆從畫面拿掉（雲端沒有、佇列也沒排）', async () => {
    const { e } = env();
    fillOutbox(e);
    e.raw(`(function(){ const t={id:77, txt:'新任務', ts:Date.now(), line_id:"${ME}"}; state.tasks.unshift(t); pushTask(t); })()`);
    await settle(e);
    assert.equal(taskTxt(e, 77), undefined);
  });

  test('滿了：待同步標示改成警示（請連網、新的修改不會存）', () => {
    const { e, el } = env();
    fillOutbox(e);
    e.call('renderSyncBadge');
    assert.match(el('syncBadge').textContent, /待同步 1000 筆，請連網/);
    e.raw('outbox = outbox.slice(0, 3)');
    e.call('renderSyncBadge');
    assert.equal(el('syncBadge').textContent, '⏳ 3 筆待同步');
  });
});

/* ========================================================================== */
describe('B-5 永久拒絕不重試、雲端忙碌照常重試', () => {

  test('不是建立者：只送一次、移出佇列、還原畫面、提示「這筆由 媽媽 維護」', async () => {
    const { e } = env({
      cloudTasks: [cloudTask(1, MOM, { text: '媽的白板事項', board: 'TRUE' })],
      fetchImpl: ({ body }) => body && body.action === 'upsert'
        ? reply({ error: 'forbidden', permanent: true, reason: 'not_owner', owner_name: '媽媽' }) : null
    });
    e.raw(`(function(){ const t=state.tasks.find(x=>x.id===1); t.txt='Neil 偷改'; pushTask(t); })()`);
    await settle(e);
    assert.equal(writes(e).length, 1, '永久拒絕不可以一直重送');
    assert.equal(e.read('outbox.length'), 0);
    assert.equal(taskTxt(e, 1), '媽的白板事項');
    assert.ok(e.toasts.some((m) => /這筆由 媽媽 維護/.test(m)));
    // 後面排的工作不會被卡住
    e.raw(`pushNote({id:5, txt:'我的雜記', ts:Date.now(), line_id:"${ME}"})`);
    await settle(e);
    assert.equal(e.read('outbox.length'), 0);
  });

  test('雲端忙碌（busy）：留在佇列，不提示權限問題', async () => {
    const { e } = env({ fetchImpl: ({ body }) => body && body.action === 'upsert' ? reply({ error: 'busy' }) : null });
    e.raw(`pushNote({id:5, txt:'我的雜記', ts:Date.now(), line_id:"${ME}"})`);
    await settle(e);
    assert.equal(e.read('outbox.length'), 1);
    assert.ok(!e.toasts.some((m) => /權限|維護/.test(m)));
  });
});

/* ========================================================================== */
describe('B-5 別人的白板項目不擺按鈕', () => {

  test('boardLocked：只有「別人建立＋已釘白板」才鎖', () => {
    const { e } = env();
    const locked = (r) => e.read('boardLocked(' + JSON.stringify(r) + ')');
    assert.equal(locked({ board: true, line_id: MOM }), true);
    assert.equal(locked({ board: true, line_id: ME }), false, '自己的');
    assert.equal(locked({ board: false, line_id: MOM }), false, '沒釘白板（Neil 2026-10-19：只管白板）');
    assert.equal(locked({ board: true, line_id: '' }), false, '沒有建立者的舊資料（Neil 2026-10-19）');
    e.raw('myLineId = null');
    assert.equal(locked({ board: true, line_id: MOM }), false, '還沒配對的裝置不鎖（雲端照樣擋）');
  });

  test('任務列表：別人的白板任務沒有刪除／釘選／編輯、勾選框停用，標「媽媽 維護」；自己的照舊', () => {
    const { e, el } = env({ cloudTasks: [cloudTask(1, MOM, { text: '媽的', board: 'TRUE' }), cloudTask(2, ME, { text: '我的', board: 'TRUE' })] });
    e.raw('scopeMine = false');
    e.call('renderTasks');
    const html = el('taskListOpen').innerHTML;
    const mom = html.split('<div class="task ').find((b) => b.includes('媽的'));
    const mine = html.split('<div class="task ').find((b) => b.includes('我的'));
    assert.ok(!/delTask\(1\)|toggleBoard\('tasks',1\)|openTaskEdit\(1\)|toggleTask\(1\)|cyclePriority\(1\)/.test(mom));
    assert.match(mom, /disabled/);
    assert.match(mom, /媽媽 維護/);
    assert.match(mine, /delTask\(2\)/);
    assert.match(mine, /toggleTask\(2\)/);
  });
});
