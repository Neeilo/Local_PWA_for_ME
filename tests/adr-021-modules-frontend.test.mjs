/**
 * ADR-021 PR-A1（前端 1.0）— 模組總開關
 *
 * 為什麼有這批測試：
 *  - 總開關對 1.0 也生效（Neil 2026-10-19：總開關就是全域）。雲端已經擋讀寫，
 *    1.0 要把入口藏好，不擺按了也存不進去的按鈕（白板 📌、提醒分段、分期頁）
 *  - 雲端沒帶 modules（舊版後端）或全開時，1.0 的行為一個都不能變
 *  - 寫入被總開關擋下是永久拒絕：移出佇列、還原畫面、講清楚是「停用」不是「沒權限」
 *
 * 跑法：npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFrontend } from './fake-browser.mjs';

const ME = 'Uneil';
const ALL = ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'board', 'notes', 'mail', 'library'];
const mods = (off = []) => ALL.map((id) => ({ module_id: id, name: id === 'reminders' ? '提醒' : id, enabled: !off.includes(id) }));

function env({ off = null, fetchImpl = null } = {}) {
  const e = loadFrontend({ fetchImpl });
  e.raw(`__attrs = {}; document.documentElement = { setAttribute(k, v){ __attrs[k] = v; }, removeAttribute(k){ delete __attrs[k]; } };`);
  e.raw('myLineId = "' + ME + '"; deviceToken = "tok"; localOnly = false; outbox = [];');
  e.raw('roster = ' + JSON.stringify([{ line_id: ME, display_name: 'Neil', is_active: 'TRUE', is_admin: 'TRUE' }]));
  if (off) e.call('applyModules', mods(off));
  return e;
}
const reply = (obj) => ({ json: () => Promise.resolve(obj) });
async function settle(e, n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

describe('沒帶 modules／全開：行為不變', () => {
  test('每一頁都照舊', () => {
    const e = env();
    for (const v of ['expenses', 'plans', 'stocks', 'tasks', 'reminders', 'notes']) assert.equal(e.call('viewAllowed', v), true, v);
    assert.equal(e.call('featureAllowed', 'clips'), true);
    assert.equal(e.read('__attrs["data-mod-off"]'), undefined);
  });

  test('全開的登記表：一樣全開，也不設 data-mod-off', () => {
    const e = env({ off: [] });
    assert.equal(e.call('viewAllowed', 'reminders'), true);
    assert.equal(e.read('__attrs["data-mod-off"]'), undefined);
  });

  test('收到不認得的內容（不是陣列、缺 module_id）：當作全開，不壞', () => {
    const e = env();
    e.call('applyModules', { nope: true });
    e.call('applyModules', [null, { enabled: false }]);
    assert.equal(e.call('viewAllowed', 'expenses'), true);
  });
});

describe('關掉的模組：入口藏起', () => {
  test('記帳關掉：記帳頁不能進；分期跟著不能進；任務照常', () => {
    const e = env({ off: ['expenses'] });
    assert.equal(e.call('viewAllowed', 'expenses'), false);
    assert.equal(e.call('viewAllowed', 'plans'), false);
    assert.equal(e.call('viewAllowed', 'tasks'), true);
  });

  test('只關分期／提醒：那一格藏起，記帳、任務照常', () => {
    const e = env({ off: ['plans', 'reminders'] });
    assert.equal(e.call('viewAllowed', 'plans'), false);
    assert.equal(e.call('viewAllowed', 'reminders'), false);
    assert.equal(e.call('viewAllowed', 'expenses'), true);
    assert.equal(e.call('viewAllowed', 'tasks'), true);
  });

  test('圖書館關掉：收藏分段的 featureAllowed 也關', () => {
    assert.equal(env({ off: ['library'] }).call('featureAllowed', 'clips'), false);
  });

  test('白板、提醒關掉：data-mod-off 標上去（CSS 藏 📌 與提醒分段）；再打開就拿掉', () => {
    const e = env({ off: ['board', 'reminders'] });
    assert.equal(e.read('__attrs["data-mod-off"]'), 'reminders board');
    e.call('applyModules', mods([]));
    assert.equal(e.read('__attrs["data-mod-off"]'), undefined);
  });

  test('CSS 規則真的存在：📌 與提醒分段在 data-mod-off 底下會藏起來', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /:root\[data-mod-off~="board"\] \.pin/);
    assert.match(html, /:root\[data-mod-off~="reminders"\] #taskSeg button\[data-val="reminder"\]/);
  });
});

describe('寫入被總開關擋下（permanent）', () => {
  test('移出佇列、還原畫面、提示「已停用」', async () => {
    const e = env({ off: ['reminders'], fetchImpl: ({ body }) => body && body.action === 'upsert'
      ? reply({ error: 'forbidden', permanent: true, reason: 'module_off', module: 'reminders' }) : null });
    e.raw(`toast = function(m){ __toast = m; }; revertRecord = function(s, id){ __reverted = s + ':' + id; };`);
    e.raw(`outbox = [{sheet:'tasks', key_field:'id', seq:1, record:{id:'7', text:'繳房租', kind:'reminder'}}];`);
    await e.call('flushOutbox');
    await settle(e);
    assert.equal(e.read('outbox.length'), 0);
    assert.equal(e.read('__reverted'), 'tasks:7');
    assert.match(e.read('__toast'), /「提醒」已停用/);
  });
});
